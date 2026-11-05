/**
 * The office's front door: a small HTTP server that serves the GUI, exposes a
 * JSON API, and streams live events to the browser over SSE.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { store, newId, DATA_DIR } from './store.js';
import { bus } from './bus.js';
import {
  listApprovals,
  resolveApproval,
  answerQuestion,
  escalate,
  reapStaleApprovals,
  notify,
} from './approvals.js';
import {
  hireOn,
  dismiss,
  order,
  workerFor,
  workerState,
  allWorkerStates,
  activityFor,
  stopAll,
  summariseToolCall,
  deliverToAgent,
} from './runtime.js';
import {
  externalSessions,
  authStatus,
  availableSkills,
  availableMcpServers,
  startWatchingExternalSessions,
} from './discovery.js';
import { startScheduler } from './scheduler.js';
import { postMessage } from './office-tools.js';
import {
  createAgent,
  updateAgent,
  deleteAgent,
  createDepartment,
  deleteDepartment,
  setDepartmentHead,
  seedOffice,
  ensureCeoOffice,
  relayoutFloor,
  clamp,
} from './operations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const ok = (res, data = { ok: true }) => send(res, 200, data);
const fail = (res, status, message) => send(res, status, { ok: false, error: message });

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);

  // Never serve anything outside public/.
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'forbidden');

  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    // Unknown path: fall back to the app shell.
    if (!path.extname(file)) {
      try {
        const shell = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        return res.end(shell);
      } catch {}
    }
    fail(res, 404, 'not found');
  }
}

/** The whole world, as the browser needs it on load. */
async function snapshot() {
  const projectDirs = store.state.projects.map((p) => p.directory).filter(Boolean);
  const [visitors, auth, skills, mcpServers] = await Promise.all([
    externalSessions(),
    authStatus(),
    availableSkills(projectDirs),
    availableMcpServers(projectDirs),
  ]);

  return {
    office: store.state.office,
    departments: store.state.departments,
    agents: store.state.agents,
    projects: store.state.projects,
    components: { skills, mcpServers, registry: store.state.components },
    approvals: store.state.approvals.slice(0, 100),
    notifications: store.state.notifications.slice(0, 100),
    messages: store.state.messages.slice(0, 100),
    workers: allWorkerStates(),
    visitors,
    auth,
    dataDir: DATA_DIR,
  };
}

// --- route table ------------------------------------------------------------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/state$/, async (req, res) => ok(res, await snapshot()));

// Live event stream.
route('GET', /^\/api\/events$/, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);

  const remove = bus.addClient(res);
  // Comment frames keep proxies and browsers from closing an idle stream.
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* cleaned up on close */
    }
  }, 20_000);

  req.on('close', () => {
    clearInterval(ping);
    remove();
  });
});

// --- office ---------------------------------------------------------------

route('PATCH', /^\/api\/office$/, async (req, res) => {
  const patch = await readBody(req);
  Object.assign(store.state.office, pick(patch, ['name', 'motto', 'charter', 'lordName', 'ceoAgentId']));
  store.save();
  bus.emitEvent('office.updated', store.state.office);
  ok(res, store.state.office);
});

/** Staff an empty office with a sensible starting company. */
route('POST', /^\/api\/office\/seed$/, async (req, res) => {
  const result = seedOffice();
  ensureCeoOffice();
  ok(res, result);
});

/** Give the CEO their own room at the top of the plan. */
route('POST', /^\/api\/office\/ceo-suite$/, async (req, res) => {
  const result = ensureCeoOffice();
  if (!result.ok) return fail(res, 400, result.error);
  ok(res, result.department);
});

/** Lord Marcos's own inbox: everything addressed to him. */
route('GET', /^\/api\/inbox$/, async (req, res) => {
  ok(res, {
    messages: store.state.messages.filter((m) => m.toAgentId === 'lord').slice(0, 200),
    sent: store.state.messages.filter((m) => m.fromAgentId === 'lord').slice(0, 100),
  });
});

