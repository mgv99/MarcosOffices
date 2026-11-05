/**
 * Every sprite in this office is drawn in code, pixel by pixel. There are no
 * image files: an agent's appearance is derived from a hash of their id, so
 * each member of staff looks like themselves and always will.
 *
 * Everything is drawn 1:1 into a small offscreen canvas and later blitted at
 * an integer scale with smoothing off, which is what keeps the pixels crisp.
 */

export const TILE = 16;

const cache = new Map();
function cached(key, w, h, draw) {
  if (cache.has(key)) return cache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  draw(ctx, canvas);
  cache.set(key, canvas);
  return canvas;
}

/** Fill a rectangle of pixels. The only drawing primitive we need. */
function px(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

// --- colour -----------------------------------------------------------------

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < String(text).length; i++) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const hsl = (h, s, l) => `hsl(${h % 360} ${s}% ${l}%)`;

/** A stable, distinct look for one member of staff. */
export function paletteFor(seed) {
  const h = hash(seed);

  const skins = ['#f3c9a0', '#e0a87a', '#c08457', '#8d5524', '#ffdbac', '#6b4423'];
  const hairs = [20, 35, 0, 275, 210, 145, 320, 45];

  const shirtHue = (h >> 3) % 360;
  const hairHue = hairs[(h >> 7) % hairs.length];
  const dark = ((h >> 11) % 3) === 0;

  return {
    skin: skins[h % skins.length],
    skinShade: 'rgba(0,0,0,0.18)',
    hair: hsl(hairHue, dark ? 25 : 45, dark ? 18 : 32),
    hairLight: hsl(hairHue, dark ? 25 : 45, dark ? 26 : 44),
    shirt: hsl(shirtHue, 45, 46),
    shirtShade: hsl(shirtHue, 45, 34),
    trousers: hsl((shirtHue + 180) % 360, 20, 28),
    shoes: '#2b2b35',
    outline: '#1b1b24',
  };
}

// --- staff ------------------------------------------------------------------

/**
 * A 16x24 character in the classic overworld three-quarter view.
 * `frame` 0/1 is the idle breathing bob; `outfit` gives the CEO a jacket.
 */
export function agentSprite(seed, { outfit = 'shirt', frame = 0 } = {}) {
  return cached(`agent:${seed}:${outfit}:${frame}`, 16, 24, (ctx) => {
    const p = paletteFor(seed);
    const bob = frame === 1 ? 1 : 0; // the whole body drops a pixel

    // Legs and shoes
    px(ctx, 5, 19, 3, 4, p.trousers);
    px(ctx, 8, 19, 3, 4, p.trousers);
    px(ctx, 5, 22, 3, 2, p.shoes);
    px(ctx, 8, 22, 3, 2, p.shoes);

    const bodyY = 11 + bob;

    // Torso
    px(ctx, 4, bodyY, 8, 9 - bob, p.shirt);
    px(ctx, 4, bodyY, 8, 1, p.shirtShade); // collar shadow
    px(ctx, 4, bodyY + 7 - bob, 8, 2, p.shirtShade); // hem

    if (outfit === 'suit') {
      // Lapels and a tie mark the executive floor.
      px(ctx, 4, bodyY, 2, 8 - bob, '#2a2f3d');
      px(ctx, 10, bodyY, 2, 8 - bob, '#2a2f3d');
      px(ctx, 7, bodyY + 1, 2, 5 - bob, '#b4454f');
      px(ctx, 7, bodyY, 2, 1, '#f2f2f5');
    }

    // Arms
    px(ctx, 3, bodyY + 1, 1, 6 - bob, p.shirtShade);
    px(ctx, 12, bodyY + 1, 1, 6 - bob, p.shirtShade);
    px(ctx, 3, bodyY + 7 - bob, 1, 2, p.skin); // hands
    px(ctx, 12, bodyY + 7 - bob, 1, 2, p.skin);

    const headY = 3 + bob;

    // Head
    px(ctx, 4, headY, 8, 8, p.skin);
    px(ctx, 4, headY + 7, 8, 1, p.skinShade); // chin shadow
    px(ctx, 5, headY + 8, 6, 1, p.skin); // neck

    // Hair: a fringe plus a back fall, which reads at this size
    px(ctx, 3, headY - 2, 10, 4, p.hair);
    px(ctx, 3, headY - 1, 10, 1, p.hairLight);
    px(ctx, 3, headY + 2, 2, 4, p.hair);
    px(ctx, 11, headY + 2, 2, 4, p.hair);

    // Eyes
    px(ctx, 6, headY + 3, 1, 2, p.outline);
    px(ctx, 9, headY + 3, 1, 2, p.outline);

    // Mouth
    px(ctx, 7, headY + 6, 2, 1, 'rgba(0,0,0,0.35)');
  });
}

