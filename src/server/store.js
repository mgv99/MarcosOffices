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

    this._migrateLegacyMemory();
    this.migrateAgentLogs();
    return this.state;
  }

  /**
   * Memory used to be one flat MEMORY.md per agent. Fold any left over into
   * the topic layout as 'general', once, at start-up — otherwise an agent who
   * has not been called to duty since the change looks like they remember
   * nothing.
   */
  _migrateLegacyMemory() {
    for (const agent of this.state.agents) {
      const legacy = path.join(this.agentDir(agent.id), 'MEMORY.md');
      const general = this.memoryFile(agent.id, 'general');
      try {
        if (!fs.existsSync(legacy) || fs.existsSync(general)) continue;
        fs.mkdirSync(this.memoryDir(agent.id), { recursive: true });
        fs.renameSync(legacy, general);
        console.log(`[store] moved ${agent.name}'s memory into topic "general"`);
      } catch {
        /* leave it where it is rather than lose it */
      }
    }
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

    // Staff dismissed before departures were tidied up can leave references
    // behind: a department headed by someone who has gone, or an agent
    // reporting to one. Clear them, or the office describes a hierarchy that
    // does not exist.
    const present = new Set(s.agents.map((a) => a.id));
    for (const d of s.departments) {
      if (d.headAgentId && !present.has(d.headAgentId)) d.headAgentId = null;
    }
    for (const a of s.agents) {
      if (a.supervisorId && !present.has(a.supervisorId)) {
        a.supervisorId = a.isCeo ? null : s.office.ceoAgentId || null;
      }
    }

    // Rooms used to be laid out without a head of department's desk at the
    // front. Grow the old ones so the new seating plan fits inside them.
    for (const d of s.departments) {
      d.headAgentId ??= null;
      // The CEO's suite is deliberately small and single-seated; growing it
      // to the standard room size would put it on top of the floor below.
      if (d.isCeoOffice) continue;
      if ((d.h || 0) < 16) d.h = 16;
      if ((d.w || 0) < 14) d.w = 14;
      if ((d.seats || 0) < 9) d.seats = 9;
    }

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
      // The CEO runs the company by definition; an office created before this
      // field existed would otherwise leave them without the instruments to
      // do it, able only to talk.
      a.canManageOffice = a.isCeo ? true : (a.canManageOffice ?? false);
      a.stats ??= emptyStats();
      // Every conversation this agent has held, newest last.
      a.sessions ??= a.lastSessionId
        ? [{ id: a.lastSessionId, startedAt: a.createdAt || Date.now(), title: 'Session 1' }]
        : [];
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

  /**
   * Each conversation keeps its own record, so switching sessions shows that
   * session's chat and a fresh one starts empty.
   */
  sessionLogFile(agentId, sessionId) {
    if (!sessionId) return null;
    const dir = path.resolve(LOGS_DIR, agentId);
    const file = path.resolve(dir, `${String(sessionId).replace(/[^\w-]/g, '')}.jsonl`);
    return file.startsWith(dir) ? file : null;
  }

  /**
   * Records used to be one flat file per agent, covering every conversation
   * at once. Attribute an old one to the session it belonged to, so existing
   * history survives rather than appearing under every session.
   */
  migrateAgentLogs() {
    for (const agent of this.state.agents) {
      const legacy = path.join(LOGS_DIR, `${agent.id}.jsonl`);
      const target = this.sessionLogFile(agent.id, agent.lastSessionId);
      try {
        if (!target || !fs.existsSync(legacy) || fs.existsSync(target)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(legacy, target);
      } catch {
        /* leave it rather than lose it */
      }
    }
  }

  /** Where an agent's memory files live, one per topic. */
  memoryDir(id) {
    return path.join(this.agentDir(id), 'memory');
  }

  /** Topic names become file names, so keep them to a plain slug. */
  memoryFile(id, topic = 'general') {
    const slug = String(topic).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return null;
    const file = path.resolve(this.memoryDir(id), `${slug}.md`);
    return file.startsWith(path.resolve(this.memoryDir(id))) ? file : null;
  }

  /** Every memory topic an agent holds. */
  memoryTopics(id) {
    try {
      return fs
        .readdirSync(this.memoryDir(id))
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Make sure an agent has somewhere to remember things, and migrate the old
   * single MEMORY.md into the topic-based layout if one is left over.
   */
  ensureMemoryFile(id, topic = 'general') {
    const agent = this.agent(id);
    if (!agent) return null;

    const file = this.memoryFile(id, topic);
    if (!file) return null;

    try {
      fs.mkdirSync(this.memoryDir(id), { recursive: true });

      // One flat MEMORY.md was the old shape; fold it in as 'general'.
      const legacy = path.join(this.agentDir(id), 'MEMORY.md');
      const general = this.memoryFile(id, 'general');
      if (fs.existsSync(legacy) && !fs.existsSync(general)) {
        fs.renameSync(legacy, general);
      }

      if (!fs.existsSync(file)) {
        fs.writeFileSync(
          file,
          `# ${agent.name} — ${topic}\n\n` +
            `What I have chosen to remember about ${topic}. Written by me with the\n` +
            `\`remember\` tool, and readable by ${this.state.office.lordName || 'Lord Marcos'}.\n\n`,
          'utf8'
        );
      }
      return file;
    } catch {
      return null;
    }
  }

  /** Everything an agent remembers, as one block for their system prompt. */
  readAllMemory(id, { limit = 20000 } = {}) {
    const parts = [];
    for (const topic of this.memoryTopics(id)) {
      try {
        const body = fs.readFileSync(this.memoryFile(id, topic), 'utf8').trim();
        // Skip files that only carry the generated header.
        const lines = body.split('\n').filter((l) => l.trim().startsWith('-'));
        if (lines.length) parts.push(`### ${topic}\n${lines.join('\n')}`);
      } catch {}
    }
    return parts.join('\n\n').slice(0, limit);
  }
}

export const store = new Store();
