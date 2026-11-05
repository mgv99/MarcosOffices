/**
 * The office floor at runtime.
 *
 * Each employed agent gets an `AgentWorker`, which holds one long-lived Claude
 * Agent SDK session in streaming-input mode. Orders from Lord Marcos, messages
 * from colleagues and scheduled rounds of work are all pushed into that same
 * session, so the agent keeps its context across a whole day of work.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { store, newId, emptyStats, LOGS_DIR } from './store.js';
import { bus } from './bus.js';
import { buildPersona } from './persona.js';
import { buildOfficeServer, setMessageDeliverer } from './office-tools.js';
import { buildHqServer } from './hq-tools.js';
import {
  requestApproval,
  setCeoAdjudicator,
  notify,
  cancelPendingFor,
} from './approvals.js';

const MAX_ACTIVITY_IN_MEMORY = 400;

/**
 * An async queue that doubles as the async-iterable prompt the SDK consumes.
 * Pushing a message delivers a new user turn to the live session.
 */
class TurnQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }

  push(message) {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
    return true;
  }

  close() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) {
        yield this.items.shift();
        continue;
      }
      if (this.closed) return;
      const next = await new Promise((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

export class AgentWorker {
  constructor(agentId) {
    this.agentId = agentId;
    this.queue = null;
    this.session = null;
    this.status = 'offline'; // offline | starting | idle | working | error
    this.sessionId = null;
    this.activity = [];
    this.pendingTurns = 0;
    this.startedAt = null;
    this.lastError = null;
    this.stopping = false;
    this._logStream = null;
  }

  get agent() {
    return store.agent(this.agentId);
  }

  setStatus(status, extra = {}) {
    if (this.status === status && !Object.keys(extra).length) return;
    this.status = status;
    bus.emitEvent('agent.status', {
      agentId: this.agentId,
      status,
      sessionId: this.sessionId,
      ...extra,
    });
  }

  log(kind, text, meta = {}) {
    const entry = {
      id: newId('act_'),
      agentId: this.agentId,
      at: Date.now(),
      kind,
      text,
      ...meta,
    };
    this.activity.push(entry);
    if (this.activity.length > MAX_ACTIVITY_IN_MEMORY) this.activity.shift();

    try {
      this._logStream ??= fs.createWriteStream(
        path.join(LOGS_DIR, `${this.agentId}.jsonl`),
        { flags: 'a' }
      );
      this._logStream.write(JSON.stringify(entry) + '\n');
    } catch {
      /* logging must never break the office */
    }

    bus.emitEvent('agent.activity', entry);
    return entry;
  }

  /**
   * Keep the agent's ledger. This is what lets the office answer "who is
   * costing me money" without anyone having to guess.
   */
  recordCost(message, ok) {
    const agent = this.agent;
    if (!agent) return;

    const stats = (agent.stats ??= emptyStats());
    stats.totalCostUsd += Number(message.total_cost_usd) || 0;
    stats.turns += Number(message.num_turns) || 0;
    stats.durationMs += Number(message.duration_ms) || 0;
    stats.tasks += 1;
    if (!ok) stats.errors += 1;
    stats.lastActiveAt = Date.now();

    const usage = message.usage || {};
    stats.inputTokens +=
      (Number(usage.input_tokens) || 0) +
      (Number(usage.cache_read_input_tokens) || 0) +
      (Number(usage.cache_creation_input_tokens) || 0);
    stats.outputTokens += Number(usage.output_tokens) || 0;

    store.save();
    bus.emitEvent('agent.stats', { agentId: this.agentId, stats });
  }

  /** Where this agent works. Falls back to the home directory. */
  resolveCwd() {
    const agent = this.agent;
    const project = agent?.projectId ? store.project(agent.projectId) : null;
    const dir = project?.directory;
    if (dir && fs.existsSync(dir)) return dir;
    if (dir) {
      this.log('system', `Assigned directory does not exist: ${dir}. Falling back to home.`);
    }
    return os.homedir();
  }

  buildOptions() {
    const agent = this.agent;
    const cwd = this.resolveCwd();

    // MCP servers: the office's own instruments, plus whatever Lord Marcos
    // has enabled for this particular agent.
    const mcpServers = { office: buildOfficeServer(this.agentId) };

    // Only staff trusted to run the company get the management instruments.
    if (agent.canManageOffice) {
      mcpServers.hq = buildHqServer(this.agentId, { workerStates: allWorkerStates });
    }

    for (const name of agent.enabledMcpServers || []) {
      const entry = (store.state.components.mcpServers || []).find((m) => m.name === name);
      if (entry?.config) mcpServers[name] = entry.config;
    }

    const options = {
      cwd,
      model: agent.model && agent.model !== 'inherit' ? agent.model : undefined,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildPersona(this.agentId),
      },
      title: `${agent.name} — ${agent.title}`,
      permissionMode: agent.permissionMode || 'default',
      mcpServers,
      settingSources: ['user', 'project'],
      includePartialMessages: false,
      canUseTool: this.makePermissionHandler(),
      hooks: {
        PreToolUse: [{ hooks: [this.makePreToolUseHook()] }],
      },
      stderr: (data) => {
        const line = String(data).trim();
        if (line && !isBenignNoise(line)) this.log('stderr', truncate(line, 400));
      },
    };

    if (agent.effort) options.effort = agent.effort;
    if (agent.allowedTools?.length) options.allowedTools = agent.allowedTools;
    if (agent.disallowedTools?.length) options.disallowedTools = agent.disallowedTools;
    if (agent.extraDirs?.length) options.additionalDirectories = agent.extraDirs;
    // An empty list means "no skills"; undefined means "load everything".
    if (Array.isArray(agent.enabledSkills) && agent.enabledSkills.length) {
      options.skills = agent.enabledSkills;
    }
    if (agent.lastSessionId && agent.resumeLastSession !== false) {
      options.resume = agent.lastSessionId;
    }

    return options;
  }

  /**
   * Put a tool call in front of the CEO or Lord Marcos and wait for a verdict.
   * Returns null when the office does not care to be asked.
   */
  async askLeave(toolName, input) {
    if (isHouseTool(toolName)) return null;

    const policy = this.agent?.approvalPolicy?.tools || 'lord';
    if (policy === 'auto') return null;

    const summary = summariseToolCall(toolName, input);
    this.setStatus('awaiting');
    this.log('approval', `Requests leave to use ${toolName}: ${summary}`, { toolName });

    try {
      const verdict = await requestApproval({
        agentId: this.agentId,
        kind: 'tool',
        title: `${toolName} — ${summary}`,
        detail: '```json\n' + safeJson(input) + '\n```',
        toolName,
        toolInput: input,
      });

      this.log(
        'approval',
        verdict.decision === 'approved'
          ? `Leave granted to use ${toolName}.`
          : `Leave to use ${toolName} was denied.`,
        { toolName }
      );
      return verdict;
    } finally {
      if (this.status === 'awaiting') this.setStatus('working');
    }
  }

  /**
   * The office's real gate.
   *
   * A PreToolUse hook fires for *every* tool call, before Claude Code consults
   * its own permission rules. `canUseTool` alone is not enough: anything the
   * user has already allowlisted in ~/.claude/settings.json would sail past it
   * and never reach the approval queue.
   */
  makePreToolUseHook() {
    return async (input) => {
      const verdict = await this.askLeave(input.tool_name, input.tool_input);
      if (!verdict) return {}; // office has no opinion; normal rules apply

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: verdict.decision === 'approved' ? 'allow' : 'deny',
          permissionDecisionReason:
            verdict.note ||
            (verdict.decision === 'approved'
              ? 'Sanctioned by the office.'
              : 'Refused by the office. Do not attempt this again; report back instead.'),
        },
      };
    };
  }

  /** A second line of defence, for anything that slips past the hook. */
  makePermissionHandler() {
    return async (toolName, input) => {
      const verdict = await this.askLeave(toolName, input);
      if (!verdict || verdict.decision === 'approved') {
        return { behavior: 'allow', updatedInput: input };
      }
      return {
        behavior: 'deny',
        message:
          verdict.note ||
          'Permission was refused. Do not attempt this again; report back instead.',
      };
    };
  }

  async start() {
    if (this.session) return;
    const agent = this.agent;
    if (!agent) throw new Error('no such agent');

    this.stopping = false;
    this.queue = new TurnQueue();
    this.setStatus('starting');
    this.startedAt = Date.now();
    this.lastError = null;

    try {
      this.session = query({ prompt: this.queue, options: this.buildOptions() });
    } catch (err) {
      this.setStatus('error');
      this.lastError = err.message;
      this.log('error', `Could not report for duty: ${err.message}`);
      throw err;
    }

    this.log('system', `${agent.name} reports for duty.`);
    this._consume();
    this.setStatus('idle');

    // Anything a colleague sent while this agent was off duty.
    const unread = store.state.messages.filter(
      (m) => m.toAgentId === this.agentId && !m.read
    ).length;
    if (unread) {
      this.log('system', `${unread} unread message(s) waiting in the inbox.`);
    }
  }

  /** Drain the SDK's message stream into the activity feed. */
  async _consume() {
    try {
      for await (const message of this.session) {
        this._handleMessage(message);
      }
    } catch (err) {
      if (!this.stopping) {
        this.lastError = err.message;
        this.log('error', `Session failed: ${err.message}`);
        this.setStatus('error');
        notify({
          kind: 'error',
          title: `${this.agent?.name || 'An agent'} has collapsed`,
          body: err.message,
          agentId: this.agentId,
        });
      }
    } finally {
      this.session = null;
      if (!this.stopping) this.setStatus('offline');
    }
  }

  _handleMessage(message) {
    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init') {
          this.sessionId = message.session_id || this.sessionId;
          const agent = this.agent;
          if (agent && this.sessionId) {
            agent.lastSessionId = this.sessionId;
            store.save();
          }
          this.setStatus(this.pendingTurns > 0 ? 'working' : 'idle');
        }
        break;
      }

      case 'assistant': {
        const content = message.message?.content || [];
        for (const block of content) {
          if (block.type === 'text' && block.text?.trim()) {
            this.log('say', block.text, { subagent: message.agent_id || null });
          } else if (block.type === 'thinking' && block.thinking?.trim()) {
            this.log('thinking', block.thinking, { subagent: message.agent_id || null });
          } else if (block.type === 'tool_use') {
            this.log('tool', summariseToolCall(block.name, block.input), {
              toolName: block.name,
              subagent: message.agent_id || null,
            });
          }
        }
        break;
      }

      case 'result': {
        this.pendingTurns = Math.max(0, this.pendingTurns - 1);
        const ok = message.subtype === 'success';
        this.recordCost(message, ok);
        this.log('result', ok ? 'Task complete.' : `Task ended: ${message.subtype}`, {
          cost: message.total_cost_usd,
          turns: message.num_turns,
          durationMs: message.duration_ms,
          ok,
        });
        this.setStatus(this.pendingTurns > 0 ? 'working' : 'idle');

        if (this.pendingTurns === 0) {
          notify({
            kind: 'done',
            title: `${this.agent?.name || 'An agent'} has finished`,
            body: lastSaid(this.activity),
            agentId: this.agentId,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  /** Give the agent a new turn of work. */
  send(text, { from = 'lord' } = {}) {
    if (!this.session || !this.queue) throw new Error('agent is not on duty');
    this.pendingTurns++;
    this.setStatus('working');
    this.log('order', text, { from });
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    return true;
  }

  async interrupt() {
    try {
      await this.session?.interrupt?.();
      this.pendingTurns = 0;
      this.log('system', 'Work interrupted by order of Lord Marcos.');
      this.setStatus('idle');
    } catch (err) {
      this.log('error', `Could not interrupt: ${err.message}`);
    }
  }

  async stop() {
    this.stopping = true;
    cancelPendingFor(this.agentId, 'The agent left their post.');
    try {
      this.queue?.close();
      await this.session?.interrupt?.().catch(() => {});
    } catch {}
    this.session = null;
    this.pendingTurns = 0;
    this._logStream?.end();
    this._logStream = null;
    this.log('system', 'Left their post.');
    this.setStatus('offline');
  }
}

// --- the floor --------------------------------------------------------------

/** agentId -> AgentWorker */
const workers = new Map();

export function workerFor(agentId, { create = true } = {}) {
  let worker = workers.get(agentId);
  if (!worker && create) {
    worker = new AgentWorker(agentId);
    workers.set(agentId, worker);
  }
  return worker || null;
}

export function workerState(agentId) {
  const worker = workers.get(agentId);
  if (!worker) return { status: 'offline', sessionId: null, pendingTurns: 0 };
  return {
    status: worker.status,
    sessionId: worker.sessionId,
    pendingTurns: worker.pendingTurns,
    startedAt: worker.startedAt,
    lastError: worker.lastError,
  };
}

export function allWorkerStates() {
  const out = {};
  for (const agent of store.state.agents) out[agent.id] = workerState(agent.id);
  return out;
}

export function activityFor(agentId, limit = 200) {
  const worker = workers.get(agentId);
  if (!worker) return [];
  return worker.activity.slice(-limit);
}

export async function hireOn(agentId) {
  const worker = workerFor(agentId);
  if (worker.status === 'offline' || worker.status === 'error') await worker.start();
  return workerState(agentId);
}

export async function dismiss(agentId) {
  const worker = workers.get(agentId);
  if (worker) await worker.stop();
  return workerState(agentId);
}

export async function order(agentId, text) {
  const worker = workerFor(agentId);
  if (!worker.session) await worker.start();
  worker.send(text, { from: 'lord' });
  return workerState(agentId);
}

export async function stopAll() {
  await Promise.all([...workers.values()].map((w) => w.stop().catch(() => {})));
}

/**
 * Deliver a colleague's message into a live session, so staff who are on duty
 * actually notice each other rather than only finding mail later.
 */
setMessageDeliverer(async (toAgentId, message) => {
  const worker = workers.get(toAgentId);
  if (!worker?.session) return false;

  const from = store.agent(message.fromAgentId);
  worker.send(
    `[INTERNAL MAIL] From ${from ? `${from.name} (${from.title})` : 'a colleague'} — ` +
      `Subject: ${message.subject}\n\n${message.body}\n\n` +
      `Handle this as your post requires. If it needs no action, say so briefly.`,
    { from: 'agent' }
  );
  // It has been put in front of them; no need for them to find it again.
  message.read = true;
  store.save();
  return true;
});

/**
 * Ask the CEO to rule on a proposal. This runs as a short, isolated one-shot
 * query with no office tools, so an adjudication can never recurse into
 * another adjudication.
 */
setCeoAdjudicator(async (approval) => {
  const ceo = store.ceo();
  if (!ceo) return { decision: 'escalate', note: 'This office has no CEO.' };

  const petitioner = store.agent(approval.agentId);
  const lord = store.state.office.lordName || 'Lord Marcos';

  const prompt =
    `A member of your staff has submitted a proposal for your approval.\n\n` +
    `From: ${petitioner?.name} (${petitioner?.title})\n` +
    `Proposal: ${approval.title}\n\n${approval.detail}\n\n` +
    `Stated risk: ${approval.risk || '(none stated)'}\n\n` +
    `Rule on it now. Reply with EXACTLY one line of JSON and nothing else:\n` +
    `{"decision":"approved"|"rejected"|"escalate","note":"one or two sentences"}\n\n` +
    `Choose "escalate" only if this is genuinely a matter reserved to ${lord}: ` +
    `irreversible destruction, money, his personal affairs, or a change of direction ` +
    `that is his to set.`;

  let text = '';
  const session = query({
    prompt,
    options: {
      model: ceo.model && ceo.model !== 'inherit' ? ceo.model : undefined,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: buildPersona(ceo.id) },
      // An adjudication is pure judgement: no tools, no side effects.
      allowedTools: [],
      permissionMode: 'dontAsk',
      maxTurns: 1,
      settingSources: [],
      persistSession: false,
    },
  });

  for await (const message of session) {
    if (message.type === 'assistant') {
      for (const block of message.message?.content || []) {
        if (block.type === 'text') text += block.text;
      }
    }
  }

  const ruling = parseRuling(text);
  bus.emitEvent('approval.ceo-ruling', { approvalId: approval.id, ...ruling });
  return ruling;
});

function parseRuling(text) {
  const match = text.match(/\{[\s\S]*?\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (['approved', 'rejected', 'escalate'].includes(parsed.decision)) {
        return { decision: parsed.decision, note: String(parsed.note || '').slice(0, 500) };
      }
    } catch {}
  }
  // An unreadable ruling is not a licence to act.
  return {
    decision: 'escalate',
    note: 'The CEO did not return a readable verdict.',
  };
}

// --- helpers ----------------------------------------------------------------

/**
 * Chatter that Claude Code writes to stderr on a healthy run — corporate CA
 * bundles, Node deprecations and the like. It is not an agent's problem, and
 * it drowns the activity feed, so keep it out of the office record.
 */
const BENIGN_STDERR = [
  /ignored the certificate with SHA-256 fingerprint/i,
  /NODE_EXTRA_CA_CERTS/,
  /DeprecationWarning/,
  /ExperimentalWarning/,
  /--trace-(deprecation|warnings)/,
];

function isBenignNoise(line) {
  return BENIGN_STDERR.some((pattern) => pattern.test(line));
}

/**
 * Tools that only affect the agent's own context and reach nothing outside the
 * session. Asking Lord Marcos to sanction these spends his attention for
 * nothing: ToolSearch merely loads tool schemas, TodoWrite is the agent's own
 * scratch list.
 */
const UNGATED_TOOLS = new Set(['ToolSearch', 'TodoWrite']);

/**
 * Whether a tool bypasses the approval hook.
 *
 * `office` tools must: `request_approval` asking for approval of itself would
 * deadlock the agent instantly. `hq` tools must too: they raise their own
 * proposal before changing anything, so gating them here would ask twice.
 */
function isHouseTool(toolName) {
  const name = String(toolName || '');
  return (
    name.startsWith('mcp__office__') ||
    name.startsWith('mcp__hq__') ||
    UNGATED_TOOLS.has(name)
  );
}

function safeJson(value) {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 4000 ? text.slice(0, 4000) + '\n… (truncated)' : text;
  } catch {
    return String(value);
  }
}

function summariseToolCall(name, input = {}) {
  const i = input || {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return truncate(i.command || '', 160);
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return truncate(i.file_path || i.notebook_path || '', 160);
    case 'Grep':
      return truncate(`/${i.pattern || ''}/ in ${i.path || '.'}`, 160);
    case 'Glob':
      return truncate(i.pattern || '', 160);
    case 'WebFetch':
    case 'WebSearch':
      return truncate(i.url || i.query || '', 160);
    case 'Agent':
      return truncate(i.description || '', 160);
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string');
      return truncate(first || name, 160);
    }
  }
}

function truncate(text, n) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function lastSaid(activity) {
  for (let i = activity.length - 1; i >= 0; i--) {
    if (activity[i].kind === 'say') return truncate(activity[i].text, 200);
  }
  return '';
}

export { summariseToolCall };
