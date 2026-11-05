/**
 * The office floor, drawn on a canvas.
 *
 * Departments are rooms on a tile grid, desks are laid out inside them
 * according to the department's seat count, and each agent sits at their own
 * desk with a status bubble over their head. Zoom is kept to whole numbers so
 * the pixels never smear.
 */
import {
  TILE,
  agentSeated,
  agentSprite,
  deskSprite,
  chairSprite,
  plantSprite,
  coolerSprite,
  floorTile,
  wallTile,
  wallTopTile,
  doorSprite,
  statusBubble,
  selectionRing,
  themeFor,
  STATUS_COLORS,
} from './sprites.js';

const ZOOM_LEVELS = [2, 3, 4, 5, 6];

export class OfficeMap {
  constructor(canvas, { onSelectAgent, onSelectDepartment, onBackground } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelectAgent = onSelectAgent || (() => {});
    this.onSelectDepartment = onSelectDepartment || (() => {});
    this.onBackground = onBackground || (() => {});

    this.state = null;
    this.workers = {};
    this.visitors = [];
    this.selectedAgentId = null;
    this.hoverAgentId = null;

    this.camera = { x: 16 * TILE, y: 10 * TILE, zoomIndex: 1 };
    this.dragging = null;
    this._hitboxes = [];
    this._running = false;

    this._bindEvents();
    this.resize();
  }

  get zoom() {
    return ZOOM_LEVELS[this.camera.zoomIndex];
  }

  setState(state) {
    this.state = state;
    this.workers = state.workers || {};
    this.visitors = state.visitors || [];
  }

  setWorkers(workers) {
    this.workers = workers;
  }

  select(agentId) {
    this.selectedAgentId = agentId;
  }

  // --- coordinates ----------------------------------------------------------

  screenToWorld(sx, sy) {
    const rect = this.canvas.getBoundingClientRect();
    const x = sx - rect.left;
    const y = sy - rect.top;
    return {
      x: (x - rect.width / 2) / this.zoom + this.camera.x,
      y: (y - rect.height / 2) / this.zoom + this.camera.y,
    };
  }

  /** Where a department's desks sit, in world pixels. */
  deskPosition(dept, seat) {
    const interiorX = dept.x + 1;
    const interiorY = dept.y + 2;
    const interiorW = Math.max(2, dept.w - 2);

    const cols = Math.max(1, Math.floor(interiorW / 3));
    const col = seat % cols;
    const row = Math.floor(seat / cols);

    return {
      x: (interiorX + col * 3) * TILE,
      y: (interiorY + 1 + row * 3) * TILE,
    };
  }

