/**
 * The working day.
 *
 * Agents put "on shift" get handed their standing task on a fixed interval,
 * the way an employee would pick a job back up each morning. A shift only
 * fires when the agent is actually idle, so a long task is never trampled by
 * the next tick.
 */
import { store } from './store.js';
import { bus } from './bus.js';
import { workerFor, order, workerState } from './runtime.js';

let timer = null;

async function tick() {
  const now = Date.now();

  for (const agent of store.state.agents) {
    const loop = agent.loop;
    if (!loop?.enabled || !loop.prompt?.trim()) continue;

    const intervalMs = Math.max(1, Number(loop.intervalMinutes) || 30) * 60_000;
    const due = (loop.lastRunAt || 0) + intervalMs;
    if (now < due) continue;

    const state = workerState(agent.id);
    // Never interrupt work in progress, and never start a shift for an agent
    // that is sitting in front of an unanswered approval.
    if (state.status === 'working' || state.status === 'awaiting') continue;
    if (state.status === 'error') continue;

    loop.lastRunAt = now;
    store.save();

    try {
      await order(
        agent.id,
        `[SCHEDULED SHIFT] This is your standing assignment. Check your inbox first, ` +
          `then carry it out:\n\n${loop.prompt.trim()}`
      );
      bus.emitEvent('agent.shift', { agentId: agent.id, at: now });
    } catch (err) {
      bus.emitEvent('agent.shift-failed', { agentId: agent.id, error: err.message });
    }
  }
}

export function startScheduler(intervalMs = 30_000) {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => console.error('[scheduler]', err));
  }, intervalMs);
  timer.unref?.();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
