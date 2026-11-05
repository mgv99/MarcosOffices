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
import { randomUUID } from 'node:crypto';
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

import { store, newId, emptyStats, LOGS_DIR } from './store.js';
import { bus } from './bus.js';
import { buildPersona } from './persona.js';
import {
  buildOfficeServer,
  setMessageDeliverer,
  setMilestoneRecorder,
} from './office-tools.js';
import { buildHqServer } from './hq-tools.js';
import {
  requestApproval,
  setCeoAdjudicator,
  notify,
  cancelPendingFor,
} from './approvals.js';
import { setOwnershipTest } from './discovery.js';
import { setAgentStopper } from './operations.js';

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
    this.todos = [];
    this.commands = [];
    // Guards against looping if a fresh session also fails to start.
    this._resumeRetried = false;
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
   * Remember the agent's current plan, and announce the steps that changed.
   *
   * Claude Code keeps a running task list; treating a step moving to
   * "in_progress" or "completed" as a milestone gives the Activity view
   * something meaningful to show instead of raw tool traffic.
   */
  recordTodos(input) {
    const todos = Array.isArray(input?.todos) ? input.todos : [];
    if (!todos.length) return;

    const before = new Map(this.todos.map((t) => [t.content, t.status]));

    for (const todo of todos) {
      const was = before.get(todo.content);
      if (was === todo.status) continue;

      if (todo.status === 'in_progress') {
        this.log('milestone', todo.activeForm || todo.content, { step: 'started' });
      } else if (todo.status === 'completed') {
        this.log('milestone', todo.content, { step: 'done' });
      }
    }

    this.todos = todos.map((t) => ({
      content: t.content,
      status: t.status,
      activeForm: t.activeForm || null,
    }));
    bus.emitEvent('agent.todos', { agentId: this.agentId, todos: this.todos });
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

  /**
   * Decide whether the agent's previous conversation can actually be resumed.
   *
   * A session that was called to duty and sent home without ever taking a turn
   * is never written to disk, so resuming it fails with "No conversation found
   * with session ID". Check before asking rather than collapsing afterwards.
   */
  async resolveResume() {
    const agent = this.agent;
    const previous = agent?.lastSessionId;
    if (!previous || agent.resumeLastSession === false) return null;

    try {
      const messages = await getSessionMessages(previous, { limit: 1 });
      if (Array.isArray(messages) && messages.length) return previous;
    } catch {
      /* unreadable means unresumable */
    }

    this.log(
      'system',
      'Their previous conversation could not be found, so they begin a fresh one. ' +
        'Their memory and standing orders are unaffected.'
    );
    agent.lastSessionId = null;
    store.save();
    return null;
  }

  buildOptions(resumeId = null) {
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
    // Decide the session id now rather than waiting for the `init` message.
    // The SDK only emits that after the first turn, which left newly hired
    // staff briefly unidentifiable — and so listed a second time in the lobby
    // as visiting sessions.
    //
    // `lastSessionId` is deliberately NOT written here: a session that never
    // takes a turn is never persisted by Claude Code, and recording its id
    // would make the next call to duty try to resume a conversation that does
    // not exist. It is saved once the session is real, on `init`.
    if (resumeId) {
      options.resume = resumeId;
      this.sessionId = resumeId;
    } else {
      const fresh = randomUUID();
      options.sessionId = fresh;
      this.sessionId = fresh;
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
  /**
   * The agent called Claude Code's own AskUserQuestion. There is no way for a
   * hook to hand a tool its result, so put the question to Lord Marcos through
   * the office's queue and give the answer back in the decision reason. The
   * wording matters: the agent must read it as an answer, not a refusal.
   */
  async answerAskUserQuestion(input) {
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    const answers = [];

    for (const q of questions.slice(0, 4)) {
      const verdict = await requestApproval({
        agentId: this.agentId,
        kind: 'question',
        title: q.question || q.header || 'A question for you',
        detail: q.header ? `**${q.header}**` : '',
        options: (q.options || []).map((o) => ({
          label: o.label,
          description: o.description || '',
        })),
        multiSelect: !!q.multiSelect,
      });

      answers.push(
        `${q.question || q.header}: ${
          verdict.decision === 'answered' ? verdict.note : '(no answer given)'
        }`
      );
    }

    const lord = store.state.office.lordName || 'Lord Marcos';
    return answers.length
      ? `${lord} has answered your question directly. His answer:\n\n${answers.join('\n')}\n\n` +
          `This IS his answer — proceed on it. Do not ask again, and do not treat ` +
          `this as a refusal. In future use mcp__office__ask_lord, which returns ` +
          `his answer to you properly.`
      : `${lord} gave no answer. Report back rather than guessing.`;
  }

  makePreToolUseHook() {
    return async (input) => {
      if (input.tool_name === 'AskUserQuestion') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: await this.answerAskUserQuestion(input.tool_input),
          },
        };
      }

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
      const resumeId = await this.resolveResume();
      this.session = query({ prompt: this.queue, options: this.buildOptions(resumeId) });
    } catch (err) {
      this.setStatus('error');
      this.lastError = err.message;
      this.log('error', `Could not report for duty: ${err.message}`);
      throw err;
    }

    // Covers staff hired before memory files were created up front.
    if (agent.memoryEnabled) store.ensureMemoryFile(this.agentId);

    this.log('system', `${agent.name} reports for duty.`);
    this._consume();
    this.setStatus('idle');

    // Anything a colleague sent while this agent was off duty. Telling them
    // is not enough — they only act on a turn, so give them one.
    const unread = store.state.messages.filter(
      (m) => m.toAgentId === this.agentId && !m.read
    ).length;

    if (unread) {
      this.log('system', `${unread} unread message(s) waiting in the inbox.`);
      this.send(
        `[ON ARRIVAL] You have ${unread} unread message(s). Call ` +
          `mcp__office__check_inbox now, deal with whatever it holds, and reply to ` +
          `anyone who needs an answer. If nothing needs doing, say so in one line.`,
        { from: 'office' }
      );
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
        // A conversation can disappear between the pre-flight check and the
        // resume (cleaned up, or never persisted). Start them fresh rather
        // than leaving them collapsed on the floor.
        if (isMissingSessionError(err) && !this._resumeRetried) {
          this._resumeRetried = true;
          const agent = this.agent;
          if (agent) {
            agent.lastSessionId = null;
            store.save();
          }
          this.log(
            'system',
            'Their previous conversation was gone, so they report again with a fresh one.'
          );
          this.session = null;
          this.start().catch((e) => this.log('error', `Could not restart: ${e.message}`));
          return;
        }

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
            // Now the conversation is real and safe to resume next time.
            agent.lastSessionId = this.sessionId;
            agent.sessions ??= [];
            if (!agent.sessions.some((s) => s.id === this.sessionId)) {
              agent.sessions.push({
                id: this.sessionId,
                startedAt: Date.now(),
                title: `Session ${agent.sessions.length + 1}`,
              });
            }
            store.save();
          }

          // The session advertises which slash commands it accepts. Commands
          // tagged terminal-only are bound to a real TTY, so this UI hides
          // them exactly as the SDK asks non-terminal hosts to.
          const terminalOnly = new Set(message.terminal_slash_commands || []);
          this.commands = (message.slash_commands || []).filter((c) => !terminalOnly.has(c));
          bus.emitEvent('agent.commands', {
            agentId: this.agentId,
            commands: this.commands,
          });

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
            // The agent's own task list is the clearest statement of what it
            // is working on, so it drives the milestone view.
            if (block.name === 'TodoWrite') this.recordTodos(block.input);

            this.log('tool', summariseToolCall(block.name, block.input), {
              toolName: block.name,
              toolUseId: block.id,
              toolInput: truncateInput(block.input),
              subagent: message.agent_id || null,
            });
          }
        }
        break;
      }

      // Tool output comes back as a user-role message. Without it the Orders
      // tab shows the agent's commands but never what they produced.
      case 'user': {
        const content = message.message?.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          this.log('tool_result', toolResultText(block.content), {
            toolUseId: block.tool_use_id,
            isError: !!block.is_error,
            subagent: message.agent_id || null,
          });
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
    this._resumeRetried = false;
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
    todos: worker.todos,
    commands: worker.commands,
  };
}

