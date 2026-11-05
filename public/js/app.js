/**
 * Marcos Offices — the front of house.
 *
 * Holds the snapshot of the office, keeps it in step with the server over SSE,
 * and renders whichever panel Lord Marcos has open.
 */
import { api, connectEvents } from './api.js';
import { OfficeMap } from './office.js';
import { STATUS_COLORS, THEME_NAMES, agentSprite, themeFor } from './sprites.js';
import { markdownNode } from './markdown.js';
import { openWindow, closeWindow, isWindowOpen, refreshWindow } from './windows.js';
import { HierarchyTree } from './tree.js';

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
    // `cond && node` yields 0 for an empty-length condition, which would
    // otherwise print a stray "0". Text always arrives via the `text` prop,
    // so a bare 0 here is never something we meant to show.
    if (child == null || child === false || child === 0) continue;
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

/** Costs here are usually fractions of a cent, so four decimals earn their place. */
function money(n) {
  const v = Number(n) || 0;
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

/**
 * A passing notice. When it names an agent, clicking it takes you there —
 * a notification you cannot act on is just noise.
 */
function toast({ title, body = '', kind = 'info', timeout = 6000, agentId = null }) {
  const el = h('div.toast', { 'data-kind': kind, 'data-goes-somewhere': String(!!agentId) }, [
    h('div.toast-title', { text: title }),
    body && h('div.toast-body', { text: String(body).slice(0, 240) }),
    agentId && h('div.toast-go', { text: 'Click to open →' }),
  ]);

  el.addEventListener('click', () => {
    if (agentId && agentById(agentId)) {
      openAgent(agentId);
      map.focusAgent(agentId);
      if (view === 'tree') tree.select(agentId);
    }
    el.remove();
  });

  $('#toasts').append(el);
  setTimeout(() => el.remove(), timeout);
}

// --- application state ------------------------------------------------------

const state = {
  snapshot: null,
  selectedAgentId: null,
  panel: null, // 'agent' | 'sanctions' | 'inbox' | 'dispatches' | 'staff' | ...
  agentTab: 'orders',
  activity: [], // for the open agent
  todos: [], // their current task list
  // Unsent order text, per agent. The panel re-renders whenever an agent's
  // status changes, which would otherwise throw away what you were typing.
  drafts: {},
};

let map = null;
let tree = null;
let view = 'office'; // 'office' | 'tree'

const agentById = (id) => state.snapshot?.agents.find((a) => a.id === id) || null;
const deptById = (id) => state.snapshot?.departments.find((d) => d.id === id) || null;
const statusOf = (id) => state.snapshot?.workers?.[id]?.status || 'offline';

const pendingApprovals = () =>
  (state.snapshot?.approvals || []).filter((a) => a.status === 'pending' && a.route === 'lord');

const unreadNotifications = () =>
  (state.snapshot?.notifications || []).filter((n) => !n.read);

/** Everything the staff have addressed to Lord Marcos. */
const lordInbox = () =>
  (state.snapshot?.messages || []).filter((m) => m.toAgentId === 'lord');

const unreadInbox = () => lordInbox().filter((m) => !m.read);

/** Resolve a message sender for display: agents, or the Lord himself. */
function senderName(id) {
  if (id === 'lord') return state.snapshot?.office?.lordName || 'Lord Marcos';
  return agentById(id)?.name || 'unknown';
}

// --- boot -------------------------------------------------------------------

async function boot() {
  const canvas = $('#office-canvas');

  map = new OfficeMap(canvas, {
    onSelectAgent: (id) => openAgent(id),
    onSelectVisitor: (id) => openVisitor(id),
    onSelectDepartment: (id) => openPanel('departments', { highlight: id }),
    onBackground: () => closePanel(),
  });

  tree = new HierarchyTree($('#tree-view'), {
    onSelectAgent: (id) => openAgent(id),
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
  tree?.setState(state.snapshot);
  if (view === 'tree') tree.render();
  renderAuth();
  renderBadges();
}

/** Swap between the floor plan and the chain of command. */
function setView(next) {
  view = next;
  $('#office-canvas').hidden = next !== 'office';
  $('#tree-view').hidden = next !== 'tree';
  $('#btn-view-office').dataset.active = String(next === 'office');
  $('#btn-view-tree').dataset.active = String(next === 'tree');

  if (next === 'tree') {
    tree.setState(state.snapshot);
    tree.render();
    tree.select(state.selectedAgentId);
  } else {
    map.resize();
  }
}

function wireChrome() {
  for (const btn of document.querySelectorAll('[data-panel]')) {
    btn.addEventListener('click', () => {
      const name = btn.dataset.panel;
      state.panel === name ? closePanel() : openPanel(name);
    });
  }

  $('#side-close').addEventListener('click', closePanel);
  $('#btn-view-office').addEventListener('click', () => setView('office'));
  $('#btn-view-tree').addEventListener('click', () => setView('tree'));
  // The zoom controls drive whichever view is showing.
  $('#btn-fit').addEventListener('click', () => (view === 'tree' ? tree.fit() : map.fit()));
  $('#btn-zoom-in').addEventListener('click', () => {
    if (view === 'tree') return tree.zoomBy(1.2);
    map.camera.zoomIndex = Math.min(map.maxZoomIndex, map.camera.zoomIndex + 1);
  });
  $('#btn-zoom-out').addEventListener('click', () => {
    if (view === 'tree') return tree.zoomBy(1 / 1.2);
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

  wireSideResize();

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

/** Let the right-hand panel be dragged wider or narrower, and remember it. */
function wireSideResize() {
  const side = $('#side');
  const grip = $('#side-resize');

  const stored = Number(localStorage.getItem('mo.sideWidth'));
  if (stored >= 320) side.style.setProperty('--side-w', `${stored}px`);

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing');

    const move = (ev) => {
      // The panel is anchored right, so width grows as the pointer moves left.
      const width = Math.min(
        Math.max(window.innerWidth - ev.clientX, 320),
        Math.max(360, window.innerWidth - 240)
      );
      side.style.setProperty('--side-w', `${Math.round(width)}px`);
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      const width = parseInt(side.style.getPropertyValue('--side-w'), 10);
      if (width) {
        try {
          localStorage.setItem('mo.sideWidth', String(width));
        } catch {
          /* private browsing; the width simply will not persist */
        }
      }
      map.resize();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
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
  const counts = {
    sanctions: pendingApprovals().length,
    inbox: unreadInbox().length,
    dispatches: unreadNotifications().length,
  };

  for (const [name, count] of Object.entries(counts)) {
    const badge = $(`#badge-${name}`);
    if (!badge) continue;
    badge.hidden = count === 0;
    badge.textContent = String(count);
  }
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
      // Only the status strip changes, so leave the rest of the panel — and
      // the reader's scroll position and half-typed order — alone.
      refreshAgentSubhead(data.agentId);
      syncAgentWindow(data.agentId);
      break;
    }

    case 'agent.activity': {
      if (state.panel === 'agent' && state.selectedAgentId === data.agentId) {
        state.activity.push(data);
      }
      // Feeds find themselves by agent id, so this reaches the side panel and
      // every floating window showing this agent.
      appendActivity(data);
      break;
    }

    case 'agent.commands': {
      if (state.snapshot?.workers?.[data.agentId]) {
        state.snapshot.workers[data.agentId].commands = data.commands;
      }
      // Re-render so the order box learns what it can offer.
      if (state.panel === 'agent' && state.selectedAgentId === data.agentId) renderPanel();
      break;
    }

    case 'agent.todos': {
      if (state.selectedAgentId === data.agentId) {
        state.todos = data.todos || [];
        if (state.panel === 'agent' && state.agentTab === 'activity') renderPanel();
      }
      break;
    }

    case 'agent.stats': {
      const agent = agentById(data.agentId);
      if (agent) agent.stats = data.stats;
      if (['agent', 'dispatches', 'staff'].includes(state.panel)) {
        renderPanel();
      }
      break;
    }

    case 'visitors':
      if (state.snapshot) state.snapshot.visitors = data;
      map.visitors = data;
      break;

    case 'approval.new':
    case 'approval.escalated': {
      await reloadApprovals();
      // Put it in front of whoever is watching this agent, wherever they are
      // watching from. Without this a question raised while the panel was
      // already open never appeared in the agent's own chat.
      showApprovalInFeeds(data);
      if (data.route === 'lord') {
        toast({
          title:
            data.kind === 'question'
              ? `${data.agentName} asks you a question`
              : `${data.agentName} awaits your word`,
          body: data.title,
          kind: 'approval',
          timeout: 12000,
          agentId: data.agentId,
        });
      }
      break;
    }

    case 'approval.decided': {
      await reloadApprovals();
      // Swap the live card for the outcome, rather than leaving a dead form.
      for (const card of document.querySelectorAll(
        `[data-approval="${CSS.escape(data.id)}"]`
      )) {
        card.replaceWith(approvalOutcomeNode(data));
      }
      break;
    }

    case 'notification.new': {
      state.snapshot?.notifications.unshift(data);
      renderBadges();
      toast({ title: data.title, body: data.body, kind: data.kind, agentId: data.agentId });
      if (state.panel === 'dispatches') renderPanel();
      break;
    }

    case 'message.new': {
      state.snapshot?.messages.unshift(data);
      renderBadges();
      if (data.toAgentId === 'lord') {
        toast({
          title: `${senderName(data.fromAgentId)} writes to you`,
          body: data.subject,
          kind: 'petition',
          timeout: 10000,
          agentId: data.fromAgentId,
        });
      }
      if (state.panel === 'inbox' || state.panel === 'agent') renderPanel();
      break;
    }

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
  // The agent panel keeps its own live cards, so only re-render the lists.
  if (state.panel === 'sanctions') renderPanel();
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
  tree?.select(id);
  openPanel('agent');

  try {
    const { activity, todos } = await api.activity(id);
    state.activity = activity;
    state.todos = todos || [];
    if (state.panel === 'agent' && state.selectedAgentId === id) renderPanel();
  } catch {
    state.activity = [];
    state.todos = [];
  }
}

function setPanel(title, body) {
  // A title may be a plain string or a composed node (an agent's portrait and
  // name, for instance).
  if (title instanceof Node) $('#side-title').replaceChildren(title);
  else $('#side-title').textContent = title;

  // replaceChildren stringifies whatever it is given, so a `cond ? node : null`
  // would print "null". Drop the empties the way h() does.
  $('#side-body').replaceChildren(
    ...[].concat(body).filter((n) => n != null && n !== false && n !== 0)
  );
}

function renderPanel() {
  switch (state.panel) {
    case 'agent': return renderAgentPanel();
    case 'visitor': return renderVisitorPanel();
    case 'sanctions': return renderSanctionsPanel();
    case 'inbox': return renderInboxPanel();
    case 'dispatches': return renderDispatchesPanel();
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

  // The title carries the portrait and the name, in the panel's own heading
  // style; everything factual sits beneath it in one grey line.
  const heading = h('div.agent-heading', {}, [
    portrait(agent, 22, 33),
    h('span', {
      text: `${agent.name.toUpperCase()} — ${agent.title}` +
        `${agent.isCeo ? ' ♛' : ''}${agent.canManageOffice ? ' ⚙' : ''}`,
    }),
  ]);

  const header = buildAgentSubhead(agent);
  const body = h('div.panel-content');
  const nav = tabs(
    [
      ['orders', 'Orders'],
      ['activity', 'Activity'],
      ['mail', 'Mail'],
      ['config', 'Configuration'],
      ['memory', 'Memory'],
    ],
    state.agentTab,
    (key) => {
      state.agentTab = key;
      renderPanel();
    }
  );

  setPanel(heading, [header, nav, body]);
  // The Orders tab manages its own scrolling so the order box can sit at the
  // bottom; every other tab scrolls as a normal document.
  $('#side-body').dataset.layout = state.agentTab === 'orders' ? 'console' : 'scroll';

  if (state.agentTab === 'orders') renderOrders(body, agent);
  else if (state.agentTab === 'activity') renderActivity(body);
  else if (state.agentTab === 'mail') renderAgentMail(body, agent);
  else if (state.agentTab === 'config') renderAgentConfig(body, agent);
  else renderAgentMemory(body, agent);
}

/**
 * The line of facts and controls under an agent's name.
 *
 * Built separately so a status change can refresh just this strip instead of
 * the whole panel — a full re-render would throw away the reader's scroll
 * position and whatever they were part-way through typing.
 */
function buildAgentSubhead(agent) {
  const status = statusOf(agent.id);
  const dept = deptById(agent.departmentId);
  const supervisor = agent.supervisorId ? agentById(agent.supervisorId) : null;
  const stats = agent.stats || {};

  return h('div.agent-subhead', {}, [
    h('span.agent-facts', {
      text:
        `${dept?.name || 'unassigned'} · ${money(stats.totalCostUsd)} over ` +
        `${stats.tasks || 0} task(s)` +
        `${stats.errors ? ` · ${stats.errors} failure(s)` : ''}` +
        `${supervisor ? ` · reports to ${supervisor.name}` : ''}`,
    }),

    h('span.agent-controls', {}, [
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
      h('button.btn.btn-sm', {
        text: '✦ New session',
        title: 'Leave this conversation behind and start a fresh one',
        onclick: async () => {
          if (
            !confirm(
              `Start a fresh conversation for ${agent.name}?\n\n` +
                `Their current one is kept and can be picked up again from ` +
                `Configuration. Their memory and standing orders are unaffected.`
            )
          ) {
            return;
          }
          await guard(() => api.switchSession(agent.id, null), 'A fresh conversation.');
        },
      }),
      h('button.btn.btn-sm', { text: '⌖ Find', onclick: () => map.focusAgent(agent.id) }),
      h('button.btn.btn-sm', {
        text: '⧉ Pop out',
        title: 'Open a floating console, so you can watch several agents at once',
        onclick: () => openAgentWindow(agent.id),
      }),
    ]),

    h('span.pill.pill-status', {
      text: status,
      style: { color: STATUS_COLORS[status], borderColor: STATUS_COLORS[status] },
    }),
  ]);
}

/** Refresh only the facts-and-controls strip for an agent, if it is showing. */
function refreshAgentSubhead(agentId) {
  if (state.panel !== 'agent' || state.selectedAgentId !== agentId) return;
  const agent = agentById(agentId);
  const existing = $('#side-body')?.querySelector('.agent-subhead');
  if (agent && existing) existing.replaceWith(buildAgentSubhead(agent));
}

/**
 * Which project this agent is posted to, and a way to change it without
 * digging through the Configuration tab.
 */
function projectRow(agent) {
  const project = agent.projectId ? state.snapshot.projects.find((p) => p.id === agent.projectId) : null;

  const picker = h(
    'select',
    {
      onchange: async (e) => {
        const projectId = e.target.value || null;
        try {
          const result = await api.updateAgent(agent.id, { projectId });
          await refresh();
          renderPanel();
          toast({
            title: projectId
              ? `${agent.name} is posted to ${state.snapshot.projects.find((p) => p.id === projectId)?.name}`
              : `${agent.name} has no fixed post`,
            body: result.restartRequired
              ? 'Send them home and recall them for the move to take effect.'
              : '',
            kind: result.restartRequired ? 'approval' : 'done',
          });
        } catch (err) {
          toast({ title: 'Could not reassign them', body: err.message, kind: 'error' });
        }
      },
    },
    [
      h('option', { value: '' }, ['— no fixed post —']),
      ...state.snapshot.projects.map((p) =>
        h('option', { value: p.id, selected: p.id === agent.projectId ? true : null }, [p.name])
      ),
    ]
  );

  return h('div.project-row', {}, [
    h('div.project-label', { text: 'PROJECT' }),
    picker,
    h('div.card-sub', {
      text: project
        ? project.directory
        : state.snapshot.projects.length
          ? 'They work from your home directory until posted.'
          : 'No projects yet — add one under Projects.',
    }),
  ]);
}

/**
 * An agent keeps every conversation they have held. Switching between them
 * restarts the agent on that conversation, so they pick it up with its full
 * history; starting a new one leaves the old ones untouched.
 */
function sessionRow(agent) {
  const sessions = agent.sessions || [];
  if (!sessions.length) return null;

  const current = agent.lastSessionId;

  const picker = h(
    'select',
    {
      onchange: async (e) => {
        const sessionId = e.target.value || null;
        await guard(
          () => api.switchSession(agent.id, sessionId),
          sessionId ? 'Picked up that conversation.' : 'Started a fresh conversation.'
        );
      },
    },
    [
      ...sessions.map((s, i) =>
        h('option', { value: s.id, selected: s.id === current ? true : null }, [
          `${s.title || `Session ${i + 1}`} — ${new Date(s.startedAt).toLocaleDateString()}`,
        ])
      ),
      h('option', { value: '' }, ['+ Start a new conversation']),
    ]
  );

  const rename = h('button.btn.btn-sm', {
    text: '✎',
    title: 'Rename this conversation',
    onclick: async () => {
      const session = sessions.find((s) => s.id === current);
      if (!session) return;
      const title = prompt('Name this conversation:', session.title || '');
      if (!title?.trim()) return;
      await guard(() => api.renameSession(agent.id, current, title), 'Renamed.');
    },
  });

  return h('div.project-row', {}, [
    h('div.project-label', { text: 'SESSION' }),
    h('div.resume-line', {}, [picker, rename]),
    h('div.card-sub', {
      text:
        `${sessions.length} conversation(s). Switching sends them home and brings ` +
        `them back on the one you choose.`,
    }),
  ]);
}

/**
 * The command to open this agent's actual conversation in a real terminal.
 *
 * The office drives agents through the SDK, which is what makes the approval
 * gate and the office tools work — but the conversation is an ordinary Claude
 * Code session, so you can always pick it up by hand.
 */
function resumeRow(agent) {
  const sessionId = state.snapshot.workers?.[agent.id]?.sessionId || agent.lastSessionId;
  if (!sessionId) return null;

  const project = agent.projectId
    ? state.snapshot.projects.find((p) => p.id === agent.projectId)
    : null;
  const command = project
    ? `cd "${project.directory}"; claude --resume ${sessionId}`
    : `claude --resume ${sessionId}`;

  const copy = h('button.btn.btn-sm', {
    text: '⧉ Copy',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(command);
        copy.textContent = '✓ Copied';
        setTimeout(() => (copy.textContent = '⧉ Copy'), 1500);
      } catch {
        // Clipboard can be refused; selecting the text is the fallback.
        field.select();
        toast({ title: 'Press Ctrl+C to copy', kind: 'info' });
      }
    },
  });

  const field = h('input.resume-cmd', {
    type: 'text',
    value: command,
    readonly: true,
    onclick: (e) => e.target.select(),
  });

  return h('div.resume-row', {}, [
    h('div.project-label', { text: 'TERMINAL' }),
    h('div.resume-line', {}, [field, copy]),
    h('div.card-sub', {
      text:
        'Opens this agent\'s own conversation in a real terminal. Note: the office ' +
        'cannot gate tools or offer its instruments in a session it does not drive — ' +
        'so send them home here first, or you will both be talking at once.',
    }),
  ]);
}

/** A live-rendered portrait of the agent, from the same sprite the map uses. */
function portrait(agent, w = 32, h = 48) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  Object.assign(canvas.style, { imageRendering: 'pixelated', flex: 'none' });

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    agentSprite(agent.appearance?.seed || agent.id, {
      outfit: agent.isCeo ? 'suit' : agent.appearance?.outfit || 'shirt',
    }),
    0, 0, w, h
  );
  return canvas;
}

/**
 * The agent console: their activity feed, with the order box pinned beneath it.
 *
 * Used by both the right-hand panel and every floating window, so an agent
 * behaves identically wherever you are watching them from.
 */
function buildAgentConsole(agent, { activity, showNote = true } = {}) {
  const input = h('textarea', {
    placeholder: `Speak, and ${agent.name} obeys…`,
    rows: 1,
    text: state.drafts[agent.id] || '',
  });

  /**
   * Grow with the text so a long order is readable while it is written,
   * stopping at a point where the box would start eating the conversation.
   * The border is added back because scrollHeight covers content and padding
   * only, while a border-box height must also carry the border.
   */
  const ORDER_BOX_MAX = 220;
  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight + 4, ORDER_BOX_MAX)}px`;
  };

  // Keep what is typed, so a re-render mid-sentence does not lose it.
  input.addEventListener('input', () => {
    state.drafts[agent.id] = input.value;
    autoGrow();
  });

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    delete state.drafts[agent.id];
    autoGrow();
    try {
      await api.order(agent.id, text);
    } catch (err) {
      toast({ title: 'The order did not reach them', body: err.message, kind: 'error' });
      // Give it back rather than swallowing what they wrote.
      state.drafts[agent.id] = text;
      input.value = text;
      autoGrow();
    }
  };

  // Slash commands the live session advertises. Typing "/" offers them.
  const commands = state.snapshot?.workers?.[agent.id]?.commands || [];
  const palette = h('div.cmd-palette', { hidden: true });

  const closePalette = () => {
    palette.hidden = true;
    palette.replaceChildren();
  };

  const showPalette = () => {
    const value = input.value;
    // Only while the whole box is a single word starting with a slash.
    const match = /^\/(\w*)$/.exec(value.trim());
    if (!match || !commands.length) return closePalette();

    const matches = commands
      .filter((c) => c.toLowerCase().startsWith(match[1].toLowerCase()))
      .slice(0, 12);
    if (!matches.length) return closePalette();

    palette.replaceChildren(
      ...matches.map((c) =>
        h('button.cmd-item', {
          text: `/${c}`,
          onclick: () => {
            input.value = `/${c} `;
            state.drafts[agent.id] = input.value;
            closePalette();
            autoGrow();
            input.focus();
          },
        })
      )
    );
    palette.hidden = false;
  };

  input.addEventListener('input', showPalette);
  input.addEventListener('blur', () => setTimeout(closePalette, 150));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      closePalette();
      send();
    } else if (e.key === 'Tab' && !palette.hidden) {
      // Tab completes to the first match, like a shell.
      e.preventDefault();
      palette.querySelector('.cmd-item')?.click();
    } else if (e.key === 'Escape') {
      closePalette();
    }
  });

  const waiting = (state.snapshot?.approvals || []).filter(
    (a) => a.status === 'pending' && a.agentId === agent.id
  );

  // The feed is tagged with the agent so live events can find every view of
  // them at once — side panel and floating windows alike. `data-feed-filter`
  // tells appendActivity which entries this particular view wants.
  // Anything still awaiting an answer sits at the END of the conversation,
  // below the history. Rendering it above meant the auto-scroll to the newest
  // line pushed it out of sight, so a question only ever showed if it arrived
  // while you happened to be watching.
  const pending = h('div.feed-pending', {}, waiting.map((a) => approvalCard(a)));

  const scroller = h(
    'div.feed-scroll.terminal',
    { 'data-feed-agent': agent.id, 'data-feed-filter': 'terminal' },
    [
      showNote &&
        h('div.lord-note', {
          text:
            'You speak as Lord Marcos, their god and employer. They address you as ' +
            'The Lord Almighty, He Who Is Everywhere and Rules Over All.',
        }),
      h(
        'div.feed.feed-term',
        {},
        (activity || []).filter(isTerminal).slice(-400).map(terminalNode)
      ),
      pending,
    ]
  );

  const console_ = h('div.console', {}, [
    scroller,
    h('div.order-box', {}, [
      palette,
      h('div.order-line', {}, [
        input,
        h('button.btn.btn-gold.order-send', {
          text: '↑',
          // The shortcut lives here now rather than as a line of chrome.
          title: commands.length
            ? `Issue order (Ctrl+Enter) · type / for ${commands.length} commands`
            : 'Issue order (Ctrl+Enter)',
          onclick: send,
        }),
      ]),
    ]),
  ]);

  // Start at the newest entry, and size a restored draft to fit.
  requestAnimationFrame(() => {
    scroller.scrollTop = scroller.scrollHeight;
    autoGrow();
  });

  return console_;
}

function renderOrders(container, agent) {
  container.replaceChildren(buildAgentConsole(agent, { activity: state.activity }));
}

/** The milestone view: the plan, and the notable things that happened. */
function renderActivity(container) {
  const entries = state.activity.filter(isMilestone);
  const todos = state.todos || [];

  container.replaceChildren(
    h('div.hint', {
      text:
        'The steps they set themselves and how the work is going. The full terminal ' +
        'is under Orders.',
      style: { marginBottom: '10px' },
    }),

    todos.length
      ? h('div.card', {}, [
          h('div.card-title', { text: 'Current plan', style: { marginBottom: '8px' } }),
          h(
            'div.todo-list',
            {},
            todos.map((t) =>
              h(`div.todo.todo-${t.status}`, {}, [
                h('span.todo-mark', {
                  text: t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○',
                }),
                h('span', {
                  text: t.status === 'in_progress' ? t.activeForm || t.content : t.content,
                }),
              ])
            )
          ),
        ])
      : null,

    entries.length
      ? h(
          'div.feed-scroll',
          { 'data-feed-agent': state.selectedAgentId, 'data-feed-filter': 'milestone' },
          [h('div.feed', {}, entries.slice(-300).map(activityNode))]
        )
      : h('div.empty', { text: 'No milestones recorded yet.' })
  );
}

/**
 * One line of the terminal, rendered the way the CLI renders it: the order you
 * typed, their prose, the tools they ran and what came back.
 */
function terminalNode(entry) {
  const text = String(entry.text ?? '');

  switch (entry.kind) {
    case 'order':
      return h('div.term-line.term-order', {}, [
        h('span.term-caret', { text: '>' }),
        h('span', { text }),
      ]);

    case 'say':
      return h('div.term-line.term-say', {}, [
        h('span.term-bullet', { text: '⏺' }),
        markdownNode(text.slice(0, 20000)),
      ]);

    case 'thinking':
      return collapsible('✻ Thinking', markdownNode(text.slice(0, 20000)), 'term-thinking');

    case 'tool': {
      const head = h('div.term-line.term-tool', {}, [
        h('span.term-bullet', { text: '⏺' }),
        h('span.term-toolname', { text: entry.toolName || 'tool' }),
        h('span.term-toolarg', { text: text ? `(${text})` : '' }),
      ]);
      if (!entry.toolInput) return head;
      return h('div', {}, [
        head,
        collapsible('arguments', h('pre.term-pre', { text: safeStringify(entry.toolInput) }), 'term-args'),
      ]);
    }

    case 'tool_result': {
      const body = h('pre.term-pre', { text: text.slice(0, 4000) });
      const label = entry.isError ? '⎿ failed' : '⎿ result';
      // Short results are worth showing outright; long ones fold away.
      return text.length > 400
        ? collapsible(label, body, entry.isError ? 'term-err' : 'term-res')
        : h(`div.term-result${entry.isError ? '.term-err' : ''}`, {}, [
            h('span.term-pipe', { text: '⎿' }),
            body,
          ]);
    }

    case 'result':
      return h('div.term-line.term-done', {
        text:
          `${entry.ok === false ? '✗' : '✓'} ${text}` +
          (entry.turns ? ` · ${entry.turns} turns` : '') +
          (entry.cost ? ` · ${money(entry.cost)}` : ''),
      });

    case 'error':
    case 'stderr':
      return h('div.term-line.term-err', { text: `✗ ${text.slice(0, 4000)}` });

    default:
      return h('div.term-line.term-sys', { text: `· ${text.slice(0, 2000)}` });
  }
}

/** A fold-away block, closed by default. */
function collapsible(label, body, className = '') {
  const details = h(`details.term-fold.${className || 'term-fold-plain'}`);
  details.append(h('summary', { text: label }), body);
  return details;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * The two views of an agent's record.
 *
 * ORDERS is the conversation — what you said, what they said back, and nothing
 * else, as you would see it in the Claude CLI. ACTIVITY is the operational
 * log: what they actually did, what they asked leave for, and how it ended.
 */
// The terminal shows everything the CLI would show you.
const TERMINAL_KINDS = new Set([
  'order', 'say', 'thinking', 'tool', 'tool_result', 'result', 'error', 'system', 'stderr',
]);

// Milestones are the agent's own account of the work: the steps it set itself,
// what it asked leave for, and how each task ended.
const MILESTONE_KINDS = new Set(['order', 'milestone', 'approval', 'result', 'error']);

const isTerminal = (entry) => TERMINAL_KINDS.has(entry.kind);
const isMilestone = (entry) => MILESTONE_KINDS.has(entry.kind);

const ACTIVITY_LABELS = {
  order: 'ORDER FROM THE LORD',
  say: 'SAYS',
  thinking: 'THINKING',
  tool: null, // filled in from the tool name
  tool_result: 'RESULT',
  milestone: 'STEP',
  approval: 'APPROVAL',
  result: 'TASK COMPLETE',
  error: 'ERROR',
  system: 'OFFICE',
  stderr: 'STDERR',
};

/** Which kinds are worth rendering as markdown rather than plain text. */
const MARKDOWN_KINDS = new Set(['say', 'thinking']);

function activityNode(entry) {
  const label =
    entry.kind === 'tool'
      ? `USES ${entry.toolName || 'a tool'}`
      : entry.kind === 'milestone'
        ? { done: '✓ FINISHED', blocked: '⚠ BLOCKED' }[entry.step] || '▸ STARTED'
        : entry.kind === 'order'
          ? 'TASK ASSIGNED'
          : ACTIVITY_LABELS[entry.kind] || entry.kind.toUpperCase();

  const text = String(entry.text ?? '');
  const body = MARKDOWN_KINDS.has(entry.kind)
    ? markdownNode(text.slice(0, 20000))
    : h('div.act-plain', { text: text.slice(0, 6000) });

  return h(`div.act.act-${entry.kind}`, {}, [
    h('div.act-meta', {}, [
      h('span', { text: timeOf(entry.at) }),
      h('span', { text: label }),
      entry.subagent && h('span', { text: '· subagent' }),
    ]),
    body,
  ]);
}

/**
 * Drop an approval or question into every open feed for that agent, so it
 * appears inline in the conversation where it was raised.
 */
function showApprovalInFeeds(approval) {
  if (!approval?.agentId) return;

  for (const scroller of document.querySelectorAll(
    `[data-feed-agent="${CSS.escape(approval.agentId)}"]`
  )) {
    // Pending items live in their own container at the foot of the feed, so a
    // re-render finds them in the same place a live arrival put them.
    const pending = scroller.querySelector('.feed-pending');
    if (!pending) continue;
    if (pending.querySelector(`[data-approval="${CSS.escape(approval.id)}"]`)) continue;

    pending.append(approvalCard(approval));
    scroller.scrollTop = scroller.scrollHeight;
  }
}

/** What a question or request looks like once it has been settled. */
function approvalOutcomeNode(approval) {
  const answered = approval.decision === 'answered';
  const text = answered
    ? `You answered: ${approval.note}`
    : `${approval.decision === 'approved' ? 'Sanctioned' : 'Refused'}` +
      `${approval.decidedBy === 'ceo' ? ' by the CEO' : ''}` +
      `${approval.note ? ` — ${approval.note}` : ''}`;

  return h(`div.act.act-approval`, { 'data-approval': approval.id }, [
    h('div.act-meta', {}, [
      h('span', { text: timeOf(approval.decidedAt || Date.now()) }),
      h('span', { text: answered ? 'ANSWERED' : 'DECIDED' }),
    ]),
    h('div.act-plain', { text: `${approval.title}\n${text}` }),
  ]);
}

/** Push a new entry into every open view of that agent that wants it. */
function appendActivity(entry) {
  if (!entry.agentId) return;

  for (const scroller of document.querySelectorAll(
    `[data-feed-agent="${CSS.escape(entry.agentId)}"]`
  )) {
    const terminal = scroller.dataset.feedFilter === 'terminal';
    if (terminal ? !isTerminal(entry) : !isMilestone(entry)) continue;

    const feed = scroller.querySelector('.feed');
    if (!feed) continue;

    // Only follow the tail if the reader was already at the bottom.
    const atBottom =
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 80;
    feed.append(terminal ? terminalNode(entry) : activityNode(entry));
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  }
}

// --- floating agent windows -------------------------------------------------

const winKey = (agentId) => `agent:${agentId}`;

/** Open a floating console for an agent, so several can be watched at once. */
async function openAgentWindow(agentId) {
  const agent = agentById(agentId);
  if (!agent) return;

  const key = winKey(agentId);
  if (isWindowOpen(key)) return refreshWindow(key);

  let activity = [];
  try {
    activity = (await api.activity(agentId)).activity;
  } catch {
    /* an agent that has never worked simply has nothing to show */
  }

  openWindow(key, {
    title: `${agent.name} — ${agent.title}`,
    subtitle: statusOf(agentId),
    render: (body) => {
      const live = agentById(agentId);
      if (!live) return closeWindow(key);
      // Re-reading the feed from the DOM would lose scroll position, so the
      // stored activity is only used for the initial fill.
      body.replaceChildren(buildAgentConsole(live, { activity, showNote: false }));
    },
  });
}

/** Keep any open floating window's status line in step. */
function syncAgentWindow(agentId) {
  const key = winKey(agentId);
  if (!isWindowOpen(key)) return;
  const agent = agentById(agentId);
  refreshWindow(key, {
    title: agent ? `${agent.name} — ${agent.title}` : 'Gone',
    subtitle: statusOf(agentId),
  });
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
      // The project is set live by its own row above, not by this form.
      memoryEnabled: form.memoryEnabled.checked,
      canManageOffice: form.canManageOffice.checked,
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
    // Where they work, which conversation they are on, and how to reach that
    // conversation by hand — the facts you change rather than read.
    h('div.card', {}, [projectRow(agent), sessionRow(agent), resumeRow(agent)]),

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

    h('label.toggle', {}, [
      (form.canManageOffice = h('input', {
        type: 'checkbox',
        checked: agent.canManageOffice ? true : null,
      })),
      h('div', {}, [
        h('div.toggle-name', { text: 'May manage the office ⚙' }),
        h('div.toggle-desc', {
          text:
            'Grants the hq instruments: read the whole company, account for what every ' +
            'agent costs, report project status, and propose hires, reassignments, ' +
            'shifts and dismissals. Every change still needs your sanction.',
        }),
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

/** Everything this agent has sent and received. */
async function renderAgentMail(container, agent) {
  container.replaceChildren(h('div.empty', { text: 'Opening their mail…' }));

  let mail = [];
  try {
    mail = (await api.mail(agent.id)).mail;
  } catch (err) {
    return container.replaceChildren(h('div.empty', { text: err.message }));
  }

  const received = mail.filter((m) => m.toAgentId === agent.id);
  const sent = mail.filter((m) => m.fromAgentId === agent.id);

  const card = (m, incoming) =>
    h('div.card', { style: { opacity: incoming && !m.read ? '1' : '.8' } }, [
      h('div.card-head', {}, [
        h('div', { style: { flex: '1', minWidth: '0' } }, [
          h('div.card-title', { text: m.subject, style: { fontSize: '12px' } }),
          h('div.card-sub', {
            text: incoming
              ? `from ${senderName(m.fromAgentId)} · ${timeOf(m.at)}`
              : `to ${senderName(m.toAgentId)} · ${timeOf(m.at)}`,
          }),
        ]),
        incoming && !m.read && h('span.pill', { text: 'UNREAD', style: { color: 'var(--gold)' } }),
      ]),
      markdownNode(String(m.body || '').slice(0, 4000)),
    ]);

  container.replaceChildren(
    h('div.actions', { style: { marginBottom: '10px' } }, [
      h('button.btn.btn-gold.btn-sm', {
        text: '✎ Write to them',
        onclick: () => openComposeForm({ toAgentId: agent.id }),
      }),
    ]),

    h('h4', { text: `Received (${received.length})`, style: { margin: '6px 0 8px', color: 'var(--gold)' } }),
    ...(received.length ? received.map((m) => card(m, true)) : [h('div.empty', { text: 'Nothing received.' })]),

    h('h4', { text: `Sent (${sent.length})`, style: { margin: '18px 0 8px', color: 'var(--gold)' } }),
    ...(sent.length ? sent.map((m) => card(m, false)) : [h('div.empty', { text: 'Nothing sent.' })])
  );
}

/** Their memory, one file per topic. */
async function renderAgentMemory(container, agent) {
  container.replaceChildren(h('div.empty', { text: 'Reading their memory…' }));

  let topics = [];
  try {
    topics = (await api.memory(agent.id)).topics;
  } catch (err) {
    return container.replaceChildren(h('div.empty', { text: err.message }));
  }

  const blocks = topics.map(({ topic, content }) => {
    const area = h('textarea', { rows: 8, text: content });
    return h('div.card', {}, [
      h('div.card-head', {}, [
        h('div.card-title', { text: topic, style: { flex: '1', fontSize: '12px' } }),
        h('span.pill', {
          text: `${content.split('\n').filter((l) => l.trim().startsWith('-')).length} note(s)`,
        }),
      ]),
      area,
      h('div.actions', {}, [
        h('button.btn.btn-primary.btn-sm', {
          text: 'Save',
          onclick: () =>
            guard(() => api.saveMemory(agent.id, topic, area.value), `"${topic}" saved.`),
        }),
        h('button.btn.btn-danger.btn-sm', {
          text: 'Forget this topic',
          onclick: async () => {
            if (!confirm(`Delete everything ${agent.name} remembers about "${topic}"?`)) return;
            await guard(() => api.deleteMemory(agent.id, topic), `"${topic}" forgotten.`);
            renderPanel();
          },
        }),
      ]),
    ]);
  });

  const newTopic = h('input', { type: 'text', placeholder: 'build-system' });

  container.replaceChildren(
    h('div.hint', {
      text:
        `Kept as one file per topic under ${state.snapshot.dataDir}\\agents\\${agent.id}\\memory\\. ` +
        `They file notes themselves with "remember", and prune stale ones with "forget".`,
      style: { marginBottom: '10px' },
    }),

    ...(blocks.length ? blocks : [h('div.empty', { text: 'They remember nothing yet.' })]),

    h('h4', { text: 'Start a topic', style: { margin: '18px 0 8px', color: 'var(--gold)' } }),
    h('div.actions', {}, [
      newTopic,
      h('button.btn.btn-sm', {
        text: '+ Create',
        onclick: async () => {
          const slug = newTopic.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
          if (!slug) return toast({ title: 'Give the topic a name', kind: 'error' });
          await guard(
            () => api.saveMemory(agent.id, slug, `# ${agent.name} — ${slug}\n\n`),
            `"${slug}" created.`
          );
          renderPanel();
        },
      }),
    ])
  );
}

