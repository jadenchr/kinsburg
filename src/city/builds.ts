// What the city builds when commenters ask for it (shared/builds.mjs BUILDS), the hidden spots
// and the "saved for a bestie" sign. Same iso conventions as objects.ts: one tile footprint, u to
// the lower right, v to the lower left, the +v (left) and +u (right) faces are visible, z in tile
// widths. Everything is painted into the chunk cache, so it follows the sky (lit windows, string
// lights and lamp glow switch on at night) whenever the chunks are re-keyed.
import { COLORS, alpha, mix, type SkyState } from '../theme';
import {
  box, fillPoly, glassColor, groundEllipse, hash, material, projX, projY, trace, wallMat, type Proj,
} from './iso';
import type { Look } from './ground';
import type { Obj } from './model';
import { hipRoof, windowRow } from './services';

const TAU = Math.PI * 2;

/** Sprite colours (fixed hues; the sky tints them through material()). */
const K = {
  water: '#4cc2ea', red: '#d0493f', yellow: '#f3c34b', pink: '#f08fb2', mint: '#6fcfb0', purple: '#8266b8',
  stone: '#cfc8bb', brick: '#b85d43', wood: '#a06f43', leaf: '#4c9a4a', white: '#f7f4ee', navy: '#2f4f8f',
  orange: '#f08a3c', steel: '#8ea2b5', ink: '#2a2f45', cream: '#f3e3c8', iron: '#8a4a3a', copper: '#5fb8a0',
  sand: '#e8d29a', concrete: '#b9bcc2',
} as const;

/** Height above the ground in world px, for chunk bounds and tap tests. */
export const BUILD_HEIGHT: Record<string, number> = {
  pool: 44, fountain: 46, park: 62, playground: 48, ferris: 104, carousel: 72, castle: 92, tower: 114, statue: 92,
  garden: 40, treehouse: 88, cafe: 52, bakery: 58, icecream: 66, pizza: 56, library: 66, museum: 66, stadium: 58,
  skatepark: 36, shop: 52, ship: 88, cinema: 66,
};

const X = (p: Proj, u: number, v: number) => projX(p, u, v);
const Y = (p: Proj, u: number, v: number, z: number) => projY(p, u, v, z);
const lit = (sky: SkyState) => sky.glow > 0.05;

function disc(ctx: CanvasRenderingContext2D, p: Proj, u: number, v: number, z: number, r: number, color: string): void {
  groundEllipse(ctx, p, u, v, z, r);
  ctx.fillStyle = color;
  ctx.fill();
}

function shadow(ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, r: number, a = 0.16): void {
  disc(ctx, p, 0, 0, 0, r, alpha(sky.palette.edge, a));
}

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, sky: SkyState, k = 1): void {
  if (!lit(sky)) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, alpha(COLORS.glow, 0.7 * sky.glow * k));
  g.addColorStop(1, alpha(COLORS.glow, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

/** A bulb that is warm at night and plain by day. */
function bulb(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, sky: SkyState, color: string): void {
  ctx.fillStyle = lit(sky) ? mix(color, COLORS.glow, Math.min(1, sky.glow)) : color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  if (lit(sky)) glow(ctx, x, y, r * 4.5, sky, 0.6);
}

/** Paint a shape lit on its left, then again on its right half. */
function twoTone(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number, rx: number, path: () => void, l: string, r: string): void {
  path();
  ctx.fillStyle = l;
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, Math.min(y0, y1) - 400, rx + 2, Math.abs(y0 - y1) + 800);
  ctx.clip();
  path();
  ctx.fillStyle = r;
  ctx.fill();
  ctx.restore();
}

/** Upright cylinder centred on (u, v) from z0 to z1, with a flat top. */
function drum(ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, u: number, v: number, z0: number, z1: number, r: number, color: string, top?: string): void {
  const m = material(sky, color);
  const x = X(p, u, v), ya = Y(p, u, v, z0), yb = Y(p, u, v, z1);
  const rx = r * p.s * 0.7071, ry = rx * 0.5;
  twoTone(ctx, x, ya, yb, rx, () => {
    ctx.beginPath();
    ctx.ellipse(x, ya, rx, ry, 0, 0, Math.PI);
    ctx.lineTo(x - rx, yb);
    ctx.ellipse(x, yb, rx, ry, 0, Math.PI, TAU);
    ctx.closePath();
  }, m.l, m.r);
  ctx.beginPath();
  ctx.ellipse(x, yb, rx, ry, 0, 0, TAU);
  ctx.fillStyle = top ?? m.top;
  ctx.fill();
}

/** Cone from a round base at z0 up to a point at z1. */
function cone(ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, u: number, v: number, z0: number, z1: number, r: number, color: string): void {
  const m = material(sky, color);
  const x = X(p, u, v), ya = Y(p, u, v, z0), yb = Y(p, u, v, z1);
  const rx = r * p.s * 0.7071, ry = rx * 0.5;
  twoTone(ctx, x, ya, yb, rx, () => {
    ctx.beginPath();
    ctx.ellipse(x, ya, rx, ry, 0, 0, Math.PI);
    ctx.lineTo(x, yb);
    ctx.closePath();
  }, m.l, m.r);
}

function tree(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, look: Look, round = true): void {
  const r = 9 * k;
  ctx.fillStyle = look.shadow;
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.9, r * 0.45, 0, 0, TAU);
  ctx.fill();
  if (!round) {
    ctx.fillStyle = look.trunk;
    ctx.fillRect(x - 1.2 * k, y - 5 * k, 2.4 * k, 5 * k);
    const h = 26 * k, b = y - 4 * k, w = 8 * k;
    ctx.fillStyle = look.treeL;
    ctx.beginPath();
    ctx.moveTo(x, b - h);
    ctx.lineTo(x - w, b);
    ctx.lineTo(x, b + 2);
    ctx.fill();
    ctx.fillStyle = look.treeR;
    ctx.beginPath();
    ctx.moveTo(x, b - h);
    ctx.lineTo(x + w, b);
    ctx.lineTo(x, b + 2);
    ctx.fill();
    return;
  }
  ctx.fillStyle = look.trunk;
  ctx.fillRect(x - 1.3 * k, y - 7 * k, 2.6 * k, 7 * k);
  const cy = y - 7 * k - r * 0.8;
  ctx.fillStyle = look.treeShade;
  ctx.beginPath();
  ctx.arc(x, cy, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = look.treeLit;
  ctx.beginPath();
  ctx.arc(x + look.sky.sunX * r * 0.22, cy - r * 0.16, r * 0.78, 0, TAU);
  ctx.fill();
}

/** Flat rectangle on the +v (left) face. */
const faceL = (ctx: CanvasRenderingContext2D, p: Proj, v: number, u0: number, u1: number, z0: number, z1: number, c: string) =>
  fillPoly(ctx, p, [u0, v, z0, u1, v, z0, u1, v, z1, u0, v, z1], c);
/** Flat rectangle on the +u (right) face. */
const faceR = (ctx: CanvasRenderingContext2D, p: Proj, u: number, v0: number, v1: number, z0: number, z1: number, c: string) =>
  fillPoly(ctx, p, [u, v1, z0, u, v0, z0, u, v0, z1, u, v1, z1], c);

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, w: number, c: string): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineWidth = w;
  ctx.strokeStyle = c;
  ctx.stroke();
}

/** A circle standing on the +v plane (u across, z up). */
function ringPoly(u: number, v: number, z: number, r: number, n = 24): number[] {
  const c: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU;
    c.push(u + Math.cos(a) * r, v, z + Math.sin(a) * r);
  }
  return c;
}

// ── small shop used by cafe, bakery, ice cream, pizza, shop and cinema ─────────────────────────
interface ShopStyle {
  wall: string;
  roof: string;
  awn: string;
  sign: 'cup' | 'bread' | 'cone' | 'pizza' | 'bag' | 'film';
}