/** A seated agent: same character, folded at a desk. */
export function agentSeated(seed, { outfit = 'shirt', frame = 0 } = {}) {
  return cached(`seated:${seed}:${outfit}:${frame}`, 16, 20, (ctx) => {
    const p = paletteFor(seed);
    const bob = frame === 1 ? 1 : 0;
    const bodyY = 10 + bob;

    px(ctx, 4, bodyY, 8, 9 - bob, p.shirt);
    px(ctx, 4, bodyY, 8, 1, p.shirtShade);

    if (outfit === 'suit') {
      px(ctx, 4, bodyY, 2, 8 - bob, '#2a2f3d');
      px(ctx, 10, bodyY, 2, 8 - bob, '#2a2f3d');
      px(ctx, 7, bodyY + 1, 2, 4, '#b4454f');
    }

    // Arms reaching forward to the desk
    px(ctx, 3, bodyY + 2, 2, 5, p.shirtShade);
    px(ctx, 11, bodyY + 2, 2, 5, p.shirtShade);

    const headY = 2 + bob;
    px(ctx, 4, headY, 8, 8, p.skin);
    px(ctx, 4, headY + 7, 8, 1, p.skinShade);
    px(ctx, 3, headY - 2, 10, 4, p.hair);
    px(ctx, 3, headY - 1, 10, 1, p.hairLight);
    px(ctx, 3, headY + 2, 2, 4, p.hair);
    px(ctx, 11, headY + 2, 2, 4, p.hair);
    px(ctx, 6, headY + 3, 1, 2, p.outline);
    px(ctx, 9, headY + 3, 1, 2, p.outline);
  });
}

// --- furniture --------------------------------------------------------------

const THEMES = {
  default: { floor: '#c8a479', floorAlt: '#bd9a70', wall: '#5a6b8c', wallTop: '#8ea1c4', trim: '#3f4c66' },
  executive: { floor: '#8d6a4f', floorAlt: '#836245', wall: '#6b4f6b', wallTop: '#a583a5', trim: '#4a364a' },
  engineering: { floor: '#9aa6b5', floorAlt: '#909caa', wall: '#3f6b7a', wallTop: '#6fa3b3', trim: '#2b4b56' },
  research: { floor: '#b5ab8e', floorAlt: '#aaa083', wall: '#4e7a5c', wallTop: '#7fae8c', trim: '#355442' },
  creative: { floor: '#c9a0a8', floorAlt: '#be959d', wall: '#8c5a6b', wallTop: '#bf8a9b', trim: '#603c48' },
};

export function themeFor(name) {
  return THEMES[name] || THEMES.default;
}

export const THEME_NAMES = Object.keys(THEMES);

/** Floor tile with a subtle plank pattern so large rooms do not read as flat. */
export function floorTile(theme, variant = 0) {
  return cached(`floor:${theme}:${variant}`, TILE, TILE, (ctx) => {
    const t = themeFor(theme);
    px(ctx, 0, 0, TILE, TILE, variant % 2 ? t.floorAlt : t.floor);
    px(ctx, 0, 0, TILE, 1, 'rgba(255,255,255,0.07)');
    px(ctx, 0, TILE - 1, TILE, 1, 'rgba(0,0,0,0.12)');
    if (variant % 2) px(ctx, 7, 0, 1, TILE, 'rgba(0,0,0,0.08)');
  });
}

