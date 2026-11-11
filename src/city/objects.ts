// Everything that stands on the ground: trees, lamps, lots, shops, civic buildings,
// landmarks — plus the animated bits drawn fresh every frame on top of the chunks.
import { COLORS, ROOFS, WALLS, alpha, mix, type SkyState } from '../theme';
import { drawHouseEx } from './house';
import {
  HH, HW, box, fillPoly, glassColor, groundEllipse, hash, material, projX, projY, sideShade, trace, wallMat, type Proj,
} from './iso';
import type { Look } from './ground';
import type { Obj } from './model';

const TAU = Math.PI * 2;

export function projFor(o: Obj): Proj {
  const gx = o.x + o.w / 2;
  const gy = o.y + o.h / 2;
  return { cx: (gx - gy) * HW, cy: (gx + gy) * HH, s: 64 };
}

export function drawEntry(ctx: CanvasRenderingContext2D, o: Obj, look: Look, detail: number, highlighted = false): void {
  const sky = look.sky;
  switch (o.kind) {
    case 'house': {
      const p = projFor(o);
      const r = o.resident!;
      drawHouseEx(ctx, p.cx, p.cy, 64, { style: r.houseStyle, perks: r.perks, sky, highlighted, level: r.level }, detail, o.seed);
      return;
    }
    case 'trees':
      if (detail >= 1) drawTrees(ctx, o, look, detail);
      return;
    case 'bush':
      if (detail >= 1) drawBush(ctx, o, look);
      return;
    case 'lamp':
      if (detail >= 1) drawLamp(ctx, o, look);
      return;
    case 'lot':
      drawLot(ctx, o, look, detail);
      return;
    case 'shop':
      drawShop(ctx, o, sky, detail);
      return;
    case 'civic':
      drawCivic(ctx, o, sky, detail);
      return;
    case 'landmark':
      drawLandmark(ctx, o, look, detail);
      return;
  }
}

// ── nature ───────────────────────────────────────────────────────────────────
const SLOTS: [number, number][][] = [
  [[0, 0]],
  [[-0.2, -0.06], [0.16, 0.14]],
  [[-0.22, -0.18], [0.22, -0.04], [-0.04, 0.2]],
];

function drawTrees(ctx: CanvasRenderingContext2D, o: Obj, look: Look, detail: number): void {
  const n = 1 + Math.floor(hash(o.x, o.y, 1) * 3);
  const slots = SLOTS[n - 1]
    .map(([u, v], k) => [u + (hash(o.x, o.y, 50 + k) - 0.5) * 0.12, v + (hash(o.x, o.y, 60 + k) - 0.5) * 0.12, k] as const)
    .sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  const p = projFor(o);
  for (const [u, v, k] of slots) {
    const x = projX(p, u, v);
    const y = projY(p, u, v, 0);
    const big = 0.8 + 0.4 * hash(o.x, o.y, 70 + k);
    if (hash(o.x, o.y, 80 + k) < 0.4) cone(ctx, x, y, big, look);
    else round(ctx, x, y, big, look, detail);
  }
}

function round(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, look: Look, detail: number): void {
  const r = 9 * k;
  ctx.fillStyle = look.shadow;
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.9, r * 0.45, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = look.trunk;
  ctx.fillRect(x - 1.3, y - 7 * k, 2.6, 7 * k);
  const cy = y - 7 * k - r * 0.8;
  ctx.fillStyle = look.treeShade;
  ctx.beginPath();
  ctx.arc(x, cy, r, 0, TAU);
  ctx.fill();
  const sx = look.sky.sunX;
  ctx.fillStyle = look.treeLit;
  ctx.beginPath();
  ctx.arc(x + sx * r * 0.22, cy - r * 0.16, r * 0.78, 0, TAU);
  ctx.fill();
  if (detail >= 2) {
    ctx.fillStyle = look.treeHi;
    ctx.beginPath();
    ctx.arc(x + sx * r * 0.4, cy - r * 0.4, r * 0.3, 0, TAU);
    ctx.fill();
  }
}

