/**
 * Marcos Offices — the front of house.
 *
 * Holds the snapshot of the office, keeps it in step with the server over SSE,
 * and renders whichever panel Lord Marcos has open.
 */
import { api, connectEvents } from './api.js';
import { OfficeMap } from './office.js';
import { STATUS_COLORS, THEME_NAMES, agentSprite } from './sprites.js';

// --- tiny DOM helpers -------------------------------------------------------

/** h('div.card', { onclick }, [children]) */
function h(spec, props = {}, children = []) {
  const [tag, ...classes] = String(spec).split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');

  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }

  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const $ = (sel) => document.querySelector(sel);

const field = (label, control, hint) =>
  h('div.field', {}, [h('label', { text: label }), control, hint && h('div.hint', { text: hint })]);

function timeOf(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function toast({ title, body = '', kind = 'info', timeout = 6000 }) {
  const el = h('div.toast', { 'data-kind': kind }, [
    h('div.toast-title', { text: title }),
    body && h('div.toast-body', { text: String(body).slice(0, 240) }),
  ]);
  el.addEventListener('click', () => el.remove());
  $('#toasts').append(el);
  setTimeout(() => el.remove(), timeout);
}

// --- application state ------------------------------------------------------

const state = {
  snapshot: null,
  selectedAgentId: null,
  panel: null, // 'agent' | 'hq' | 'staff' | ...
  agentTab: 'orders',
  activity: [], // for the open agent
};

let map = null;

const agentById = (id) => state.snapshot?.agents.find((a) => a.id === id) || null;
const deptById = (id) => state.snapshot?.departments.find((d) => d.id === id) || null;
const statusOf = (id) => state.snapshot?.workers?.[id]?.status || 'offline';

const pendingApprovals = () =>
  (state.snapshot?.approvals || []).filter((a) => a.status === 'pending' && a.route === 'lord');

const unreadNotifications = () =>
  (state.snapshot?.notifications || []).filter((n) => !n.read);

// --- boot -------------------------------------------------------------------

async function boot() {
  const canvas = $('#office-canvas');

  map = new OfficeMap(canvas, {
    onSelectAgent: (id) => openAgent(id),
    onSelectDepartment: (id) => openPanel('departments', { highlight: id }),
    onBackground: () => closePanel(),
  });

  await refresh();
  map.fit();
  map.start();

  connectEvents(handleEvent, (status) => {
    $('#conn').dataset.status = status;
  });

  wireChrome();
  renderLegend();
  renderBadges();
}

async function refresh() {
  state.snapshot = await api.state();
  map.setState(state.snapshot);
  renderAuth();
  renderBadges();
}

function wireChrome() {
  for (const btn of document.querySelectorAll('[data-panel]')) {
    btn.addEventListener('click', () => {
      const name = btn.dataset.panel;
      state.panel === name ? closePanel() : openPanel(name);
    });
  }

  $('#side-close').addEventListener('click', closePanel);
  $('#btn-fit').addEventListener('click', () => map.fit());
  $('#btn-zoom-in').addEventListener('click', () => {
    map.camera.zoomIndex = Math.min(4, map.camera.zoomIndex + 1);
  });
  $('#btn-zoom-out').addEventListener('click', () => {
    map.camera.zoomIndex = Math.max(0, map.camera.zoomIndex - 1);
  });

  $('#auth-pill').addEventListener('click', async () => {
    const auth = state.snapshot?.auth;
    if (auth?.loggedIn) return openPanel('settings');
    try {
      await api.login();
      toast({
        title: 'A terminal has been opened',
        body: 'Finish signing in there, then reopen this panel.',
        kind: 'info',
      });
    } catch (err) {
      toast({ title: 'Could not open a terminal', body: err.message, kind: 'error' });
    }
  });

  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('#modal-backdrop')) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#modal-backdrop').hidden) closeModal();
      else closePanel();
    }
  });
}

function renderAuth() {
  const auth = state.snapshot?.auth || {};
  const pill = $('#auth-pill');
  pill.dataset.ok = String(!!auth.loggedIn);
  pill.textContent = auth.loggedIn
    ? `● ${auth.email || 'signed in'}`
    : '○ sign in to Claude';
  pill.title = auth.loggedIn
    ? `${auth.authMethod || ''} ${auth.subscriptionType ? `(${auth.subscriptionType})` : ''}`.trim()
    : 'Click to open a terminal and run: claude auth login';
}

function renderBadges() {
  const count = pendingApprovals().length + unreadNotifications().length;
  const badge = $('#badge-hq');
  badge.hidden = count === 0;
  badge.textContent = String(count);
}

function renderLegend() {
  const rows = [
    ['working', 'working'],
    ['awaiting', 'awaiting your word'],
    ['idle', 'idle at desk'],
    ['offline', 'off duty'],
    ['error', 'in trouble'],
  ];
  $('#map-legend').replaceChildren(
    ...rows.map(([key, label]) =>
      h('div.legend-row', {}, [
        h('span.legend-dot', { style: { background: STATUS_COLORS[key] } }),
        label,
      ])
    )
  );
}

// --- live events ------------------------------------------------------------

