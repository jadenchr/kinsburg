// Limited-edition homes: the villa and the skyscraper. They replace the ordinary house on
// the resident's own 1×1 lot, so everything fits the tile (the tower just goes up).
import { COLORS, WALLS, alpha, mix, type SkyState } from '../theme';
import type { HomeKind, Perk } from '../types';
import { box, fillPoly, glassColor, groundEllipse, hash, material, projX, projY, wallMat, type Proj } from './iso';

export interface HomeOptions {
  style: number;
  perks: readonly Perk[];
  sky: SkyState;
}

const GOLD_STAR_LIFT = 0.2;

/** Height of the top of a home above the ground, in tile widths (for bounds / hit tests). */
export function homeTop(kind: HomeKind, perks: readonly Perk[]): number {
  const top = kind === 'villa' ? 0.7 : SKY_ANT + 0.04;
  return perks.includes('star') ? top + 0.3 : top;
}

export function drawHome(ctx: CanvasRenderingContext2D, kind: HomeKind, cx: number, cy: number, size: number, opts: HomeOptions, detail: number, seed: number): void {
  const p: Proj = { cx, cy, s: size };
  if (kind === 'villa') drawVilla(ctx, p, opts, detail, seed);
  else drawSkyscraper(ctx, p, opts, detail, seed);
}

function star(ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, top: number, detail: number): void {
  const sx = projX(p, 0, 0);
  const sy = projY(p, 0, 0, top + GOLD_STAR_LIFT);
  const sr = p.s * 0.085;
  if (sky.glow > 0.05) {
    ctx.beginPath();
    ctx.arc(sx, sy, sr * 1.9, 0, Math.PI * 2);
    ctx.fillStyle = alpha(COLORS.gold, 0.28 * sky.glow);
    ctx.fill();
  }
  const path = (x: number, y: number, r: number) => {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? r : r * 0.45;
      if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
  };
  path(sx, sy, sr);
  ctx.fillStyle = COLORS.gold;
  ctx.fill();
  if (detail >= 1) {
    path(sx - sr * 0.12, sy - sr * 0.12, sr * 0.5);
    ctx.fillStyle = mix(COLORS.gold, sky.palette.wall, 0.45);
    ctx.fill();
  }
}

// quads on the two visible faces; the left face sits at v = plane, the right at u = plane
const qL = (v: number, a0: number, a1: number, z0: number, z1: number) => [a0, v, z0, a1, v, z0, a1, v, z1, a0, v, z1];
const qR = (u: number, a0: number, a1: number, z0: number, z1: number) => [u, a1, z0, u, a0, z0, u, a0, z1, u, a1, z1];

// ───────────────────────────── villa ─────────────────────────────

const VU0 = -0.43, VU1 = 0.12, VV0 = -0.43, VV1 = 0.4;
const SLAB_Z = 0.27;
const UP_Z = 0.305;
const UP_TOP = 0.5;

