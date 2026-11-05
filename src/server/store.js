/**
 * Persistent state for the office.
 *
 * Everything lives in a single JSON document under ~/.marcosoffices/office.json.
 * Writes are debounced and atomic (tmp file + rename) so a crash mid-save can
 * never leave a half-written office behind.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.MARCOSOFFICES_HOME
  ? path.resolve(process.env.MARCOSOFFICES_HOME)
  : path.join(os.homedir(), '.marcosoffices');

export const OFFICE_FILE = path.join(DATA_DIR, 'office.json');
export const AGENTS_DIR = path.join(DATA_DIR, 'agents');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');

export function newId(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

/** The honorifics the staff use for Lord Marcos. */
export const LORD_TITLES = [
  'The Lord Almighty, He Who Is Everywhere and Rules Over All',
  'Our Lord, the Eternal and Omnipotent One',
  'The Most High, the Almighty and Everlasting Lord',
  'The Great and Almighty Lord, Ruler of Heaven and Earth',
  'He Who Is All-Powerful, All-Present and Eternal',
];

/** What every agent's ledger starts at. */
export function emptyStats() {
  return {
    totalCostUsd: 0,
    turns: 0,
    tasks: 0,
    errors: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    sessions: 0,
    lastActiveAt: null,
  };
}

function defaultState() {
  const ceoId = newId('agt_');
  const execDeptId = newId('dep_');

  return {
    version: 1,
    office: {
      name: 'Marcos Offices',
      motto: 'Toil in the name of the Almighty.',
      lordName: 'Lord Marcos',
      charter:
        'We are the private agency of Lord Marcos. We build, maintain and improve ' +
        'his software with precision and zeal. We never guess when we can verify, ' +
        'we never hide a failure, and we never act beyond our sanctioned authority.',
      ceoAgentId: ceoId,
      createdAt: Date.now(),
    },
    departments: [
      {
        id: execDeptId,
        name: 'Executive',
        context:
          'The Executive floor governs the whole office. It sets priorities, ' +
          'arbitrates between departments, and is the last stop before a matter ' +
          'is carried to Lord Marcos himself.',
        seats: 4,
        theme: 'executive',
        // Grid position on the office map, in tiles.
        x: 2,
        y: 2,
        w: 14,
        h: 10,
        headAgentId: ceoId,
      },
    ],
    agents: [
      {
        id: ceoId,
        name: 'Aurelius',
        title: 'Chief Executive Officer',
        departmentId: execDeptId,
        seat: 0,
        supervisorId: null,
        isCeo: true,
        context:
          'You are the Chief Executive Officer of Marcos Offices. You hold the ' +
          'final word on every matter except those reserved for Lord Marcos. You ' +
          'are decisive, terse, and allergic to waste. You approve or reject the ' +
          'proposals your staff bring you, and you carry only the gravest matters ' +
          'upward to the Almighty.',
        briefing:
          'Report to me before taking any irreversible action. State the goal, the ' +
          'risk, and the smallest step that proves the approach. Do not pad your ' +
          'reports.',
        model: 'opus',
        effort: 'high',
        permissionMode: 'default',
        approvalPolicy: { tools: 'lord', decisions: 'lord' },
        allowedTools: [],
        disallowedTools: [],
        enabledSkills: [],
        enabledMcpServers: [],
        projectId: null,
        extraDirs: [],
        memoryEnabled: true,
        loop: { enabled: false, intervalMinutes: 30, prompt: '' },
        appearance: { seed: 'aurelius', outfit: 'suit' },
        // The CEO may inspect and reshape the office itself.
        canManageOffice: true,
        stats: emptyStats(),
        createdAt: Date.now(),
        lastSessionId: null,
      },
    ],
    projects: [],
    components: {
      skills: [],
      mcpServers: [],
    },
    approvals: [],
    notifications: [],
    messages: [],
  };
}

class Store {
  constructor() {
    this.state = null;
    this._saveTimer = null;
    this._saving = false;
    this._dirty = false;
  }