/** The face of a back wall. */
export function wallTile(theme) {
  return cached(`wall:${theme}`, TILE, TILE, (ctx) => {
    const t = themeFor(theme);
    px(ctx, 0, 0, TILE, TILE, t.wall);
    px(ctx, 0, 0, TILE, 2, t.wallTop);
    px(ctx, 0, TILE - 2, TILE, 2, t.trim);
    for (let x = 0; x < TILE; x += 8) px(ctx, x, 2, 1, TILE - 4, 'rgba(0,0,0,0.08)');
  });
}

/** The crown along the top of a wall, which gives the room its depth. */
export function wallTopTile(theme) {
  return cached(`walltop:${theme}`, TILE, TILE, (ctx) => {
    const t = themeFor(theme);
    px(ctx, 0, 0, TILE, TILE, t.wallTop);
    px(ctx, 0, TILE - 3, TILE, 3, t.trim);
    px(ctx, 0, 0, TILE, 2, 'rgba(255,255,255,0.15)');
  });
}

/** A desk: two tiles wide, with a monitor that glows when there is work. */
export function deskSprite({ lit = false, ceo = false } = {}) {
  return cached(`desk:${lit}:${ceo}`, TILE * 2, TILE * 2, (ctx) => {
    const top = ceo ? '#6b4a2f' : '#a9743f';
    const front = ceo ? '#4e3522' : '#8a5c31';
    const edge = ceo ? '#372415' : '#6b4725';

    // Desk surface and front panel
    px(ctx, 0, 14, 32, 8, top);
    px(ctx, 0, 14, 32, 2, 'rgba(255,255,255,0.18)');
    px(ctx, 0, 22, 32, 8, front);
    px(ctx, 0, 29, 32, 2, edge);

    // Monitor
    px(ctx, 9, 2, 14, 11, '#2b2b36');
    px(ctx, 10, 3, 12, 8, lit ? '#7fe3c4' : '#3d4452');
    if (lit) {
      // A few code-ish lines on the screen
      px(ctx, 11, 4, 7, 1, '#1d6b56');
      px(ctx, 11, 6, 9, 1, '#1d6b56');
      px(ctx, 11, 8, 5, 1, '#1d6b56');
    }
    px(ctx, 14, 13, 4, 2, '#20202a'); // stand
    px(ctx, 12, 15, 8, 1, '#20202a'); // base

    // Keyboard and mug
    px(ctx, 10, 17, 10, 3, '#d9d9e2');
    px(ctx, 24, 16, 4, 4, ceo ? '#c9a227' : '#cf5f54');
    px(ctx, 28, 17, 1, 2, ceo ? '#c9a227' : '#cf5f54');
  });
}

/** An office chair, seen from behind: a padded back with armrests. */
export function chairSprite() {
  return cached('chair', TILE, TILE, (ctx) => {
    px(ctx, 4, 0, 8, 9, '#49526a'); // backrest
    px(ctx, 4, 0, 8, 2, '#5c6782'); // highlight along the top
    px(ctx, 5, 3, 6, 4, '#3b4357'); // cushion seam
    px(ctx, 2, 4, 2, 4, '#3b4357'); // armrests
    px(ctx, 12, 4, 2, 4, '#3b4357');
    px(ctx, 7, 9, 2, 3, '#2a2f3a'); // post
    px(ctx, 4, 12, 8, 2, '#2a2f3a'); // base
  });
}