function drawVilla(ctx: CanvasRenderingContext2D, p: Proj, opts: HomeOptions, detail: number, seed: number): void {
  const { sky } = opts;
  const pal = sky.palette;
  const style = Math.abs(Math.floor(opts.style)) % 12;
  const gold = opts.perks.includes('goldRoof');
  const walls = ['#fbf6ea', '#f4ead6', '#fffdf6', '#f2e4cf'];
  const wall = wallMat(sky, walls[style % walls.length]);
  const terra = !gold && hash(seed, 3) < 0.55;
  const roof = material(sky, gold ? COLORS.gold : terra ? '#c8633c' : '#e9e3d6');
  const slab = material(sky, gold ? mix(COLORS.gold, '#ffffff', 0.35) : '#f3eee3');
  const glow = sky.glow;
  const on = glow > 0.05 + 0.5 * hash(seed, 91);

  // soft contact shadow
  if (detail >= 1) {
    groundEllipse(ctx, p, -sky.sunX * 0.05, sky.sunX * 0.05, 0, 0.5);
    ctx.fillStyle = alpha(pal.edge, 0.2 * (1 - 0.5 * sky.darkness));
    ctx.fill();
  }

  // ── pool deck + turquoise pool in the front corner ──
  const deck = material(sky, '#eadfc9');
  fillPoly(ctx, p, [0.15, -0.06, 0.004, 0.47, -0.06, 0.004, 0.47, 0.46, 0.004, 0.15, 0.46, 0.004], deck.top);
  const pool = mix(mix('#37c6cc', pal.skyTop, 0.35 * sky.darkness), '#a8fbff', 0.3 * glow);
  const rim = mix(deck.top, '#ffffff', 0.4);
  fillPoly(ctx, p, [0.2, 0.07, 0.006, 0.42, 0.07, 0.006, 0.42, 0.41, 0.006, 0.2, 0.41, 0.006], rim);
  fillPoly(ctx, p, [0.225, 0.095, 0.008, 0.395, 0.095, 0.008, 0.395, 0.385, 0.008, 0.225, 0.385, 0.008], pool);
  if (detail >= 2) {
    // a couple of light ripples
    fillPoly(ctx, p, [0.25, 0.16, 0.009, 0.34, 0.16, 0.009, 0.34, 0.175, 0.009, 0.25, 0.175, 0.009], alpha('#ffffff', 0.35));
    fillPoly(ctx, p, [0.29, 0.27, 0.009, 0.37, 0.27, 0.009, 0.37, 0.283, 0.009, 0.29, 0.283, 0.009], alpha('#ffffff', 0.28));
  }

  // ── ground-floor walls ──
  box(ctx, p, VU0, VU1, VV0, VV1, 0, SLAB_Z, null, wall.l, wall.r);
  const lit = (i: number) => (on ? hash(seed, i) < 0.78 : false);
  if (detail >= 1) {
    // glass doors on both faces
    for (let k = 0; k < 3; k++) win(ctx, p, sky, qL(VV1 + 0.001, -0.39 + k * 0.155, -0.27 + k * 0.155, 0.04, 0.23), lit(k), glow, detail);
    for (let k = 0; k < 4; k++) win(ctx, p, sky, qR(VU1 + 0.001, -0.39 + k * 0.19, -0.27 + k * 0.19, 0.04, 0.23), lit(k + 5), glow, detail);
    // front door
    fillPoly(ctx, p, qL(VV1 + 0.001, 0.0, 0.08, 0.0, 0.18), mix(roof.base, pal.edge, 0.35));
  } else if (on && hash(seed, 0) < 0.8) {
    fillPoly(ctx, p, qR(VU1 + 0.001, -0.3, 0.3, 0.05, 0.16), glassColor(sky, true, 1));
  }
  // flat roof slab with overhang
  box(ctx, p, VU0 - 0.03, VU1 + 0.03, VV0 - 0.03, VV1 + 0.03, SLAB_Z, UP_Z, slab.top, slab.l, slab.r);

  // ── upper volume ──
  const u0 = -0.34, u1 = 0.0, v0 = -0.3, v1 = 0.22;
  box(ctx, p, u0, u1, v0, v1, UP_Z, UP_TOP, null, wall.l, wall.r);
  if (detail >= 1) {
    for (let k = 0; k < 2; k++) win(ctx, p, sky, qL(v1 + 0.001, -0.31 + k * 0.17, -0.19 + k * 0.17, UP_Z + 0.04, UP_TOP - 0.035), lit(k + 10), glow, detail);
    for (let k = 0; k < 3; k++) win(ctx, p, sky, qR(u1 + 0.001, -0.26 + k * 0.17, -0.14 + k * 0.17, UP_Z + 0.04, UP_TOP - 0.035), lit(k + 13), glow, detail);
  }
  if (terra) {
    const o = 0.05;
    const a0 = u0 - o, a1 = u1 + o, b0 = v0 - o, b1 = v1 + o;
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, r = 0.08, z1 = UP_TOP + 0.12;
    fillPoly(ctx, p, [a0, b0, UP_TOP, a1, b0, UP_TOP, cu + r, cv, z1, cu - r, cv, z1], roof.dark);
    fillPoly(ctx, p, [a1, b1, UP_TOP, a1, b0, UP_TOP, cu + r, cv, z1], roof.r);
    fillPoly(ctx, p, [a0, b1, UP_TOP, a1, b1, UP_TOP, cu + r, cv, z1, cu - r, cv, z1], roof.l);
    if (detail >= 1) fillPoly(ctx, p, [a0, b1, UP_TOP, a1, b1, UP_TOP, a1, b1, UP_TOP - 0.025, a0, b1, UP_TOP - 0.025], roof.dark);
  } else {
    box(ctx, p, u0 - 0.04, u1 + 0.04, v0 - 0.04, v1 + 0.04, UP_TOP, UP_TOP + 0.03, roof.top, roof.l, roof.r);
  }

  // ── pool-side bits: lounger, palm ──
  if (detail >= 1) {
    const lc = material(sky, '#fffaf0');
    box(ctx, p, 0.28, 0.42, 0.0, 0.065, 0.004, 0.03, lc.top, lc.l, lc.r);
    const pc = material(sky, '#ee8f6a');
    box(ctx, p, 0.28, 0.32, 0.0, 0.065, 0.03, 0.045, pc.top, pc.l, pc.r);
    palm(ctx, p, sky, 0.37, -0.25, detail);
  }

  if (opts.perks.includes('star')) star(ctx, p, sky, terra ? UP_TOP + 0.12 : UP_TOP + 0.03, detail);
}