// --- visiting sessions ------------------------------------------------------

async function openVisitor(sessionId) {
  state.selectedVisitorId = sessionId;
  openPanel('visitor');
}

function renderVisitorPanel() {
  const sessionId = state.selectedVisitorId;
  const visitor = (state.snapshot.visitors || []).find((v) => v.sessionId === sessionId);

  if (!visitor) {
    return setPanel('VISITOR', h('div.empty', { text: 'That session is no longer running.' }));
  }

  const feed = h('div.feed-scroll', {}, [h('div.empty', { text: 'Reading their transcript…' })]);

  setPanel(`VISITOR — ${visitor.name || sessionId.slice(0, 8)}`, [
    h('div.card', {}, [
      h('div.card-head', {}, [
        h('div', { style: { flex: '1', minWidth: '0' } }, [
          h('div.card-title', { text: visitor.name || 'unnamed session' }),
          h('div.card-sub', { text: visitor.cwd || '' }),
          h('div.card-sub', {
            text:
              `${visitor.kind} · pid ${visitor.pid ?? '?'} · ${sessionId}` +
              (visitor.startedAt ? ` · started ${timeOf(visitor.startedAt)}` : ''),
          }),
        ]),
        h('span.pill.pill-status', {
          text: visitor.status,
          style: {
            color: STATUS_COLORS[visitor.status === 'busy' ? 'working' : 'idle'],
          },
        }),
      ]),
      h('div.hint', {
        text:
          'You started this session yourself in a terminal, so the office only watches ' +
          'it. Take it onto the payroll and it becomes staff — calling them to duty ' +
          'resumes this very conversation.',
      }),
      h('div.actions', {}, [
        h('button.btn.btn-gold.btn-sm', {
          text: '＋ Take onto the payroll',
          onclick: () => openAdoptForm(visitor),
        }),
      ]),
    ]),
    h('h4', { text: 'Their transcript', style: { margin: '14px 0 8px', color: 'var(--gold)' } }),
    feed,
  ]);

  $('#side-body').dataset.layout = 'scroll';

  api
    .visitorTranscript(sessionId)
    .then(({ activity }) => {
      feed.replaceChildren(
        activity.length
          ? h('div.feed', {}, activity.slice(-150).map(activityNode))
          : h('div.empty', { text: 'Nothing readable in that transcript yet.' })
      );
    })
    .catch((err) => {
      feed.replaceChildren(h('div.empty', { text: `Could not read it: ${err.message}` }));
    });
}

