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
  seedOffice,
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
  ok(res, result);
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
  ok(res, { activity: activityFor(id, 300) })
);

route('GET', /^\/api\/agents\/([\w]+)\/memory$/, async (req, res, [id]) => {
  try {
    ok(res, { content: await fsp.readFile(store.memoryFile(id), 'utf8') });
  } catch {
    ok(res, { content: '' });
  }
});

route('PUT', /^\/api\/agents\/([\w]+)\/memory$/, async (req, res, [id]) => {
  if (!store.agent(id)) return fail(res, 404, 'no such agent');
  const { content = '' } = await readBody(req);
  await fsp.mkdir(store.agentDir(id), { recursive: true });
  await fsp.writeFile(store.memoryFile(id), content, 'utf8');
  bus.emitEvent('agent.memory', { agentId: id });
  ok(res);
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
  ok(res, postMessage({ fromAgentId: 'lord', toAgentId, subject, body }));
});

// --- components -----------------------------------------------------------

route('GET', /^\/api\/components$/, async (req, res) => {
  const projectDirs = store.state.projects.map((p) => p.directory).filter(Boolean);
  const [skills, mcpServers] = await Promise.all([
    availableSkills(projectDirs),
    availableMcpServers(projectDirs),
  ]);
  ok(res, { skills, mcpServers, registry: store.state.components });
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
