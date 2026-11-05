/**
 * The office as a chain of command.
 *
 * The floor plan says where people sit; this says who answers to whom. The CEO
 * is at the top, each agent hangs under their supervisor, and every card is
 * tinted with its department's colour so the two readings of the office line
 * up rather than competing.
 */
import { agentSprite, themeFor, STATUS_COLORS } from './sprites.js';

const CARD_W = 132;
const CARD_H = 76;
const GAP_X = 18;
const GAP_Y = 58;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

const clampZoom = (z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

/**
 * Lay out a tidy tree: children are placed side by side, and each parent is
 * centred over its own children.
 */
function layout(nodes, byParent, rootId, depth, cursor) {
  const children = byParent.get(rootId) || [];
  const node = { id: rootId, depth, x: 0, y: depth * (CARD_H + GAP_Y) };

  if (!children.length) {
    node.x = cursor.x;
    cursor.x += CARD_W + GAP_X;
  } else {
    const placed = children.map((c) => layout(nodes, byParent, c.id, depth + 1, cursor));
    const first = placed[0];
    const last = placed[placed.length - 1];
    node.x = (first.x + last.x) / 2;
  }

  nodes.push(node);
  return node;
}

export class HierarchyTree {
  constructor(container, { onSelectAgent } = {}) {
    this.el = container;
    this.onSelectAgent = onSelectAgent || (() => {});
    this.state = null;
    this.workers = {};
    this.selectedAgentId = null;
    this.zoom = 1;
    this.canvasEl = null;
    this._bindNavigation();
  }

  /**
   * Drag to pan, scroll to zoom — the same gestures as the floor plan, so the
   * two views do not have to be learned separately.
   */
  _bindNavigation() {
    this.el.addEventListener('pointerdown', (e) => {
      // Let the cards take their own clicks.
      if (e.target.closest('.tree-card')) return;
      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const left = this.el.scrollLeft;
      const top = this.el.scrollTop;
      this.el.style.cursor = 'grabbing';

      const move = (ev) => {
        this.el.scrollLeft = left - (ev.clientX - startX);
        this.el.scrollTop = top - (ev.clientY - startY);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.el.style.cursor = '';
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    this.el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const before = this.zoom;
        const next = clampZoom(before * (e.deltaY > 0 ? 0.9 : 1.1));
        if (next === before) return;

        // Keep the point under the cursor where it is.
        const rect = this.el.getBoundingClientRect();
        const px = e.clientX - rect.left + this.el.scrollLeft;
        const py = e.clientY - rect.top + this.el.scrollTop;
        const ratio = next / before;

        this.zoom = next;
        this._applyZoom();
        this.el.scrollLeft = px * ratio - (e.clientX - rect.left);
        this.el.scrollTop = py * ratio - (e.clientY - rect.top);
      },
      { passive: false }
    );
  }

  _applyZoom() {
    if (!this.canvasEl) return;
    this.canvasEl.style.transform = `scale(${this.zoom})`;
    this.canvasEl.style.transformOrigin = '0 0';
    // The wrapper has to grow with the content or scrolling stops early.
    const w = parseFloat(this.canvasEl.dataset.w) || 0;
    const h = parseFloat(this.canvasEl.dataset.h) || 0;
    this.canvasEl.style.marginRight = `${w * (this.zoom - 1)}px`;
    this.canvasEl.style.marginBottom = `${h * (this.zoom - 1)}px`;
  }

  setZoom(z) {
    this.zoom = clampZoom(z);
    this._applyZoom();
  }

  zoomBy(factor) {
    this.setZoom(this.zoom * factor);
  }

  /** Frame the whole chart in the available space. */
  fit() {
    if (!this.canvasEl) return;
    const w = parseFloat(this.canvasEl.dataset.w) || 1;
    const h = parseFloat(this.canvasEl.dataset.h) || 1;
    const rect = this.el.getBoundingClientRect();
    this.setZoom(Math.min((rect.width - 48) / w, (rect.height - 96) / h, 1));
    this.el.scrollLeft = 0;
    this.el.scrollTop = 0;
  }

  setState(state) {
    this.state = state;
    this.workers = state.workers || {};
  }

  select(agentId) {
    this.selectedAgentId = agentId;
    for (const card of this.el.querySelectorAll('.tree-card')) {
      card.dataset.selected = String(card.dataset.agent === agentId);
    }
  }

  render() {
    if (!this.state) return;
    const agents = this.state.agents;
    if (!agents.length) return;

    // Build the reporting graph. Anyone whose supervisor is missing, or who is
    // the CEO, is treated as a root so nobody is lost off the chart.
    const byId = new Map(agents.map((a) => [a.id, a]));
    const byParent = new Map();
    const roots = [];

    for (const a of agents) {
      const parent = a.supervisorId && byId.has(a.supervisorId) ? a.supervisorId : null;
      if (!parent || a.isCeo) {
        roots.push(a);
        continue;
      }
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(a);
    }

    // The CEO first, so they anchor the top of the chart.
    roots.sort((a, b) => (b.isCeo ? 1 : 0) - (a.isCeo ? 1 : 0));

    const nodes = [];
    const cursor = { x: 0 };
    for (const root of roots) {
      layout(nodes, byParent, root.id, 0, cursor);
      cursor.x += GAP_X * 2; // keep separate trees apart
    }

    const positions = new Map(nodes.map((n) => [n.id, n]));
    const width = Math.max(...nodes.map((n) => n.x)) + CARD_W + 40;
    const height = Math.max(...nodes.map((n) => n.y)) + CARD_H + 40;

    const canvasEl = document.createElement('div');
    canvasEl.className = 'tree-canvas';
    canvasEl.style.width = `${width}px`;
    canvasEl.style.height = `${height}px`;
    canvasEl.dataset.w = width;
    canvasEl.dataset.h = height;

    // Connectors first, so the cards sit on top of them.
    canvasEl.append(this._connectors(agents, byId, positions, width, height));

    for (const agent of agents) {
      const pos = positions.get(agent.id);
      if (pos) canvasEl.append(this._card(agent, pos));
    }

    this.el.replaceChildren(canvasEl);
    this.canvasEl = canvasEl;
    this._applyZoom();
  }

  _connectors(agents, byId, positions, width, height) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'tree-lines');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    for (const agent of agents) {
      if (!agent.supervisorId || agent.isCeo) continue;
      const child = positions.get(agent.id);
      const parent = positions.get(agent.supervisorId);
      if (!child || !parent) continue;

      const x1 = parent.x + CARD_W / 2;
      const y1 = parent.y + CARD_H;
      const x2 = child.x + CARD_W / 2;
      const y2 = child.y;
      const mid = y1 + GAP_Y / 2;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      // Elbow connectors read as an org chart; curves read as a mind map.
      path.setAttribute('d', `M ${x1} ${y1} V ${mid} H ${x2} V ${y2}`);
      path.setAttribute('class', 'tree-line');
      svg.append(path);
    }
    return svg;
  }

  _card(agent, pos) {
    const dept = this.state.departments.find((d) => d.id === agent.departmentId);
    const theme = themeFor(dept?.theme);
    const status = this.workers[agent.id]?.status || 'offline';

    const card = document.createElement('button');
    card.className = 'tree-card';
    card.dataset.agent = agent.id;
    card.dataset.selected = String(this.selectedAgentId === agent.id);
    card.style.left = `${pos.x}px`;
    card.style.top = `${pos.y}px`;
    card.style.setProperty('--dept', theme.wallTop);
    card.title = `${agent.name} — ${agent.title}\n${dept?.name || 'unassigned'}`;

    const portrait = document.createElement('canvas');
    portrait.width = 24;
    portrait.height = 36;
    portrait.className = 'tree-portrait';
    const ctx = portrait.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      agentSprite(agent.appearance?.seed || agent.id, {
        outfit: agent.isCeo ? 'suit' : agent.appearance?.outfit || 'shirt',
      }),
      0, 0, 24, 36
    );

    const name = document.createElement('div');
    name.className = 'tree-name';
    name.textContent = `${agent.name}${agent.isCeo ? ' ♛' : ''}`;

    const title = document.createElement('div');
    title.className = 'tree-title';
    title.textContent = agent.title;

    const deptTag = document.createElement('div');
    deptTag.className = 'tree-dept';
    deptTag.textContent = dept?.name || '—';

    const dot = document.createElement('span');
    dot.className = 'tree-dot';
    dot.style.background = STATUS_COLORS[status] || STATUS_COLORS.offline;

    const body = document.createElement('div');
    body.className = 'tree-body';
    body.append(name, title, deptTag);

    card.append(dot, portrait, body);
    card.addEventListener('click', () => this.onSelectAgent(agent.id));
    return card;
  }
}