function shop(ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, detail: number, seed: number, st: ShopStyle, H = 0.42): void {
  const pal = sky.palette;
  const wall = wallMat(sky, st.wall);
  const roof = material(sky, st.roof);
  const awn = material(sky, st.awn);
  const u0 = -0.5, u1 = 0.1, v0 = -0.5, v1 = 0.06;
  shadow(ctx, p, sky, 0.7);
  box(ctx, p, u0, u1, v0, v1, 0, H, null, wall.l, wall.r);
  box(ctx, p, u0 - 0.04, u1 + 0.04, v0 - 0.04, v1 + 0.04, H, H + 0.07, roof.top, roof.l, roof.r);
  if (detail >= 1) fillPoly(ctx, p, [u0 + 0.02, v0 + 0.02, H + 0.07, u1 - 0.02, v0 + 0.02, H + 0.07, u1 - 0.02, v1 - 0.02, H + 0.07, u0 + 0.02, v1 - 0.02, H + 0.07], roof.dark);
  // shop window and door on the +v face, window on the +u face
  const g = glassColor(sky, lit(sky), 1);
  faceL(ctx, p, v1 + 0.001, u0 + 0.06, u1 - 0.24, 0.06, 0.26, g);
  faceL(ctx, p, v1 + 0.001, u1 - 0.18, u1 - 0.06, 0, 0.26, mix(awn.base, pal.edge, 0.45));
  faceR(ctx, p, u1 + 0.001, v0 + 0.1, v1 - 0.1, 0.08, 0.26, glassColor(sky, hash(seed) < 0.7, 0.8));
  // striped awning over the window
  const n = 5;
  for (let k = 0; k < n; k++) {
    const a = u0 + 0.04 + ((u1 - u0 - 0.08) * k) / n;
    const b = u0 + 0.04 + ((u1 - u0 - 0.08) * (k + 1)) / n;
    fillPoly(ctx, p, [a, v1, 0.32, b, v1, 0.32, b, v1 + 0.15, 0.24, a, v1 + 0.15, 0.24], k % 2 ? mix(pal.wall, awn.base, 0.1) : awn.l);
  }
  // sign on the roof edge
  const sx = X(p, (u0 + u1) / 2, v1 + 0.02), sy = Y(p, (u0 + u1) / 2, v1 + 0.02, H + 0.2);
  glow(ctx, sx, sy, 22, sky, 0.5);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.fillStyle = mix(K.white, pal.wallShade, 0.35 * sky.darkness);
  ctx.strokeStyle = alpha(pal.edge, 0.7);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, 8.5, 0, TAU);
  ctx.fill();
  ctx.stroke();
  switch (st.sign) {
    case 'cup':
      ctx.fillStyle = K.wood;
      ctx.fillRect(-3.5, -2.5, 6, 6);
      ctx.strokeStyle = K.wood;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(3, 0.5, 2, -1.2, 1.2);
      ctx.stroke();
      break;
    case 'bread':
      ctx.fillStyle = K.orange;
      ctx.beginPath();
      ctx.ellipse(0, 0.5, 5.2, 3.2, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = K.cream;
      ctx.lineWidth = 0.9;
      for (const d of [-2.2, 0, 2.2]) {
        ctx.beginPath();
        ctx.moveTo(d - 0.8, -1.5);
        ctx.lineTo(d + 0.8, 2.4);
        ctx.stroke();
      }
      break;
    case 'cone':
      ctx.fillStyle = K.orange;
      ctx.beginPath();
      ctx.moveTo(-3, 0);
      ctx.lineTo(3, 0);
      ctx.lineTo(0, 6);
      ctx.fill();
      ctx.fillStyle = K.pink;
      ctx.beginPath();
      ctx.arc(0, -1.6, 3.4, 0, TAU);
      ctx.fill();
      break;
    case 'pizza':
      ctx.fillStyle = K.yellow;
      ctx.beginPath();
      ctx.arc(0, 0, 5.2, 0, TAU);
      ctx.fill();
      ctx.fillStyle = K.red;
      for (const [a, b] of [[-2, -1.5], [2, -2], [0, 2], [-2.5, 2], [2.8, 1.4]]) {
        ctx.beginPath();
        ctx.arc(a, b, 1.1, 0, TAU);
        ctx.fill();
      }
      break;
    case 'bag':
      ctx.fillStyle = K.pink;
      ctx.fillRect(-3.8, -2, 7.6, 6.4);
      ctx.strokeStyle = K.ink;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, -2, 2.2, Math.PI, 0);
      ctx.stroke();
      break;
    case 'film':
      ctx.fillStyle = K.ink;
      ctx.fillRect(-5, -3.6, 10, 7.2);
      ctx.fillStyle = K.white;
      for (let i = -4; i <= 3; i += 2) {
        ctx.fillRect(i, -3.1, 1.1, 1.1);
        ctx.fillRect(i, 2, 1.1, 1.1);
      }
      break;
  }
  ctx.restore();
}

// ── the kinds ───────────────────────────────────────────────────────────────────────────────────
type Draw = (ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, look: Look, detail: number, seed: number) => void;

const pool: Draw = (ctx, p, sky, _look, detail) => {
  const pal = sky.palette;
  const stone = wallMat(sky, K.stone);
  shadow(ctx, p, sky, 0.85, 0.12);
  box(ctx, p, -0.66, 0.66, -0.66, 0.66, 0, 0.05, stone.top, stone.l, stone.r);
  const w = mix(mix(pal.water, K.water, 0.55), K.white, 0.08);
  const glowy = lit(sky) ? mix(w, '#9fefff', 0.55 * sky.glow) : w;
  fillPoly(ctx, p, [-0.52, -0.52, 0.056, 0.52, -0.52, 0.056, 0.52, 0.52, 0.056, -0.52, 0.52, 0.056], glowy);
  if (detail >= 1) {
    for (const v of [-0.17, 0.17]) fillPoly(ctx, p, [-0.46, v, 0.058, 0.46, v, 0.058, 0.46, v + 0.012, 0.058, -0.46, v + 0.012, 0.058], alpha(K.white, 0.5));
    for (const [a, b] of [[-0.3, -0.34], [0.2, 0.28], [0.3, -0.1]] as const) {
      fillPoly(ctx, p, [a, b, 0.06, a + 0.12, b, 0.06, a + 0.12, b + 0.012, 0.06, a, b + 0.012, 0.06], alpha(pal.waterShine, 0.9));
    }
    // ladder + a lounger with a parasol
    const lx = X(p, 0.52, -0.2), ly = Y(p, 0.52, -0.2, 0.06);
    line(ctx, lx, ly, lx, ly - 9, 1.2, K.steel);
    line(ctx, lx + 4, ly + 1, lx + 4, ly - 9, 1.2, K.steel);
    box(ctx, p, -0.6, -0.4, 0.38, 0.6, 0.05, 0.1, K.white, mix(K.white, pal.wallShade, 0.3), mix(K.white, pal.wallShade, 0.15));
    drum(ctx, p, sky, -0.62, 0.55, 0.05, 0.45, 0.012, K.steel);
    cone(ctx, p, sky, -0.62, 0.55, 0.4, 0.55, 0.2, K.red);
  }
};

const fountain: Draw = (ctx, p, sky, _look, detail) => {
  const pal = sky.palette;
  shadow(ctx, p, sky, 0.85, 0.12);
  disc(ctx, p, 0, 0, 0, 0.72, mix(wallMat(sky, K.stone).base, pal.edge, 0.12));
  drum(ctx, p, sky, 0, 0, 0, 0.14, 0.55, K.stone);
  disc(ctx, p, 0, 0, 0.14, 0.46, mix(pal.water, pal.waterShine, 0.25));
  drum(ctx, p, sky, 0, 0, 0.14, 0.52, 0.07, K.stone);
  drum(ctx, p, sky, 0, 0, 0.4, 0.46, 0.27, K.stone);
  disc(ctx, p, 0, 0, 0.46, 0.22, mix(pal.water, pal.waterShine, 0.45));
  drum(ctx, p, sky, 0, 0, 0.46, 0.7, 0.04, K.stone);
  disc(ctx, p, 0, 0, 0.7, 0.1, pal.waterShine);
  if (detail >= 1) {
    ctx.strokeStyle = alpha(pal.waterShine, 0.95);
    ctx.lineWidth = 1.4;
    const x = X(p, 0, 0), y = Y(p, 0, 0, 0.7);
    for (const d of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.quadraticCurveTo(x + d * 10, y - 12, x + d * 17, y + 6);
      ctx.stroke();
    }
    ctx.fillStyle = alpha(K.white, 0.9);
    ctx.beginPath();
    ctx.arc(x, y - 9, 1.6, 0, TAU);
    ctx.fill();
  }
  if (lit(sky)) glow(ctx, X(p, 0, 0), Y(p, 0, 0, 0.3), 30, sky, 0.35);
};