function openAdoptForm(visitor) {
  const suggested = (visitor.name || 'Contractor').replace(/[^a-zA-Z]/g, '') || 'Contractor';
  const name = h('input', { type: 'text', value: suggested });
  const title = h('input', { type: 'text', value: 'Contractor' });
  const dept = h(
    'select',
    {},
    state.snapshot.departments.map((d) => h('option', { value: d.id }, [d.name]))
  );

  openModal('Take this session onto the payroll', [
    h('div.hint', {
      text:
        'A desk is found for them and their session id is kept, so when you call them ' +
        'to duty they carry on from where this conversation left off. Close the ' +
        'terminal running it first, or the two will talk over each other.',
      style: { marginBottom: '12px' },
    }),
    h('div.row', {}, [field('Name', name), field('Title', title)]),
    field('Department', dept),
    h('div.actions', {}, [
      h('button.btn.btn-primary', {
        text: 'Hire them',
        onclick: async () => {
          try {
            const agent = await api.adoptVisitor(visitor.sessionId, {
              name: name.value,
              title: title.value,
              departmentId: dept.value,
              cwd: visitor.cwd,
            });
            closeModal();
            await refresh();
            toast({ title: `${agent.name} joins the office`, kind: 'done' });
            openAgent(agent.id);
          } catch (err) {
            toast({ title: 'Could not hire them', body: err.message, kind: 'error' });
          }
        },
      }),
      h('button.btn', { text: 'Cancel', onclick: closeModal }),
    ]),
  ]);
}