/** Mark messages in Lord Marcos's inbox as read. */
route('POST', /^\/api\/inbox\/read$/, async (req, res) => {
  const { ids } = await readBody(req);
  const target = ids?.length ? new Set(ids) : null;
  for (const m of store.state.messages) {
    if (m.toAgentId === 'lord' && (!target || target.has(m.id))) m.read = true;
  }
  store.save();
  bus.emitEvent('message.read', { to: 'lord' });
  ok(res);
});

/** Sanction everything currently waiting on Lord Marcos, in one stroke. */
route('POST', /^\/api\/approvals\/sanction-all$/, async (req, res) => {
  const { note = '' } = await readBody(req);
  const waiting = store.state.approvals.filter(
    // Questions need a real answer, so they are never swept up by this.
    (a) => a.status === 'pending' && a.route === 'lord' && a.kind !== 'question'
  );

  for (const a of waiting) resolveApproval(a.id, 'approved', { by: 'lord', note });
  ok(res, { sanctioned: waiting.length });
});

// --- departments ----------------------------------------------------------

route('POST', /^\/api\/departments$/, async (req, res) => {
  const result = createDepartment(await readBody(req));
  if (!result.ok) return fail(res, 400, result.error);
  ok(res, result.department);
});

route('PATCH', /^\/api\/departments\/([\w]+)$/, async (req, res, [id]) => {
  const dept = store.department(id);
  if (!dept) return fail(res, 404, 'no such department');

  const patch = await readBody(req);

  if (patch.seats != null) {
    const seats = clamp(Number(patch.seats) || 1, 1, 24);
    // Removing a desk somebody is sitting at would strand them off the map.
    const highestOccupied = store.state.agents
      .filter((a) => a.departmentId === id)
      .reduce((max, a) => Math.max(max, a.seat), -1);
    if (seats <= highestOccupied) {
      return fail(
        res,
        409,
        `Desk ${highestOccupied} is occupied. Reassign that member of staff before shrinking ${dept.name}.`
      );
    }
    dept.seats = seats;
  }

  Object.assign(dept, pick(patch, ['name', 'context', 'theme', 'headAgentId', 'x', 'y', 'w', 'h']));
  store.save();
  bus.emitEvent('department.updated', dept);
  ok(res, dept);
});

/** Appoint (or clear) the head of a department. */
route('POST', /^\/api\/departments\/([\w]+)\/head$/, async (req, res, [id]) => {
  const { agentId } = await readBody(req);
  const result = setDepartmentHead(id, agentId || null);
  if (!result.ok) return fail(res, 400, result.error);
  ok(res, result.department);
});

route('DELETE', /^\/api\/departments\/([\w]+)$/, async (req, res, [id]) => {
  const result = deleteDepartment(id);
  if (!result.ok) return fail(res, 409, result.error);
  ok(res);
});

// --- agents ---------------------------------------------------------------

route('POST', /^\/api\/agents$/, async (req, res) => {
  const result = createAgent(await readBody(req));
  if (!result.ok) return fail(res, 400, result.error);
  ok(res, result.agent);
});

route('PATCH', /^\/api\/agents\/([\w]+)$/, async (req, res, [id]) => {
  const result = updateAgent(id, await readBody(req));
  if (!result.ok) return fail(res, 400, result.error);

  const live = workerState(id);
  ok(res, {
    agent: result.agent,
    // Configuration is baked into the session at start-up.
    restartRequired: live.status !== 'offline',
  });
});

route('DELETE', /^\/api\/agents\/([\w]+)$/, async (req, res, [id]) => {
  await dismiss(id);
  const result = deleteAgent(id);
  if (!result.ok) return fail(res, 400, result.error);
  ok(res);
});