function win(ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, quad: number[], lit: boolean, glow: number, detail: number): void {
  if (lit && glow > 0.05 && detail >= 2) {
    // halo: the same rectangle, a little bigger
    const g = 0.025;
    const c = quad.slice();
    const du = c[3] - c[0], dv = c[4] - c[1];
    const n = Math.hypot(du, dv) || 1;
    const ex = (du / n) * g, ey = (dv / n) * g;
    c[0] -= ex; c[1] -= ey; c[3] += ex; c[4] += ey; c[6] += ex; c[7] += ey; c[9] -= ex; c[10] -= ey;
    c[2] -= g; c[5] -= g; c[8] += g; c[11] += g;
    fillPoly(ctx, p, c, alpha(COLORS.glow, 0.3 * glow));
  }
  fillPoly(ctx, p, quad, glassColor(sky, lit, 0.9));
}

function palm(ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, u: number, v: number, detail: number): void {
  const bx = projX(p, u, v), by = projY(p, u, v, 0);
  const tx = projX(p, u - 0.02, v), ty = projY(p, u - 0.02, v, 0.5);
  const trunk = mix('#8a6a48', sky.palette.edge, 0.3 * sky.darkness);
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.quadraticCurveTo(bx + p.s * 0.05, (by + ty) / 2, tx, ty);
  ctx.lineWidth = Math.max(1, p.s * 0.03);
  ctx.strokeStyle = trunk;
  ctx.lineCap = 'round';
  ctx.stroke();
  const leaf = mix('#4f9a54', sky.palette.skyTop, 0.45 * sky.darkness);
  const leaf2 = mix('#6bb862', sky.palette.skyTop, 0.45 * sky.darkness);
  const n = detail >= 1 ? 6 : 4;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.4;
    const dx = Math.cos(a) * p.s * 0.17, dy = Math.sin(a) * p.s * 0.065;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.quadraticCurveTo(tx + dx * 0.6, ty + dy * 0.6 - p.s * 0.08, tx + dx, ty + dy + p.s * 0.04);
    ctx.quadraticCurveTo(tx + dx * 0.55, ty + dy * 0.55 - p.s * 0.01, tx, ty);
    ctx.fillStyle = i % 2 ? leaf : leaf2;
    ctx.fill();
  }
}

// ───────────────────────────── skyscraper ─────────────────────────────

const SKY_PODIUM = 0.1;
const SKY_TOWER = 2.05;
const SKY_CROWN1 = 2.23;
const SKY_CROWN2 = 2.37;
const SKY_ANT = 2.67;
/** facade tints by houseStyle: glass-blue, teal, violet, steel, bronze, rose */
const TINTS = ['#7fb4d6', '#6fc2b5', '#9a8ed0', '#8aa0b8', '#d3b27c', '#d79aa6'];