const park: Draw = (ctx, p, sky, look, detail, seed) => {
  const pal = sky.palette;
  disc(ctx, p, 0, 0, 0, 0.82, mix(pal.park, pal.grassShade, 0.2));
  disc(ctx, p, 0, 0.05, 0.003, 0.5, mix(pal.sand, pal.park, 0.55));
  const spots: [number, number, number, boolean][] = [[-0.5, -0.4, 1.2, true], [0.45, -0.45, 1.05, false], [-0.4, 0.4, 0.95, true], [0.5, 0.35, 1.15, false]];
  // trees behind the bench first
  const bx = 0.02;
  for (const [u, v, k, r] of spots.filter((s) => s[0] + s[1] < 0.2)) tree(ctx, X(p, u, v), Y(p, u, v, 0), k, look, r);
  // pond-side bench
  const wood = material(sky, K.wood);
  box(ctx, p, bx - 0.22, bx + 0.22, 0.02, 0.1, 0.06, 0.12, wood.top, wood.l, wood.r);
  box(ctx, p, bx - 0.22, bx + 0.22, 0.02, 0.04, 0.12, 0.26, null, wood.l, wood.r);
  for (const [u, v, k, r] of spots.filter((s) => s[0] + s[1] >= 0.2)) tree(ctx, X(p, u, v), Y(p, u, v, 0), k, look, r);
  if (detail >= 1) {
    for (let i = 0; i < 6; i++) {
      const u = (hash(seed, i, 1) - 0.5) * 1.1, v = (hash(seed, i, 2) - 0.5) * 1.1;
      ctx.fillStyle = look.flowers[i % look.flowers.length];
      ctx.beginPath();
      ctx.arc(X(p, u, v), Y(p, u, v, 0), 1.5, 0, TAU);
      ctx.fill();
    }
    // a lamp that comes on at night
    const lx = X(p, 0.3, 0.12), ly = Y(p, 0.3, 0.12, 0);
    line(ctx, lx, ly, lx, ly - 24, 1.4, look.lampPost);
    bulb(ctx, lx, ly - 25, 2.4, sky, K.cream);
  }
};

const playground: Draw = (ctx, p, sky, _look, detail) => {
  const pal = sky.palette;
  shadow(ctx, p, sky, 0.85, 0.1);
  disc(ctx, p, 0, 0, 0, 0.78, mix(pal.sand, pal.park, 0.25));
  const red = material(sky, K.red), yel = material(sky, K.yellow), blu = material(sky, K.navy);
  // slide: tower + ramp
  box(ctx, p, -0.55, -0.3, -0.45, -0.2, 0, 0.42, red.top, red.l, red.r);
  fillPoly(ctx, p, [-0.3, -0.42, 0.4, -0.3, -0.24, 0.4, 0.15, -0.24, 0.04, 0.15, -0.42, 0.04], yel.r);
  box(ctx, p, -0.55, -0.3, -0.45, -0.2, 0.42, 0.5, blu.top, blu.l, blu.r);
  // swings: frame + seats
  const post = (u: number, v: number) => drum(ctx, p, sky, u, v, 0, 0.5, 0.025, K.steel);
  post(0.1, 0.38);
  post(0.55, 0.38);
  post(0.1, 0.58);
  post(0.55, 0.58);
  fillPoly(ctx, p, [0.1, 0.38, 0.5, 0.55, 0.38, 0.5, 0.55, 0.58, 0.5, 0.1, 0.58, 0.5], mix(K.steel, pal.edge, 0.2));
  if (detail >= 1) {
    for (const u of [0.22, 0.43]) {
      const x0 = X(p, u, 0.48), y0 = Y(p, u, 0.48, 0.5), y1 = Y(p, u, 0.48, 0.18);
      line(ctx, x0 - 3, y0, x0 - 3, y1, 0.9, K.ink);
      line(ctx, x0 + 3, y0, x0 + 3, y1, 0.9, K.ink);
      ctx.fillStyle = u < 0.3 ? K.pink : K.mint;
      ctx.fillRect(x0 - 4, y1, 8, 2.4);
    }
    // see-saw
    fillPoly(ctx, p, [-0.1, 0.2, 0.1, 0.3, 0.2, 0.16, 0.3, 0.26, 0.2, 0.2, -0.1, 0.1, 0.2, 0.25], K.orange);
  }
};

const ferris: Draw = (ctx, p, sky, _look, detail, seed) => {
  const pal = sky.palette;
  shadow(ctx, p, sky, 0.8);
  const stone = wallMat(sky, K.stone);
  box(ctx, p, -0.5, 0.5, -0.12, 0.2, 0, 0.05, stone.top, stone.l, stone.r);
  const zc = 0.86, R = 0.62, v = 0.03;
  const hx = X(p, 0, v), hy = Y(p, 0, v, zc);
  const steel = mix(material(sky, K.steel).base, pal.edge, 0.15);
  // A-frame legs
  for (const side of [-1, 1]) {
    line(ctx, X(p, side * 0.46, v - 0.02), Y(p, side * 0.46, v - 0.02, 0.05), hx, hy, 2.4, steel);
    line(ctx, X(p, side * 0.46, v + 0.1), Y(p, side * 0.46, v + 0.1, 0.05), hx, hy, 2.4, steel);
  }
  // rim and spokes
  trace(ctx, p, ringPoly(0, v, zc, R));
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = mix(material(sky, K.red).base, pal.edge, 0.1);
  ctx.stroke();
  trace(ctx, p, ringPoly(0, v, zc, R * 0.55, 18));
  ctx.lineWidth = 1;
  ctx.strokeStyle = alpha(steel, 0.8);
  ctx.stroke();
  const n = 12;
  const rot = hash(seed, 1) * TAU;
  for (let k = 0; k < n; k++) {
    const a = rot + (k / n) * TAU;
    const ex = X(p, Math.cos(a) * R, v), ey = Y(p, Math.cos(a) * R, v, zc + Math.sin(a) * R);
    line(ctx, hx, hy, ex, ey, 1, alpha(steel, 0.85));
    const col = [K.yellow, K.pink, K.mint, K.orange][k % 4];
    if (detail >= 1) {
      ctx.fillStyle = mix(col, pal.edge, 0.15 * sky.darkness);
      ctx.fillRect(ex - 3.2, ey - 1, 6.4, 5.4);
      ctx.fillStyle = alpha(pal.edge, 0.4);
      ctx.fillRect(ex - 3.2, ey - 1, 6.4, 1.3);
    }
    if (lit(sky)) bulb(ctx, ex, ey - 4, 1.4, sky, K.cream);
  }
  ctx.fillStyle = material(sky, K.red).base;
  ctx.beginPath();
  ctx.arc(hx, hy, 3.2, 0, TAU);
  ctx.fill();
  // ticket booth
  const t = material(sky, K.pink);
  box(ctx, p, 0.3, 0.52, 0.3, 0.52, 0, 0.22, t.top, t.l, t.r);
  cone(ctx, p, sky, 0.41, 0.41, 0.22, 0.36, 0.2, K.red);
};

const carousel: Draw = (ctx, p, sky, _look, detail, seed) => {
  const pal = sky.palette;
  shadow(ctx, p, sky, 0.8);
  drum(ctx, p, sky, 0, 0, 0, 0.09, 0.66, K.pink);
  disc(ctx, p, 0, 0, 0.095, 0.55, mix(K.cream, pal.wallShade, 0.2 * sky.darkness));
  drum(ctx, p, sky, 0, 0, 0.09, 0.55, 0.06, K.yellow);
  const horses = 6;
  for (let k = 0; k < horses; k++) {
    const a = (k / horses) * TAU + 0.4;
    const u = Math.cos(a) * 0.4, v = Math.sin(a) * 0.4;
    if (v < 0) continue; // far side is hidden behind the canopy anyway; keep the near horses
    drum(ctx, p, sky, u, v, 0.09, 0.52, 0.014, K.yellow);
    if (detail >= 1) {
      ctx.fillStyle = [K.white, K.pink, K.mint, K.orange][k % 4];
      ctx.beginPath();
      ctx.ellipse(X(p, u, v), Y(p, u, v, 0.3), 4.2, 3, 0, 0, TAU);
      ctx.fill();
    }
  }
  // canopy: striped cone
  const z0 = 0.52, z1 = 0.86;
  cone(ctx, p, sky, 0, 0, z0, z1, 0.64, K.red);
  if (detail >= 1) {
    const x = X(p, 0, 0), ya = Y(p, 0, 0, z0), yb = Y(p, 0, 0, z1), rx = 0.64 * p.s * 0.7071;
    ctx.fillStyle = alpha(K.white, 0.82);
    for (let k = -1; k <= 1; k++) {
      const bx = x + k * rx * 0.55;
      ctx.beginPath();
      ctx.moveTo(x + k * rx * 0.1, yb);
      ctx.lineTo(bx - rx * 0.16, ya + Math.sqrt(Math.max(0, 1 - (k * 0.55) ** 2)) * rx * 0.5 * 0.9);
      ctx.lineTo(bx + rx * 0.16, ya + Math.sqrt(Math.max(0, 1 - (k * 0.55) ** 2)) * rx * 0.5 * 0.9);
      ctx.fill();
    }
    for (let k = 0; k < 7; k++) {
      const a = Math.PI * (k / 6);
      bulb(ctx, x - Math.cos(a) * rx * 0.97, ya + Math.sin(a) * rx * 0.48, 1.1, sky, K.cream);
    }
    drum(ctx, p, sky, 0, 0, z1, z1 + 0.1, 0.012, K.steel);
    fillPoly(ctx, p, [0, 0, z1 + 0.1, 0.0, 0.0, z1 + 0.1, 0.0, -0.14, z1 + 0.04, 0.0, -0.14, z1 + 0.16], K.yellow);
  }
  void seed;
};