async function handleEvent({ type, data }) {
  switch (type) {
    case 'agent.status': {
      if (state.snapshot?.workers) {
        state.snapshot.workers[data.agentId] = {
          ...(state.snapshot.workers[data.agentId] || {}),
          status: data.status,
          sessionId: data.sessionId,
        };
        map.setWorkers(state.snapshot.workers);
      }
      if (state.panel === 'agent' && state.selectedAgentId === data.agentId) {
        renderPanel();
      }
      break;
    }

    case 'agent.activity': {
      if (state.panel === 'agent' && state.selectedAgentId === data.agentId) {
        state.activity.push(data);
        if (state.agentTab === 'activity' || state.agentTab === 'orders') appendActivity(data);
      }
      break;
    }

    case 'visitors':
      if (state.snapshot) state.snapshot.visitors = data;
      map.visitors = data;
      break;

    case 'approval.new':
    case 'approval.escalated':
    case 'approval.decided': {
      await reloadApprovals();
      if (type !== 'approval.decided' && data.route === 'lord') {
        toast({
          title: `${data.agentName} awaits your word`,
          body: data.title,
          kind: 'approval',
          timeout: 12000,
        });
      }
      break;
    }

    case 'notification.new': {
      state.snapshot?.notifications.unshift(data);
      renderBadges();
      toast({ title: data.title, body: data.body, kind: data.kind });
      break;
    }

    case 'message.new':
      state.snapshot?.messages.unshift(data);
      if (state.panel === 'hq') renderPanel();
      break;

    // Anything structural: take a fresh snapshot rather than patching by hand.
    case 'agent.created':
    case 'agent.deleted':
    case 'agent.updated':
    case 'department.created':
    case 'department.updated':
    case 'department.deleted':
    case 'project.created':
    case 'project.updated':
    case 'project.deleted':
    case 'office.updated':
      await refresh();
      if (state.panel) renderPanel();
      break;

    default:
      break;
  }
}

async function reloadApprovals() {
  const { approvals } = await api.approvals();
  if (state.snapshot) state.snapshot.approvals = approvals;
  renderBadges();
  if (state.panel === 'hq') renderPanel();
  if (state.panel === 'agent') renderPanel();
}

// --- panel plumbing ---------------------------------------------------------

function openPanel(name, options = {}) {
  state.panel = name;
  state.panelOptions = options;
  $('#side').dataset.open = 'true';
  for (const btn of document.querySelectorAll('[data-panel]')) {
    btn.dataset.active = String(btn.dataset.panel === name);
  }
  renderPanel();
}

function closePanel() {
  state.panel = null;
  state.selectedAgentId = null;
  map.select(null);
  $('#side').dataset.open = 'false';
  for (const btn of document.querySelectorAll('[data-panel]')) btn.dataset.active = 'false';
}

async function openAgent(id) {
  state.selectedAgentId = id;
  state.agentTab = 'orders';
  map.select(id);
  openPanel('agent');

  try {
    const { activity } = await api.activity(id);
    state.activity = activity;
    if (state.panel === 'agent' && state.selectedAgentId === id) renderPanel();
  } catch {
    state.activity = [];
  }
}

function setPanel(title, body) {
  $('#side-title').textContent = title;
  $('#side-body').replaceChildren(...[].concat(body));
}

function renderPanel() {
  switch (state.panel) {
    case 'agent': return renderAgentPanel();
    case 'hq': return renderHqPanel();
    case 'staff': return renderStaffPanel();
    case 'departments': return renderDepartmentsPanel();
    case 'projects': return renderProjectsPanel();
    case 'components': return renderComponentsPanel();
    case 'settings': return renderSettingsPanel();
    default: return;
  }
}

function tabs(items, active, onPick) {
  return h(
    'div.tabs',
    {},
    items.map(([key, label]) =>
      h('button.tab', { 'data-active': String(key === active), onclick: () => onPick(key) }, [label])
    )
  );
}

// --- the agent panel --------------------------------------------------------

function renderAgentPanel() {
  const agent = agentById(state.selectedAgentId);
  if (!agent) return closePanel();

  const status = statusOf(agent.id);
  const dept = deptById(agent.departmentId);
  const supervisor = agent.supervisorId ? agentById(agent.supervisorId) : null;

  const header = h('div.card', {}, [
    h('div.card-head', {}, [
      portrait(agent),
      h('div', { style: { flex: '1', minWidth: '0' } }, [
        h('div.card-title', { text: `${agent.name}${agent.isCeo ? ' ♛' : ''}` }),
        h('div.card-sub', {
          text: `${agent.title} · ${dept?.name || 'unassigned'}${
            supervisor ? ` · reports to ${supervisor.name}` : ''
          }`,
        }),
      ]),
      h('span.pill.pill-status', {
        text: status,
        style: { color: STATUS_COLORS[status], borderColor: STATUS_COLORS[status] },
      }),
    ]),
    h('div.actions', {}, [
      status === 'offline' || status === 'error'
        ? h('button.btn.btn-primary.btn-sm', {
            text: '▶ Call to duty',
            onclick: () => guard(() => api.hire(agent.id), 'Reporting for duty…'),
          })
        : h('button.btn.btn-danger.btn-sm', {
            text: '■ Send home',
            onclick: () => guard(() => api.dismiss(agent.id), 'Sent home.'),
          }),
      status === 'working' &&
        h('button.btn.btn-sm', {
          text: '⏸ Interrupt',
          onclick: () => guard(() => api.interrupt(agent.id), 'Work interrupted.'),
        }),
      h('button.btn.btn-sm', { text: '⌖ Find on map', onclick: () => map.focusAgent(agent.id) }),
    ]),
  ]);

  const body = h('div');
  const nav = tabs(
    [
      ['orders', 'Orders'],
      ['activity', 'Activity'],
      ['config', 'Configuration'],
      ['memory', 'Memory'],
    ],
    state.agentTab,
    (key) => {
      state.agentTab = key;
      renderPanel();
    }
  );

  setPanel(`${agent.name.toUpperCase()} — ${agent.title}`, [header, nav, body]);

  if (state.agentTab === 'orders') renderOrders(body, agent);
  else if (state.agentTab === 'activity') renderActivity(body);
  else if (state.agentTab === 'config') renderAgentConfig(body, agent);
  else renderAgentMemory(body, agent);
}

