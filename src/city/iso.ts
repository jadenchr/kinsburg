// Isometric helpers shared by the city renderer and the house painter.
// World space: tile (gx, gy) grid corner → ((gx - gy) * HW, (gx + gy) * HH).
// Object space (for drawing one building): u, v in tile units around the footprint
// centre, z upward in units of the projector's `s` (one tile width).
import { TILE_W, TILE_H, COLORS, mix, type SkyState, type Palette } from '../theme';

export const HW = TILE_W / 2;
export const HH = TILE_H / 2;

export const wxOf = (gx: number, gy: number) => (gx - gy) * HW;
export const wyOf = (gx: number, gy: number) => (gx + gy) * HH;

export interface Proj {
  cx: number;
  cy: number;
  /** width of one tile in pixels */
  s: number;
}

export const projX = (p: Proj, u: number, v: number) => p.cx + (u - v) * p.s * 0.5;
export const projY = (p: Proj, u: number, v: number, z: number) => p.cy + (u + v) * p.s * 0.25 - z * p.s;

/** Trace a closed polygon from flat [u, v, z, u, v, z, …] coordinates. */
export function trace(ctx: CanvasRenderingContext2D, p: Proj, c: readonly number[]): void {
  ctx.beginPath();
  for (let i = 0; i < c.length; i += 3) {
    const x = projX(p, c[i], c[i + 1]);
    const y = projY(p, c[i], c[i + 1], c[i + 2]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function fillPoly(ctx: CanvasRenderingContext2D, p: Proj, c: readonly number[], color: string): void {
  trace(ctx, p, c);
  ctx.fillStyle = color;
  ctx.fill();
}

/** Axis-aligned box; draws the three visible faces (left = +v side, right = +u side). */
export function box(
  ctx: CanvasRenderingContext2D,
  p: Proj,
  u0: number, u1: number, v0: number, v1: number, z0: number, z1: number,
  top: string | null, left: string, right: string,
): void {
  fillPoly(ctx, p, [u0, v1, z0, u1, v1, z0, u1, v1, z1, u0, v1, z1], left);
  fillPoly(ctx, p, [u1, v1, z0, u1, v0, z0, u1, v0, z1, u1, v1, z1], right);
  if (top) fillPoly(ctx, p, [u0, v0, z1, u1, v0, z1, u1, v1, z1, u0, v1, z1], top);
}

/** Ellipse lying flat on the ground (a circle of radius r tiles). */
export function groundEllipse(ctx: CanvasRenderingContext2D, p: Proj, u: number, v: number, z: number, r: number): void {
  ctx.beginPath();
  ctx.ellipse(projX(p, u, v), projY(p, u, v, z), r * p.s * 0.7071, r * p.s * 0.3536, 0, 0, Math.PI * 2);
}

/** Integer hash → [0, 1). */
export function hash(a: number, b = 0, c = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** How far toward the shaded colour each visible side goes (0 = fully lit, 1 = fully shaded). */
export function sideShade(sky: SkyState): { l: number; r: number } {
  let l = 0.08 + 0.8 * sstep(-0.35, 0.6, sky.sunX);
  let r = 0.96 - l;
  // At night the light is ambient: soften the contrast.
  const k = 0.5 * sky.darkness;
  l += (0.45 - l) * k;
  r += (0.45 - r) * k;
  return { l, r };
}

/** A solid material (roof tile, stone, wood…) lit for the current sky. */
export interface Mat {
  top: string;
  l: string;
  r: string;
  base: string;
  dark: string;
}

const matCache = new WeakMap<SkyState, Map<string, Mat>>();
function cacheFor(sky: SkyState): Map<string, Mat> {
  let m = matCache.get(sky);
  if (!m) {
    m = new Map();
    matCache.set(sky, m);
  }
  return m;
}

export function material(sky: SkyState, color: string): Mat {
  const cache = cacheFor(sky);
  const key = 'm' + color;
  let m = cache.get(key);
  if (!m) {
    const pal = sky.palette;
    const sh = sideShade(sky);
    const base = mix(color, pal.skyTop, 0.5 * sky.darkness);
    const dark = mix(base, pal.edge, 0.4);
    m = { base, dark, top: mix(base, pal.wall, 0.1), l: mix(base, dark, sh.l), r: mix(base, dark, sh.r) };
    cache.set(key, m);
  }
  return m;
}

/** Wall material: tinted plaster that follows palette.wall / wallShade so it darkens at night. */
export function wallMat(sky: SkyState, tint: string): Mat {
  const cache = cacheFor(sky);
  const key = 'w' + tint;
  let m = cache.get(key);
  if (!m) {
    const pal = sky.palette;
    const sh = sideShade(sky);
    const base = mix(tint, pal.wall, 0.25 + 0.65 * sky.darkness);
    const dark = mix(mix(tint, pal.wallShade, 0.55 + 0.35 * sky.darkness), pal.edge, 0.12);
    m = { base, dark, top: base, l: mix(base, dark, sh.l), r: mix(base, dark, sh.r) };
    cache.set(key, m);
  }
  return m;
}

/** Window glass colour; lit windows glow at night. */
export function glassColor(sky: SkyState, lit: boolean, bright: number): string {
  const cache = cacheFor(sky);
  const key = 'g' + (lit ? Math.round(bright * 8) : -1);
  let m = cache.get(key);
  if (!m) {
    const pal: Palette = sky.palette;
    const base = mix(mix(pal.waterShine, pal.edge, 0.45), pal.skyTop, 0.45 * sky.darkness);
    const c = lit ? mix(base, COLORS.glow, clamp(sky.glow * (0.55 + 0.45 * (Math.round(bright * 8) / 8)), 0, 1)) : base;
    m = { base: c, dark: c, top: c, l: c, r: c };
    cache.set(key, m);
  }
  return m.base;
}
