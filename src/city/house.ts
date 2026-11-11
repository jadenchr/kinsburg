// Draws one house in isometric view. Shared by the city renderer and the share card.
// OWNER: city renderer agent. Keep this signature; replace the body.
import { ROOFS, WALLS, COLORS, alpha, mix, type SkyState } from '../theme';
import type { Perk } from '../types';
import { box, fillPoly, groundEllipse, glassColor, hash, material, projX, projY, wallMat, type Proj } from './iso';

export interface HouseOptions {
  /** 0..11, see Resident.houseStyle */
  style: number;
  perks: Perk[];
  sky: SkyState;
  /** draw a highlight ring under the house */
  highlighted?: boolean;
  /** 0..3 extra storeys, earned by commenting (Resident.level) */
  level?: number;
}

/**
 * Draw a house whose footprint is a 2:1 diamond centred on (cx, cy), `size` px wide.
 * The house rises upward from that diamond.
 */
export function drawHouse(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  opts: HouseOptions,
): void {
  drawHouseEx(ctx, cx, cy, size, opts, 2, opts.style * 7 + 3);
}

/** 0 gable, 1 hip, 2 flat with chimney */
export const houseShape = (style: number) => (style + Math.floor(style / ROOFS.length)) % 3;

const E = 0.34; // footprint half extent (tile units)
const O = 0.07; // eave overhang
const WALL_H = [0.3, 0.3, 0.38];
const ROOF_H = [0.25, 0.2, 0];
/** height of one extra storey (tile units) */
const FLOOR_H = 0.19;
const floors = (level: number | undefined) => Math.max(0, Math.min(3, Math.floor(level ?? 0)));

/** Height of the house top above the ground, in tile widths (for bounds / hit tests). */
export function houseTop(style: number, perks: readonly Perk[], level = 0): number {
  const sh = houseShape(style);
  const top = (sh === 2 ? WALL_H[2] + 0.25 : WALL_H[sh] + ROOF_H[sh]) + floors(level) * FLOOR_H;
  return perks.includes('star') ? top + 0.3 : top;
}