function drawSkyscraper(ctx: CanvasRenderingContext2D, p: Proj, opts: HomeOptions, detail: number, seed: number): void {
  const { sky } = opts;
  const pal = sky.palette;
  const style = Math.abs(Math.floor(opts.style)) % 12;
  const gold = opts.perks.includes('goldRoof');
  const tint = TINTS[style % TINTS.length];
  const glass = material(sky, mix(tint, '#ffffff', 0.32));
  const pane = material(sky, mix(tint, '#1f4c70', 0.55));
  const stone = wallMat(sky, WALLS[(style + 3) % WALLS.length]);
  const crown = material(sky, gold ? COLORS.gold : mix(tint, '#ffffff', 0.62));
  const glow = sky.glow;

  if (detail >= 1) {
    groundEllipse(ctx, p, -sky.sunX * 0.06, sky.sunX * 0.06, 0, 0.5);
    ctx.fillStyle = alpha(pal.edge, 0.22 * (1 - 0.5 * sky.darkness));
    ctx.fill();
  }

  // podium
  const P = 0.38;
  box(ctx, p, -P, P, -P, P, 0, SKY_PODIUM, stone.top, stone.l, stone.r);
  if (detail >= 1) {
    const lobby = glow > 0.05 && hash(seed, 77) < 0.9;
    fillPoly(ctx, p, qL(P + 0.001, -0.2, 0.2, 0.02, 0.08), glassColor(sky, lobby, 1));
    fillPoly(ctx, p, qR(P + 0.001, -0.25, 0.25, 0.02, 0.08), glassColor(sky, lobby, 0.7));
  }

  // tower shaft
  const T = 0.3;
  box(ctx, p, -T, T, -T, T, SKY_PODIUM, SKY_TOWER, null, glass.l, glass.r);
  // roof of the shaft (visible around the crown)
  fillPoly(ctx, p, [-T, -T, SKY_TOWER, T, -T, SKY_TOWER, T, T, SKY_TOWER, -T, T, SKY_TOWER], glass.top);

  // window grid: lit cells scatter deterministically per resident
  const cols = 5;
  const rows = 18;
  const z0 = SKY_PODIUM + 0.07;
  const span = SKY_TOWER - 0.05 - z0;
  const rh = span / rows;
  const litFrac = 0.35 + 0.3 * hash(seed, 5);
  const faceL = pane.l, faceR = pane.r;
  const cw = (2 * T - 0.06) / cols;
  if (detail >= 2) {
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const a0 = -T + 0.03 + c * cw + 0.012, a1 = a0 + cw - 0.024;
        const zA = z0 + r * rh + 0.012, zB = zA + rh - 0.028;
        for (let f = 0; f < 2; f++) {
          const h1 = hash(seed, r * 16 + c, f + 1);
          const lit = h1 < litFrac && glow > 0.05 + 0.45 * hash(seed, r * 16 + c, f + 9);
          const col = lit ? glassColor(sky, true, 0.4 + 0.6 * hash(seed, r, c + f * 7)) : mix(f ? faceR : faceL, '#ffffff', 0.06 + 0.2 * hash(seed, r + 20, c) * (1 - sky.darkness));
          fillPoly(ctx, p, f ? qR(T + 0.001, a0, a1, zA, zB) : qL(T + 0.001, a0, a1, zA, zB), col);
        }
      }
  } else if (detail >= 1) {
    // a ribbon per row, two lit/unlit halves
    for (let r = 0; r < rows; r++) {
      const zA = z0 + r * rh + 0.015, zB = zA + rh - 0.03;
      for (let f = 0; f < 2; f++)
        for (let h = 0; h < 2; h++) {
          const lit = hash(seed, r * 4 + h, f + 1) < litFrac && glow > 0.05 + 0.45 * hash(seed, r, h + 9);
          const a0 = -T + 0.03 + h * (T - 0.015), a1 = a0 + T - 0.045;
          const col = lit ? glassColor(sky, true, 0.8) : mix(f ? faceR : faceL, '#ffffff', 0.12 * (1 - sky.darkness));
          fillPoly(ctx, p, f ? qR(T + 0.001, a0, a1, zA, zB) : qL(T + 0.001, a0, a1, zA, zB), col);
        }
    }
  } else if (glow > 0.05) {
    // far away: a handful of lit dots
    for (let i = 0; i < 5; i++) {
      const z = z0 + hash(seed, i, 3) * span;
      const a = (hash(seed, i, 4) - 0.5) * 0.4;
      fillPoly(ctx, p, qR(T + 0.001, a - 0.05, a + 0.05, z, z + 0.08), glassColor(sky, true, 1));
    }
  }

  // stepped crown + antenna
  box(ctx, p, -0.22, 0.22, -0.22, 0.22, SKY_TOWER, SKY_CROWN1, crown.top, crown.l, crown.r);
  box(ctx, p, -0.12, 0.12, -0.12, 0.12, SKY_CROWN1, SKY_CROWN2, crown.top, mix(crown.l, glass.l, 0.3), mix(crown.r, glass.r, 0.3));
  if (detail >= 1) {
    // a glowing band under the crown at night
    if (glow > 0.05) fillPoly(ctx, p, qL(0.221, -0.22, 0.22, SKY_TOWER + 0.075, SKY_TOWER + 0.1), alpha(COLORS.glow, 0.55 * glow));
  }
  const ax = projX(p, 0, 0), ay0 = projY(p, 0, 0, SKY_CROWN2), ay1 = projY(p, 0, 0, SKY_ANT);
  ctx.beginPath();
  ctx.moveTo(ax, ay0);
  ctx.lineTo(ax, ay1);
  ctx.lineWidth = Math.max(1, p.s * 0.022);
  ctx.strokeStyle = gold ? COLORS.gold : mix('#8b94a0', pal.edge, 0.3 * sky.darkness);
  ctx.lineCap = 'round';
  ctx.stroke();
  // rooftop beacon: a soft red-warm light at night
  const bc = '#ff6b5e';
  ctx.beginPath();
  ctx.arc(ax, ay1, Math.max(1.2, p.s * 0.025), 0, Math.PI * 2);
  ctx.fillStyle = glow > 0.05 ? mix('#c9d0d8', bc, Math.min(1, glow * 1.5)) : '#c9d0d8';
  ctx.fill();
  if (glow > 0.05 && detail >= 1) {
    const r = p.s * 0.2;
    const g = ctx.createRadialGradient(ax, ay1, 0, ax, ay1, r);
    g.addColorStop(0, alpha(bc, 0.55 * glow));
    g.addColorStop(1, alpha(bc, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(ax, ay1, r, 0, Math.PI * 2);
    ctx.fill();
  }

  if (opts.perks.includes('star')) star(ctx, p, sky, SKY_ANT + 0.06, detail);
}