const castle: Draw = (ctx, p, sky, _look, detail, seed) => {
  const pal = sky.palette;
  const stone = wallMat(sky, K.stone);
  const roof = material(sky, K.navy);
  shadow(ctx, p, sky, 0.85);
  // back towers first, then walls, then front towers
  const T = 0.5, tr = 0.15;
  const tower = (u: number, v: number, h: number, col = roof) => {
    drum(ctx, p, sky, u, v, 0, h, tr, K.stone);
    cone(ctx, p, sky, u, v, h, h + 0.3, tr + 0.05, K.navy);
    void col;
    if (detail >= 1) {
      const x = X(p, u, v), y = Y(p, u, v, h * 0.55);
      ctx.fillStyle = glassColor(sky, lit(sky), 1);
      ctx.fillRect(x - 1.6, y - 4, 3.2, 7);
    }
  };
  tower(-T, -T, 0.6);
  tower(T, -T, 0.52);
  box(ctx, p, -T, T, -T, T, 0, 0.36, null, stone.l, stone.r);
  // battlements
  if (detail >= 1)
    for (let k = 0; k < 5; k++) {
      const a = -T + 0.1 + k * 0.2;
      box(ctx, p, a, a + 0.1, T - 0.05, T, 0.36, 0.44, stone.top, stone.l, stone.r);
      box(ctx, p, T - 0.05, T, a, a + 0.1, 0.36, 0.44, stone.top, stone.l, stone.r);
    }
  // keep
  box(ctx, p, -0.2, 0.2, -0.2, 0.2, 0.36, 0.78, null, stone.l, stone.r);
  hipRoof(ctx, p, 0.24, 0.24, 0.77, 1.02, 0.02, roof);
  fillPoly(ctx, p, [-0.0, 0, 1.02, 0.0, 0, 1.3, 0.2, 0, 1.2], K.red);
  line(ctx, X(p, 0, 0), Y(p, 0, 0, 1.0), X(p, 0, 0), Y(p, 0, 0, 1.28), 1.4, K.ink);
  windowRow(ctx, p, sky, 'l', 0.2 + 0.001, -0.14, 0.14, 0.5, 0.68, 2, seed);
  windowRow(ctx, p, sky, 'r', 0.2 + 0.001, -0.14, 0.14, 0.5, 0.68, 2, seed + 1);
  // gate
  faceL(ctx, p, T + 0.001, -0.1, 0.1, 0, 0.24, mix(K.ink, pal.edge, 0.3));
  tower(-T, T, 0.62);
  tower(T, T, 0.62);
};

const tower: Draw = (ctx, p, sky, _look, detail) => {
  const pal = sky.palette;
  const iron = material(sky, K.iron);
  shadow(ctx, p, sky, 0.7);
  const dark = mix(iron.dark, pal.edge, 0.3);
  // two visible faces of a tapering lattice tower
  const face = (leftFace: boolean) => {
    const P = (a: number, z: number): [number, number, number] => (leftFace ? [a, 0.38 - z * 0.26, z] : [0.38 - z * 0.26, a, z]);
    const flat = (pts: [number, number, number][], c: string) => fillPoly(ctx, p, pts.flat(), c);
    const w = (z: number) => 0.38 - z * 0.27;
    const col = leftFace ? iron.l : iron.r;
    // legs: two stripes from the base to the first platform, then a single shaft
    flat([P(-0.38, 0), P(-0.28, 0), P(-0.14, 0.4), P(-0.2, 0.4)], col);
    flat([P(0.28, 0), P(0.38, 0), P(0.2, 0.4), P(0.14, 0.4)], col);
    // arch between the legs
    flat([P(-0.28, 0), P(0.28, 0), P(0.14, 0.4), P(-0.14, 0.4)], alpha(dark, 0.0));
    flat([P(-0.2, 0.4), P(0.2, 0.4), P(0.1, 0.8), P(-0.1, 0.8)], col);
    flat([P(-0.1, 0.8), P(0.1, 0.8), P(0.04, 1.3), P(-0.04, 1.3)], col);
    if (detail >= 1) {
      ctx.strokeStyle = alpha(dark, 0.85);
      ctx.lineWidth = 0.9;
      for (let z = 0.05; z < 1.25; z += z < 0.4 ? 0.1 : 0.14) {
        const a = z < 0.4 ? 0.3 - z * 0.38 : z < 0.8 ? 0.2 - (z - 0.4) * 0.25 : 0.1 - (z - 0.8) * 0.12;
        const b = z < 0.4 ? 0.21 : 0.14;
        void b;
        const s1 = P(-a, z), s2 = P(a, z + 0.08);
        ctx.beginPath();
        ctx.moveTo(X(p, s1[0], s1[1]), Y(p, s1[0], s1[1], s1[2]));
        ctx.lineTo(X(p, s2[0], s2[1]), Y(p, s2[0], s2[1], s2[2]));
        ctx.stroke();
        const s3 = P(a, z), s4 = P(-a, z + 0.08);
        ctx.beginPath();
        ctx.moveTo(X(p, s3[0], s3[1]), Y(p, s3[0], s3[1], s3[2]));
        ctx.lineTo(X(p, s4[0], s4[1]), Y(p, s4[0], s4[1], s4[2]));
        ctx.stroke();
      }
    }
    void w;
  };
  face(true);
  face(false);
  box(ctx, p, -0.3, 0.3, -0.3, 0.3, 0.38, 0.43, iron.top, iron.l, iron.r);
  box(ctx, p, -0.16, 0.16, -0.16, 0.16, 0.76, 0.8, iron.top, iron.l, iron.r);
  line(ctx, X(p, 0, 0), Y(p, 0, 0, 1.28), X(p, 0, 0), Y(p, 0, 0, 1.72), 1.6, dark);
  bulb(ctx, X(p, 0, 0), Y(p, 0, 0, 1.74), 2.4, sky, K.cream);
  if (lit(sky)) {
    for (const z of [0.43, 0.8]) for (const [u, v] of [[-0.3, 0.3], [0.3, 0.3], [0.3, -0.3]] as const) bulb(ctx, X(p, u, v), Y(p, u, v, z), 1.2, sky, K.cream);
  }
};

const statue: Draw = (ctx, p, sky, _look, detail) => {
  const pal = sky.palette;
  const stone = wallMat(sky, K.stone);
  const cu = material(sky, K.copper);
  shadow(ctx, p, sky, 0.7);
  box(ctx, p, -0.5, 0.5, -0.5, 0.5, 0, 0.1, stone.top, stone.l, stone.r);
  box(ctx, p, -0.34, 0.34, -0.34, 0.34, 0.1, 0.24, stone.top, stone.l, stone.r);
  box(ctx, p, -0.22, 0.22, -0.22, 0.22, 0.24, 0.52, stone.top, stone.l, stone.r);
  // robed body
  const x = X(p, 0, 0);
  fillPoly(ctx, p, [-0.17, 0.12, 0.52, 0.17, 0.12, 0.52, 0.08, 0.04, 1.08, -0.08, 0.04, 1.08], cu.l);
  fillPoly(ctx, p, [0.17, 0.12, 0.52, 0.17, -0.12, 0.52, 0.08, -0.06, 1.08, 0.08, 0.04, 1.08], cu.r);
  // head and crown
  const hy = Y(p, 0, 0, 1.15);
  ctx.fillStyle = cu.base;
  ctx.beginPath();
  ctx.arc(x, hy, 5.6, 0, TAU);
  ctx.fill();
  ctx.fillStyle = cu.top;
  ctx.beginPath();
  ctx.arc(x - 1.2, hy - 1, 3.6, 0, TAU);
  ctx.fill();
  if (detail >= 1) {
    ctx.strokeStyle = cu.dark;
    ctx.lineWidth = 1.5;
    for (let k = -3; k <= 3; k++) {
      ctx.beginPath();
      ctx.moveTo(x + k * 1.5, hy - 5);
      ctx.lineTo(x + k * 3, hy - 11);
      ctx.stroke();
    }
  }
  // raised arm with a torch
  const ax = X(p, 0.1, -0.1), ay = Y(p, 0.1, -0.1, 1.04);
  line(ctx, ax, ay, ax + 7, ay - 22, 3.4, cu.base);
  const fx = ax + 7.5, fy = ay - 29;
  glow(ctx, fx, fy, 24, sky, 0.9);
  ctx.fillStyle = mix(COLORS.gold, K.orange, 0.3);
  ctx.beginPath();
  ctx.moveTo(fx - 3.4, fy + 2);
  ctx.quadraticCurveTo(fx - 4, fy - 5, fx, fy - 9);
  ctx.quadraticCurveTo(fx + 4, fy - 5, fx + 3.4, fy + 2);
  ctx.fill();
  // tablet in the other hand
  fillPoly(ctx, p, [-0.14, 0.14, 0.62, -0.02, 0.2, 0.62, -0.02, 0.2, 0.84, -0.14, 0.14, 0.84], mix(cu.l, pal.edge, 0.1));
};