  // --- rendering ------------------------------------------------------------

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.dpr = dpr;
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
  }

  render() {
    const { ctx, canvas } = this;
    const rect = canvas.getBoundingClientRect();
    if (Math.abs(rect.width * this.dpr - canvas.width) > 1) this.resize();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#10121a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!this.state) return;

    const zoom = this.zoom * this.dpr;
    const cx = canvas.width / 2 - this.camera.x * zoom;
    const cy = canvas.height / 2 - this.camera.y * zoom;
    ctx.setTransform(zoom, 0, 0, zoom, cx, cy);
    ctx.imageSmoothingEnabled = false;

    this._hitboxes = [];

    this._drawCarpet();
    for (const dept of this.state.departments) this._drawRoom(dept);
    this._drawVisitors();

    // Labels are drawn unscaled so the text stays sharp.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._drawLabels();
  }

  /** The void outside the rooms — a dark carpet with a faint grid. */
  _drawCarpet() {
    const { ctx } = this;
    const bounds = this._worldBounds();
    ctx.fillStyle = '#171b26';
    ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);

    ctx.strokeStyle = 'rgba(255,255,255,0.025)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = TILE * 2;
    for (let x = Math.floor(bounds.x / step) * step; x < bounds.x + bounds.w; x += step) {
      ctx.moveTo(x, bounds.y);
      ctx.lineTo(x, bounds.y + bounds.h);
    }
    for (let y = Math.floor(bounds.y / step) * step; y < bounds.y + bounds.h; y += step) {
      ctx.moveTo(bounds.x, y);
      ctx.lineTo(bounds.x + bounds.w, y);
    }
    ctx.stroke();
  }

  _worldBounds() {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width / this.zoom;
    const h = rect.height / this.zoom;
    return { x: this.camera.x - w / 2, y: this.camera.y - h / 2, w, h };
  }

  _drawRoom(dept) {
    const { ctx } = this;
    const theme = dept.theme || 'default';
    const x0 = dept.x * TILE;
    const y0 = dept.y * TILE;

    // Floor
    for (let ty = 2; ty < dept.h - 1; ty++) {
      for (let tx = 1; tx < dept.w - 1; tx++) {
        ctx.drawImage(floorTile(theme, (tx + ty) % 2), x0 + tx * TILE, y0 + ty * TILE);
      }
    }

    // Back wall: a crown row and a face row give the room depth.
    for (let tx = 0; tx < dept.w; tx++) {
      ctx.drawImage(wallTopTile(theme), x0 + tx * TILE, y0);
      ctx.drawImage(wallTile(theme), x0 + tx * TILE, y0 + TILE);
    }

    // Side walls
    for (let ty = 2; ty < dept.h; ty++) {
      ctx.drawImage(wallTile(theme), x0, y0 + ty * TILE);
      ctx.drawImage(wallTile(theme), x0 + (dept.w - 1) * TILE, y0 + ty * TILE);
    }

    // Front wall, with a doorway in the middle
    const doorAt = Math.floor(dept.w / 2);
    for (let tx = 1; tx < dept.w - 1; tx++) {
      const sprite = tx === doorAt ? doorSprite(theme) : wallTile(theme);
      ctx.drawImage(sprite, x0 + tx * TILE, y0 + (dept.h - 1) * TILE);
    }

    // A plant in the corner, and a cooler by the door, for life
    ctx.drawImage(plantSprite(), x0 + (dept.w - 2) * TILE, y0 + (dept.h - 3) * TILE);
    if (dept.w > 6) ctx.drawImage(coolerSprite(), x0 + TILE, y0 + (dept.h - 3) * TILE);

    this._hitboxes.push({
      kind: 'department',
      id: dept.id,
      x: x0,
      y: y0,
      w: dept.w * TILE,
      h: dept.h * TILE,
    });

    // Desks: every seat gets one, occupied or not.
    const staff = this.state.agents.filter((a) => a.departmentId === dept.id);
    for (let seat = 0; seat < dept.seats; seat++) {
      const agent = staff.find((a) => a.seat === seat) || null;
      this._drawDesk(dept, seat, agent);
    }
  }

  _drawDesk(dept, seat, agent) {
    const { ctx } = this;
    const { x, y } = this.deskPosition(dept, seat);
    const worker = agent ? this.workers[agent.id] : null;
    const status = worker?.status || 'offline';
    const busy = status === 'working' || status === 'awaiting';

    // Chair behind the desk
    ctx.drawImage(chairSprite(), x + 8, y - 22);

    if (agent) {
      // Only animate staff who are actually doing something.
      const frame = busy ? Math.floor(Date.now() / 320) % 2 : 0;
      ctx.drawImage(agentSeated(agent.appearance?.seed || agent.id, {
        outfit: agent.isCeo ? 'suit' : agent.appearance?.outfit || 'shirt',
        frame,
      }), x + 8, y - 18);
    }

    ctx.drawImage(deskSprite({ lit: busy, ceo: !!agent?.isCeo }), x, y - 6);

    if (agent) {
      if (this.selectedAgentId === agent.id) {
        ctx.drawImage(selectionRing(), x, y + 8);
      }
      if (status !== 'offline') {
        const bob = status === 'working' ? Math.floor(Date.now() / 400) % 2 : 0;
        // Tucked just above the agent's shoulder, not floating over the room.
        ctx.drawImage(statusBubble(status), x + 18, y - 26 - bob);
      }

      this._hitboxes.push({
        kind: 'agent',
        id: agent.id,
        x,
        y: y - 24,
        w: TILE * 2,
        h: TILE * 3,
      });
    }
  }

  /**
   * Where the lobby sits: below every department, so visitors never collide
   * with the rooms or with the toolbar floating over the top-left.
   */
  _lobbyOrigin() {
    const depts = this.state?.departments || [];
    if (!depts.length) return { x: 2 * TILE, y: 2 * TILE };
    const left = Math.min(...depts.map((d) => d.x));
    const bottom = Math.max(...depts.map((d) => d.y + d.h));
    return { x: left * TILE, y: (bottom + 3) * TILE };
  }

  /** Sessions Lord Marcos started himself, loitering in the lobby. */
  _drawVisitors() {
    const { ctx } = this;
    if (!this.visitors.length) return;

    const { x: startX, y } = this._lobbyOrigin();

    this.visitors.forEach((visitor, i) => {
      const x = startX + i * TILE * 3;
      const frame = visitor.status === 'busy' ? Math.floor(Date.now() / 320) % 2 : 0;
      ctx.drawImage(
        agentSprite(visitor.sessionId || `visitor${i}`, { outfit: 'shirt', frame }),
        x,
        y
      );
      if (visitor.status !== 'unknown') {
        ctx.drawImage(
          statusBubble(visitor.status === 'busy' ? 'working' : 'idle'),
          x + 10,
          y - 16
        );
      }
      this._hitboxes.push({
        kind: 'visitor',
        id: visitor.sessionId,
        x,
        y,
        w: TILE,
        h: TILE * 1.5,
      });
    });
  }

  /** Room names, staff names and the visitor banner, in crisp screen space. */
  _drawLabels() {
    const { ctx } = this;
    const rect = this.canvas.getBoundingClientRect();
    const zoom = this.zoom;
    const toScreen = (wx, wy) => ({
      x: (wx - this.camera.x) * zoom + rect.width / 2,
      y: (wy - this.camera.y) * zoom + rect.height / 2,
    });

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const dept of this.state.departments) {
      const p = toScreen((dept.x + dept.w / 2) * TILE, dept.y * TILE - 6);
      if (p.x < -200 || p.x > rect.width + 200) continue;

      const theme = themeFor(dept.theme);
      const staff = this.state.agents.filter((a) => a.departmentId === dept.id).length;
      const label = `${dept.name.toUpperCase()}  ${staff}/${dept.seats}`;

      ctx.font = '700 11px ui-monospace, Menlo, Consolas, monospace';
      const w = ctx.measureText(label).width + 16;

      ctx.fillStyle = 'rgba(10,12,18,0.88)';
      ctx.fillRect(p.x - w / 2, p.y - 10, w, 20);
      ctx.fillStyle = theme.wallTop;
      ctx.fillRect(p.x - w / 2, p.y + 8, w, 2);
      ctx.fillStyle = '#e8e6df';
      ctx.fillText(label, p.x, p.y);
    }

    // Name tags under each member of staff
    ctx.font = '600 10px ui-monospace, Menlo, Consolas, monospace';
    for (const dept of this.state.departments) {
      for (const agent of this.state.agents.filter((a) => a.departmentId === dept.id)) {
        const desk = this.deskPosition(dept, agent.seat);
        const p = toScreen(desk.x + TILE, desk.y + TILE + 8);
        if (p.x < -100 || p.x > rect.width + 100) continue;

        const status = this.workers[agent.id]?.status || 'offline';
        const w = ctx.measureText(agent.name).width + 12;

        ctx.fillStyle = 'rgba(10,12,18,0.85)';
        ctx.fillRect(p.x - w / 2, p.y - 8, w, 15);
        ctx.fillStyle = STATUS_COLORS[status] || '#6b7280';
        ctx.fillRect(p.x - w / 2, p.y + 5, w, 2);
        ctx.fillStyle = this.selectedAgentId === agent.id ? '#ffd866' : '#d8d5cc';
        ctx.fillText(agent.name, p.x, p.y);
      }
    }

    if (this.visitors.length) {
      const lobby = this._lobbyOrigin();
      const p = toScreen(lobby.x, lobby.y - TILE);
      ctx.textAlign = 'left';
      ctx.font = '600 10px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = '#7f8da3';
      ctx.fillText(
        `VISITORS — ${this.visitors.length} session(s) you started yourself`,
        p.x,
        p.y
      );
    }
  }

  // --- interaction ----------------------------------------------------------

  _hitTest(worldX, worldY) {
    // Later entries are drawn on top, so search backwards.
    for (let i = this._hitboxes.length - 1; i >= 0; i--) {
      const box = this._hitboxes[i];
      if (
        worldX >= box.x &&
        worldX <= box.x + box.w &&
        worldY >= box.y &&
        worldY <= box.y + box.h
      ) {
        return box;
      }
    }
    return null;
  }

  _bindEvents() {
    const canvas = this.canvas;

    canvas.addEventListener('mousedown', (e) => {
      this.dragging = { x: e.clientX, y: e.clientY, moved: false };
    });

    window.addEventListener('mousemove', (e) => {
      if (this.dragging) {
        const dx = e.clientX - this.dragging.x;
        const dy = e.clientY - this.dragging.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.dragging.moved = true;
        this.camera.x -= dx / this.zoom;
        this.camera.y -= dy / this.zoom;
        this.dragging.x = e.clientX;
        this.dragging.y = e.clientY;
        return;
      }

      const world = this.screenToWorld(e.clientX, e.clientY);
      const hit = this._hitTest(world.x, world.y);
      const agentId = hit?.kind === 'agent' ? hit.id : null;
      if (agentId !== this.hoverAgentId) {
        this.hoverAgentId = agentId;
        canvas.style.cursor = agentId ? 'pointer' : 'grab';
      }
    });

    window.addEventListener('mouseup', (e) => {
      const drag = this.dragging;
      this.dragging = null;
      if (!drag || drag.moved) return;
      if (e.target !== canvas) return;

      const world = this.screenToWorld(e.clientX, e.clientY);
      const hit = this._hitTest(world.x, world.y);

      if (hit?.kind === 'agent') {
        this.selectedAgentId = hit.id;
        this.onSelectAgent(hit.id);
      } else if (hit?.kind === 'department') {
        this.onSelectDepartment(hit.id);
      } else {
        this.onBackground();
      }
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Zoom toward the cursor so the point under it stays put.
        const before = this.screenToWorld(e.clientX, e.clientY);
        const next = this.camera.zoomIndex + (e.deltaY > 0 ? -1 : 1);
        this.camera.zoomIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, next));
        const after = this.screenToWorld(e.clientX, e.clientY);
        this.camera.x += before.x - after.x;
        this.camera.y += before.y - after.y;
      },
      { passive: false }
    );

    window.addEventListener('resize', () => this.resize());
  }

  /** Bring an agent into view. */
  focusAgent(agentId) {
    const agent = this.state?.agents.find((a) => a.id === agentId);
    if (!agent) return;
    const dept = this.state.departments.find((d) => d.id === agent.departmentId);
    if (!dept) return;
    const desk = this.deskPosition(dept, agent.seat);
    this.camera.x = desk.x + TILE;
    this.camera.y = desk.y;
  }

  /** Frame the whole office. */
  fit() {
    if (!this.state?.departments.length) return;
    const xs = this.state.departments.flatMap((d) => [d.x, d.x + d.w]);
    const ys = this.state.departments.flatMap((d) => [d.y, d.y + d.h]);
    // Keep the lobby in shot so visiting sessions are not stranded off-screen.
    if (this.visitors.length) ys.push(Math.max(...ys) + 5);
    // Room name plates hang above the top row; leave them somewhere to sit.
    ys.push(Math.min(...ys) - 2);
    this.camera.x = ((Math.min(...xs) + Math.max(...xs)) / 2) * TILE;
    this.camera.y = ((Math.min(...ys) + Math.max(...ys)) / 2) * TILE;

    const rect = this.canvas.getBoundingClientRect();
    const worldW = (Math.max(...xs) - Math.min(...xs)) * TILE;
    const worldH = (Math.max(...ys) - Math.min(...ys)) * TILE;
    let index = 0;
    for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
      if (worldW * ZOOM_LEVELS[i] < rect.width * 0.9 && worldH * ZOOM_LEVELS[i] < rect.height * 0.9) {
        index = i;
        break;
      }
    }
    this.camera.zoomIndex = index;
  }
}
