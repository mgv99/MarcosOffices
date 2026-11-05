/**
 * Floating panels over the office map.
 *
 * The right-hand side panel can only ever show one agent. These windows let
 * several agents be watched at once: drag them by the title bar, resize from
 * any corner, and they stack in the order you last touched them.
 */

const MIN_W = 320;
const MIN_H = 220;

let topZ = 30;
const open = new Map(); // key -> { el, body }

/** Keep a window from being dragged somewhere it cannot be grabbed again. */
function clampToViewport(el) {
  const rect = el.getBoundingClientRect();
  const maxLeft = window.innerWidth - 80;
  const maxTop = window.innerHeight - 50;

  let left = parseFloat(el.style.left) || 0;
  let top = parseFloat(el.style.top) || 0;

  left = Math.min(Math.max(left, -(rect.width - 120)), maxLeft);
  top = Math.min(Math.max(top, 56), maxTop); // never under the top bar

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function raise(el) {
  el.style.zIndex = String(++topZ);
}

/** Cascade each new window so they do not land exactly on top of each other. */
function nextPosition() {
  const n = open.size;
  return {
    left: 90 + ((n * 36) % 320),
    top: 90 + ((n * 30) % 220),
  };
}

function makeDraggable(el, handle) {
  handle.addEventListener('pointerdown', (e) => {
    // Let buttons in the title bar behave like buttons.
    if (e.target.closest('button')) return;
    e.preventDefault();
    raise(el);

    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = parseFloat(el.style.left) || 0;
    const startTop = parseFloat(el.style.top) || 0;

    const move = (ev) => {
      el.style.left = `${startLeft + ev.clientX - startX}px`;
      el.style.top = `${startTop + ev.clientY - startY}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      clampToViewport(el);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function makeResizable(el) {
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const grip = document.createElement('div');
    grip.className = `win-grip win-grip-${corner}`;
    el.append(grip);

    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      raise(el);

      const startX = e.clientX;
      const startY = e.clientY;
      const rect = el.getBoundingClientRect();
      const startLeft = parseFloat(el.style.left) || rect.left;
      const startTop = parseFloat(el.style.top) || rect.top;

      const move = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;

        // Dragging a west or north grip moves the origin as well as the size.
        if (corner.includes('e')) el.style.width = `${Math.max(MIN_W, rect.width + dx)}px`;
        if (corner.includes('s')) el.style.height = `${Math.max(MIN_H, rect.height + dy)}px`;
        if (corner.includes('w')) {
          const width = Math.max(MIN_W, rect.width - dx);
          el.style.width = `${width}px`;
          el.style.left = `${startLeft + (rect.width - width)}px`;
        }
        if (corner.includes('n')) {
          const height = Math.max(MIN_H, rect.height - dy);
          el.style.height = `${height}px`;
          el.style.top = `${startTop + (rect.height - height)}px`;
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        clampToViewport(el);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
}

/**
 * Open (or focus) a floating window.
 *
 * `render(body)` fills the window's content area and is called again whenever
 * `refreshWindow` is used, so a window can follow live state.
 */
export function openWindow(key, { title, subtitle = '', render, onClose }) {
  const existing = open.get(key);
  if (existing) {
    raise(existing.el);
    return existing;
  }

  const el = document.createElement('section');
  el.className = 'win';
  el.dataset.key = key;

  const { left, top } = nextPosition();
  Object.assign(el.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: '480px',
    height: '460px',
  });

  const bar = document.createElement('header');
  bar.className = 'win-bar';
  bar.innerHTML =
    `<div class="win-title"></div><div class="win-sub"></div>` +
    `<button class="win-close" title="Close">✕</button>`;
  bar.querySelector('.win-title').textContent = title;
  bar.querySelector('.win-sub').textContent = subtitle;

  const body = document.createElement('div');
  body.className = 'win-body';

  el.append(bar, body);
  document.body.append(el);

  bar.querySelector('.win-close').addEventListener('click', () => closeWindow(key));
  el.addEventListener('pointerdown', () => raise(el), true);

  makeDraggable(el, bar);
  makeResizable(el);
  raise(el);

  const entry = { el, body, render, onClose };
  open.set(key, entry);
  render?.(body);
  return entry;
}

export function closeWindow(key) {
  const entry = open.get(key);
  if (!entry) return;
  entry.onClose?.();
  entry.el.remove();
  open.delete(key);
}

export function isWindowOpen(key) {
  return open.has(key);
}

export function openWindowKeys() {
  return [...open.keys()];
}

/**
 * Update a window's title bar.
 *
 * The body is left alone unless `rerender` is asked for: rebuilding it would
 * discard the live feed appended since it opened, and throw away the reader's
 * scroll position with it.
 */
export function refreshWindow(key, { title, subtitle, rerender = false } = {}) {
  const entry = open.get(key);
  if (!entry) return;
  if (title != null) entry.el.querySelector('.win-title').textContent = title;
  if (subtitle != null) entry.el.querySelector('.win-sub').textContent = subtitle;
  if (rerender) entry.render?.(entry.body);
}

export function closeAllWindows() {
  for (const key of [...open.keys()]) closeWindow(key);
}