const garden: Draw = (ctx, p, sky, look, detail, seed) => {
  const pal = sky.palette;
  disc(ctx, p, 0, 0, 0, 0.8, mix(pal.grass, pal.park, 0.5));
  const soil = mix(pal.farm, pal.edge, 0.5);
  const bed = (u: number, v: number, r: number, flowerSet: string[]) => {
    disc(ctx, p, u, v, 0, r, soil);
    for (let i = 0; i < 9; i++) {
      const a = hash(seed, i, u * 9 + v * 7) * TAU;
      const d = Math.sqrt(hash(seed, i + 40, u * 9)) * r * 0.82;
      const fu = u + Math.cos(a) * d, fv = v + Math.sin(a) * d;
      const x = X(p, fu, fv), y = Y(p, fu, fv, 0);
      ctx.strokeStyle = mix(pal.tree, pal.edge, 0.1);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - 3.5);
      ctx.stroke();
      ctx.fillStyle = flowerSet[i % flowerSet.length];
      ctx.beginPath();
      ctx.arc(x, y - 4.4, detail >= 1 ? 2.3 : 1.8, 0, TAU);
      ctx.fill();
    }
  };
  bed(-0.32, -0.2, 0.3, [K.pink, K.white, K.yellow]);
  bed(0.34, -0.12, 0.28, [K.red, K.orange, K.yellow]);
  bed(-0.05, 0.38, 0.32, [K.purple, K.pink, K.white]);
  // greenhouse in the back corner
  const g = glassColor(sky, lit(sky), 0.8);
  const frame = mix(K.white, pal.wallShade, 0.4 * sky.darkness);
  box(ctx, p, -0.55, -0.15, -0.62, -0.38, 0, 0.26, null, mix(g, K.white, 0.25), mix(g, K.white, 0.1));
  fillPoly(ctx, p, [-0.55, -0.38, 0.26, -0.15, -0.38, 0.26, -0.15, -0.38, 0.26, -0.35, -0.5, 0.36, -0.55, -0.5, 0.36], alpha(frame, 0.9));
  if (detail >= 1) for (const a of [-0.45, -0.35, -0.25]) line(ctx, X(p, a, -0.38), Y(p, a, -0.38, 0), X(p, a, -0.38), Y(p, a, -0.38, 0.26), 0.8, frame);
  // arch with roses
  const ax = X(p, 0.3, 0.55), ay = Y(p, 0.3, 0.55, 0);
  ctx.strokeStyle = frame;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(ax - 8, ay);
  ctx.lineTo(ax - 8, ay - 18);
  ctx.quadraticCurveTo(ax, ay - 30, ax + 8, ay - 18);
  ctx.lineTo(ax + 8, ay);
  ctx.stroke();
  ctx.fillStyle = K.pink;
  for (const [dx, dy] of [[-8, -10], [-7, -17], [-2, -25], [4, -24], [8, -16], [7, -8]]) {
    ctx.beginPath();
    ctx.arc(ax + dx, ay + dy, 2.3, 0, TAU);
    ctx.fill();
  }
  void look;
};

const treehouse: Draw = (ctx, p, sky, look, detail) => {
  const pal = sky.palette;
  shadow(ctx, p, sky, 0.8);
  drum(ctx, p, sky, 0.05, -0.05, 0, 0.9, 0.12, K.wood);
  const x = X(p, 0.05, -0.05);
  // canopy: back lobes, then the hut, then front lobes
  const lobe = (dx: number, dy: number, r: number, c: string) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x + dx, Y(p, 0.05, -0.05, 1.0) + dy, r, 0, TAU);
    ctx.fill();
  };
  lobe(-16, 2, 20, look.treeShade);
  lobe(17, 3, 19, look.treeShade);
  lobe(0, -12, 22, look.treeShade);
  lobe(-4, -12, 17, look.treeLit);
  const wall = wallMat(sky, K.cream), roof = material(sky, K.red), wood = material(sky, K.wood);
  // platform + hut
  box(ctx, p, -0.28, 0.4, -0.3, 0.3, 0.46, 0.5, wood.top, wood.l, wood.r);
  box(ctx, p, -0.18, 0.28, -0.2, 0.2, 0.5, 0.76, null, wall.l, wall.r);
  hipRoof(ctx, p, 0.34, 0.26, 0.74, 0.96, 0.1, roof);
  faceL(ctx, p, 0.2 + 0.001, 0.0, 0.2, 0.52, 0.7, glassColor(sky, true, 1));
  faceR(ctx, p, 0.28 + 0.001, -0.12, 0.12, 0.54, 0.7, glassColor(sky, hash(7) < 2, 0.7));
  glow(ctx, X(p, 0.1, 0.2), Y(p, 0.1, 0.2, 0.6), 18, sky, 0.5);
  lobe(15, 10, 14, look.treeLit);
  lobe(-18, 8, 12, look.treeLit);
  if (detail >= 1) {
    // ladder up the trunk and a rope swing
    for (let z = 0.06; z < 0.46; z += 0.07) fillPoly(ctx, p, [0.36, 0.3, z, 0.36, 0.38, z, 0.36, 0.38, z + 0.015, 0.36, 0.3, z + 0.015], wood.dark);
    line(ctx, X(p, 0.4, 0.34), Y(p, 0.4, 0.34, 0.46), X(p, 0.4, 0.34), Y(p, 0.4, 0.34, 0.02), 1, wood.dark);
    line(ctx, X(p, 0.34, 0.3), Y(p, 0.34, 0.3, 0.04), X(p, 0.34, 0.3), Y(p, 0.34, 0.3, 0.46), 1, wood.dark);
    void pal;
  }
};

const cafe: Draw = (ctx, p, sky, _look, detail, seed) => {
  shop(ctx, p, sky, detail, seed, { wall: K.cream, roof: K.wood, awn: K.mint, sign: 'cup' });
  const pal = sky.palette;
  for (const [u, v] of [[-0.3, 0.38], [0.18, 0.4]] as const) {
    drum(ctx, p, sky, u, v, 0, 0.22, 0.012, K.steel);
    disc(ctx, p, u, v, 0.22, 0.14, mix(K.white, pal.wallShade, 0.3 * sky.darkness));
    if (detail >= 1) {
      drum(ctx, p, sky, u, v, 0.22, 0.52, 0.01, K.steel);
      cone(ctx, p, sky, u, v, 0.5, 0.64, 0.22, K.mint);
    }
  }
  // a steaming cup
  if (detail >= 1) {
    ctx.strokeStyle = alpha(K.white, 0.7);
    ctx.lineWidth = 1;
    const x = X(p, -0.2, -0.2), y = Y(p, -0.2, -0.2, 0.7);
    for (const d of [-2, 2]) {
      ctx.beginPath();
      ctx.moveTo(x + d, y);
      ctx.quadraticCurveTo(x + d + 2, y - 4, x + d, y - 8);
      ctx.stroke();
    }
  }
};

const bakery: Draw = (ctx, p, sky, _look, detail, seed) => {
  shop(ctx, p, sky, detail, seed, { wall: K.cream, roof: K.pink, awn: K.pink, sign: 'bread' });
  // chimney with a wisp of smoke
  const br = material(sky, K.brick);
  box(ctx, p, -0.4, -0.28, -0.42, -0.3, 0.46, 0.76, br.top, br.l, br.r);
  if (detail >= 1) {
    const x = X(p, -0.34, -0.36), y = Y(p, -0.34, -0.36, 0.78);
    ctx.fillStyle = alpha(K.white, 0.55);
    for (const [dx, dy, r] of [[0, -4, 3], [3, -10, 3.6], [-1, -17, 4.2]]) {
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, r, 0, TAU);
      ctx.fill();
    }
  }
  // bread crate out front
  const w = material(sky, K.wood);
  box(ctx, p, 0.2, 0.42, 0.18, 0.4, 0, 0.12, w.top, w.l, w.r);
  ctx.fillStyle = K.orange;
  for (const [u, v] of [[0.26, 0.24], [0.34, 0.3]] as const) {
    ctx.beginPath();
    ctx.ellipse(X(p, u, v), Y(p, u, v, 0.14), 3.6, 2, 0, 0, TAU);
    ctx.fill();
  }
};