/** A live-rendered portrait of the agent, from the same sprite the map uses. */
function portrait(agent) {
  const canvas = h('canvas', { width: 32, height: 48, style: { imageRendering: 'pixelated', flex: 'none' } });
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    agentSprite(agent.appearance?.seed || agent.id, {
      outfit: agent.isCeo ? 'suit' : agent.appearance?.outfit || 'shirt',
    }),
    0, 0, 32, 48
  );
  return canvas;
}

function renderOrders(container, agent) {
  const input = h('textarea', {
    placeholder: `Speak, and ${agent.name} obeys…`,
    rows: 4,
  });

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await api.order(agent.id, text);
    } catch (err) {
      toast({ title: 'The order did not reach them', body: err.message, kind: 'error' });
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
  });

  const waiting = (state.snapshot?.approvals || []).filter(
    (a) => a.status === 'pending' && a.agentId === agent.id
  );

  container.replaceChildren(
    h('div.lord-note', {
      text:
        'You speak as Lord Marcos, their god and employer. They address you as The Lord Almighty, ' +
        'He Who Is Everywhere and Rules Over All.',
    }),
    ...(waiting.length
      ? [h('div', {}, waiting.map((a) => approvalCard(a, { compact: true })))]
      : []),
    h('div.order-box', {}, [
      input,
      h('div.actions', {}, [
        h('button.btn.btn-gold', { text: 'Issue order', onclick: send }),
        h('span.spacer'),
        h('span.card-sub', { text: 'Ctrl+Enter' }),
      ]),
    ]),
    h('div.feed', { id: 'feed' }, state.activity.slice(-80).map(activityNode))
  );
}

function renderActivity(container) {
  container.replaceChildren(
    state.activity.length
      ? h('div.feed', { id: 'feed' }, state.activity.slice(-250).map(activityNode))
      : h('div.empty', { text: 'Nothing recorded yet this session.' })
  );
}

function activityNode(entry) {
  const label = {
    order: 'ORDER FROM THE LORD',
    say: 'SAYS',
    thinking: 'THINKING',
    tool: `USES ${entry.toolName || 'a tool'}`,
    approval: 'APPROVAL',
    result: 'COMPLETE',
    error: 'ERROR',
    system: 'OFFICE',
    stderr: 'STDERR',
  }[entry.kind] || entry.kind.toUpperCase();

  return h(`div.act.act-${entry.kind}`, {}, [
    h('div.act-meta', {}, [
      h('span', { text: timeOf(entry.at) }),
      h('span', { text: label }),
      entry.subagent && h('span', { text: `· subagent` }),
    ]),
    h('div', { text: String(entry.text).slice(0, 4000) }),
  ]);
}

function appendActivity(entry) {
  const feed = document.getElementById('feed');
  if (!feed) return;
  const atBottom = feed.parentElement
    ? feed.parentElement.scrollTop + feed.parentElement.clientHeight >=
      feed.parentElement.scrollHeight - 60
    : true;
  feed.append(activityNode(entry));
  if (atBottom) $('#side-body').scrollTop = $('#side-body').scrollHeight;
}

// --- agent configuration ----------------------------------------------------