function cone(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, look: Look): void {
  const r = 8 * k;
  const h = 28 * k;
  ctx.fillStyle = look.shadow;
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.5, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = look.trunk;
  ctx.fillRect(x - 1.2, y - 5 * k, 2.4, 5 * k);
  const b = y - 4 * k;
  ctx.fillStyle = look.treeL;
  ctx.beginPath();
  ctx.moveTo(x, b - h);
  ctx.lineTo(x - r, b);
  ctx.quadraticCurveTo(x - r * 0.5, b + r * 0.35, x, b + r * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = look.treeR;
  ctx.beginPath();
  ctx.moveTo(x, b - h);
  ctx.lineTo(x + r, b);
  ctx.quadraticCurveTo(x + r * 0.5, b + r * 0.35, x, b + r * 0.4);
  ctx.closePath();
  ctx.fill();
}

function drawBush(ctx: CanvasRenderingContext2D, o: Obj, look: Look): void {
  const p = projFor(o);
  const u = (hash(o.x, o.y, 2) - 0.5) * 0.4;
  const v = (hash(o.x, o.y, 3) - 0.5) * 0.4;
  const x = projX(p, u, v);
  const y = projY(p, u, v, 0);
  ctx.fillStyle = look.shadow;
  ctx.beginPath();
  ctx.ellipse(x, y, 9, 4.5, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = look.treeShade;
  ctx.beginPath();
  ctx.arc(x - 3, y - 5, 5.5, 0, TAU);
  ctx.arc(x + 3.5, y - 4.5, 5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = look.treeLit;
  ctx.beginPath();
  ctx.arc(x + look.sky.sunX * 2, y - 7.5, 4.5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = look.flowers[Math.floor(hash(o.x, o.y, 4) * 2)];
  ctx.beginPath();
  ctx.arc(x - 2.5, y - 8, 1.3, 0, TAU);
  ctx.arc(x + 3.5, y - 6.5, 1.3, 0, TAU);
  ctx.fill();
}

function drawLamp(ctx: CanvasRenderingContext2D, o: Obj, look: Look): void {
  const p = projFor(o);
  const u = (o.lampU ?? 0) * 0.92;
  const v = (o.lampV ?? 0) * 0.92;
  const x = projX(p, u, v);
  const y = projY(p, u, v, 0);
  const top = y - 30;
  ctx.fillStyle = look.lampPost;
  ctx.fillRect(x - 0.9, top, 1.8, 30);
  const glow = look.sky.glow;
  if (glow > 0.05) {
    const g = ctx.createRadialGradient(x, top, 0, x, top, 11);
    g.addColorStop(0, alpha(COLORS.glow, 0.7 * glow));
    g.addColorStop(1, alpha(COLORS.glow, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, top, 11, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = look.lampHead;
  ctx.beginPath();
  ctx.arc(x, top, 2.6, 0, TAU);
  ctx.fill();
}

// ── lots, shops, civic ──────────────────────────────────────────────────────
function drawLot(ctx: CanvasRenderingContext2D, o: Obj, look: Look, detail: number): void {
  const p = projFor(o);
  const e = 0.38;
  fillPoly(ctx, p, [-e, -e, 0, e, -e, 0, e, e, 0, -e, e, 0], look.dirt);
  if (detail < 1) return;
  // a few tufts and a little "for sale" sign, then a picket fence
  const sky = look.sky;
  const wood = material(sky, mix(sky.palette.farm, sky.palette.edge, 0.35));
  const fh = 0.07;
  ctx.fillStyle = look.fence;
  const rail = (c: number[]) => fillPoly(ctx, p, c, look.fence);
  rail([-e, -e, fh, e, -e, fh, e, -e, fh - 0.015, -e, -e, fh - 0.015]);
  rail([-e, -e, fh, -e, e, fh, -e, e, fh - 0.015, -e, -e, fh - 0.015]);
  // sign
  box(ctx, p, -0.02, 0.0, 0.12, 0.14, 0, 0.16, null, wood.l, wood.r);
  fillPoly(ctx, p, [-0.12, 0.15, 0.1, 0.1, 0.15, 0.1, 0.1, 0.15, 0.2, -0.12, 0.15, 0.2], mix(sky.palette.wall, sky.palette.edge, 0.1 + 0.4 * sky.darkness));
  rail([-e, e, fh, e, e, fh, e, e, fh - 0.015, -e, e, fh - 0.015]);
  rail([e, -e, fh, e, e, fh, e, e, fh - 0.015, e, -e, fh - 0.015]);
  if (detail >= 2) {
    ctx.fillStyle = look.fence;
    for (let k = 0; k <= 4; k++) {
      const a = -e + (2 * e * k) / 4;
      for (const [u, v] of [[a, e], [e, a]] as const) {
        const x = projX(p, u, v);
        const y = projY(p, u, v, 0);
        ctx.fillRect(x - 0.6, y - 0.1 * 64, 1.2, 0.1 * 64);
      }
    }
  }
}

function drawShop(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, detail: number): void {
  const p = projFor(o);
  const pal = sky.palette;
  const ins = 0.1;
  const u1 = o.w / 2 - ins, v1 = o.h / 2 - ins;
  const u0 = -u1, v0 = -v1;
  const H = 0.4;
  const wall = wallMat(sky, WALLS[o.seed % WALLS.length]);
  const roof = material(sky, mix(WALLS[0], pal.edge, 0.25));
  const awn = material(sky, ROOFS[(o.seed >>> 3) % ROOFS.length]);
  groundEllipse(ctx, p, 0, 0, 0, Math.max(o.w, o.h) * 0.4);
  ctx.fillStyle = alpha(pal.edge, 0.1);
  ctx.fill();
  box(ctx, p, u0, u1, v0, v1, 0, H, null, wall.l, wall.r);
  box(ctx, p, u0 - 0.02, u1 + 0.02, v0 - 0.02, v1 + 0.02, H, H + 0.06, roof.top, roof.l, roof.r);
  if (detail >= 1) fillPoly(ctx, p, [u0 + 0.04, v0 + 0.04, H + 0.06, u1 - 0.04, v0 + 0.04, H + 0.06, u1 - 0.04, v1 - 0.04, H + 0.06, u0 + 0.04, v1 - 0.04, H + 0.06], roof.dark);

  const onLeft = o.w >= o.h;
  const lit = sky.glow > 0.05;
  const glass = glassColor(sky, true, 1);
  const dayGlass = glassColor(sky, false, 0);
  const g = lit ? glass : dayGlass;
  // shop window + door
  if (onLeft) {
    fillPoly(ctx, p, [u0 + 0.08, v1 + 0.001, 0.05, u1 - 0.22, v1 + 0.001, 0.05, u1 - 0.22, v1 + 0.001, 0.22, u0 + 0.08, v1 + 0.001, 0.22], g);
    fillPoly(ctx, p, [u1 - 0.17, v1 + 0.001, 0, u1 - 0.06, v1 + 0.001, 0, u1 - 0.06, v1 + 0.001, 0.22, u1 - 0.17, v1 + 0.001, 0.22], mix(awn.base, pal.edge, 0.45));
    if (detail >= 1) fillPoly(ctx, p, [u1 + 0.001, v1 - 0.1, 0.12, u1 + 0.001, v0 + 0.1, 0.12, u1 + 0.001, v0 + 0.1, 0.26, u1 + 0.001, v1 - 0.1, 0.26], glassColor(sky, hash(o.seed) < 0.6, 0.6));
  } else {
    fillPoly(ctx, p, [u1 + 0.001, v1 - 0.08, 0.05, u1 + 0.001, v0 + 0.22, 0.05, u1 + 0.001, v0 + 0.22, 0.22, u1 + 0.001, v1 - 0.08, 0.22], g);
    fillPoly(ctx, p, [u1 + 0.001, v0 + 0.17, 0, u1 + 0.001, v0 + 0.06, 0, u1 + 0.001, v0 + 0.06, 0.22, u1 + 0.001, v0 + 0.17, 0.22], mix(awn.base, pal.edge, 0.45));
    if (detail >= 1) fillPoly(ctx, p, [u0 + 0.1, v1 + 0.001, 0.12, u1 - 0.1, v1 + 0.001, 0.12, u1 - 0.1, v1 + 0.001, 0.26, u0 + 0.1, v1 + 0.001, 0.26], glassColor(sky, hash(o.seed) < 0.6, 0.6));
  }
  // awning: striped, sloping out from the wall
  const za = 0.3, zb = 0.22, out = 0.14;
  const len = onLeft ? u1 - u0 : v1 - v0;
  const n = detail >= 1 ? Math.max(3, Math.round(len / 0.12)) : 1;
  const stripeB = mix(pal.wall, awn.base, 0.08);
  for (let k = 0; k < n; k++) {
    const a = (onLeft ? u0 : v0) + (len * k) / n;
    const b = (onLeft ? u0 : v0) + (len * (k + 1)) / n;
    const c = k % 2 === 0 || n === 1 ? (onLeft ? awn.l : awn.r) : stripeB;
    if (onLeft) fillPoly(ctx, p, [a, v1, za, b, v1, za, b, v1 + out, zb, a, v1 + out, zb], c);
    else fillPoly(ctx, p, [u1, b, za, u1, a, za, u1 + out, a, zb, u1 + out, b, zb], c);
  }
  if (detail >= 1) {
    if (onLeft) fillPoly(ctx, p, [u0, v1 + out, zb, u1, v1 + out, zb, u1, v1 + out, zb - 0.03, u0, v1 + out, zb - 0.03], awn.dark);
    else fillPoly(ctx, p, [u1 + out, v1, zb, u1 + out, v0, zb, u1 + out, v0, zb - 0.03, u1 + out, v1, zb - 0.03], awn.dark);
  }
}

function hipRoof(ctx: CanvasRenderingContext2D, p: Proj, E1: number, E2: number, z0: number, z1: number, r: number, mat: { l: string; r: string; dark: string }): void {
  // ridge along u of half-length r; footprint half extents E1 (u), E2 (v)
  fillPoly(ctx, p, [-E1, -E2, z0, E1, -E2, z0, r, 0, z1, -r, 0, z1], mat.dark);
  fillPoly(ctx, p, [E1, E2, z0, E1, -E2, z0, r, 0, z1], mat.r);
  fillPoly(ctx, p, [-E1, E2, z0, E1, E2, z0, r, 0, z1, -r, 0, z1], mat.l);
}

function windowRow(
  ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, face: 'l' | 'r', plane: number,
  a0: number, a1: number, z0: number, z1: number, n: number, seed: number,
): void {
  const span = (a1 - a0) / n;
  for (let k = 0; k < n; k++) {
    const a = a0 + span * (k + 0.25);
    const b = a0 + span * (k + 0.75);
    const c = glassColor(sky, hash(seed, k) < 0.75, hash(seed, k + 9));
    if (face === 'l') fillPoly(ctx, p, [a, plane, z0, b, plane, z0, b, plane, z1, a, plane, z1], c);
    else fillPoly(ctx, p, [plane, b, z0, plane, a, z0, plane, a, z1, plane, b, z1], c);
  }
}

function drawCivic(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, detail: number): void {
  const p = projFor(o);
  const pal = sky.palette;
  const U = o.w / 2 - 0.2, V = o.h / 2 - 0.32;
  const H = 0.56;
  const wall = wallMat(sky, WALLS[1]);
  const roof = material(sky, mix(ROOFS[(o.seed >>> 2) % ROOFS.length], pal.edge, 0.2));
  const stone = wallMat(sky, WALLS[0]);
  groundEllipse(ctx, p, 0, 0, 0, Math.max(o.w, o.h) * 0.5);
  ctx.fillStyle = alpha(pal.edge, 0.15);
  ctx.fill();
  box(ctx, p, -U - 0.08, U + 0.08, -V - 0.08, V + 0.3, 0, 0.05, stone.top, stone.l, stone.r);
  box(ctx, p, -U, U, -V, V, 0.05, H, null, wall.l, wall.r);
  if (detail >= 1) {
    windowRow(ctx, p, sky, 'r', U + 0.001, -V, V, 0.2, 0.4, 3, o.seed);
    windowRow(ctx, p, sky, 'l', V + 0.001, -U, U, 0.2, 0.4, 4, o.seed + 1);
  }
  hipRoof(ctx, p, U + 0.06, V + 0.06, H - 0.01, H + 0.3, U * 0.5, roof);
  // portico: columns + pediment on the front (+v) face
  const pv = V + 0.22;
  const cu = U * 0.62;
  const cols = detail >= 1 ? 4 : 0;
  for (let k = 0; k < cols; k++) {
    const u = -cu + (2 * cu * k) / (cols - 1);
    box(ctx, p, u - 0.035, u + 0.035, pv - 0.035, pv + 0.035, 0.05, 0.42, null, stone.l, stone.r);
  }
  box(ctx, p, -cu - 0.08, cu + 0.08, V, pv + 0.06, 0.42, 0.48, stone.top, stone.l, stone.r);
  fillPoly(ctx, p, [-cu - 0.08, pv + 0.06, 0.48, cu + 0.08, pv + 0.06, 0.48, 0, pv + 0.06, 0.66], stone.l);
  fillPoly(ctx, p, [0, pv + 0.06, 0.66, cu + 0.08, pv + 0.06, 0.48, cu + 0.08, V, 0.48, 0, V, 0.66], roof.r);
}

// ── landmarks ───────────────────────────────────────────────────────────────
function drawLandmark(ctx: CanvasRenderingContext2D, o: Obj, look: Look, detail: number): void {
  switch (o.landmark!.kind) {
    case 'townhall': return townhall(ctx, o, look.sky, detail);
    case 'fountain': return fountain(ctx, o, look.sky);
    case 'market': return market(ctx, o, look.sky, detail);
    case 'monument': return monument(ctx, o, look.sky);
    case 'lighthouse': return lighthouse(ctx, o, look.sky);
    case 'windmill': return windmill(ctx, o, look.sky, detail);
  }
}

function townhall(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, detail: number): void {
  const p = projFor(o);
  const pal = sky.palette;
  const hu = o.w / 2, hv = o.h / 2;
  const stone = wallMat(sky, WALLS[0]);
  const wall = wallMat(sky, WALLS[1]);
  const roof = material(sky, ROOFS[0]);
  const accent = material(sky, ROOFS[3]);
  groundEllipse(ctx, p, 0, 0, 0, Math.max(hu, hv) * 1.0);
  ctx.fillStyle = alpha(pal.edge, 0.14);
  ctx.fill();
  // steps/platform
  box(ctx, p, -hu + 0.15, hu - 0.15, -hv + 0.15, hv - 0.1, 0, 0.06, stone.top, stone.l, stone.r);
  // main hall (centred on its own projector so the hip roof sits right)
  const U = hu - 0.35, V0 = -hv + 0.35, V1 = hv * 0.25;
  const HV = (V1 - V0) / 2;
  const hp: Proj = { cx: projX(p, 0, (V0 + V1) / 2), cy: projY(p, 0, (V0 + V1) / 2, 0), s: p.s };
  const H = 0.62;
  box(ctx, hp, -U, U, -HV, HV, 0.06, H, null, wall.l, wall.r);
  if (detail >= 1) {
    windowRow(ctx, hp, sky, 'r', U + 0.001, -HV, HV, 0.24, 0.48, 4, o.seed);
    windowRow(ctx, hp, sky, 'l', HV + 0.001, -U, -0.4, 0.24, 0.48, 2, o.seed + 3);
    windowRow(ctx, hp, sky, 'l', HV + 0.001, 0.4, U, 0.24, 0.48, 2, o.seed + 5);
    box(ctx, hp, -U - 0.03, U + 0.03, -HV - 0.03, HV + 0.03, H - 0.05, H, null, stone.l, stone.r);
  }
  hipRoof(ctx, hp, U + 0.08, HV + 0.08, H, H + 0.36, U * 0.55, roof);
  // tower on the front
  const tv = V1 + 0.15;
  const T = 0.32;
  const tp: Proj = { cx: projX(p, 0, tv), cy: projY(p, 0, tv, 0), s: p.s };
  box(ctx, tp, -T, T, -T, T, 0.06, 1.18, null, stone.l, stone.r);
  if (detail >= 1) {
    // door
    fillPoly(ctx, tp, [-0.12, T + 0.001, 0.06, 0.12, T + 0.001, 0.06, 0.12, T + 0.001, 0.36, -0.12, T + 0.001, 0.36], mix(accent.base, pal.edge, 0.4));
    windowRow(ctx, tp, sky, 'r', T + 0.001, -T, T, 0.5, 0.7, 2, o.seed + 7);
    windowRow(ctx, tp, sky, 'l', T + 0.001, -T, T, 0.5, 0.7, 2, o.seed + 8);
    // clock face (circle in the +v face plane)
    trace(ctx, tp, circleCoords(0, T + 0.002, 0.95, 0.16, 'l'));
    ctx.fillStyle = mix(pal.wall, COLORS.glow, 0.5 * sky.glow);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.gold;
    ctx.stroke();
    ctx.beginPath();
    const cx = projX(tp, 0, T), cy = projY(tp, 0, T, 0.95);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - 7);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - 4, cy - 1);
    ctx.strokeStyle = pal.edge;
    ctx.stroke();
  }
  box(ctx, tp, -T - 0.04, T + 0.04, -T - 0.04, T + 0.04, 1.18, 1.24, stone.top, stone.l, stone.r);
  // pyramid spire
  const S = T + 0.04, Z0 = 1.24, Z1 = 1.72;
  fillPoly(ctx, tp, [-S, S, Z0, S, S, Z0, 0, 0, Z1], roof.l);
  fillPoly(ctx, tp, [S, S, Z0, S, -S, Z0, 0, 0, Z1], roof.r);
  // flag
  const fx = projX(tp, 0, 0), fy = projY(tp, 0, 0, Z1);
  ctx.fillStyle = pal.edge;
  ctx.fillRect(fx - 0.7, fy - 26, 1.4, 26);
  ctx.fillStyle = material(sky, ROOFS[2]).base;
  ctx.beginPath();
  ctx.moveTo(fx + 0.7, fy - 26);
  ctx.quadraticCurveTo(fx + 8, fy - 27, fx + 15, fy - 22);
  ctx.quadraticCurveTo(fx + 8, fy - 19, fx + 0.7, fy - 17);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = COLORS.gold;
  ctx.beginPath();
  ctx.arc(fx, fy - 27, 1.8, 0, TAU);
  ctx.fill();
}

function circleCoords(u: number, plane: number, z: number, r: number, face: 'l' | 'r'): number[] {
  const c: number[] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU;
    const du = Math.cos(a) * r;
    const dz = Math.sin(a) * r;
    if (face === 'l') c.push(u + du, plane, z + dz);
    else c.push(plane, u + du, z + dz);
  }
  return c;
}

function fountain(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState): void {
  const p = projFor(o);
  const pal = sky.palette;
  const stone = wallMat(sky, WALLS[0]);
  groundEllipse(ctx, p, 0, 0, 0, 0.46);
  ctx.fillStyle = stone.r;
  ctx.fill();
  ctx.fillRect(projX(p, 0, 0) - 0.46 * 64 * 0.7071, projY(p, 0, 0, 0.08), 0.92 * 64 * 0.7071, 0.08 * 64);
  groundEllipse(ctx, p, 0, 0, 0.08, 0.46);
  ctx.fillStyle = stone.top;
  ctx.fill();
  groundEllipse(ctx, p, 0, 0, 0.08, 0.38);
  ctx.fillStyle = mix(pal.water, pal.waterShine, 0.2);
  ctx.fill();
  box(ctx, p, -0.04, 0.04, -0.04, 0.04, 0.08, 0.3, null, stone.l, stone.r);
  groundEllipse(ctx, p, 0, 0, 0.3, 0.14);
  ctx.fillStyle = stone.top;
  ctx.fill();
  groundEllipse(ctx, p, 0, 0, 0.305, 0.1);
  ctx.fillStyle = pal.waterShine;
  ctx.fill();
}

function market(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, detail: number): void {
  const pal = sky.palette;
  const wood = material(sky, mix(pal.farm, pal.edge, 0.35));
  const cloth = mix(pal.wall, pal.skyTop, 0.3 * sky.darkness);
  const cells: [number, number][] = [];
  for (let j = 0; j < o.h; j++) for (let i = 0; i < o.w; i++) cells.push([i, j]);
  cells.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  for (const [i, j] of cells) {
    const gx = o.x + i + 0.5, gy = o.y + j + 0.5;
    const p: Proj = { cx: (gx - gy) * HW, cy: (gx + gy) * HH, s: 64 };
    const k = (o.x + i) * 3 + (o.y + j) * 5;
    const can = material(sky, ROOFS[k % ROOFS.length]);
    groundEllipse(ctx, p, 0, 0, 0, 0.4);
    ctx.fillStyle = alpha(pal.edge, 0.14);
    ctx.fill();
    // counter
    box(ctx, p, -0.28, 0.28, -0.18, 0.2, 0, 0.17, wood.top, wood.l, wood.r);
    if (detail >= 1) {
      // produce
      for (let q = 0; q < 4; q++) {
        const u = -0.2 + q * 0.13;
        ctx.fillStyle = material(sky, [ROOFS[1], ROOFS[5], ROOFS[2], pal.farm][(k + q) % 4]).base;
        ctx.beginPath();
        ctx.arc(projX(p, u, 0.05), projY(p, u, 0.05, 0.19), 2.4, 0, TAU);
        ctx.fill();
      }
      // posts
      ctx.fillStyle = wood.dark;
      for (const [u, v] of [[-0.3, 0.24], [0.3, 0.24], [0.3, -0.2]] as const) {
        const x = projX(p, u, v);
        const y = projY(p, u, v, 0);
        ctx.fillRect(x - 0.7, y - 0.46 * 64, 1.4, 0.46 * 64);
      }
    }
    // striped tent canopy (gable along u)
    const z0 = 0.42, z1 = 0.56, E = 0.36, V = 0.3;
    fillPoly(ctx, p, [-E, -V, z0, E, -V, z0, E, 0, z1, -E, 0, z1], can.dark);
    fillPoly(ctx, p, [E, -V, z0, E, V, z0, E, 0, z1], cloth);
    const n = detail >= 1 ? 4 : 1;
    for (let s = 0; s < n; s++) {
      const a = -E + (2 * E * s) / n, b = -E + (2 * E * (s + 1)) / n;
      fillPoly(ctx, p, [a, 0, z1, b, 0, z1, b, V, z0, a, V, z0], s % 2 === 0 ? can.l : cloth);
    }
  }
}

function monument(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState): void {
  const p = projFor(o);
  const pal = sky.palette;
  const stone = wallMat(sky, mix(WALLS[1], pal.edge, 0.12));
  const light = wallMat(sky, WALLS[0]);
  groundEllipse(ctx, p, 0, 0, 0, 0.9);
  ctx.fillStyle = alpha(pal.edge, 0.12);
  ctx.fill();
  box(ctx, p, -0.72, 0.72, -0.72, 0.72, 0, 0.07, stone.top, stone.l, stone.r);
  box(ctx, p, -0.46, 0.46, -0.46, 0.46, 0.07, 0.2, light.top, light.l, light.r);
  const b0 = 0.17, b1 = 0.1, z0 = 0.2, z1 = 1.45, zt = 1.65;
  fillPoly(ctx, p, [-b0, b0, z0, b0, b0, z0, b1, b1, z1, -b1, b1, z1], light.l);
  fillPoly(ctx, p, [b0, b0, z0, b0, -b0, z0, b1, -b1, z1, b1, b1, z1], light.r);
  const gold = material(sky, COLORS.gold);
  fillPoly(ctx, p, [-b1, b1, z1, b1, b1, z1, 0, 0, zt], gold.l);
  fillPoly(ctx, p, [b1, b1, z1, b1, -b1, z1, 0, 0, zt], gold.r);
  // plaque
  fillPoly(ctx, p, [-0.1, b0 + 0.002, 0.3, 0.1, b0 + 0.002, 0.3, 0.1, b0 + 0.002, 0.42, -0.1, b0 + 0.002, 0.42], gold.l);
}

/** Round tower silhouette (tapered); `bands` are [z0, z1, colour] stripes. */
function tower(
  ctx: CanvasRenderingContext2D, sky: SkyState, x: number, y: number, s: number,
  r0: number, r1: number, z0: number, z1: number, body: string, bands: [number, number, string][],
): void {
  const k = 0.7071 * s;
  const rAt = (z: number) => r0 + ((r1 - r0) * (z - z0)) / (z1 - z0);
  const seg = (za: number, zb: number) => {
    const ya = y - za * s, yb = y - zb * s;
    ctx.beginPath();
    ctx.ellipse(x, ya, rAt(za) * k, rAt(za) * k * 0.5, 0, 0, Math.PI, false);
    ctx.lineTo(x - rAt(zb) * k, yb);
    ctx.ellipse(x, yb, rAt(zb) * k, rAt(zb) * k * 0.5, 0, Math.PI, 0, true);
    ctx.closePath();
  };
  seg(z0, z1);
  ctx.fillStyle = body;
  ctx.fill();
  for (const [a, b, c] of bands) {
    seg(a, b);
    ctx.fillStyle = c;
    ctx.fill();
  }
  // shade one half
  const sh = sideShade(sky);
  const pal = sky.palette;
  for (const side of [-1, 1]) {
    const amt = side < 0 ? sh.l : sh.r;
    ctx.save();
    ctx.beginPath();
    ctx.rect(side < 0 ? x - 200 : x, y - z1 * s - 200, 200, z1 * s + 400);
    ctx.clip();
    seg(z0, z1);
    ctx.fillStyle = alpha(pal.edge, 0.32 * amt);
    ctx.fill();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.ellipse(x, y - z1 * s, r1 * k, r1 * k * 0.5, 0, 0, TAU);
  ctx.fillStyle = mix(body, pal.edge, 0.15);
  ctx.fill();
}

export const LIGHTHOUSE_LAMP_Z = 1.88;

function lighthouse(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState): void {
  const p = projFor(o);
  const pal = sky.palette;
  const rock = material(sky, mix(pal.sand, pal.edge, 0.4));
  const body = wallMat(sky, WALLS[0]).base;
  const red = material(sky, ROOFS[2]).base;
  groundEllipse(ctx, p, 0, 0, 0, 0.48);
  ctx.fillStyle = alpha(pal.edge, 0.18);
  ctx.fill();
  box(ctx, p, -0.38, 0.38, -0.38, 0.38, 0, 0.1, rock.top, rock.l, rock.r);
  const x = p.cx, y = p.cy;
  tower(ctx, sky, x, y, 64, 0.3, 0.19, 0.1, 1.72, body, [[0.45, 0.72, red], [1.05, 1.32, red]]);
  // gallery
  ctx.beginPath();
  ctx.ellipse(x, y - 1.74 * 64, 0.27 * 45.25, 0.27 * 22.6, 0, 0, TAU);
  ctx.fillStyle = mix(pal.edge, pal.road, 0.3);
  ctx.fill();
  // lamp room
  const g = sky.glow > 0.05 ? mix(glassColor(sky, false, 0), COLORS.glow, Math.min(1, sky.glow * 1.3)) : glassColor(sky, false, 0);
  ctx.fillStyle = g;
  ctx.fillRect(x - 0.14 * 45.25, y - 1.98 * 64, 0.28 * 45.25, 0.24 * 64);
  // cap
  ctx.fillStyle = red;
  ctx.beginPath();
  ctx.ellipse(x, y - 1.98 * 64, 0.18 * 45.25, 0.18 * 22.6, 0, Math.PI, 0, false);
  ctx.lineTo(x, y - 2.2 * 64);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(x - 0.8, y - 2.3 * 64, 1.6, 0.1 * 64);
}

export const WINDMILL_HUB_Z = 1.12;

function windmill(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, detail: number): void {
  const p = projFor(o);
  const pal = sky.palette;
  const body = wallMat(sky, WALLS[1]).base;
  const cap = material(sky, ROOFS[5]);
  groundEllipse(ctx, p, 0, 0, 0, 0.75);
  ctx.fillStyle = alpha(pal.edge, 0.16);
  ctx.fill();
  const x = p.cx, y = p.cy;
  tower(ctx, sky, x, y, 64, 0.58, 0.36, 0, 1.0, body, []);
  if (detail >= 1) {
    // door + windows on the front
    ctx.fillStyle = mix(cap.base, pal.edge, 0.45);
    ctx.beginPath();
    ctx.moveTo(x - 9, y + 13);
    ctx.lineTo(x - 9, y - 4);
    ctx.arc(x - 3.5, y - 4, 5.5, Math.PI, 0);
    ctx.lineTo(x + 2, y + 14);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = glassColor(sky, true, 0.7);
    ctx.fillRect(x - 6, y - 40, 5, 7);
    ctx.fillStyle = glassColor(sky, false, 0);
    ctx.fillRect(x + 8, y - 30, 4, 6);
  }
  // conical cap
  const k = 0.7071 * 64;
  const zc = 1.0;
  ctx.beginPath();
  ctx.ellipse(x, y - zc * 64, 0.42 * k, 0.21 * k, 0, 0, Math.PI, false);
  ctx.lineTo(x, y - 1.42 * 64);
  ctx.closePath();
  ctx.fillStyle = cap.l;
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y - 2 * 64, 100, 2 * 64);
  ctx.clip();
  ctx.beginPath();
  ctx.ellipse(x, y - zc * 64, 0.42 * k, 0.21 * k, 0, 0, Math.PI, false);
  ctx.lineTo(x, y - 1.42 * 64);
  ctx.closePath();
  ctx.fillStyle = cap.r;
  ctx.fill();
  ctx.restore();
}

// ── animated overlays ───────────────────────────────────────────────────────
export function drawAnimated(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, t: number, scale: number): void {
  const p = projFor(o);
  const pal = sky.palette;
  switch (o.landmark?.kind) {
    case 'windmill': {
      const hx = projX(p, 0, 0.42);
      const hy = projY(p, 0, 0.42, WINDMILL_HUB_Z);
      const L = 0.95;
      const frame = mix(pal.edge, pal.farm, 0.3);
      const sail = mix(mix(pal.wall, pal.wallShade, 0.3), pal.skyTop, 0.3 * sky.darkness);
      const a0 = t * 0.0006;
      for (let b = 0; b < 4; b++) {
        const a = a0 + (b * Math.PI) / 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        // point along blade at distance d, offset w perpendicular — in the +v facing plane (u, z)
        const pt = (d: number, w: number): [number, number] => {
          const du = ca * d - sa * w;
          const dz = sa * d + ca * w;
          return [hx + du * 32, hy + du * 16 - dz * 64];
        };
        const q = [pt(0.18, 0), pt(L, 0), pt(L, 0.17), pt(0.22, 0.12)];
        ctx.beginPath();
        ctx.moveTo(q[0][0], q[0][1]);
        for (let i = 1; i < 4; i++) ctx.lineTo(q[i][0], q[i][1]);
        ctx.closePath();
        ctx.fillStyle = sail;
        ctx.fill();
        const s0 = pt(0, 0), s1 = pt(L, 0);
        ctx.beginPath();
        ctx.moveTo(s0[0], s0[1]);
        ctx.lineTo(s1[0], s1[1]);
        ctx.lineWidth = Math.max(1.6, 1 / scale);
        ctx.strokeStyle = frame;
        ctx.stroke();
      }
      ctx.fillStyle = frame;
      ctx.beginPath();
      ctx.arc(hx, hy, 3.2, 0, TAU);
      ctx.fill();
      return;
    }
    case 'lighthouse': {
      if (sky.glow < 0.05) return;
      const lx = p.cx, ly = p.cy - LIGHTHOUSE_LAMP_Z * 64;
      const a = t * 0.0009;
      const L = 7; // tiles
      const spread = 0.16;
      const dir = (ang: number): [number, number] => [lx + (Math.cos(ang) - Math.sin(ang)) * L * 32, ly + (Math.cos(ang) + Math.sin(ang)) * L * 16];
      const [ax, ay] = dir(a - spread);
      const [bx, by] = dir(a + spread);
      const [mx, my] = dir(a);
      const g = ctx.createLinearGradient(lx, ly, mx, my);
      g.addColorStop(0, alpha(COLORS.glow, 0.55 * sky.glow));
      g.addColorStop(1, alpha(COLORS.glow, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.closePath();
      ctx.fill();
      const h = ctx.createRadialGradient(lx, ly, 0, lx, ly, 26);
      h.addColorStop(0, alpha(COLORS.glow, 0.8 * sky.glow));
      h.addColorStop(1, alpha(COLORS.glow, 0));
      ctx.fillStyle = h;
      ctx.beginPath();
      ctx.arc(lx, ly, 26, 0, TAU);
      ctx.fill();
      return;
    }
    case 'fountain': {
      if (scale < 0.35) return;
      const x = p.cx, y = p.cy - 0.3 * 64;
      ctx.fillStyle = alpha(pal.waterShine, 0.9);
      for (let k = 0; k < 10; k++) {
        const ph = ((t * 0.0011 + k / 10) % 1 + 1) % 1;
        const ang = (k / 10) * TAU;
        const r = ph * 10;
        const dx = Math.cos(ang) * r * 0.9;
        const dy = Math.sin(ang) * r * 0.45 - (ph * 22 - ph * ph * 22);
        ctx.beginPath();
        ctx.arc(x + dx, y + dy - 4, 1.4 * (1 - ph * 0.5), 0, TAU);
        ctx.fill();
      }
      return;
    }
  }
}
