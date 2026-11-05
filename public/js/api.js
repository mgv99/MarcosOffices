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

  createDepartment: (body) => request('POST', '/api/departments', body),
  updateDepartment: (id, patch) => request('PATCH', `/api/departments/${id}`, patch),
  deleteDepartment: (id) => request('DELETE', `/api/departments/${id}`),

  createAgent: (body) => request('POST', '/api/agents', body),
  updateAgent: (id, patch) => request('PATCH', `/api/agents/${id}`, patch),
  deleteAgent: (id) => request('DELETE', `/api/agents/${id}`),
  hire: (id) => request('POST', `/api/agents/${id}/hire`),
  dismiss: (id) => request('POST', `/api/agents/${id}/dismiss`),
  order: (id, text) => request('POST', `/api/agents/${id}/order`, { text }),
  interrupt: (id) => request('POST', `/api/agents/${id}/interrupt`),
  activity: (id) => request('GET', `/api/agents/${id}/activity`),
  memory: (id) => request('GET', `/api/agents/${id}/memory`),
  saveMemory: (id, content) => request('PUT', `/api/agents/${id}/memory`, { content }),
  persona: (id) => request('GET', `/api/agents/${id}/persona`),

  createProject: (body) => request('POST', '/api/projects', body),
  updateProject: (id, patch) => request('PATCH', `/api/projects/${id}`, patch),
  deleteProject: (id) => request('DELETE', `/api/projects/${id}`),

  approvals: () => request('GET', '/api/approvals'),
  resolve: (id, decision, note) =>
    request('POST', `/api/approvals/${id}/resolve`, { decision, note }),
  escalate: (id) => request('POST', `/api/approvals/${id}/escalate`),

  readNotifications: (ids) => request('POST', '/api/notifications/read', { ids }),
  message: (toAgentId, subject, body) =>
    request('POST', '/api/messages', { toAgentId, subject, body }),

  components: () => request('GET', '/api/components'),
  addMcp: (name, config) => request('POST', '/api/components/mcp', { name, config }),

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
      'agent.deleted', 'agent.memory', 'agent.shift', 'agent.stats',
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