function renderAgentConfig(container, agent) {
  const snapshot = state.snapshot;
  const form = {};

  const text = (key, value) => (form[key] = h('input', { type: 'text', value: value ?? '' }));
  const area = (key, value, rows = 4) =>
    (form[key] = h('textarea', { rows, text: value ?? '' }));

  const select = (key, options, value) =>
    (form[key] = h(
      'select',
      {},
      options.map(([v, label]) =>
        h('option', { value: v, selected: v === value ? true : null }, [label])
      )
    ));

  const skills = snapshot.components.skills || [];
  const mcps = snapshot.components.mcpServers || [];

  const skillBoxes = skills.map((s) =>
    h('label.toggle', {}, [
      h('input', {
        type: 'checkbox',
        'data-skill': s.name,
        checked: agent.enabledSkills?.includes(s.name) ? true : null,
      }),
      h('div', {}, [
        h('div.toggle-name', { text: s.name }),
        h('div.toggle-desc', { text: s.description || s.source }),
      ]),
    ])
  );

  const mcpBoxes = mcps.map((m) =>
    h('label.toggle', {}, [
      h('input', {
        type: 'checkbox',
        'data-mcp': m.name,
        checked: agent.enabledMcpServers?.includes(m.name) ? true : null,
      }),
      h('div', {}, [
        h('div.toggle-name', { text: m.name }),
        h('div.toggle-desc', { text: `${m.transport} · ${m.summary || m.source}` }),
      ]),
    ])
  );

  const save = async () => {
    const patch = {
      name: form.name.value.trim(),
      title: form.title.value.trim(),
      context: form.context.value,
      briefing: form.briefing.value,
      model: form.model.value,
      effort: form.effort.value,
      permissionMode: form.permissionMode.value,
      departmentId: form.departmentId.value,
      supervisorId: form.supervisorId.value || null,
      projectId: form.projectId.value || null,
      memoryEnabled: form.memoryEnabled.checked,
      approvalPolicy: {
        tools: form.policyTools.value,
        decisions: form.policyDecisions.value,
      },
      loop: {
        enabled: form.loopEnabled.checked,
        intervalMinutes: Number(form.loopInterval.value) || 30,
        prompt: form.loopPrompt.value,
      },
      enabledSkills: [...container.querySelectorAll('[data-skill]:checked')].map(
        (el) => el.dataset.skill
      ),
      enabledMcpServers: [...container.querySelectorAll('[data-mcp]:checked')].map(
        (el) => el.dataset.mcp
      ),
    };

    try {
      const result = await api.updateAgent(agent.id, patch);
      toast({
        title: 'Orders recorded',
        body: result.restartRequired
          ? 'They must be sent home and recalled for this to take effect.'
          : 'Saved.',
        kind: result.restartRequired ? 'approval' : 'done',
      });
      await refresh();
      renderPanel();
    } catch (err) {
      toast({ title: 'Could not save', body: err.message, kind: 'error' });
    }
  };

  container.replaceChildren(
    h('div.row', {}, [
      field('Name', text('name', agent.name)),
      field('Title', text('title', agent.title)),
    ]),

    field(
      'Their own context',
      area('context', agent.context, 5),
      'Who they are and what they are for. Folded into their system prompt.'
    ),
    field(
      'Briefing they pass down',
      area('briefing', agent.briefing, 3),
      'Standing orders inherited by everyone who reports to them.'
    ),

    h('div.row', {}, [
      field('Department', select('departmentId', snapshot.departments.map((d) => [d.id, d.name]), agent.departmentId)),
      field(
        'Supervisor',
        select(
          'supervisorId',
          [['', '— none (answers to you) —'], ...snapshot.agents.filter((a) => a.id !== agent.id).map((a) => [a.id, `${a.name} (${a.title})`])],
          agent.supervisorId || ''
        )
      ),
    ]),

    field(
      'Project',
      select(
        'projectId',
        [['', '— no fixed post —'], ...snapshot.projects.map((p) => [p.id, `${p.name} — ${p.directory}`])],
        agent.projectId || ''
      ),
      'Their working directory. They may read elsewhere, but this is their post.'
    ),

    h('div.row', {}, [
      field('Model', select('model', [
        ['opus', 'Opus — gravest work'],
        ['sonnet', 'Sonnet — the workhorse'],
        ['haiku', 'Haiku — errands'],
        ['inherit', 'Inherit'],
      ], agent.model)),
      field('Effort', select('effort', [
        ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max'],
      ], agent.effort)),
    ]),

    h('h4', { text: 'Permissions', style: { margin: '18px 0 8px', color: 'var(--gold)' } }),

    field(
      'Permission mode',
      select('permissionMode', [
        ['default', 'default — ask before unsanctioned tools'],
        ['acceptEdits', 'acceptEdits — file edits without asking'],
        ['plan', 'plan — may only explore and propose'],
        ['dontAsk', "dontAsk — refuse anything that would ask"],
        ['bypassPermissions', 'bypassPermissions — unchained (dangerous)'],
      ], agent.permissionMode),
      'How Claude Code itself gates this agent before the office ever sees the request.'
    ),

    h('div.row', {}, [
      field(
        'Who sanctions their tools',
        select('policyTools', [
          ['auto', 'Nobody — let them work'],
          ['ceo', 'The CEO'],
          ['lord', 'You, Lord Marcos'],
        ], agent.approvalPolicy?.tools || 'lord')
      ),
      field(
        'Who sanctions their decisions',
        select('policyDecisions', [
          ['auto', 'Nobody'],
          ['ceo', 'The CEO'],
          ['lord', 'You, Lord Marcos'],
        ], agent.approvalPolicy?.decisions || 'ceo')
      ),
    ]),

    h('label.toggle', {}, [
      (form.memoryEnabled = h('input', { type: 'checkbox', checked: agent.memoryEnabled ? true : null })),
      h('div', {}, [
        h('div.toggle-name', { text: 'Allow a memory of their own' }),
        h('div.toggle-desc', { text: 'They may record what they learn and read it back next time.' }),
      ]),
    ]),

    h('h4', { text: 'Standing shift', style: { margin: '18px 0 8px', color: 'var(--gold)' } }),

    h('label.toggle', {}, [
      (form.loopEnabled = h('input', { type: 'checkbox', checked: agent.loop?.enabled ? true : null })),
      h('div', {}, [
        h('div.toggle-name', { text: 'Put them on shift' }),
        h('div.toggle-desc', { text: 'They pick up their standing task on an interval, like a real employee.' }),
      ]),
    ]),
    field('Every (minutes)', (form.loopInterval = h('input', { type: 'number', value: agent.loop?.intervalMinutes ?? 30, min: 1 }))),
    field('Standing task', area('loopPrompt', agent.loop?.prompt, 3)),

    h('h4', { text: `Skills (${skills.length} found)`, style: { margin: '18px 0 8px', color: 'var(--gold)' } }),
    skillBoxes.length
      ? h('div.toggle-grid', {}, skillBoxes)
      : h('div.empty', { text: 'No skills installed under ~/.claude/skills.' }),
    h('div.hint', { text: 'Tick none to give them every skill you have installed.' }),

    h('h4', { text: `MCP servers (${mcps.length} found)`, style: { margin: '18px 0 8px', color: 'var(--gold)' } }),
    mcpBoxes.length
      ? h('div.toggle-grid', {}, mcpBoxes)
      : h('div.empty', { text: 'No MCP servers configured.' }),

    h('div.actions', {}, [
      h('button.btn.btn-primary', { text: 'Save', onclick: save }),
      h('button.btn.btn-sm', {
        text: 'View full system prompt',
        onclick: async () => {
          const { persona } = await api.persona(agent.id);
          openModal(`${agent.name}'s charge`, h('pre', {
            text: persona,
            style: { whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: '1.6', margin: '0' },
          }));
        },
      }),
      h('span.spacer'),
      !agent.isCeo &&
        h('button.btn.btn-danger.btn-sm', {
          text: 'Dismiss from service',
          onclick: async () => {
            if (!confirm(`Dismiss ${agent.name} from the office permanently?`)) return;
            await guard(() => api.deleteAgent(agent.id), `${agent.name} has been dismissed.`);
            closePanel();
          },
        }),
    ])
  );
}