/** Ground ring used to highlight a building. `r` in tile units. */
export function drawRing(ctx: CanvasRenderingContext2D, p: Proj, r: number, strength = 1): void {
  groundEllipse(ctx, p, 0, 0, 0, r);
  ctx.fillStyle = alpha(COLORS.gold, 0.28 * strength);
  ctx.fill();
  ctx.lineWidth = Math.max(1, p.s * 0.035);
  ctx.strokeStyle = alpha(COLORS.gold, Math.min(1, 0.95 * strength));
  ctx.stroke();
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

type Win = [number, number, number, number]; // a0, a1, z0, z1 along the face

/**
 * Renderer entry point with a detail level (0 far … 2 close) and a per-house seed
 * (varies which windows are lit at night).
 */
export function drawHouseEx(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  opts: HouseOptions,
  detail: number,
  seed: number,
): void {
  const { sky } = opts;
  const pal = sky.palette;
  const style = Math.abs(Math.floor(opts.style)) % 12;
  const p: Proj = { cx, cy, s: size };
  const shape = houseShape(style);
  const orient = Math.floor(style / 3) % 2;
  const gold = opts.perks.includes('goldRoof');
  const wall = wallMat(sky, WALLS[Math.floor(style / ROOFS.length) % WALLS.length]);
  const roof = material(sky, gold ? COLORS.gold : ROOFS[style % ROOFS.length]);
  const extra = floors(opts.level);
  const H = WALL_H[shape] + extra * FLOOR_H;
  const R = ROOF_H[shape];

  if (opts.highlighted) drawRing(ctx, p, 0.62);

  // soft contact shadow
  if (detail >= 1) {
    groundEllipse(ctx, p, -sky.sunX * 0.05, sky.sunX * 0.05, 0, 0.47);
    ctx.fillStyle = alpha(pal.edge, 0.2 * (1 - 0.5 * sky.darkness));
    ctx.fill();
  }

  const He = H - 0.02; // eave height
  const Hr = H + R; // ridge height
  const E2 = E + O;
  const Eg = E + 0.035;
  const zw = He + (Hr - He) * (O / E2); // roof height where it crosses the wall plane
  const edgeT = 0.028;

  // ── walls (+ the back roof slope, which sits behind them) ──
  if (shape === 0) {
    if (orient === 0) {
      fillPoly(ctx, p, [-Eg, -E2, He, E, -E2, He, E, 0, Hr, -Eg, 0, Hr], roof.dark);
      fillPoly(ctx, p, [-E, E, 0, E, E, 0, E, E, H, -E, E, H], wall.l);
      fillPoly(ctx, p, [E, E, 0, E, -E, 0, E, -E, zw, E, 0, Hr, E, E, zw], wall.r);
    } else {
      fillPoly(ctx, p, [-E2, -Eg, He, -E2, E, He, 0, E, Hr, 0, -Eg, Hr], roof.dark);
      fillPoly(ctx, p, [E, E, 0, E, -E, 0, E, -E, H, E, E, H], wall.r);
      fillPoly(ctx, p, [-E, E, 0, E, E, 0, E, E, zw, 0, E, Hr, -E, E, zw], wall.l);
    }
  } else {
    fillPoly(ctx, p, [-E, E, 0, E, E, 0, E, E, H, -E, E, H], wall.l);
    fillPoly(ctx, p, [E, E, 0, E, -E, 0, E, -E, H, E, E, H], wall.r);
  }

  // ── door + windows ──
  const glow = sky.glow;
  // Each home switches its lights on at its own moment of dusk (glow 0.05 … 0.55), so the
  // town lights up house by house instead of all at once. Full night: every home is on.
  const on = glow > 0.05 + 0.5 * hash(seed, 91);
  const lw = shape === 2 ? 0.14 : 0.11;
  const lz: [number, number] = shape === 2 ? [0.15, 0.28] : [0.11, 0.22];
  const leftWins: Win[] = [];
  const rightWins: Win[] = [];
  // one row of windows per storey; upper storeys get a window above the door too
  for (let f = 0; f <= extra; f++) {
    const z0 = lz[0] + f * FLOOR_H, z1 = lz[1] + f * FLOOR_H;
    leftWins.push([-0.26, -0.26 + lw, z0, z1]);
    rightWins.push([0.09, 0.09 + lw, z0, z1], [-0.22, -0.22 + lw, z0, z1]);
    if (f > 0) leftWins.push([0.04, 0.04 + lw, z0, z1]);
  }
  if (detail >= 1) {
    fillPoly(ctx, p, [0.03, E, 0, 0.16, E, 0, 0.16, E, 0.19, 0.03, E, 0.19], mix(roof.base, pal.edge, 0.4));
    let i = 0;
    for (const w of leftWins) drawWin(ctx, p, sky, w, true, on ? hash(seed, i++) : (i++, 1), hash(seed, i + 40), detail, glow);
    for (const w of rightWins) drawWin(ctx, p, sky, w, false, on ? hash(seed, i++) : (i++, 1), hash(seed, i + 40), detail, glow);
  } else if (on && hash(seed, 0) < 0.75) {
    // far away: one warm dot of light per lived-in house
    fillPoly(ctx, p, [E, -0.12, 0.08, E, 0.12, 0.08, E, 0.12, 0.24, E, -0.12, 0.24], glassColor(sky, true, 1));
  }

  // ── roof ──
  if (shape === 0) {
    if (orient === 0) {
      fillPoly(ctx, p, [E, -E2, He, Eg, -E2, He, Eg, 0, Hr, E, 0, Hr], roof.dark);
      fillPoly(ctx, p, [-Eg, 0, Hr, Eg, 0, Hr, Eg, E2, He, -Eg, E2, He], roof.l);
      if (detail >= 1) {
        fillPoly(ctx, p, [-Eg, E2, He, Eg, E2, He, Eg, E2, He - edgeT, -Eg, E2, He - edgeT], roof.dark);
        fillPoly(ctx, p, [Eg, -E2, He, Eg, 0, Hr, Eg, E2, He, Eg, E2, He - edgeT, Eg, 0, Hr - edgeT, Eg, -E2, He - edgeT], roof.dark);
      }
    } else {
      fillPoly(ctx, p, [-E2, E, He, -E2, Eg, He, 0, Eg, Hr, 0, E, Hr], roof.dark);
      fillPoly(ctx, p, [0, -Eg, Hr, 0, Eg, Hr, E2, Eg, He, E2, -Eg, He], roof.r);
      if (detail >= 1) {
        fillPoly(ctx, p, [E2, Eg, He, E2, -Eg, He, E2, -Eg, He - edgeT, E2, Eg, He - edgeT], roof.dark);
        fillPoly(ctx, p, [-E2, Eg, He, 0, Eg, Hr, E2, Eg, He, E2, Eg, He - edgeT, 0, Eg, Hr - edgeT, -E2, Eg, He - edgeT], roof.dark);
      }
    }
    if (detail >= 2) ridgeLine(ctx, p, orient === 0 ? [-Eg, 0, Hr, Eg, 0, Hr] : [0, -Eg, Hr, 0, Eg, Hr], mix(roof.base, pal.wall, 0.35));
  } else if (shape === 1) {
    const r = 0.12;
    if (orient === 0) {
      fillPoly(ctx, p, [-E2, -E2, He, E2, -E2, He, r, 0, Hr, -r, 0, Hr], roof.dark);
      fillPoly(ctx, p, [E2, E2, He, E2, -E2, He, r, 0, Hr], roof.r);
      fillPoly(ctx, p, [-E2, E2, He, E2, E2, He, r, 0, Hr, -r, 0, Hr], roof.l);
    } else {
      fillPoly(ctx, p, [-E2, -E2, He, -E2, E2, He, 0, r, Hr, 0, -r, Hr], roof.dark);
      fillPoly(ctx, p, [-E2, E2, He, E2, E2, He, 0, r, Hr], roof.l);
      fillPoly(ctx, p, [E2, -E2, He, E2, E2, He, 0, r, Hr, 0, -r, Hr], roof.r);
    }
    if (detail >= 1) {
      fillPoly(ctx, p, [-E2, E2, He, E2, E2, He, E2, E2, He - edgeT, -E2, E2, He - edgeT], roof.dark);
      fillPoly(ctx, p, [E2, E2, He, E2, -E2, He, E2, -E2, He - edgeT, E2, E2, He - edgeT], mix(roof.dark, pal.edge, 0.2));
    }
    if (detail >= 2) ridgeLine(ctx, p, orient === 0 ? [-r, 0, Hr, r, 0, Hr] : [0, -r, Hr, 0, r, Hr], mix(roof.base, pal.wall, 0.35));
  } else {
    const Ef = E + 0.03;
    box(ctx, p, -Ef, Ef, -Ef, Ef, H, H + 0.05, roof.top, roof.l, roof.r);
    if (detail >= 1) fillPoly(ctx, p, [-E + 0.03, -E + 0.03, H + 0.05, E - 0.03, -E + 0.03, H + 0.05, E - 0.03, E - 0.03, H + 0.05, -E + 0.03, E - 0.03, H + 0.05], mix(roof.top, roof.dark, 0.3));
    const brick = material(sky, mix(ROOFS[(style + 2) % ROOFS.length], pal.edge, 0.25));
    const c0 = orient === 0 ? 0.06 : -0.22;
    const c1 = orient === 0 ? -0.22 : 0.06;
    box(ctx, p, c0, c0 + 0.12, c1, c1 + 0.12, H + 0.05, H + 0.25, brick.top, brick.l, brick.r);
  }

  // ── perks ──
  if (opts.perks.includes('star')) {
    const top = shape === 2 ? H + 0.25 : Hr;
    const sx = projX(p, 0, 0);
    const sy = projY(p, 0, 0, top + 0.2);
    const sr = size * 0.085;
    if (glow > 0.05) {
      ctx.beginPath();
      ctx.arc(sx, sy, sr * 1.9, 0, Math.PI * 2);
      ctx.fillStyle = alpha(COLORS.gold, 0.28 * glow);
      ctx.fill();
    }
    star(ctx, sx, sy, sr);
    ctx.fillStyle = COLORS.gold;
    ctx.fill();
    if (detail >= 1) {
      star(ctx, sx - sr * 0.12, sy - sr * 0.12, sr * 0.5);
      ctx.fillStyle = mix(COLORS.gold, pal.wall, 0.45);
      ctx.fill();
    }
  }
}

function ridgeLine(ctx: CanvasRenderingContext2D, p: Proj, c: number[], color: string): void {
  ctx.beginPath();
  ctx.moveTo(projX(p, c[0], c[1]), projY(p, c[0], c[1], c[2]));
  ctx.lineTo(projX(p, c[3], c[4]), projY(p, c[3], c[4], c[5]));
  ctx.lineWidth = Math.max(0.5, Math.min(1, p.s / 64));
  ctx.strokeStyle = color;
  ctx.stroke();
}

function drawWin(
  ctx: CanvasRenderingContext2D,
  p: Proj,
  sky: SkyState,
  w: Win,
  leftFace: boolean,
  r1: number,
  r2: number,
  detail: number,
  glow: number,
): void {
  const lit = r1 < 0.7;
  const [a0, a1, z0, z1] = w;
  const c = leftFace
    ? [a0, E + 0.001, z0, a1, E + 0.001, z0, a1, E + 0.001, z1, a0, E + 0.001, z1]
    : [E + 0.001, a1, z0, E + 0.001, a0, z0, E + 0.001, a0, z1, E + 0.001, a1, z1];
  if (lit && glow > 0.05 && detail >= 2) {
    const g = 0.03;
    const h = leftFace
      ? [a0 - g, E, z0 - g, a1 + g, E, z0 - g, a1 + g, E, z1 + g, a0 - g, E, z1 + g]
      : [E, a1 + g, z0 - g, E, a0 - g, z0 - g, E, a0 - g, z1 + g, E, a1 + g, z1 + g];
    fillPoly(ctx, p, h, alpha(COLORS.glow, 0.3 * glow));
  }
  fillPoly(ctx, p, c, glassColor(sky, lit, r2));
}