// --- HQ ---------------------------------------------------------------------

/** Everything waiting on your word. */
function renderSanctionsPanel() {
  const approvals = (state.snapshot.approvals || []).filter((a) => a.status === 'pending');
  const mine = approvals.filter((a) => a.route === 'lord');
  const withCeo = approvals.filter((a) => a.route !== 'lord');
  // Questions need a real answer, so "sanction all" never sweeps them up.
  const sweepable = mine.filter((a) => a.kind !== 'question');

  setPanel('AWAITING SANCTION', [
    h('div.card', {}, [
      h('div.card-title', { text: `${mine.length} awaiting your word` }),
      h('div.card-sub', {
        text: withCeo.length
          ? `${withCeo.length} more are with the CEO.`
          : 'Nothing is with the CEO.',
      }),
      sweepable.length > 1 &&
        h('div.actions', {}, [
          h('button.btn.btn-primary.btn-sm', {
            text: `✓ Sanction all (${sweepable.length})`,
            onclick: async () => {
              if (!confirm(`Sanction ${sweepable.length} pending request(s)?`)) return;
              await guard(() => api.sanctionAll('Sanctioned in bulk.'), 'All sanctioned.');
            },
          }),
          h('span.card-sub', { text: 'Questions are left for you to answer properly.' }),
        ]),
    ]),

    ...(mine.length ? mine.map((a) => approvalCard(a)) : [h('div.empty', { text: 'Nothing awaits your word.' })]),

    // A bare `length &&` would render a literal 0 when the list is empty.
    withCeo.length
      ? h('h4', { text: 'With the CEO', style: { margin: '18px 0 8px', color: 'var(--gold)' } })
      : null,
    ...withCeo.map((a) => approvalCard(a)),
  ]);
}