async function renderAgentMemory(container, agent) {
  container.replaceChildren(h('div.empty', { text: 'Reading their memory…' }));
  const { content } = await api.memory(agent.id);

  const area = h('textarea', { rows: 18, text: content });
  container.replaceChildren(
    h('div.hint', {
      text: `Stored at ${state.snapshot.dataDir}\\agents\\${agent.id}\\MEMORY.md — they write to it themselves with the "remember" tool.`,
      style: { marginBottom: '10px' },
    }),
    area,
    h('div.actions', {}, [
      h('button.btn.btn-primary', {
        text: 'Save memory',
        onclick: () => guard(() => api.saveMemory(agent.id, area.value), 'Memory rewritten.'),
      }),
      h('button.btn.btn-danger.btn-sm', {
        text: 'Wipe',
        onclick: async () => {
          if (!confirm(`Wipe everything ${agent.name} remembers?`)) return;
          area.value = '';
          await guard(() => api.saveMemory(agent.id, ''), 'Their memory is blank.');
        },
      }),
    ])
  );
}

// --- HQ ---------------------------------------------------------------------

function renderHqPanel() {
  const approvals = (state.snapshot.approvals || []).filter((a) => a.status === 'pending');
  const notifications = state.snapshot.notifications || [];
  const messages = state.snapshot.messages || [];
  const working = state.snapshot.agents.filter((a) => statusOf(a.id) === 'working');

  setPanel('HEADQUARTERS', [
    h('div.card', {}, [
      h('div.card-title', { text: 'The office at a glance' }),
      h('div.card-sub', {
        text:
          `${state.snapshot.agents.length} staff · ${working.length} at work · ` +
          `${approvals.length} awaiting sanction · ${state.snapshot.visitors.length} visiting session(s)`,
      }),
    ]),

    h('h4', { text: `Awaiting sanction (${approvals.length})`, style: { margin: '16px 0 8px', color: 'var(--gold)' } }),
    approvals.length
      ? h('div', {}, approvals.map((a) => approvalCard(a)))
      : h('div.empty', { text: 'Nothing awaits your word.' }),

    h('h4', { text: 'Dispatches', style: { margin: '18px 0 8px', color: 'var(--gold)' } }),
    notifications.length
      ? h('div', {}, [
          h('button.btn.btn-sm', {
            text: 'Mark all read',
            onclick: () => guard(() => api.readNotifications(), 'Cleared.', true),
            style: { marginBottom: '8px' },
          }),
          ...notifications.slice(0, 40).map((n) =>
            h('div.card', { style: { opacity: n.read ? '.55' : '1' } }, [
              h('div.card-head', {}, [
                h('div.card-title', { text: n.title, style: { flex: '1' } }),
                h('span.card-sub', { text: timeOf(n.at) }),
              ]),
              n.body && h('div.card-sub', { text: String(n.body).slice(0, 400) }),
            ])
          ),
        ])
      : h('div.empty', { text: 'No dispatches.' }),

    h('h4', { text: 'Internal mail', style: { margin: '18px 0 8px', color: 'var(--gold)' } }),
    messages.length
      ? h('div', {}, messages.slice(0, 30).map((m) => {
          const from = agentById(m.fromAgentId);
          const to = agentById(m.toAgentId);
          return h('div.card', {}, [
            h('div.card-sub', {
              text: `${from?.name || 'Lord Marcos'} → ${to?.name || '?'} · ${timeOf(m.at)}`,
            }),
            h('div.card-title', { text: m.subject, style: { fontSize: '12px' } }),
            h('div.card-sub', { text: String(m.body).slice(0, 300) }),
          ]);
        }))
      : h('div.empty', { text: 'The staff have not written to each other yet.' }),
  ]);
}

function approvalCard(approval, { compact = false } = {}) {
  const note = h('input', { type: 'text', placeholder: 'A remark, if you wish…' });

  const decide = async (decision) => {
    try {
      await api.resolve(approval.id, decision, note.value);
      toast({
        title: decision === 'approved' ? 'Sanctioned' : 'Refused',
        body: approval.title,
        kind: 'done',
      });
    } catch (err) {
      toast({ title: 'Could not answer', body: err.message, kind: 'error' });
    }
  };

  return h('div.card.approval', { 'data-route': approval.route }, [
    h('div.card-head', {}, [
      h('div', { style: { flex: '1', minWidth: '0' } }, [
        h('div.card-title', { text: approval.title, style: { fontSize: '12px' } }),
        h('div.card-sub', {
          text:
            `${approval.agentName} · ${approval.kind === 'tool' ? 'tool' : 'decision'} · ` +
            `${approval.route === 'lord' ? 'for you' : 'with the CEO'}` +
            `${approval.escalated ? ' · escalated' : ''}`,
        }),
      ]),
      h('span.pill', { text: approval.severity === 'grave' ? 'GRAVE' : timeOf(approval.createdAt) }),
    ]),

    approval.escalationNote && h('div.card-sub', { text: `CEO: ${approval.escalationNote}` }),

    !compact && approval.detail &&
      h('div.approval-detail', { text: approval.detail }),
    !compact && approval.risk &&
      h('div.card-sub', { text: `Risk: ${approval.risk}` }),

    approval.route === 'lord'
      ? h('div', {}, [
          note,
          h('div.actions', {}, [
            h('button.btn.btn-primary.btn-sm', { text: '✓ Sanction', onclick: () => decide('approved') }),
            h('button.btn.btn-danger.btn-sm', { text: '✕ Refuse', onclick: () => decide('rejected') }),
          ]),
        ])
      : h('div.actions', {}, [
          h('span.card-sub', { text: 'The CEO is ruling on this…' }),
          h('button.btn.btn-sm', {
            text: 'Call it up to me',
            onclick: () => guard(() => api.escalate(approval.id), 'Called up.', true),
          }),
        ]),
  ]);
}