const icecream: Draw = (ctx, p, sky, _look, detail, seed) => {
  shop(ctx, p, sky, detail, seed, { wall: K.pink, roof: K.white, awn: K.mint, sign: 'cone' }, 0.38);
  // giant cone on the roof
  const x = X(p, -0.2, -0.2);
  const yb = Y(p, -0.2, -0.2, 0.46);
  const waffle = material(sky, K.orange);
  ctx.fillStyle = waffle.l;
  ctx.beginPath();
  ctx.moveTo(x - 7, yb - 12);
  ctx.lineTo(x + 7, yb - 12);
  ctx.lineTo(x, yb + 2);
  ctx.fill();
  ctx.fillStyle = waffle.r;
  ctx.beginPath();
  ctx.moveTo(x, yb - 12);
  ctx.lineTo(x + 7, yb - 12);
  ctx.lineTo(x, yb + 2);
  ctx.fill();
  for (const [dy, r, c] of [[-17, 8, K.pink], [-25, 6.6, K.white], [-31, 3.4, K.red]] as const) {
    ctx.fillStyle = mix(c, sky.palette.edge, 0.15 * sky.darkness);
    ctx.beginPath();
    ctx.arc(x, yb + dy, r, 0, TAU);
    ctx.fill();
  }
  if (detail >= 1) {
    ctx.fillStyle = alpha(K.white, 0.5);
    ctx.beginPath();
    ctx.arc(x - 2.5, yb - 19, 2.2, 0, TAU);
    ctx.fill();
  }
};

const pizza: Draw = (ctx, p, sky, _look, detail, seed) => {
  shop(ctx, p, sky, detail, seed, { wall: K.cream, roof: K.red, awn: K.red, sign: 'pizza' });
  const br = material(sky, K.brick);
  // pizza oven chimney
  drum(ctx, p, sky, -0.36, -0.34, 0.46, 0.84, 0.07, K.brick);
  if (detail >= 1) {
    const x = X(p, -0.36, -0.34), y = Y(p, -0.36, -0.34, 0.86);
    ctx.fillStyle = alpha(K.white, 0.5);
    ctx.beginPath();
    ctx.arc(x + 1, y - 4, 3, 0, TAU);
    ctx.arc(x + 4, y - 11, 3.8, 0, TAU);
    ctx.fill();
  }
  // a scooter delivery bike
  box(ctx, p, 0.2, 0.46, 0.36, 0.44, 0.04, 0.12, K.red, material(sky, K.red).l, material(sky, K.red).r);
  ctx.fillStyle = mix(K.ink, sky.palette.edge, 0.3);
  for (const u of [0.23, 0.43]) {
    ctx.beginPath();
    ctx.arc(X(p, u, 0.42), Y(p, u, 0.42, 0.05), 3.2, 0, TAU);
    ctx.fill();
  }
  void br;
};

const library: Draw = (ctx, p, sky, _look, detail, seed) => {
  const pal = sky.palette;
  const wall = wallMat(sky, K.cream), stone = wallMat(sky, K.stone), roof = material(sky, K.navy);
  shadow(ctx, p, sky, 0.75);
  box(ctx, p, -0.55, 0.52, -0.55, 0.4, 0, 0.1, stone.top, stone.l, stone.r);
  box(ctx, p, -0.46, 0.4, -0.46, 0.3, 0.1, 0.5, null, wall.l, wall.r);
  hipRoof(ctx, p, 0.5, 0.36, 0.49, 0.78, 0.18, roof);
  windowRow(ctx, p, sky, 'l', 0.3 + 0.001, -0.4, 0.2, 0.26, 0.42, 3, seed);
  windowRow(ctx, p, sky, 'r', 0.4 + 0.001, -0.4, 0.2, 0.26, 0.42, 3, seed + 3);
  // portico
  for (const u of [-0.36, -0.18, 0, 0.18]) drum(ctx, p, sky, u, 0.4, 0.1, 0.48, 0.035, K.white);
  box(ctx, p, -0.44, 0.26, 0.34, 0.5, 0.48, 0.54, stone.top, stone.l, stone.r);
  fillPoly(ctx, p, [-0.44, 0.5, 0.54, 0.26, 0.5, 0.54, -0.09, 0.5, 0.72], stone.l);
  // a big open book on the pediment
  const bx = X(p, -0.09, 0.5), by = Y(p, -0.09, 0.5, 0.58);
  ctx.fillStyle = K.red;
  ctx.fillRect(bx - 5, by - 3, 10, 2.4);
  ctx.fillStyle = mix(K.white, pal.wallShade, 0.3 * sky.darkness);
  ctx.beginPath();
  ctx.moveTo(bx, by - 3);
  ctx.lineTo(bx - 5, by - 6);
  ctx.lineTo(bx - 5, by - 3);
  ctx.moveTo(bx, by - 3);
  ctx.lineTo(bx + 5, by - 6);
  ctx.lineTo(bx + 5, by - 3);
  ctx.fill();
  if (detail >= 1) glow(ctx, X(p, 0, 0.5), Y(p, 0, 0.5, 0.3), 24, sky, 0.3);
};

const museum: Draw = (ctx, p, sky, _look, detail, seed) => {
  const pal = sky.palette;
  const wall = wallMat(sky, K.white), stone = wallMat(sky, K.stone), banner = material(sky, K.purple);
  shadow(ctx, p, sky, 0.78);
  for (let k = 0; k < 3; k++) box(ctx, p, -0.6 + k * 0.03, 0.6 - k * 0.03, -0.54 + k * 0.03, 0.54 - k * 0.03, k * 0.03, (k + 1) * 0.03, stone.top, stone.l, stone.r);
  box(ctx, p, -0.48, 0.48, -0.42, 0.4, 0.09, 0.5, null, wall.l, wall.r);
  box(ctx, p, -0.52, 0.52, -0.46, 0.42, 0.5, 0.56, stone.top, stone.l, stone.r);
  fillPoly(ctx, p, [-0.52, 0.42, 0.56, 0.52, 0.42, 0.56, 0, 0.42, 0.8], stone.l);
  fillPoly(ctx, p, [0, 0.42, 0.8, 0.52, 0.42, 0.56, 0.52, -0.46, 0.56, 0, -0.46, 0.8], stone.r);
  for (let k = 0; k < 5; k++) drum(ctx, p, sky, -0.4 + k * 0.2, 0.46, 0.09, 0.5, 0.04, K.white);
  windowRow(ctx, p, sky, 'r', 0.48 + 0.001, -0.36, 0.3, 0.2, 0.42, 3, seed);
  // banners and a lit door
  faceL(ctx, p, 0.41, -0.06, 0.06, 0.09, 0.3, glassColor(sky, true, 1));
  if (detail >= 1) {
    faceL(ctx, p, 0.405, -0.35, -0.22, 0.2, 0.46, banner.base);
    faceL(ctx, p, 0.405, 0.22, 0.35, 0.2, 0.46, banner.base);
  }
  ctx.fillStyle = COLORS.gold;
  ctx.beginPath();
  ctx.arc(X(p, 0, 0.42), Y(p, 0, 0.42, 0.62), 2.6, 0, TAU);
  ctx.fill();
  glow(ctx, X(p, 0, 0.42), Y(p, 0, 0.42, 0.2), 22, sky, 0.4);
  void pal;
};

