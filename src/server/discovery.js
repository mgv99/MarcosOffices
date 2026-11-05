/**
 * Looks outward: what Claude sessions are already running on this machine,
 * whether Lord Marcos is signed in, and which skills and MCP servers exist to
 * be handed out to staff.
 *
 * Sessions running outside the office are shown as "visitors" — Claude
 * sessions Lord Marcos started himself in a terminal. We can watch them, but
 * we do not command them.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { bus } from './bus.js';

const CLAUDE_HOME = path.join(os.homedir(), '.claude');

/**
 * Run the `claude` CLI and return stdout.
 *
 * On Windows `claude` is a .cmd/.ps1 shim, which bare spawn cannot execute, so
 * go through cmd.exe explicitly rather than `shell: true` — that keeps the
 * arguments as a real argv instead of a concatenated string.
 */
function runClaude(args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const [command, argv] =
      process.platform === 'win32' ? ['cmd.exe', ['/c', 'claude', ...args]] : ['claude', args];

    const child = spawn(command, argv, {
      windowsHide: true,
      timeout,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      // `claude auth status` and friends print JSON on stdout even when the
      // exit code is non-zero, so prefer parseable output over the code.
      if (out.trim()) resolve(out);
      else if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `claude ${args.join(' ')} exited ${code}`));
    });
  });
}

function firstJson(text) {
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  // Fall back to the first JSON array/object embedded in the output.
  const match = trimmed.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {}
  }
  return null;
}

/**
 * Sessions currently alive on this machine, from `claude agents --json`.
 * The exact field names have varied between CLI versions, so read defensively.
 */
export async function externalSessions() {
  try {
    const raw = await runClaude(['agents', '--json']);
    const parsed = firstJson(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((s) => ({
      sessionId: s.sessionId || s.session_id || s.id || null,
      pid: s.pid ?? null,
      name: s.name || s.title || null,
      cwd: s.cwd || s.directory || null,
      kind: s.kind || s.type || 'interactive',
      status: normaliseStatus(s.status),
      startedAt: toMillis(s.startedAt ?? s.started_at ?? s.createdAt ?? s.created_at),
      model: s.model || null,
    }));
  } catch (err) {
    return [];
  }
}

function normaliseStatus(status) {
  const s = String(status || '').toLowerCase();
  if (['busy', 'running', 'working'].includes(s)) return 'busy';
  if (['idle', 'waiting', 'ready'].includes(s)) return 'idle';
  if (['stopped', 'exited', 'completed', 'done'].includes(s)) return 'stopped';
  return s || 'unknown';
}

function toMillis(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function authStatus() {
  try {
    const raw = await runClaude(['auth', 'status']);
    const parsed = firstJson(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return { loggedIn: /logged in|authenticated/i.test(raw), raw: raw.trim().slice(0, 400) };
  } catch (err) {
    return { loggedIn: false, error: err.message };
  }
}

/** Read `name` and `description` out of a SKILL.md front-matter block. */
function parseSkillFrontmatter(text, fallbackName) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const result = { name: fallbackName, description: '' };
  if (!match) return result;

  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim().replace(/^["']|["']$/g, '');
    if (kv[1] === 'name' && value) result.name = value;
    if (kv[1] === 'description') result.description = value;
  }
  return result;
}

async function scanSkillDir(dir, source) {
  const found = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    try {
      const text = await fsp.readFile(file, 'utf8');
      const meta = parseSkillFrontmatter(text, entry.name);
      found.push({
        name: meta.name,
        description: meta.description.slice(0, 300),
        source,
        path: path.join(dir, entry.name),
      });
    } catch {
      /* not a skill directory */
    }
  }
  return found;
}

/** Skills installed for the user, plus any inside a project directory. */
export async function availableSkills(projectDirs = []) {
  const found = await scanSkillDir(path.join(CLAUDE_HOME, 'skills'), 'user');

  for (const dir of projectDirs) {
    if (!dir) continue;
    found.push(...(await scanSkillDir(path.join(dir, '.claude', 'skills'), 'project')));
  }

  // De-duplicate by name, preferring the first (user) definition.
  const seen = new Map();
  for (const skill of found) if (!seen.has(skill.name)) seen.set(skill.name, skill);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** MCP servers configured for the user, readable from ~/.claude.json. */
export async function availableMcpServers(projectDirs = []) {
  const found = [];

  const pushFrom = (servers, source) => {
    for (const [name, config] of Object.entries(servers || {})) {
      found.push({
        name,
        source,
        transport: config.type || (config.url ? 'http' : 'stdio'),
        summary: config.command
          ? `${config.command} ${(config.args || []).join(' ')}`.trim()
          : config.url || '',
        config,
      });
    }
  };

  try {
    const raw = await fsp.readFile(path.join(os.homedir(), '.claude.json'), 'utf8');
    const parsed = JSON.parse(raw);
    pushFrom(parsed.mcpServers, 'user');
  } catch {}

  for (const dir of projectDirs) {
    if (!dir) continue;
    try {
      const raw = await fsp.readFile(path.join(dir, '.mcp.json'), 'utf8');
      pushFrom(JSON.parse(raw).mcpServers, 'project');
    } catch {}
  }

  const seen = new Map();
  for (const server of found) if (!seen.has(server.name)) seen.set(server.name, server);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// --- polling ----------------------------------------------------------------

let timer = null;
let lastSignature = '';

export function startWatchingExternalSessions(intervalMs = 5000) {
  const tick = async () => {
    const sessions = await externalSessions();
    const signature = JSON.stringify(
      sessions.map((s) => [s.sessionId, s.status, s.name]).sort()
    );
    if (signature !== lastSignature) {
      lastSignature = signature;
      bus.emitEvent('visitors', sessions);
    }
  };

  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function stopWatchingExternalSessions() {
  if (timer) clearInterval(timer);
  timer = null;
}