// --- staff, departments, projects, components, settings ---------------------

function renderStaffPanel() {
  const rows = state.snapshot.agents.map((agent) => {
    const status = statusOf(agent.id);
    const dept = deptById(agent.departmentId);
    return h('div.card', {}, [
      h('div.card-head', {}, [
        portrait(agent),
        h('div', { style: { flex: '1', minWidth: '0' } }, [
          h('div.card-title', { text: `${agent.name}${agent.isCeo ? ' ♛' : ''}` }),
          h('div.card-sub', { text: `${agent.title} · ${dept?.name || '—'}` }),
        ]),
        h('span.pill.pill-status', {
          text: status,
          style: { color: STATUS_COLORS[status], borderColor: STATUS_COLORS[status] },
        }),
      ]),
      h('div.actions', {}, [
        h('button.btn.btn-sm', { text: 'Open', onclick: () => openAgent(agent.id) }),
        status === 'offline' || status === 'error'
          ? h('button.btn.btn-primary.btn-sm', {
              text: 'Call to duty',
              onclick: () => guard(() => api.hire(agent.id), `${agent.name} reports for duty.`),
            })
          : h('button.btn.btn-sm', {
              text: 'Send home',
              onclick: () => guard(() => api.dismiss(agent.id), `${agent.name} goes home.`),
            }),
      ]),
    ]);
  });

  setPanel('STAFF', [
    h('div.actions', { style: { marginBottom: '12px' } }, [
      h('button.btn.btn-gold', { text: '+ Hire someone', onclick: openHireForm }),
      h('button.btn.btn-sm', {
        text: 'Call everyone to duty',
        onclick: async () => {
          for (const agent of state.snapshot.agents) {
            if (statusOf(agent.id) === 'offline') await api.hire(agent.id).catch(() => {});
          }
          toast({ title: 'The office is at work', kind: 'done' });
        },
      }),
    ]),
    ...rows,
    state.snapshot.visitors.length &&
      h('h4', { text: 'Visiting sessions', style: { margin: '18px 0 8px', color: 'var(--gold)' } }),
    ...state.snapshot.visitors.map((v) =>
      h('div.card', {}, [
        h('div.card-title', { text: v.name || v.sessionId?.slice(0, 8) || 'session', style: { fontSize: '12px' } }),
        h('div.card-sub', { text: `${v.status} · ${v.cwd || ''}` }),
        h('div.card-sub', { text: 'Started outside the office — watched, not commanded.' }),
      ])
    ),
  ]);
}

function openHireForm() {
  const snapshot = state.snapshot;
  const form = {};
  const name = (form.name = h('input', { type: 'text', placeholder: 'Cassia' }));
  const title = (form.title = h('input', { type: 'text', placeholder: 'Senior Engineer' }));
  const dept = (form.departmentId = h('select', {}, snapshot.departments.map((d) =>
    h('option', { value: d.id }, [`${d.name} (${snapshot.agents.filter((a) => a.departmentId === d.id).length}/${d.seats} seats)`])
  )));
  const supervisor = (form.supervisorId = h('select', {}, [
    h('option', { value: '' }, ['— the CEO —']),
    ...snapshot.agents.map((a) => h('option', { value: a.id }, [`${a.name} (${a.title})`])),
  ]));
  const model = (form.model = h('select', {}, [
    h('option', { value: 'sonnet' }, ['Sonnet — the workhorse']),
    h('option', { value: 'opus' }, ['Opus — gravest work']),
    h('option', { value: 'haiku' }, ['Haiku — errands']),
  ]));
  const project = (form.projectId = h('select', {}, [
    h('option', { value: '' }, ['— no fixed post —']),
    ...snapshot.projects.map((p) => h('option', { value: p.id }, [p.name])),
  ]));
  const context = (form.context = h('textarea', { rows: 4, placeholder: 'What they are for, and how they should behave.' }));

  openModal('Hire a member of staff', [
    h('div.row', {}, [field('Name', name), field('Title', title)]),
    h('div.row', {}, [field('Department', dept), field('Supervisor', supervisor)]),
    h('div.row', {}, [field('Model', model), field('Project', project)]),
    field('Their context', context),
    h('div.actions', {}, [
      h('button.btn.btn-primary', {
        text: 'Hire',
        onclick: async () => {
          if (!name.value.trim()) return toast({ title: 'They need a name', kind: 'error' });
          try {
            const agent = await api.createAgent({
              name: name.value,
              title: title.value,
              departmentId: dept.value,
              supervisorId: supervisor.value || null,
              model: model.value,
              projectId: project.value || null,
              context: context.value,
            });
            closeModal();
            await refresh();
            toast({ title: `${agent.name} joins the office`, kind: 'done' });
            openAgent(agent.id);
          } catch (err) {
            toast({ title: 'Could not hire', body: err.message, kind: 'error' });
          }
        },
      }),
      h('button.btn', { text: 'Cancel', onclick: closeModal }),
    ]),
  ]);
}