const stadium: Draw = (ctx, p, sky, _look, detail) => {
  const pal = sky.palette;
  shadow(ctx, p, sky, 0.95, 0.14);
  drum(ctx, p, sky, 0, 0, 0, 0.3, 0.78, K.stone);
  // rim ring (stands) and the pitch
  const x = X(p, 0, 0), rx = 0.78 * p.s * 0.7071;
  const topY = Y(p, 0, 0, 0.3);
  ctx.beginPath();
  ctx.ellipse(x, topY, rx, rx * 0.5, 0, 0, TAU);
  ctx.fillStyle = mix(material(sky, K.red).base, pal.edge, 0.1);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x, topY + 1.5, rx * 0.72, rx * 0.5 * 0.72, 0, 0, TAU);
  ctx.fillStyle = mix(mix(pal.grass, K.leaf, 0.5), pal.edge, 0.1 * sky.darkness);
  ctx.fill();
  if (detail >= 1) {
    ctx.strokeStyle = alpha(K.white, 0.75);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x, topY + 1.5, rx * 0.36, rx * 0.5 * 0.36, 0, 0, TAU);
    ctx.stroke();
    line(ctx, x - rx * 0.36, topY + 1.5 - rx * 0.18, x + rx * 0.36, topY + 1.5 + rx * 0.18, 1, alpha(K.white, 0.75));
    // crowd dots
    for (let k = 0; k < 30; k++) {
      const a = (k / 30) * TAU;
      ctx.fillStyle = [K.yellow, K.white, K.pink, K.mint][k % 4];
      ctx.fillRect(x + Math.cos(a) * rx * 0.88 - 0.8, topY + Math.sin(a) * rx * 0.44 - 0.8, 1.7, 1.7);
    }
  }
  // floodlights
  for (const [u, v] of [[-0.62, -0.1], [0.5, -0.42], [0.62, 0.3], [-0.2, 0.62]] as const) {
    const lx = X(p, u, v), ly = Y(p, u, v, 0.28);
    line(ctx, lx, ly, lx, ly - 22, 1.6, K.steel);
    ctx.fillStyle = mix(K.steel, pal.edge, 0.2);
    ctx.fillRect(lx - 4, ly - 27, 8, 5);
    glow(ctx, lx, ly - 24, 18, sky, 0.9);
    if (lit(sky)) {
      ctx.fillStyle = mix(K.cream, COLORS.glow, sky.glow);
      ctx.fillRect(lx - 3, ly - 26, 6, 3);
    }
  }
};

const skatepark: Draw = (ctx, p, sky, _look, detail) => {
  const pal = sky.palette;
  const con = wallMat(sky, K.concrete);
  shadow(ctx, p, sky, 0.85, 0.1);
  box(ctx, p, -0.7, 0.7, -0.7, 0.7, 0, 0.04, con.top, con.l, con.r);
  // bowl
  disc(ctx, p, 0.1, 0.08, 0.042, 0.4, mix(con.base, pal.edge, 0.35));
  disc(ctx, p, 0.1, 0.1, 0.043, 0.3, mix(con.base, pal.edge, 0.2));
  // quarter pipes
  const q = (u0: number, u1: number, v0: number, v1: number, up: 'u' | 'v') => {
    const m = material(sky, K.steel);
    if (up === 'v') {
      fillPoly(ctx, p, [u0, v1, 0.04, u1, v1, 0.04, u1, v0, 0.34, u0, v0, 0.34], m.l);
      fillPoly(ctx, p, [u1, v1, 0.04, u1, v0, 0.34, u1, v0, 0.04], m.r);
    } else {
      fillPoly(ctx, p, [u1, v0, 0.04, u1, v1, 0.04, u0, v1, 0.34, u0, v0, 0.34], m.r);
      fillPoly(ctx, p, [u0, v1, 0.04, u1, v1, 0.04, u0, v1, 0.34], m.l);
    }
  };
  q(-0.66, -0.2, -0.66, -0.4, 'v');
  q(-0.66, -0.52, -0.2, 0.4, 'u');
  // grind rail + a kid
  if (detail >= 1) {
    line(ctx, X(p, -0.2, 0.52), Y(p, -0.2, 0.52, 0.12), X(p, 0.4, 0.52), Y(p, 0.4, 0.52, 0.12), 1.6, K.steel);
    for (const u of [-0.18, 0.38]) line(ctx, X(p, u, 0.52), Y(p, u, 0.52, 0.12), X(p, u, 0.52), Y(p, u, 0.52, 0.04), 1.2, K.steel);
    const kx = X(p, 0.1, 0.1), ky = Y(p, 0.1, 0.1, 0.05);
    ctx.fillStyle = K.red;
    ctx.fillRect(kx - 2, ky - 12, 4, 7);
    ctx.fillStyle = K.cream;
    ctx.beginPath();
    ctx.arc(kx, ky - 15, 2.4, 0, TAU);
    ctx.fill();
    ctx.fillStyle = K.yellow;
    ctx.fillRect(kx - 5, ky - 4, 10, 2);
  }
};

const shopBuild: Draw = (ctx, p, sky, _look, detail, seed) => {
  shop(ctx, p, sky, detail, seed, { wall: K.white, roof: K.purple, awn: K.pink, sign: 'bag' });
  // balloons by the door
  if (detail >= 1) {
    const x = X(p, 0.3, 0.3), y = Y(p, 0.3, 0.3, 0.1);
    for (const [dx, dy, c] of [[-4, -22, K.red], [3, -26, K.yellow], [8, -20, K.mint]] as const) {
      line(ctx, x, y, x + dx, y + dy + 5, 0.7, alpha(K.ink, 0.5));
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.ellipse(x + dx, y + dy, 3.4, 4.2, 0, 0, TAU);
      ctx.fill();
    }
  }
};