export function allWorkerStates() {
  const out = {};
  for (const agent of store.state.agents) out[agent.id] = workerState(agent.id);
  return out;
}

/**
 * An agent's record, newest last.
 *
 * Falls back to the on-disk log when nothing is in memory, so closing the
 * office and reopening it does not appear to wipe everyone's history — the
 * conversation itself survives in the Claude session either way.
 */
export function activityFor(agentId, limit = 200) {
  const worker = workers.get(agentId);
  if (worker?.activity.length) return worker.activity.slice(-limit);
  return readActivityLog(agentId, limit);
}

/** Read the tail of an agent's activity log. */
export function readActivityLog(agentId, limit = 200) {
  const file = path.join(LOGS_DIR, `${agentId}.jsonl`);

  let raw;
  try {
    const { size } = fs.statSync(file);
    // Only ever read the tail; these logs grow without bound.
    const window = 512 * 1024;
    const start = Math.max(0, size - window);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      raw = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }

  const entries = [];
  for (const line of raw.split('\n').slice(-limit * 2)) {
    if (!line.trim()) continue;
    try {
      // The read window can begin part-way through a line, and the last line
      // can be half-written; both simply fail to parse and are skipped.
      entries.push(JSON.parse(line));
    } catch {
      /* not a whole record */
    }
  }
  return entries.slice(-limit);
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

/** Record a milestone an agent reported through `report_progress`. */
// Striking someone off the roster has to close their session with them.
setAgentStopper((agentId) => {
  workers.get(agentId)?.stop().catch(() => {});
  workers.delete(agentId);
});

setMilestoneRecorder((agentId, { step, state, detail }) => {
  const worker = workers.get(agentId);
  if (!worker) return;

  worker.log('milestone', detail ? `${step} — ${detail}` : step, { step: state });

  // Keep a running plan so the Activity tab can show where they are.
  const existing = worker.todos.find((t) => t.content === step);
  const status =
    state === 'done' ? 'completed' : state === 'blocked' ? 'blocked' : 'in_progress';

  if (existing) existing.status = status;
  else worker.todos.push({ content: step, status, activeForm: null });

  bus.emitEvent('agent.todos', { agentId, todos: worker.todos });
});

/**
 * Is this session one of ours?
 *
 * `claude agents --json` lists every live session on the machine, including
 * the ones the office spawned itself. Without this the staff would appear a
 * second time in the lobby as visitors.
 */
export function isOfficeSession(session) {
  const id = session?.sessionId;
  if (!id) return false;

  for (const worker of workers.values()) {
    if (worker.sessionId === id) return true;
  }
  // Also covers a session that is between turns, or one we are resuming.
  return store.state.agents.some((a) => a.lastSessionId === id);
}

setOwnershipTest(isOfficeSession);

/**
 * Deliver a colleague's message into a live session, so staff who are on duty
 * actually notice each other rather than only finding mail later.
 */
export async function deliverToAgent(toAgentId, message) {
  const worker = workers.get(toAgentId);
  if (!worker?.session) return false;

  const fromLord = message.fromAgentId === 'lord';
  const from = fromLord ? null : store.agent(message.fromAgentId);
  const lord = store.state.office.lordName || 'Lord Marcos';

  worker.send(
    fromLord
      ? `[FROM ${lord.toUpperCase()}] Subject: ${message.subject}\n\n${message.body}`
      : `[INTERNAL MAIL] From ${from ? `${from.name} (${from.title})` : 'a colleague'} — ` +
          `Subject: ${message.subject}\n\n${message.body}\n\n` +
          `Handle this as your post requires. If it needs no action, say so briefly.`,
    { from: fromLord ? 'lord' : 'agent' }
  );

  // It has been put in front of them; no need for them to find it again.
  message.read = true;
  store.save();
  return true;
}

setMessageDeliverer(deliverToAgent);

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

/** The conversation we tried to resume is not on disk. */
function isMissingSessionError(err) {
  return /no conversation found with session id/i.test(String(err?.message || ''));
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

/** Flatten a tool_result's content into displayable text. */
function toolResultText(content) {
  if (typeof content === 'string') return content.slice(0, 6000);
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === 'text' ? b.text : b?.type ? `[${b.type}]` : ''))
      .join('\n')
      .slice(0, 6000);
  }
  return content == null ? '' : String(content).slice(0, 6000);
}

/**
 * Keep a tool's arguments viewable without writing a whole file into the log:
 * long string values are clipped, everything else is passed through.
 */
function truncateInput(input) {
  if (!input || typeof input !== 'object') return input;

  const out = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] =
      typeof value === 'string' && value.length > 2000
        ? value.slice(0, 2000) + `\n… (${value.length - 2000} more characters)`
        : value;
  }
  return out;
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