function renderDepartmentsPanel() {
  const cards = state.snapshot.departments.map((dept) => {
    const staff = state.snapshot.agents.filter((a) => a.departmentId === dept.id);
    const seats = h('input', { type: 'number', value: dept.seats, min: String(Math.max(1, staff.length)), max: '24' });
    const name = h('input', { type: 'text', value: dept.name });
    const context = h('textarea', { rows: 3, text: dept.context || '' });
    const theme = h('select', {}, THEME_NAMES.map((t) =>
      h('option', { value: t, selected: t === dept.theme ? true : null }, [t])
    ));

    return h('div.card', {}, [
      h('div.card-head', {}, [
        h('div.card-title', { text: dept.name, style: { flex: '1' } }),
        h('span.pill', { text: `${staff.length}/${dept.seats} seats` }),
      ]),
      h('div.row', {}, [field('Name', name), field('Desks', seats), field('Decor', theme)]),
      field('Department context', context, 'Inherited by everyone who serves here.'),
      h('div.actions', {}, [
        h('button.btn.btn-primary.btn-sm', {
          text: 'Save',
          onclick: () =>
            guard(
              () =>
                api.updateDepartment(dept.id, {
                  name: name.value,
                  seats: Number(seats.value),
                  context: context.value,
                  theme: theme.value,
                }),
              'Department updated.'
            ),
        }),
        h('span.spacer'),
        h('button.btn.btn-danger.btn-sm', {
          text: 'Close department',
          onclick: async () => {
            if (!confirm(`Close ${dept.name}?`)) return;
            await guard(() => api.deleteDepartment(dept.id), `${dept.name} is closed.`);
          },
        }),
      ]),
    ]);
  });

  setPanel('DEPARTMENTS', [
    h('div.actions', { style: { marginBottom: '12px' } }, [
      h('button.btn.btn-gold', { text: '+ Open a department', onclick: openDepartmentForm }),
    ]),
    ...cards,
  ]);
}

function openDepartmentForm() {
  const name = h('input', { type: 'text', placeholder: 'Engineering' });
  const seats = h('input', { type: 'number', value: '6', min: '1', max: '24' });
  const theme = h('select', {}, THEME_NAMES.map((t) => h('option', { value: t }, [t])));
  const context = h('textarea', { rows: 4, placeholder: 'What this department is responsible for.' });

  openModal('Open a department', [
    h('div.row', {}, [field('Name', name), field('Desks', seats), field('Decor', theme)]),
    field('Department context', context),
    h('div.actions', {}, [
      h('button.btn.btn-primary', {
        text: 'Open it',
        onclick: async () => {
          if (!name.value.trim()) return toast({ title: 'It needs a name', kind: 'error' });
          try {
            await api.createDepartment({
              name: name.value,
              seats: Number(seats.value),
              theme: theme.value,
              context: context.value,
            });
            closeModal();
            await refresh();
            map.fit();
            toast({ title: `${name.value} is open for business`, kind: 'done' });
          } catch (err) {
            toast({ title: 'Could not open it', body: err.message, kind: 'error' });
          }
        },
      }),
      h('button.btn', { text: 'Cancel', onclick: closeModal }),
    ]),
  ]);
}

function renderProjectsPanel() {
  const cards = state.snapshot.projects.map((project) => {
    const staff = state.snapshot.agents.filter((a) => a.projectId === project.id);
    return h('div.card', {}, [
      h('div.card-title', { text: project.name }),
      h('div.card-sub', { text: project.directory }),
      project.description && h('div.card-sub', { text: project.description }),
      h('div.card-sub', {
        text: staff.length ? `Staffed by ${staff.map((a) => a.name).join(', ')}` : 'No one is posted here.',
      }),
      h('div.actions', {}, [
        h('button.btn.btn-danger.btn-sm', {
          text: 'Remove',
          onclick: async () => {
            if (!confirm(`Remove the project ${project.name}? The directory itself is untouched.`)) return;
            await guard(() => api.deleteProject(project.id), 'Project removed.');
          },
        }),
      ]),
    ]);
  });

  setPanel('PROJECTS', [
    h('div.hint', { text: 'A project is a directory on this machine. Staff posted to one work there.', style: { marginBottom: '10px' } }),
    h('div.actions', { style: { marginBottom: '12px' } }, [
      h('button.btn.btn-gold', { text: '+ Add a project', onclick: openProjectForm }),
    ]),
    ...(cards.length ? cards : [h('div.empty', { text: 'No projects yet.' })]),
  ]);
}

function openProjectForm() {
  const name = h('input', { type: 'text', placeholder: 'MarcosOffices' });
  const directory = h('input', { type: 'text', placeholder: 'D:\\MARCOS\\Git\\MarcosOffices' });
  const description = h('textarea', { rows: 3, placeholder: 'What this project is.' });
  const listing = h('div.dir-list');
  const current = h('div.dir-current', { text: 'loading…' });

  const browse = async (path) => {
    try {
      const result = await api.browse(path);
      current.textContent = result.path;
      directory.value = result.path;
      listing.replaceChildren(
        ...(result.parent ? [h('div.dir-item', { text: '.. (up)', onclick: () => browse(result.parent) })] : []),
        ...result.directories.map((d) =>
          h('div.dir-item', { text: `📁 ${d.name}`, onclick: () => browse(d.path) })
        )
      );
    } catch (err) {
      current.textContent = err.message;
    }
  };
  browse();

  openModal('Add a project', [
    field('Name', name),
    field('Directory', directory),
    h('div.field', {}, [h('label', { text: 'Or browse' }), current, listing]),
    field('Description', description),
    h('div.actions', {}, [
      h('button.btn.btn-primary', {
        text: 'Add it',
        onclick: async () => {
          try {
            await api.createProject({
              name: name.value || directory.value.split(/[\\/]/).pop(),
              directory: directory.value,
              description: description.value,
            });
            closeModal();
            await refresh();
            toast({ title: 'Project added', kind: 'done' });
          } catch (err) {
            toast({ title: 'Could not add it', body: err.message, kind: 'error' });
          }
        },
      }),
      h('button.btn', { text: 'Cancel', onclick: closeModal }),
    ]),
  ]);
}