const ship: Draw = (ctx, p, sky, _look, detail, seed) => {
  const pal = sky.palette;
  const hull = material(sky, K.wood), sail = wallMat(sky, K.white);
  disc(ctx, p, 0, 0, 0, 0.8, alpha(pal.water, 0.9));
  disc(ctx, p, 0, 0, 0.002, 0.7, mix(pal.water, pal.waterShine, 0.25));
  // hull: a boat-shaped prism along u
  fillPoly(ctx, p, [-0.52, 0.2, 0.16, 0.5, 0.2, 0.16, 0.38, 0.14, 0.02, -0.4, 0.14, 0.02], mix(hull.l, K.ink, 0.1));
  fillPoly(ctx, p, [0.5, 0.2, 0.16, 0.5, -0.2, 0.16, 0.38, -0.14, 0.02, 0.38, 0.14, 0.02], hull.r);
  fillPoly(ctx, p, [-0.52, 0.2, 0.16, 0.5, 0.2, 0.16, 0.5, -0.2, 0.16, -0.52, -0.2, 0.16], mix(hull.top, K.cream, 0.1));
  // masts and sails
  for (const [u, h, w] of [[-0.12, 0.98, 0.4], [0.24, 0.8, 0.3]] as const) {
    drum(ctx, p, sky, u, 0, 0.14, h, 0.022, K.wood);
    fillPoly(ctx, p, [u, -w * 0.5, h - 0.04, u, w * 0.5, h - 0.04, u, w * 0.5 + 0.02, 0.42, u, -w * 0.5 - 0.02, 0.42], sail.l);
    if (detail >= 1) fillPoly(ctx, p, [u + 0.001, -0.02, h - 0.04, u + 0.001, 0.02, h - 0.04, u + 0.001, 0.02, 0.42, u + 0.001, -0.02, 0.42], alpha(pal.edge, 0.25));
  }
  // jolly roger
  const fx = X(p, -0.12, 0), fy = Y(p, -0.12, 0, 1.02);
  ctx.fillStyle = K.ink;
  ctx.fillRect(fx, fy - 8, 11, 7);
  ctx.fillStyle = K.white;
  ctx.beginPath();
  ctx.arc(fx + 5.5, fy - 5.6, 1.8, 0, TAU);
  ctx.fill();
  ctx.fillRect(fx + 4.6, fy - 4, 1.8, 1.4);
  if (detail >= 1) {
    for (const u of [-0.25, 0.1]) {
      ctx.fillStyle = K.ink;
      ctx.beginPath();
      ctx.arc(X(p, u, 0.2), Y(p, u, 0.2, 0.1), 1.6, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = alpha(K.white, 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(X(p, 0, 0), Y(p, 0, 0, 0.002), 0.68 * 32 * 1.0, 0.34 * 32 * 1.0, 0, 0, TAU);
    ctx.stroke();
  }
  void seed;
  glow(ctx, X(p, 0.4, 0), Y(p, 0.4, 0, 0.3), 14, sky, 0.5);
};

const cinema: Draw = (ctx, p, sky, _look, detail, seed) => {
  shop(ctx, p, sky, detail, seed, { wall: K.navy, roof: K.ink, awn: K.red, sign: 'film' }, 0.5);
  // marquee: a lit board over the entrance with bulbs
  const u0 = -0.46, u1 = 0.06;
  const board = mix(K.ink, sky.palette.edge, 0.3);
  fillPoly(ctx, p, [u0, 0.1, 0.52, u1, 0.1, 0.52, u1, 0.1, 0.34, u0, 0.1, 0.34], board);
  fillPoly(ctx, p, [u0, 0.1, 0.52, u1, 0.1, 0.52, u1, 0.1, 0.48, u0, 0.1, 0.48], mix(K.red, K.ink, 0.1));
  for (let k = 0; k < 9; k++) {
    const u = u0 + 0.03 + k * ((u1 - u0 - 0.06) / 8);
    bulb(ctx, X(p, u, 0.1), Y(p, u, 0.1, 0.5), 1.1, sky, K.yellow);
  }
  if (detail >= 1) {
    ctx.fillStyle = lit(sky) ? mix(K.cream, COLORS.glow, sky.glow) : K.cream;
    for (let k = 0; k < 4; k++) ctx.fillRect(X(p, u0 + 0.06 + k * 0.12, 0.1) - 2, Y(p, u0 + 0.06 + k * 0.12, 0.1, 0.45) + 1, 4, 5);
    // red carpet
    fillPoly(ctx, p, [u1 - 0.2, 0.1, 0.004, u1 - 0.08, 0.1, 0.004, u1 - 0.04, 0.55, 0.004, u1 - 0.24, 0.55, 0.004], K.red);
  }
};

const KINDS: Record<string, Draw> = {
  pool, fountain, park, playground, ferris, carousel, castle, tower, statue, garden, treehouse, cafe, bakery,
  icecream, pizza, library, museum, stadium, skatepark, shop: shopBuild, ship, cinema,
};

export function drawBuild(ctx: CanvasRenderingContext2D, o: Obj, look: Look, detail: number, proj: Proj): void {
  const fn = KINDS[o.build?.kind ?? ''];
  if (fn) fn(ctx, proj, look.sky, look, detail, o.seed);
  else {
    // a kind this version doesn't know yet: a little marker so the site is not empty
    shadow(ctx, proj, look.sky, 0.6);
    box(ctx, proj, -0.3, 0.3, -0.3, 0.3, 0, 0.3, material(look.sky, K.stone).top, material(look.sky, K.stone).l, material(look.sky, K.stone).r);
  }
}

// ── hidden spots ────────────────────────────────────────────────────────────────────────────────
/** Tiny and low on purpose: only seen when zoomed in. */
export function drawSecret(ctx: CanvasRenderingContext2D, o: Obj, look: Look, detail: number, proj: Proj): void {
  if (detail < 1) return;
  const sky = look.sky;
  const pal = sky.palette;
  const p = proj;
  switch (o.secret?.kind) {
    case 'garden': {
      disc(ctx, p, 0, 0, 0, 0.3, alpha(pal.tree, 0.55));
      for (let k = 0; k < 9; k++) {
        const a = hash(o.seed, k) * TAU, d = 0.12 + hash(o.seed, k + 9) * 0.14;
        ctx.fillStyle = [K.pink, K.yellow, K.white, K.purple][k % 4];
        ctx.beginPath();
        ctx.arc(X(p, Math.cos(a) * d, Math.sin(a) * d), Y(p, Math.cos(a) * d, Math.sin(a) * d, 0.04), 1.7, 0, TAU);
        ctx.fill();
      }
      return;
    }
    case 'well': {
      const st = material(sky, K.stone), w = material(sky, K.wood);
      drum(ctx, p, sky, 0, 0, 0, 0.17, 0.15, K.stone);
      disc(ctx, p, 0, 0, 0.17, 0.1, mix(pal.water, K.ink, 0.45));
      for (const s of [-1, 1]) box(ctx, p, s * 0.13 - 0.012, s * 0.13 + 0.012, -0.012, 0.012, 0.17, 0.4, w.top, w.l, w.r);
      fillPoly(ctx, p, [-0.17, 0.0, 0.4, 0.17, 0.0, 0.4, 0.0, 0.0, 0.52], mix(st.l, K.red, 0.5));
      void st;
      return;
    }
    case 'fairy': {
      disc(ctx, p, 0, 0, 0, 0.26, alpha(pal.park, 0.6));
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU, u = Math.cos(a) * 0.19, v = Math.sin(a) * 0.19;
        const x = X(p, u, v), y = Y(p, u, v, 0);
        ctx.fillStyle = K.cream;
        ctx.fillRect(x - 0.8, y - 3, 1.6, 3);
        ctx.fillStyle = k % 2 ? K.red : K.pink;
        ctx.beginPath();
        ctx.ellipse(x, y - 3.2, 2.6, 1.8, 0, Math.PI, 0);
        ctx.fill();
      }
      glow(ctx, X(p, 0, 0), Y(p, 0, 0, 0.05), 16, sky, 0.4);
      return;
    }
    case 'chest': {
      const w = material(sky, K.wood);
      disc(ctx, p, 0, 0, 0, 0.2, alpha(pal.sand, 0.9));
      box(ctx, p, -0.12, 0.12, -0.08, 0.08, 0, 0.1, w.top, w.l, w.r);
      fillPoly(ctx, p, [-0.12, 0.08, 0.1, 0.12, 0.08, 0.1, 0.12, -0.08, 0.1, 0.0, -0.1, 0.16, -0.12, -0.08, 0.1], w.top);
      ctx.fillStyle = COLORS.gold;
      ctx.fillRect(X(p, 0, 0.08) - 1.2, Y(p, 0, 0.08, 0.08), 2.4, 3);
      for (const [u, v] of [[0.16, 0.1], [-0.17, 0.12]] as const) {
        ctx.beginPath();
        ctx.arc(X(p, u, v), Y(p, u, v, 0.01), 1.5, 0, TAU);
        ctx.fill();
      }
      return;
    }
    case 'bench': {
      const w = material(sky, K.wood);
      box(ctx, p, -0.2, 0.2, 0.0, 0.1, 0.09, 0.14, w.top, w.l, w.r);
      box(ctx, p, -0.2, 0.2, 0.0, 0.02, 0.14, 0.26, null, w.l, w.r);
      for (const u of [-0.17, 0.17]) box(ctx, p, u - 0.012, u + 0.012, 0.02, 0.08, 0, 0.09, null, w.dark, w.dark);
      return;
    }
    case 'gnomes': {
      for (const [u, v, k, c] of [[-0.18, -0.1, 1, K.red], [0.14, 0.02, 0.8, K.navy], [-0.02, 0.2, 0.9, K.orange]] as const) {
        const x = X(p, u, v), y = Y(p, u, v, 0);
        ctx.fillStyle = K.cream;
        ctx.beginPath();
        ctx.ellipse(x, y - 4 * k, 3.6 * k, 4.4 * k, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = mix(c, pal.edge, 0.15 * sky.darkness);
        ctx.beginPath();
        ctx.moveTo(x - 3.8 * k, y - 7 * k);
        ctx.lineTo(x, y - 15 * k);
        ctx.lineTo(x + 3.8 * k, y - 7 * k);
        ctx.fill();
        ctx.fillStyle = look.shadow;
        ctx.fillRect(x - 1.1 * k, y - 2.4 * k, 2.2 * k, 2.4 * k);
        glow(ctx, x, y - 3 * k, 6, sky, 0.5);
      }
      return;
    }
  }
}

// ── "saved for a bestie" sign on a held lot ─────────────────────────────────────────────────────
export function drawHoldSign(ctx: CanvasRenderingContext2D, o: Obj, look: Look, detail: number, p: Proj): void {
  const sky = look.sky;
  const wood = material(sky, K.wood);
  const board = mix(K.cream, sky.palette.wallShade, 0.4 * sky.darkness);
  // post
  box(ctx, p, -0.02, 0.02, 0.1, 0.14, 0, 0.5, null, wood.l, wood.r);
  // board on the +v face
  const v = 0.08, u0 = -0.3, u1 = 0.3, z0 = 0.42, z1 = 0.84;
  fillPoly(ctx, p, [u0 - 0.03, v, z0 - 0.03, u1 + 0.03, v, z0 - 0.03, u1 + 0.03, v, z1 + 0.03, u0 - 0.03, v, z1 + 0.03], wood.dark);
  fillPoly(ctx, p, [u0, v + 0.002, z0, u1, v + 0.002, z0, u1, v + 0.002, z1, u0, v + 0.002, z1], board);
  // heart (💛)
  const hx = X(p, detail >= 2 ? -0.2 : 0, v), hy = Y(p, detail >= 2 ? -0.2 : 0, v, (z0 + z1) / 2);
  ctx.save();
  ctx.translate(hx, hy);
  ctx.transform(1, 0.5, 0, 1, 0, 0);
  const s = detail >= 2 ? 0.65 : 1.2;
  ctx.fillStyle = K.yellow;
  ctx.strokeStyle = alpha(sky.palette.edge, 0.55);
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(0, 4.2 * s);
  ctx.bezierCurveTo(-8 * s, -1 * s, -4.6 * s, -7 * s, 0, -3 * s);
  ctx.bezierCurveTo(4.6 * s, -7 * s, 8 * s, -1 * s, 0, 4.2 * s);
  ctx.fill();
  ctx.stroke();
  if (detail >= 2) {
    ctx.fillStyle = mix(K.ink, sky.palette.edge, 0.2 * sky.darkness);
    ctx.font = '700 4.4px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('Saved for', 3.4, -2);
    ctx.fillText('a bestie', 3.4, 3.4);
  }
  ctx.restore();
  void o;
}
