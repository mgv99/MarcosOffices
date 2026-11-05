/**
 * The approval pipeline.
 *
 * Two kinds of thing need sanction in this office:
 *
 *   - `tool`     a tool call an agent wants to make (raised by the SDK's
 *                canUseTool callback)
 *   - `decision` a proposal an agent submitted deliberately via the
 *                `request_approval` office tool
 *
 * Each is routed either to the CEO (who adjudicates automatically, and may
 * escalate) or straight to Lord Marcos, who answers in the GUI.
 */
import { store, newId } from './store.js';
import { bus } from './bus.js';

/** approvalId -> { resolve } for requests currently awaiting a verdict. */
const pending = new Map();

/**
 * Late-bound so this module does not have to import the runtime (which imports
 * this one). The runtime installs a function that asks the CEO agent to rule.
 */
let ceoAdjudicator = null;
export function setCeoAdjudicator(fn) {
  ceoAdjudicator = fn;
}

export function listApprovals({ status } = {}) {
  let list = store.state.approvals;
  if (status) list = list.filter((a) => a.status === status);
  return list;
}

/** Decide who must sanction this request. */
function routeFor(agent, { severity, kind }) {
  const policy = agent.approvalPolicy || {};
  const setting = kind === 'tool' ? policy.tools : policy.decisions;

  if (setting === 'auto') return 'auto';
  if (setting === 'lord') return 'lord';
  // The CEO cannot approve their own work; they answer to the Lord.
  if (agent.isCeo) return 'lord';
  if (severity === 'grave') return 'lord';
  return 'ceo';
}

/**
 * Raise a request and wait for a verdict.
 * Resolves to { decision: 'approved' | 'rejected', by, note }.
 */
export async function requestApproval({
  agentId,
  kind = 'decision',
  title,
  detail = '',
  risk = '',
  severity = 'normal',
  toolName = null,
  toolInput = null,
}) {
  const agent = store.agent(agentId);
  if (!agent) throw new Error(`unknown agent ${agentId}`);

  const route = routeFor(agent, { severity, kind });

  if (route === 'auto') {
    return { decision: 'approved', by: 'office-policy', note: 'Auto-approved by standing policy.' };
  }

  const approval = {
    id: newId('apr_'),
    agentId,
    agentName: agent.name,
    departmentId: agent.departmentId,
    kind,
    title,
    detail,
    risk,
    severity,
    toolName,
    toolInput,
    route, // 'ceo' | 'lord'
    status: 'pending',
    createdAt: Date.now(),
    decidedAt: null,
    decision: null,
    decidedBy: null,
    note: null,
    escalated: false,
  };

  store.state.approvals.unshift(approval);
  store.save();
  bus.emitEvent('approval.new', approval);

  const verdict = await new Promise((resolve) => {
    pending.set(approval.id, { resolve });

    if (route === 'ceo' && ceoAdjudicator) {
      // Ask the CEO to rule. If they escalate (or the attempt fails), the
      // request falls through to Lord Marcos and simply stays pending here.
      Promise.resolve(ceoAdjudicator(approval))
        .then((ruling) => {
          if (!ruling || ruling.decision === 'escalate') {
            escalate(approval.id, ruling?.note || 'The CEO refers this matter upward.');
            return;
          }
          resolveApproval(approval.id, ruling.decision, {
            by: 'ceo',
            note: ruling.note || '',
          });
        })
        .catch((err) => {
          escalate(approval.id, `The CEO could not rule: ${err.message}`);
        });
    }
  });

  return verdict;
}

/** Move a pending CEO-routed request up to Lord Marcos. */
export function escalate(id, note = '') {
  const approval = store.state.approvals.find((a) => a.id === id);
  if (!approval || approval.status !== 'pending') return;
  approval.route = 'lord';
  approval.escalated = true;
  approval.escalationNote = note;
  store.save();
  bus.emitEvent('approval.escalated', approval);
  notify({
    kind: 'approval',
    title: `${approval.agentName} awaits your judgement`,
    body: approval.title,
    agentId: approval.agentId,
    refId: approval.id,
  });
}

/** Hand down a verdict. Called by the GUI (Lord Marcos) or by the CEO. */
export function resolveApproval(id, decision, { by = 'lord', note = '' } = {}) {
  const approval = store.state.approvals.find((a) => a.id === id);
  if (!approval) return { ok: false, error: 'no such approval' };
  if (approval.status !== 'pending') return { ok: false, error: 'already decided' };

  approval.status = 'decided';
  approval.decision = decision; // 'approved' | 'rejected'
  approval.decidedBy = by;
  approval.note = note;
  approval.decidedAt = Date.now();
  store.save();
  bus.emitEvent('approval.decided', approval);

  const waiter = pending.get(id);
  if (waiter) {
    pending.delete(id);
    waiter.resolve({ decision, by, note });
  }
  return { ok: true, approval };
}

/**
 * Release everything still waiting — used when an agent is stopped or the
 * server shuts down, so no tool call is left hanging forever.
 */
export function cancelPendingFor(agentId, reason = 'The agent was dismissed.') {
  for (const approval of store.state.approvals) {
    if (approval.status === 'pending' && (!agentId || approval.agentId === agentId)) {
      approval.status = 'cancelled';
      approval.note = reason;
      approval.decidedAt = Date.now();
      const waiter = pending.get(approval.id);
      if (waiter) {
        pending.delete(approval.id);
        waiter.resolve({ decision: 'rejected', by: 'system', note: reason });
      }
    }
  }
  store.save();
}

/** Any approval left pending from a previous run can never be resolved. */
export function reapStaleApprovals() {
  let n = 0;
  for (const approval of store.state.approvals) {
    if (approval.status === 'pending') {
      approval.status = 'cancelled';
      approval.note = 'Abandoned when the office closed.';
      n++;
    }
  }
  if (n) store.save();
  return n;
}

// --- notifications ----------------------------------------------------------

export function notify({ kind = 'info', title, body = '', agentId = null, refId = null }) {
  const note = {
    id: newId('ntf_'),
    kind,
    title,
    body,
    agentId,
    refId,
    read: false,
    at: Date.now(),
  };
  store.state.notifications.unshift(note);
  // Keep the bell from growing without bound.
  if (store.state.notifications.length > 500) store.state.notifications.length = 500;
  store.save();
  bus.emitEvent('notification.new', note);
  return note;
}