function renderComponentsPanel() {
  const { skills = [], mcpServers = [] } = state.snapshot.components;

  setPanel('COMPONENTS', [
    h('div.hint', {
      text: 'Everything the office has to hand. Enable them per agent in their Configuration tab.',
      style: { marginBottom: '12px' },
    }),

    h('h4', { text: `Skills (${skills.length})`, style: { margin: '6px 0 8px', color: 'var(--gold)' } }),
    skills.length
      ? h('div', {}, skills.map((s) =>
          h('div.card', {}, [
            h('div.card-head', {}, [
              h('div.card-title', { text: s.name, style: { flex: '1', fontSize: '12px' } }),
              h('span.pill', { text: s.source }),
            ]),
            s.description && h('div.card-sub', { text: s.description }),
          ])
        ))
      : h('div.empty', { text: 'No skills found in ~/.claude/skills or your projects.' }),

    h('h4', { text: `MCP servers (${mcpServers.length})`, style: { margin: '18px 0 8px', color: 'var(--gold)' } }),
    h('div.actions', { style: { marginBottom: '10px' } }, [
      h('button.btn.btn-sm', { text: '+ Register a server', onclick: openMcpForm }),
    ]),
    mcpServers.length
      ? h('div', {}, mcpServers.map((m) =>
          h('div.card', {}, [
            h('div.card-head', {}, [
              h('div.card-title', { text: m.name, style: { flex: '1', fontSize: '12px' } }),
              h('span.pill', { text: m.transport }),
            ]),
            h('div.card-sub', { text: m.summary || m.source }),
          ])
        ))
      : h('div.empty', { text: 'No MCP servers configured.' }),

    h('h4', { text: 'Built in', style: { margin: '18px 0 8px', color: 'var(--gold)' } }),
    h('div.card', {}, [
      h('div.card-title', { text: 'office', style: { fontSize: '12px' } }),
      h('div.card-sub', {
        text:
          'send_message · check_inbox · request_approval · remember · recall · roster · petition_lord. ' +
          'Granted to every member of staff automatically.',
      }),
    ]),
  ]);
}

function openMcpForm() {
  const name = h('input', { type: 'text', placeholder: 'my-server' });
  const config = h('textarea', {
    rows: 8,
    text: JSON.stringify({ command: 'npx', args: ['-y', 'some-mcp-server'] }, null, 2),
  });

  openModal('Register an MCP server', [
    field('Name', name),
    field('Configuration (JSON)', config, 'The same shape you would put in .mcp.json.'),
    h('div.actions', {}, [
      h('button.btn.btn-primary', {
        text: 'Register',
        onclick: async () => {
          try {
            await api.addMcp(name.value, JSON.parse(config.value));
            closeModal();
            await refresh();
            toast({ title: 'Server registered', kind: 'done' });
          } catch (err) {
            toast({ title: 'Could not register it', body: err.message, kind: 'error' });
          }
        },
      }),
      h('button.btn', { text: 'Cancel', onclick: closeModal }),
    ]),
  ]);
}

function renderSettingsPanel() {
  const office = state.snapshot.office;
  const auth = state.snapshot.auth || {};

  const name = h('input', { type: 'text', value: office.name });
  const lordName = h('input', { type: 'text', value: office.lordName });
  const motto = h('input', { type: 'text', value: office.motto || '' });
  const charter = h('textarea', { rows: 6, text: office.charter || '' });
  const ceo = h('select', {}, state.snapshot.agents.map((a) =>
    h('option', { value: a.id, selected: a.id === office.ceoAgentId ? true : null }, [`${a.name} (${a.title})`])
  ));

  setPanel('THE OFFICE', [
    h('div.card', {}, [
      h('div.card-title', { text: 'Claude account' }),
      h('div.card-sub', {
        text: auth.loggedIn
          ? `Signed in as ${auth.email} · ${auth.authMethod || ''} ${auth.subscriptionType ? `· ${auth.subscriptionType}` : ''}`
          : 'Not signed in. Agents cannot work until you are.',
      }),
      h('div.actions', {}, [
        h('button.btn.btn-sm', {
          text: auth.loggedIn ? 'Re-check' : 'Sign in',
          onclick: async () => {
            if (!auth.loggedIn) await api.login().catch(() => {});
            await refresh();
            renderPanel();
          },
        }),
      ]),
    ]),

    field('Office name', name),
    field('How they address you', lordName),
    field('Motto', motto),
    field('The charter', charter, 'The founding context every member of staff inherits.'),
    field('Chief Executive Officer', ceo, 'Sits at the top and rules on proposals from below.'),

    h('div.actions', {}, [
      h('button.btn.btn-primary', {
        text: 'Save',
        onclick: () =>
          guard(
            () =>
              api.office({
                name: name.value,
                lordName: lordName.value,
                motto: motto.value,
                charter: charter.value,
                ceoAgentId: ceo.value,
              }),
            'The office is reformed.'
          ),
      }),
    ]),

    h('div.hint', { text: `State lives in ${state.snapshot.dataDir}`, style: { marginTop: '14px' } }),
  ]);
}

// --- modal ------------------------------------------------------------------

function openModal(title, body) {
  $('#modal-title').textContent = title;
  $('#modal-body').replaceChildren(...[].concat(body));
  $('#modal-backdrop').hidden = false;
}

function closeModal() {
  $('#modal-backdrop').hidden = true;
}

/** Run an API call, report the outcome honestly, and refresh. */
async function guard(fn, successMessage, quiet = false) {
  try {
    await fn();
    if (!quiet && successMessage) toast({ title: successMessage, kind: 'done' });
    await refresh();
    if (state.panel) renderPanel();
  } catch (err) {
    toast({ title: 'That failed', body: err.message, kind: 'error' });
  }
}

boot().catch((err) => {
  document.body.innerHTML =
    `<div style="padding:40px;font-family:monospace;color:#d4574e">` +
    `Could not open the office: ${err.message}</div>`;
});