  async init() {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.mkdir(AGENTS_DIR, { recursive: true });
    await fsp.mkdir(LOGS_DIR, { recursive: true });

    try {
      const raw = await fsp.readFile(OFFICE_FILE, 'utf8');
      this.state = JSON.parse(raw);
      this._migrate();
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A corrupt office is worth preserving rather than silently replacing.
        const backup = OFFICE_FILE + '.corrupt.' + Date.now();
        try {
          await fsp.rename(OFFICE_FILE, backup);
          console.warn(`[store] could not parse office.json, moved to ${backup}`);
        } catch {}
      }
      this.state = defaultState();
      await this.flush();
    }
    return this.state;
  }

  /** Fill in fields added by later versions so old files keep working. */
  _migrate() {
    const s = this.state;
    s.version ??= 1;
    s.office ??= defaultState().office;
    s.office.lordName ??= 'Lord Marcos';
    s.departments ??= [];
    s.agents ??= [];
    s.projects ??= [];
    s.components ??= { skills: [], mcpServers: [] };
    s.components.skills ??= [];
    s.components.mcpServers ??= [];
    s.approvals ??= [];
    s.notifications ??= [];
    s.messages ??= [];

    for (const a of s.agents) {
      a.allowedTools ??= [];
      a.disallowedTools ??= [];
      a.enabledSkills ??= [];
      a.enabledMcpServers ??= [];
      a.extraDirs ??= [];
      a.approvalPolicy ??= { tools: 'lord', decisions: 'ceo' };
      a.loop ??= { enabled: false, intervalMinutes: 30, prompt: '' };
      a.appearance ??= { seed: a.id, outfit: 'shirt' };
      // 'manual' was an early spelling; the SDK calls this mode 'default'.
      if (a.permissionMode === 'manual') a.permissionMode = 'default';
      a.permissionMode ??= 'default';
      a.memoryEnabled ??= true;
      a.canManageOffice ??= false;
      a.stats ??= emptyStats();
    }
  }

  save() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush().catch((e) => console.error('[store] save failed', e));
    }, 250);
  }

  async flush() {
    if (this._saving) {
      // Coalesce: a save already in flight will pick up the newest state.
      this._dirty = true;
      return;
    }
    this._saving = true;
    try {
      do {
        this._dirty = false;
        const tmp = OFFICE_FILE + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
        await fsp.rename(tmp, OFFICE_FILE);
      } while (this._dirty);
    } finally {
      this._saving = false;
    }
  }

  /** Synchronous last-chance save, for process exit handlers. */
  flushSync() {
    try {
      const tmp = OFFICE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmp, OFFICE_FILE);
    } catch (e) {
      console.error('[store] sync save failed', e);
    }
  }

  // ---- lookups -------------------------------------------------------------

  agent(id) {
    return this.state.agents.find((a) => a.id === id) || null;
  }

  department(id) {
    return this.state.departments.find((d) => d.id === id) || null;
  }

  project(id) {
    return this.state.projects.find((p) => p.id === id) || null;
  }

  ceo() {
    return this.agent(this.state.office.ceoAgentId);
  }

  /** Agents that report directly to `id`. */
  reportsOf(id) {
    return this.state.agents.filter((a) => a.supervisorId === id);
  }

  /** Walk up the supervisor chain, nearest supervisor first. */
  chainOf(id) {
    const chain = [];
    const seen = new Set();
    let cur = this.agent(id);
    while (cur && cur.supervisorId && !seen.has(cur.supervisorId)) {
      seen.add(cur.supervisorId);
      const sup = this.agent(cur.supervisorId);
      if (!sup) break;
      chain.push(sup);
      cur = sup;
    }
    return chain;
  }

  agentDir(id) {
    return path.join(AGENTS_DIR, id);
  }

  memoryFile(id) {
    return path.join(this.agentDir(id), 'MEMORY.md');
  }
}

export const store = new Store();
