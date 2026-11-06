/** Thin wrapper over the office API. Every call returns parsed JSON or throws. */

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* some responses carry no body */
  }

  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `${method} ${path} failed (${res.status})`);
  }
  return data;
}

export const api = {
  state: () => request('GET', '/api/state'),

  office: (patch) => request('PATCH', '/api/office', patch),
  seed: () => request('POST', '/api/office/seed'),
  ceoSuite: () => request('POST', '/api/office/ceo-suite'),

  inbox: () => request('GET', '/api/inbox'),
  readInbox: (ids) => request('POST', '/api/inbox/read', { ids }),
  /** File messages away (or take them back out) — Lord Marcos's view only. */
  archiveMessages: (ids, archived = true) =>
    request('POST', '/api/messages/archive', { ids, archived }),
  sanctionAll: (note) => request('POST', '/api/approvals/sanction-all', { note }),

  createDepartment: (body) => request('POST', '/api/departments', body),
  setDepartmentHead: (id, agentId) =>
    request('POST', `/api/departments/${id}/head`, { agentId }),
  updateDepartment: (id, patch) => request('PATCH', `/api/departments/${id}`, patch),
  deleteDepartment: (id) => request('DELETE', `/api/departments/${id}`),

  createAgent: (body) => request('POST', '/api/agents', body),
  updateAgent: (id, patch) => request('PATCH', `/api/agents/${id}`, patch),
  /** Let someone go: they move to the unemployment list, record intact. */
  deleteAgent: (id) => request('DELETE', `/api/agents/${id}`),
  /** Strike someone from the record for good. */
  purgeAgent: (id) => request('DELETE', `/api/agents/${id}/permanent`),
  rehireAgent: (id, departmentId = null) =>
    request('POST', `/api/agents/${id}/rehire`, { departmentId }),
  hire: (id) => request('POST', `/api/agents/${id}/hire`),
  dismiss: (id) => request('POST', `/api/agents/${id}/dismiss`),
  order: (id, text) => request('POST', `/api/agents/${id}/order`, { text }),
  interrupt: (id) => request('POST', `/api/agents/${id}/interrupt`),
  activity: (id) => request('GET', `/api/agents/${id}/activity`),

  memory: (id) => request('GET', `/api/agents/${id}/memory`),
  saveMemory: (id, topic, content) =>
    request('PUT', `/api/agents/${id}/memory/${topic}`, { content }),
  deleteMemory: (id, topic) => request('DELETE', `/api/agents/${id}/memory/${topic}`),

  mail: (id) => request('GET', `/api/agents/${id}/mail`),
  switchSession: (id, sessionId) => request('POST', `/api/agents/${id}/session`, { sessionId }),
  renameSession: (id, sessionId, title) =>
    request('PATCH', `/api/agents/${id}/session/${sessionId}`, { title }),
  persona: (id) => request('GET', `/api/agents/${id}/persona`),

  createProject: (body) => request('POST', '/api/projects', body),
  updateProject: (id, patch) => request('PATCH', `/api/projects/${id}`, patch),
  deleteProject: (id) => request('DELETE', `/api/projects/${id}`),

  approvals: () => request('GET', '/api/approvals'),
  resolve: (id, decision, note) =>
    request('POST', `/api/approvals/${id}/resolve`, { decision, note }),
  answer: (id, answer) => request('POST', `/api/approvals/${id}/answer`, { answer }),
  escalate: (id) => request('POST', `/api/approvals/${id}/escalate`),

  readNotifications: (ids) => request('POST', '/api/notifications/read', { ids }),
  message: (toAgentId, subject, body) =>
    request('POST', '/api/messages', { toAgentId, subject, body }),

  components: () => request('GET', '/api/components'),
  addMcp: (name, config) => request('POST', '/api/components/mcp', { name, config }),
  addSkill: (body) => request('POST', '/api/components/skills', body),
  readSkill: (name) => request('GET', `/api/components/skills/${name}`),
  deleteSkill: (name) => request('DELETE', `/api/components/skills/${name}`),

  visitorTranscript: (sessionId) => request('GET', `/api/visitors/${sessionId}/transcript`),
  adoptVisitor: (sessionId, body) => request('POST', `/api/visitors/${sessionId}/adopt`, body),

  auth: () => request('GET', '/api/auth'),
  login: () => request('POST', '/api/auth/login'),

  browse: (path) =>
    request('GET', `/api/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
};

/** Subscribe to the live event stream. Reconnects on its own. */
export function connectEvents(onEvent, onStatusChange) {
  let source = null;
  let retry = 1000;

  const open = () => {
    source = new EventSource('/api/events');

    source.addEventListener('open', () => {
      retry = 1000;
      onStatusChange?.('connected');
    });

    source.addEventListener('error', () => {
      onStatusChange?.('reconnecting');
      source.close();
      // Back off, but never wait more than a few seconds.
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 8000);
    });

    // The server names every event, so listen broadly.
    for (const type of [
      'agent.status', 'agent.activity', 'agent.created', 'agent.updated',
      'agent.deleted', 'agent.memory', 'agent.shift', 'agent.stats', 'agent.todos', 'agent.commands', 'agent.session',
      'department.created', 'department.updated', 'department.deleted',
      'project.created', 'project.updated', 'project.deleted',
      'approval.new', 'approval.decided', 'approval.escalated', 'approval.ceo-ruling',
      'notification.new', 'message.new', 'office.updated', 'visitors',
      'components.updated',
    ]) {
      source.addEventListener(type, (e) => {
        try {
          onEvent(JSON.parse(e.data));
        } catch {}
      });
    }
  };

  open();
  return () => source?.close();
}