/**
 * Lord Marcos's own inbox: what the staff have written to him, and a way to
 * answer or pass it on.
 */
function renderInboxPanel() {
  const inbox = lordInbox();
  const lord = state.snapshot.office.lordName || 'Lord Marcos';

  setPanel('MY INBOX', [
    h('div.card', {}, [
      h('div.card-title', { text: `${inbox.length} message(s) to you` }),
      h('div.card-sub', {
        text:
          'What the CEO, the heads of department and anyone else has written to you ' +
          'directly — reports, petitions and findings. Reply to the sender, or pass ' +
          'it to someone else.',
      }),
      h('div.actions', {}, [
        h('button.btn.btn-gold.btn-sm', {
          text: '✎ Write to someone',
          onclick: () => openComposeForm(),
        }),
        unreadInbox().length
          ? h('button.btn.btn-sm', {
              text: 'Mark all read',
              onclick: () => guard(() => api.readInbox(), 'Inbox cleared.', true),
            })
          : null,
      ]),
    ]),

    ...(inbox.length
      ? inbox.map((m) => inboxCard(m))
      : [h('div.empty', { text: `Nobody has written to ${lord} yet.` })]),
  ]);
}

function inboxCard(message) {
  const from = agentById(message.fromAgentId);

  return h('div.card', { style: { opacity: message.read ? '.75' : '1' } }, [
    h('div.card-head', {}, [
      h('div', { style: { flex: '1', minWidth: '0' } }, [
        h('div.card-title', { text: message.subject, style: { fontSize: '12px' } }),
        h('div.card-sub', { text: `${senderName(message.fromAgentId)} · ${timeOf(message.at)}` }),
      ]),
      !message.read && h('span.pill', { text: 'NEW', style: { color: 'var(--gold)' } }),
      from &&
        h('button.btn.btn-sm', {
          text: '→ Open chat',
          onclick: () => {
            openAgent(from.id);
            map.focusAgent(from.id);
          },
        }),
    ]),
    markdownNode(String(message.body || '').slice(0, 6000)),
    h('div.actions', {}, [
      h('button.btn.btn-sm', {
        text: '↩ Reply',
        onclick: () => openComposeForm({ toAgentId: message.fromAgentId, subject: `Re: ${message.subject}`, quote: message.body }),
      }),
      h('button.btn.btn-sm', {
        text: '➥ Pass on',
        onclick: () => openComposeForm({ subject: `Fwd: ${message.subject}`, quote: message.body }),
      }),
    ]),
  ]);
}