route('POST', /^\/api\/agents\/([\w]+)\/hire$/, async (req, res, [id]) => {
  if (!store.agent(id)) return fail(res, 404, 'no such agent');
  try {
    ok(res, await hireOn(id));
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('POST', /^\/api\/agents\/([\w]+)\/dismiss$/, async (req, res, [id]) => {
  if (!store.agent(id)) return fail(res, 404, 'no such agent');
  ok(res, await dismiss(id));
});

route('POST', /^\/api\/agents\/([\w]+)\/order$/, async (req, res, [id]) => {
  if (!store.agent(id)) return fail(res, 404, 'no such agent');
  const { text } = await readBody(req);
  if (!text?.trim()) return fail(res, 400, 'an order needs words');
  try {
    ok(res, await order(id, text.trim()));
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('POST', /^\/api\/agents\/([\w]+)\/interrupt$/, async (req, res, [id]) => {
  const worker = workerFor(id, { create: false });
  if (!worker) return fail(res, 404, 'that agent is not on duty');
  await worker.interrupt();
  ok(res, workerState(id));
});

route('GET', /^\/api\/agents\/([\w]+)\/activity$/, async (req, res, [id]) =>
  ok(res, { activity: activityFor(id, 400), todos: workerState(id).todos || [] })
);

/** Every memory topic an agent holds, with its contents. */
route('GET', /^\/api\/agents\/([\w]+)\/memory$/, async (req, res, [id]) => {
  if (!store.agent(id)) return fail(res, 404, 'no such agent');

  const topics = [];
  for (const topic of store.memoryTopics(id)) {
    try {
      topics.push({
        topic,
        content: await fsp.readFile(store.memoryFile(id, topic), 'utf8'),
      });
    } catch {}
  }
  ok(res, { topics });
});

route('PUT', /^\/api\/agents\/([\w]+)\/memory\/([\w-]+)$/, async (req, res, [id, topic]) => {
  if (!store.agent(id)) return fail(res, 404, 'no such agent');
  const file = store.memoryFile(id, topic);
  if (!file) return fail(res, 400, 'that is not a usable topic name');

  const { content = '' } = await readBody(req);
  await fsp.mkdir(store.memoryDir(id), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
  bus.emitEvent('agent.memory', { agentId: id });
  ok(res);
});

route('DELETE', /^\/api\/agents\/([\w]+)\/memory\/([\w-]+)$/, async (req, res, [id, topic]) => {
  const file = store.memoryFile(id, topic);
  if (!file) return fail(res, 400, 'that is not a usable topic name');
  await fsp.rm(file, { force: true });
  bus.emitEvent('agent.memory', { agentId: id });
  ok(res);
});

// --- sessions -------------------------------------------------------------

/** Switch an agent to one of their earlier conversations, or start a new one. */
route('POST', /^\/api\/agents\/([\w]+)\/session$/, async (req, res, [id]) => {
  const agent = store.agent(id);
  if (!agent) return fail(res, 404, 'no such agent');

  const { sessionId } = await readBody(req);
  if (sessionId && !(agent.sessions || []).some((s) => s.id === sessionId)) {
    return fail(res, 400, 'that is not one of their conversations');
  }

  // A session is chosen at start-up, so they have to leave and come back.
  await dismiss(id);
  agent.lastSessionId = sessionId || null;
  store.save();
  bus.emitEvent('agent.updated', agent);

  try {
    ok(res, await hireOn(id));
  } catch (err) {
    fail(res, 500, err.message);
  }
});

/** Rename a conversation, so a long-lived agent's history stays navigable. */
route('PATCH', /^\/api\/agents\/([\w]+)\/session\/([\w-]+)$/, async (req, res, [id, sessionId]) => {
  const agent = store.agent(id);
  if (!agent) return fail(res, 404, 'no such agent');

  const session = (agent.sessions || []).find((s) => s.id === sessionId);
  if (!session) return fail(res, 404, 'no such conversation');

  const { title } = await readBody(req);
  if (title?.trim()) session.title = title.trim().slice(0, 80);
  store.save();
  bus.emitEvent('agent.updated', agent);
  ok(res, session);
});

/** Everything an agent has sent and received. */
route('GET', /^\/api\/agents\/([\w]+)\/mail$/, async (req, res, [id]) => {
  const mail = store.state.messages.filter(
    (m) => m.toAgentId === id || m.fromAgentId === id
  );
  ok(res, { mail: mail.slice(0, 200) });
});

route('GET', /^\/api\/agents\/([\w]+)\/persona$/, async (req, res, [id]) => {
  if (!store.agent(id)) return fail(res, 404, 'no such agent');
  const { buildPersona } = await import('./persona.js');
  ok(res, { persona: buildPersona(id) });
});

// --- projects -------------------------------------------------------------

route('POST', /^\/api\/projects$/, async (req, res) => {
  const body = await readBody(req);
  if (!body.name?.trim()) return fail(res, 400, 'a project needs a name');
  if (!body.directory?.trim()) return fail(res, 400, 'a project needs a directory');

  const directory = path.resolve(body.directory.trim());
  if (!fs.existsSync(directory)) return fail(res, 400, `no such directory: ${directory}`);
  if (!fs.statSync(directory).isDirectory()) return fail(res, 400, 'that path is not a directory');

  const project = {
    id: newId('prj_'),
    name: body.name.trim(),
    directory,
    description: body.description || '',
    createdAt: Date.now(),
  };
  store.state.projects.push(project);
  store.save();
  bus.emitEvent('project.created', project);
  ok(res, project);
});

route('PATCH', /^\/api\/projects\/([\w]+)$/, async (req, res, [id]) => {
  const project = store.project(id);
  if (!project) return fail(res, 404, 'no such project');
  const patch = await readBody(req);

  if (patch.directory) {
    const directory = path.resolve(patch.directory);
    if (!fs.existsSync(directory)) return fail(res, 400, `no such directory: ${directory}`);
    patch.directory = directory;
  }
  Object.assign(project, pick(patch, ['name', 'directory', 'description']));
  store.save();
  bus.emitEvent('project.updated', project);
  ok(res, project);
});

route('DELETE', /^\/api\/projects\/([\w]+)$/, async (req, res, [id]) => {
  store.state.projects = store.state.projects.filter((p) => p.id !== id);
  for (const agent of store.state.agents) {
    if (agent.projectId === id) agent.projectId = null;
  }
  store.save();
  bus.emitEvent('project.deleted', { id });
  ok(res);
});

// --- approvals, notifications, messages -----------------------------------

route('GET', /^\/api\/approvals$/, async (req, res) =>
  ok(res, { approvals: store.state.approvals.slice(0, 200) })
);

route('POST', /^\/api\/approvals\/([\w]+)\/resolve$/, async (req, res, [id]) => {
  const { decision, note = '' } = await readBody(req);
  if (!['approved', 'rejected'].includes(decision)) {
    return fail(res, 400, 'decision must be "approved" or "rejected"');
  }
  const result = resolveApproval(id, decision, { by: 'lord', note });
  if (!result.ok) return fail(res, 409, result.error);
  ok(res, result.approval);
});

/** Answer a question an agent put to Lord Marcos. */
route('POST', /^\/api\/approvals\/([\w]+)\/answer$/, async (req, res, [id]) => {
  const { answer } = await readBody(req);
  const result = answerQuestion(id, answer);
  if (!result.ok) return fail(res, 409, result.error);
  ok(res, result.approval);
});

route('POST', /^\/api\/approvals\/([\w]+)\/escalate$/, async (req, res, [id]) => {
  escalate(id, 'Called up by Lord Marcos.');
  ok(res);
});

route('POST', /^\/api\/notifications\/read$/, async (req, res) => {
  const { ids } = await readBody(req);
  const target = ids?.length ? new Set(ids) : null;
  for (const note of store.state.notifications) {
    if (!target || target.has(note.id)) note.read = true;
  }
  store.save();
  bus.emitEvent('notification.read', { ids: ids || 'all' });
  ok(res);
});

route('POST', /^\/api\/messages$/, async (req, res) => {
  const { toAgentId, subject, body } = await readBody(req);
  if (!store.agent(toAgentId)) return fail(res, 400, 'no such recipient');
  if (!body?.trim()) return fail(res, 400, 'a message needs words');

  const message = postMessage({
    fromAgentId: 'lord',
    toAgentId,
    subject: subject?.trim() || 'From Lord Marcos',
    body,
  });

  // Put it in front of them if they are at their desk; otherwise it waits,
  // and they are told to read it the moment they report for duty.
  const delivered = await deliverToAgent(toAgentId, message).catch(() => false);
  ok(res, { message, delivered });
});

// --- visiting sessions ----------------------------------------------------

/** Read the transcript of a session the office does not own. */
route('GET', /^\/api\/visitors\/([\w-]+)\/transcript$/, async (req, res, [sessionId]) => {
  try {
    const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
    const messages = await getSessionMessages(sessionId, { limit: 200 });
    ok(res, { activity: messages.map(transcriptToActivity).filter(Boolean) });
  } catch (err) {
    fail(res, 404, `could not read that session: ${err.message}`);
  }
});

/**
 * Take a session Lord Marcos started himself onto the payroll. The new agent
 * keeps the session id, so calling them to duty resumes that very conversation
 * rather than starting a fresh one.
 */
route('POST', /^\/api\/visitors\/([\w-]+)\/adopt$/, async (req, res, [sessionId]) => {
  const body = await readBody(req);
  if (!body.departmentId) return fail(res, 400, 'choose a department for them');

  // If the session was working in a directory we already call a project, post
  // them there; otherwise leave them unposted rather than inventing a project.
  const project = body.cwd
    ? store.state.projects.find(
        (p) => path.resolve(p.directory).toLowerCase() === path.resolve(body.cwd).toLowerCase()
      )
    : null;

  const result = createAgent({
    name: body.name?.trim() || 'Adopted',
    title: body.title?.trim() || 'Contractor',
    departmentId: body.departmentId,
    context:
      body.context ||
      'You were working as an independent session before Lord Marcos took you onto ' +
        'the payroll. Your prior conversation is your own memory of that work; carry ' +
        'on from it, but you now answer to this office and its chain of command.',
    model: body.model || 'sonnet',
    projectId: project?.id || null,
  });

  if (!result.ok) return fail(res, 400, result.error);

  result.agent.lastSessionId = sessionId;
  store.save();
  bus.emitEvent('agent.updated', result.agent);
  ok(res, result.agent);
});

/** Turn a stored transcript entry into the shape the activity feed renders. */
function transcriptToActivity(message) {
  const at = Date.parse(message.timestamp || '') || Date.now();
  const base = { id: message.uuid || newId('act_'), at, agentId: null };

  if (message.type === 'user') {
    const content = message.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return text.trim() ? { ...base, kind: 'order', text } : null;
  }

  if (message.type === 'assistant') {
    const blocks = message.message?.content || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (text.trim()) return { ...base, kind: 'say', text };

    const call = blocks.find((b) => b.type === 'tool_use');
    if (call) {
      return {
        ...base,
        kind: 'tool',
        toolName: call.name,
        text: summariseToolCall(call.name, call.input),
      };
    }
  }
  return null;
}

// --- components -----------------------------------------------------------

route('GET', /^\/api\/components$/, async (req, res) => {
  const projectDirs = store.state.projects.map((p) => p.directory).filter(Boolean);
  const [skills, mcpServers] = await Promise.all([
    availableSkills(projectDirs),
    availableMcpServers(projectDirs),
  ]);
  ok(res, { skills, mcpServers, registry: store.state.components });
});

const USER_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

/** Skill directory names must be a plain slug — they become a path and a tool name. */
function skillDir(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) return null;
  const dir = path.resolve(USER_SKILLS_DIR, name);
  // Belt and braces: never escape the skills directory.
  return dir.startsWith(path.resolve(USER_SKILLS_DIR)) ? dir : null;
}

/**
 * Install a skill into ~/.claude/skills. Every agent can then use it, and it
 * can be enabled or withheld per agent from their Configuration tab.
 */
route('POST', /^\/api\/components\/skills$/, async (req, res) => {
  const { name, description = '', content = '' } = await readBody(req);
  const slug = String(name || '').trim().toLowerCase();

  const dir = skillDir(slug);
  if (!dir) {
    return fail(
      res,
      400,
      'a skill name must be lower-case letters, digits and hyphens, e.g. "release-notes"'
    );
  }
  if (!description.trim()) {
    return fail(res, 400, 'a skill needs a description — it is how Claude decides to use it');
  }

  try {
    await fsp.access(dir);
    return fail(res, 409, `a skill called "${slug}" already exists`);
  } catch {
    /* good: it does not exist yet */
  }

  // Front matter must be literal YAML; quote anything that could break it.
  const yamlSafe = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const body =
    `---\nname: ${slug}\ndescription: ${yamlSafe(description.trim())}\n---\n\n` +
    (content.trim() || `# ${slug}\n\nDescribe here what this skill should do.\n`);

  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), body, 'utf8');

  bus.emitEvent('components.updated', {});
  ok(res, { name: slug, path: dir });
});

/** Remove a skill from disk. Only ever touches ~/.claude/skills. */
route('DELETE', /^\/api\/components\/skills\/([\w-]+)$/, async (req, res, [name]) => {
  const dir = skillDir(String(name).toLowerCase());
  if (!dir) return fail(res, 400, 'that is not a valid skill name');

  try {
    await fsp.access(path.join(dir, 'SKILL.md'));
  } catch {
    return fail(res, 404, `no skill called "${name}" is installed for your user`);
  }

  await fsp.rm(dir, { recursive: true, force: true });

  // Stop offering it to staff who had it enabled.
  for (const agent of store.state.agents) {
    if (agent.enabledSkills?.includes(name)) {
      agent.enabledSkills = agent.enabledSkills.filter((s) => s !== name);
    }
  }
  store.save();

  bus.emitEvent('components.updated', {});
  ok(res);
});

/** Read a skill's source, so it can be inspected or edited. */
route('GET', /^\/api\/components\/skills\/([\w-]+)$/, async (req, res, [name]) => {
  const dir = skillDir(String(name).toLowerCase());
  if (!dir) return fail(res, 400, 'that is not a valid skill name');
  try {
    ok(res, { name, content: await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8') });
  } catch {
    fail(res, 404, 'that skill is not installed for your user');
  }
});

route('POST', /^\/api\/components\/mcp$/, async (req, res) => {
  const body = await readBody(req);
  if (!body.name?.trim()) return fail(res, 400, 'an MCP server needs a name');
  if (!body.config || typeof body.config !== 'object') {
    return fail(res, 400, 'provide a config object');
  }
  const existing = store.state.components.mcpServers.find((m) => m.name === body.name);
  if (existing) existing.config = body.config;
  else store.state.components.mcpServers.push({ name: body.name.trim(), config: body.config });
  store.save();
  bus.emitEvent('components.updated', {});
  ok(res);
});

// --- auth & filesystem ----------------------------------------------------

route('GET', /^\/api\/auth$/, async (req, res) => ok(res, await authStatus()));

route('POST', /^\/api\/auth\/login$/, async (req, res) => {
  // Signing in is an interactive browser flow, so open a real terminal for it.
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', 'cmd', '/k', 'claude', 'auth', 'login'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', [
        '-e',
        'tell application "Terminal" to do script "claude auth login"',
        '-e',
        'tell application "Terminal" to activate',
      ], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', 'claude auth login'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
    ok(res, { launched: true });
  } catch (err) {
    fail(res, 500, `could not open a terminal: ${err.message}. Run "claude auth login" yourself.`);
  }
});

/** Browse directories, so a project can be picked without typing a path. */
route('GET', /^\/api\/fs$/, async (req, res, _m, url) => {
  const target = url.searchParams.get('path');
  const dir = target ? path.resolve(target) : os.homedir();
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    ok(res, {
      path: dir,
      parent: path.dirname(dir) === dir ? null : path.dirname(dir),
      directories: entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

// --- helpers --------------------------------------------------------------

function pick(source, keys) {
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

// --- server ---------------------------------------------------------------

export async function createServer() {
  await store.init();

  const reaped = reapStaleApprovals();
  if (reaped) console.log(`[office] cleared ${reaped} approval(s) abandoned by the last session`);

  // Tidy the floor plan on the way in, so a room closed by an older version —
  // which left a hole where it stood — does not leave the office gap-toothed.
  relayoutFloor();

  startWatchingExternalSessions();
  startScheduler();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = pathname.match(r.pattern);
      if (!match) continue;
      try {
        return await r.handler(req, res, match.slice(1), url);
      } catch (err) {
        console.error(`[api] ${req.method} ${pathname}`, err);
        if (!res.headersSent) return fail(res, 500, err.message);
        return res.end();
      }
    }
    fail(res, 404, `no route for ${req.method} ${pathname}`);
  });

  return server;
}

export async function shutdown() {
  await stopAll().catch(() => {});
  store.flushSync();
}