export function plantSprite() {
  return cached('plant', TILE, TILE * 2, (ctx) => {
    px(ctx, 5, 20, 6, 10, '#9c5b3c');
    px(ctx, 5, 20, 6, 2, '#b86d49');
    px(ctx, 7, 10, 2, 11, '#3d6b3a');
    for (const [x, y, w, h] of [
      [2, 8, 5, 3], [9, 8, 5, 3], [4, 4, 4, 4], [8, 3, 5, 4], [6, 11, 5, 3],
    ]) {
      px(ctx, x, y, w, h, '#4f8a46');
      px(ctx, x, y, w, 1, '#67a85c');
    }
  });
}

export function coolerSprite() {
  return cached('cooler', TILE, TILE * 2, (ctx) => {
    px(ctx, 4, 2, 8, 12, '#8fd4e8');
    px(ctx, 4, 2, 8, 2, '#bfeaf5');
    px(ctx, 3, 14, 10, 16, '#d8dde6');
    px(ctx, 3, 14, 10, 2, '#eef1f6');
    px(ctx, 5, 19, 6, 3, '#9aa3b2');
  });
}

/** The door gap in a room's front wall. */
export function doorSprite(theme) {
  return cached(`door:${theme}`, TILE, TILE, (ctx) => {
    const t = themeFor(theme);
    px(ctx, 0, 0, TILE, TILE, t.trim);
    px(ctx, 2, 0, 12, TILE, '#6b4725');
    px(ctx, 2, 0, 12, 2, '#8a5c31');
    px(ctx, 11, 8, 2, 2, '#e0c56a');
  });
}

// --- status bubbles ---------------------------------------------------------

export const STATUS_COLORS = {
  offline: '#6b7280',
  starting: '#d2a24c',
  idle: '#4ea3d4',
  working: '#5fc47f',
  awaiting: '#e0a13b',
  error: '#d4574e',
};

/**
 * The little bubble that floats over a working agent's head — the quickest
 * read on the whole map.
 */
export function statusBubble(status) {
  // Deliberately small: at desk scale this sits beside the head, and anything
  // larger reads as a dialog box floating over the room.
  return cached(`bubble:${status}`, 10, 11, (ctx) => {
    const ink = STATUS_COLORS[status] || STATUS_COLORS.offline;

    px(ctx, 1, 0, 8, 8, '#1b1b24'); // outline
    px(ctx, 0, 1, 10, 6, '#1b1b24');
    px(ctx, 1, 1, 8, 6, '#f4f1e8'); // face
    px(ctx, 3, 8, 2, 2, '#1b1b24'); // tail

    switch (status) {
      case 'working': // three dots, the universal "busy"
        px(ctx, 2, 3, 2, 2, ink);
        px(ctx, 4, 3, 1, 2, ink);
        px(ctx, 6, 3, 2, 2, ink);
        break;
      case 'idle': // z
        px(ctx, 3, 2, 4, 1, ink);
        px(ctx, 5, 3, 2, 1, ink);
        px(ctx, 3, 4, 2, 1, ink);
        px(ctx, 3, 5, 4, 1, ink);
        break;
      case 'awaiting': // exclamation
        px(ctx, 4, 2, 2, 3, ink);
        px(ctx, 4, 6, 2, 1, ink);
        break;
      case 'error': // cross
        for (let i = 0; i < 4; i++) {
          px(ctx, 3 + i, 2 + i, 1, 1, ink);
          px(ctx, 6 - i, 2 + i, 1, 1, ink);
        }
        break;
      case 'starting': // hourglass
        px(ctx, 3, 2, 4, 1, ink);
        px(ctx, 4, 3, 2, 1, ink);
        px(ctx, 4, 4, 2, 1, ink);
        px(ctx, 3, 5, 4, 1, ink);
        break;
      default:
        px(ctx, 3, 3, 4, 2, ink);
    }
  });
}

/** A soft pool of light under the selected agent. */
export function selectionRing() {
  return cached('selection', TILE * 2, TILE, (ctx) => {
    ctx.strokeStyle = '#ffd866';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(1.5, 1.5, TILE * 2 - 3, TILE - 3);
  });
}