/** Write to a member of staff, optionally quoting what you are answering. */
function openComposeForm({ toAgentId = '', subject = '', quote = '' } = {}) {
  const to = h(
    'select',
    {},
    [
      h('option', { value: '' }, ['— choose a recipient —']),
      ...state.snapshot.agents.map((a) =>
        h('option', { value: a.id, selected: a.id === toAgentId ? true : null }, [
          `${a.name} (${a.title})`,
        ])
      ),
    ]
  );
  const subjectInput = h('input', { type: 'text', value: subject, placeholder: 'Subject' });
  const bodyInput = h('textarea', {
    rows: 8,
    text: quote ? `\n\n---\nYou wrote:\n${String(quote).slice(0, 2000)}` : '',
    placeholder: 'Your instruction…',
  });

  openModal('Write to a member of staff', [
    field('To', to),
    field('Subject', subjectInput),
    field('Message', bodyInput),
    h('div.hint', {
      text: 'If they are on duty it is put in front of them at once; otherwise it waits in their inbox and they read it the moment they report.',
      style: { marginBottom: '10px' },
    }),
    h('div.actions', {}, [
      h('button.btn.btn-primary', {
        text: 'Send',
        onclick: async () => {
          if (!to.value) return toast({ title: 'Choose a recipient', kind: 'error' });
          try {
            const result = await api.message(to.value, subjectInput.value, bodyInput.value);
            closeModal();
            await refresh();
            if (state.panel) renderPanel();
            toast({
              title: result.delivered ? 'Delivered to their desk' : 'Waiting in their inbox',
              kind: 'done',
            });
          } catch (err) {
            toast({ title: 'Could not send it', body: err.message, kind: 'error' });
          }
        },
      }),
      h('button.btn', { text: 'Cancel', onclick: closeModal }),
    ]),
  ]);
}

/**
 * The office's event log: what the staff did without being asked, and what
 * went wrong. Useful for noticing a shift that ran, an agent that collapsed,
 * or a task that finished while you were elsewhere.
 */
function renderDispatchesPanel() {
  const notifications = state.snapshot.notifications || [];
  const working = state.snapshot.agents.filter((a) => statusOf(a.id) === 'working');

  setPanel('DISPATCHES', [
    h('div.card', {}, [
      h('div.card-title', { text: 'The office at a glance' }),
      h('div.card-sub', {
        text:
          `${state.snapshot.agents.length} staff · ${working.length} at work · ` +
          `${pendingApprovals().length} awaiting sanction · ` +
          `${state.snapshot.visitors.length} visiting session(s)`,
      }),
    ]),

    ledgerCard(),

    h('h4', {
      text: `Events (${notifications.length})`,
      style: { margin: '16px 0 8px', color: 'var(--gold)' },
    }),
    h('div.hint', {
      text:
        'Things that happened while you were looking elsewhere: tasks finished, ' +
        'shifts that ran on their own, agents that failed. Click one to go to it.',
      style: { marginBottom: '10px' },
    }),

    notifications.length
      ? h('div', {}, [
          h('button.btn.btn-sm', {
            text: 'Mark all read',
            onclick: () => guard(() => api.readNotifications(), 'Cleared.', true),
            style: { marginBottom: '8px' },
          }),
          ...notifications.slice(0, 60).map((n) => {
            const agent = n.agentId ? agentById(n.agentId) : null;
            return h('div.card.dispatch', {
              style: { opacity: n.read ? '.55' : '1', cursor: agent ? 'pointer' : 'default' },
              onclick: agent
                ? () => {
                    openAgent(agent.id);
                    map.focusAgent(agent.id);
                  }
                : null,
            }, [
              h('div.card-head', {}, [
                h('div.card-title', { text: n.title, style: { flex: '1', fontSize: '12px' } }),
                h('span.card-sub', { text: timeOf(n.at) }),
              ]),
              n.body && h('div.card-sub', { text: String(n.body).slice(0, 400) }),
            ]);
          }),
        ])
      : h('div.empty', { text: 'Nothing has happened behind your back.' }),
  ]);
}

/** What the office has spent, and on whom. */
function ledgerCard() {
  const agents = state.snapshot.agents;
  const total = agents.reduce((n, a) => n + (a.stats?.totalCostUsd || 0), 0);
  const spenders = agents
    .filter((a) => (a.stats?.totalCostUsd || 0) > 0)
    .sort((a, b) => (b.stats.totalCostUsd || 0) - (a.stats.totalCostUsd || 0));

  return h('div.card', {}, [
    h('div.card-head', {}, [
      h('div.card-title', { text: 'The ledger', style: { flex: '1' } }),
      h('span.pill', { text: money(total) }),
    ]),
    spenders.length
      ? h(
          'div',
          {},
          spenders.slice(0, 8).map((a) => {
            const share = total > 0 ? ((a.stats.totalCostUsd || 0) / total) * 100 : 0;
            return h('div', { style: { marginTop: '7px' } }, [
              h('div.card-sub', {
                text:
                  `${a.name} — ${money(a.stats.totalCostUsd)} (${share.toFixed(0)}%) · ` +
                  `${a.stats.tasks || 0} task(s) · ${a.model}`,
              }),
              // A bar is the fastest read on who is eating the budget.
              h('div', {
                style: {
                  height: '4px',
                  marginTop: '2px',
                  background: 'var(--panel-3)',
                },
              }, [
                h('div', {
                  style: {
                    height: '4px',
                    width: `${Math.max(2, share)}%`,
                    background: share > 50 ? 'var(--amber)' : 'var(--blue)',
                  },
                }),
              ]),
            ]);
          })
        )
      : h('div.card-sub', { text: 'Nothing spent yet.' }),
  ]);
}

/**
 * An agent is waiting on your answer, and has offered choices. Picking one
 * sends it straight back as the tool's result.
 */
function questionCard(approval) {
  const send = async (answer) => {
    try {
      await api.answer(approval.id, answer);
      toast({ title: 'Answered', body: answer.slice(0, 120), kind: 'done' });
    } catch (err) {
      toast({ title: 'Could not answer', body: err.message, kind: 'error' });
    }
  };

  const other = h('input', {
    type: 'text',
    placeholder: 'Or answer in your own words…',
    onkeydown: (e) => {
      if (e.key === 'Enter' && e.target.value.trim()) send(e.target.value.trim());
    },
  });

  const options = Array.isArray(approval.options) ? approval.options : [];
  const multi = !!approval.multiSelect && options.length > 0;

  return h('div.card.question', { 'data-approval': approval.id }, [
    h('div.card-head', {}, [
      h('div', { style: { flex: '1', minWidth: '0' } }, [
        h('div.card-title', { text: approval.title, style: { fontSize: '12px' } }),
        h('div.card-sub', {
          text: `${approval.agentName} asks you${multi ? ' · choose any' : ''}`,
        }),
      ]),
      openChatButton(approval),
      h('span.pill', { text: timeOf(approval.createdAt) }),
    ]),

    approval.detail ? markdownNode(approval.detail) : null,

    options.length
      ? multi
        ? // Several may be chosen: tick them, then confirm.
          h(
            'div.q-options',
            {},
            options.map((o, i) =>
              h('label.q-option.q-option-multi', {}, [
                h('input', { type: 'checkbox', 'data-choice': o.label }),
                h('div', {}, [
                  h('div.q-option-label', { text: i === 0 ? `${o.label}  ★` : o.label }),
                  o.description && h('div.q-option-desc', { text: o.description }),
                ]),
              ])
            )
          )
        : h(
            'div.q-options',
            {},
            options.map((o, i) =>
              h('button.q-option', { onclick: () => send(o.label) }, [
                h('div.q-option-label', {
                  // The agent is told to put its recommendation first.
                  text: i === 0 ? `${o.label}  ★` : o.label,
                }),
                o.description && h('div.q-option-desc', { text: o.description }),
              ])
            )
          )
      : null,

    multi
      ? h('div.actions', {}, [
          h('button.btn.btn-primary.btn-sm', {
            text: '✓ Confirm selection',
            onclick: (e) => {
              const card = e.target.closest('.question');
              const chosen = [...card.querySelectorAll('[data-choice]:checked')].map(
                (el) => el.dataset.choice
              );
              const extra = other.value.trim();
              if (!chosen.length && !extra) {
                return toast({ title: 'Choose at least one', kind: 'error' });
              }
              send([...chosen, extra].filter(Boolean).join('; '));
            },
          }),
          h('span.card-sub', { text: 'Pick as many as apply' }),
        ])
      : null,

    h('div.actions', {}, [
      other,
      !multi &&
        h('button.btn.btn-gold.btn-sm', {
          text: 'Send',
          onclick: () => other.value.trim() && send(other.value.trim()),
        }),
    ]),
  ]);
}

/**
 * Jump from a request in HQ straight to the agent who raised it. Hidden when
 * you are already looking at that agent.
 */
function openChatButton(approval) {
  if (state.panel === 'agent' && state.selectedAgentId === approval.agentId) return null;

  return h('button.btn.btn-sm', {
    text: '→ Open chat',
    title: `Open ${approval.agentName}'s console`,
    onclick: (e) => {
      e.stopPropagation();
      openAgent(approval.agentId);
      map.focusAgent(approval.agentId);
    },
  });
}

function approvalCard(approval, { compact = false } = {}) {
  if (approval.kind === 'question') return questionCard(approval);
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

  return h('div.card.approval', { 'data-route': approval.route, 'data-approval': approval.id }, [
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
      openChatButton(approval),
      h('span.pill', { text: approval.severity === 'grave' ? 'GRAVE' : timeOf(approval.createdAt) }),
    ]),

    approval.escalationNote && h('div.card-sub', { text: `CEO: ${approval.escalationNote}` }),

    // The detail is markdown — usually a fenced JSON block — so render it
    // rather than dumping the backticks on screen.
    !compact && approval.detail &&
      h('div.approval-detail', {}, [markdownNode(approval.detail)]),
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
          h('div.card-title', {
            text: `${agent.name}${agent.isCeo ? ' ♛' : ''}${agent.canManageOffice ? ' ⚙' : ''}`,
          }),
          h('div.card-sub', { text: `${agent.title} · ${dept?.name || '—'}` }),
          h('div.card-sub', {
            text: `${money(agent.stats?.totalCostUsd)} · ${agent.stats?.tasks || 0} task(s)`,
          }),
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
    // A one-CEO office is not much of an office; offer to staff it.
    state.snapshot.agents.length < 3 &&
      h('div.card', {}, [
        h('div.card-title', { text: 'This office is nearly empty' }),
        h('div.card-sub', {
          text:
            'Open Operations, Engineering and Research, each staffed and with its own ' +
            'context. Operations gets the management instruments, so you can ask them ' +
            'about the company itself. Nothing existing is touched.',
        }),
        h('div.actions', {}, [
          h('button.btn.btn-gold.btn-sm', {
            text: 'Staff the office',
            onclick: async () => {
              await guard(() => api.seed(), 'The office is staffed.');
              map.fit();
            },
          }),
        ]),
      ]),

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

      field(
        'Head of department',
        h(
          'select',
          {
            onchange: (e) =>
              guard(
                () => api.setDepartmentHead(dept.id, e.target.value || null),
                e.target.value
                  ? 'Appointed. They answer to the CEO; the department answers to them.'
                  : 'The post is vacant; the department answers to the CEO.'
              ),
          },
          [
            h('option', { value: '' }, ['— vacant —']),
            ...staff.map((a) =>
              h('option', { value: a.id, selected: a.id === dept.headAgentId ? true : null }, [
                `${a.name} (${a.title})`,
              ])
            ),
          ]
        ),
        'Takes the desk at the front of the room, answers to the CEO, and everyone ' +
          'else here answers to them.'
      ),

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

    // Group the posted staff by the department they serve in, so a project
    // reads as "who, from where" rather than a flat list of names.
    const byDept = state.snapshot.departments
      .map((dept) => ({
        dept,
        members: staff.filter((a) => a.departmentId === dept.id),
      }))
      .filter((g) => g.members.length);

    const name = h('input', { type: 'text', value: project.name });
    const directory = h('input', { type: 'text', value: project.directory });
    const description = h('textarea', { rows: 2, text: project.description || '' });

    return h('div.card', {}, [
      h('div.card-head', {}, [
        h('div.card-title', { text: project.name, style: { flex: '1' } }),
        h('span.pill', { text: `${staff.length} posted` }),
      ]),

      byDept.length
        ? h(
            'div.project-staff',
            {},
            byDept.map(({ dept, members }) =>
              h('div.project-dept', { style: { '--dept': themeFor(dept.theme).wallTop } }, [
                h('div.project-dept-name', { text: dept.name }),
                h(
                  'div.project-members',
                  {},
                  members.map((a) =>
                    h('button.project-member', {
                      text: `${a.name}${a.isCeo ? ' ♛' : ''}`,
                      title: `${a.title} — open their console`,
                      onclick: () => {
                        openAgent(a.id);
                        map.focusAgent(a.id);
                      },
                      style: { borderColor: STATUS_COLORS[statusOf(a.id)] },
                    })
                  )
                ),
              ])
            )
          )
        : h('div.card-sub', { text: 'No one is posted here.' }),

      h('details.project-edit', {}, [
        h('summary', { text: 'Edit this project' }),
        field('Name', name),
        field('Directory', directory),
        field('Description', description),
        h('div.actions', {}, [
          h('button.btn.btn-primary.btn-sm', {
            text: 'Save',
            onclick: () =>
              guard(
                () =>
                  api.updateProject(project.id, {
                    name: name.value,
                    directory: directory.value,
                    description: description.value,
                  }),
                'Project updated.'
              ),
          }),
          h('span.spacer'),
          h('button.btn.btn-danger.btn-sm', {
            text: 'Remove',
            onclick: async () => {
              if (!confirm(`Remove the project ${project.name}? The directory itself is untouched.`)) return;
              await guard(() => api.deleteProject(project.id), 'Project removed.');
            },
          }),
        ]),
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
    h('div.actions', { style: { marginBottom: '10px' } }, [
      h('button.btn.btn-sm', { text: '+ Install a skill', onclick: () => openSkillForm() }),
    ]),
    skills.length
      ? h('div', {}, skills.map((s) =>
          h('div.card', {}, [
            h('div.card-head', {}, [
              h('div.card-title', { text: s.name, style: { flex: '1', fontSize: '12px' } }),
              h('span.pill', { text: s.source }),
            ]),
            s.description && h('div.card-sub', { text: s.description }),
            h('div.card-sub', { text: s.path || '' }),
            h('div.actions', {}, [
              // Only skills installed for the user live somewhere we may touch.
              s.source === 'user' &&
                h('button.btn.btn-sm', {
                  text: 'Edit',
                  onclick: () => openSkillForm(s.name),
                }),
              s.source === 'user' &&
                h('button.btn.btn-danger.btn-sm', {
                  text: 'Uninstall',
                  onclick: async () => {
                    if (
                      !confirm(
                        `Delete the skill "${s.name}" from ~/.claude/skills?\n\n` +
                          `This removes it from disk for every Claude session on this ` +
                          `machine, not just this office.`
                      )
                    ) {
                      return;
                    }
                    await guard(() => api.deleteSkill(s.name), `${s.name} uninstalled.`);
                  },
                }),
              s.source !== 'user' &&
                h('span.card-sub', { text: 'Lives in a project — manage it there.' }),
            ]),
          ])
        ))
      : h('div.empty', { text: 'No skills found in ~/.claude/skills or your projects.' }),
    h('div.hint', {
      text:
        'Installed skills are available to every agent. Withhold one from a particular ' +
        'agent in their Configuration tab.',
    }),

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

/** Install a new skill, or edit one already installed for the user. */
async function openSkillForm(existingName = null) {
  const name = h('input', {
    type: 'text',
    placeholder: 'release-notes',
    value: existingName || '',
    disabled: existingName ? true : null,
  });
  const description = h('textarea', {
    rows: 3,
    placeholder:
      'When to use this skill. Claude reads this to decide whether to invoke it, so ' +
      'be concrete about the triggers.',
  });
  const content = h('textarea', {
    rows: 14,
    placeholder: '# release-notes\n\nStep-by-step instructions for the agent…',
  });

  if (existingName) {
    try {
      const { content: source } = await api.readSkill(existingName);
      // Split the front matter off so the two fields line up with the file.
      const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
      if (match) {
        const desc = match[1].match(/^description:\s*(.*)$/m);
        if (desc) description.value = desc[1].trim().replace(/^["']|["']$/g, '');
        content.value = match[2].trim();
      } else {
        content.value = source;
      }
    } catch (err) {
      toast({ title: 'Could not read that skill', body: err.message, kind: 'error' });
      return;
    }
  }

  openModal(existingName ? `Edit skill: ${existingName}` : 'Install a skill', [
    h('div.hint', {
      text:
        'Skills are written to ~/.claude/skills/<name>/SKILL.md and become available ' +
        'to every agent in this office — and to every other Claude session on this ' +
        'machine.',
      style: { marginBottom: '12px' },
    }),
    field('Name', name, 'Lower-case letters, digits and hyphens.'),
    field('Description', description, 'How Claude decides when to reach for it.'),
    field('Instructions (markdown)', content),
    h('div.actions', {}, [
      h('button.btn.btn-primary', {
        text: existingName ? 'Save' : 'Install',
        onclick: async () => {
          try {
            // Editing is a delete-then-write; the API refuses to overwrite.
            if (existingName) await api.deleteSkill(existingName);
            await api.addSkill({
              name: existingName || name.value,
              description: description.value,
              content: content.value,
            });
            closeModal();
            await refresh();
            toast({
              title: existingName ? `${existingName} saved` : `${name.value} installed`,
              kind: 'done',
            });
          } catch (err) {
            toast({ title: 'Could not save the skill', body: err.message, kind: 'error' });
          }
        },
      }),
      h('button.btn', { text: 'Cancel', onclick: closeModal }),
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
