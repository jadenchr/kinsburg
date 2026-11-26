// City services (hospital, school, vet, library on civic lots; police and fire stations on the
// square) and residents' pets. Same iso conventions as objects.ts: u runs to the lower right,
// v to the lower left; the +v (left) and +u (right) faces are the visible ones.
import { COLORS, ROOFS, WALLS, alpha, mix, type SkyState } from '../theme';
import type { Pet } from '../types';
import { HH, HW, box, fillPoly, glassColor, groundEllipse, hash, material, projX, projY, wallMat, type Proj } from './iso';
import type { Obj } from './model';
import { snowHip, xmasOn } from './xmas';

const TAU = Math.PI * 2;
const RED = '#c8463d';
const POLICE = '#2c4f8f';
const BRICK = '#b85d43';
const SLATE = '#59627a';

const proj = (o: Obj): Proj => {
  const gx = o.x + o.w / 2, gy = o.y + o.h / 2;
  return { cx: (gx - gy) * HW, cy: (gx + gy) * HH, s: 64 };
};

export function hipRoof(ctx: CanvasRenderingContext2D, p: Proj, E1: number, E2: number, z0: number, z1: number, r: number, mat: { l: string; r: string; dark: string }): void {
  // ridge along u of half-length r; footprint half extents E1 (u), E2 (v)
  fillPoly(ctx, p, [-E1, -E2, z0, E1, -E2, z0, r, 0, z1, -r, 0, z1], mat.dark);
  fillPoly(ctx, p, [E1, E2, z0, E1, -E2, z0, r, 0, z1], mat.r);
  fillPoly(ctx, p, [-E1, E2, z0, E1, E2, z0, r, 0, z1, -r, 0, z1], mat.l);
  if (xmasOn()) snowHip(ctx, p, E1, E2, z0, z1, r);
}

export function windowRow(
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

function shadow(ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, r: number, a = 0.15): void {
  groundEllipse(ctx, p, 0, 0, 0, r);
  ctx.fillStyle = alpha(sky.palette.edge, a);
  ctx.fill();
}

/** A flat rectangle on the +v (left) face, from u0..u1, z0..z1. */
const onLeft = (ctx: CanvasRenderingContext2D, p: Proj, v: number, u0: number, u1: number, z0: number, z1: number, c: string) =>
  fillPoly(ctx, p, [u0, v, z0, u1, v, z0, u1, v, z1, u0, v, z1], c);
/** Glow for signs that light up at night. */
const signColor = (sky: SkyState, c: string) => mix(material(sky, c).base, c, 0.6 * sky.glow);

// ── civic lots ──────────────────────────────────────────────────────────────

export function drawHospital(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, detail: number): void {
  const p = proj(o);
  const U = o.w / 2 - 0.16, V = o.h / 2 - 0.26, H = 0.78;
  const wall = wallMat(sky, WALLS[0]);
  const trim = material(sky, '#9fb3c8');
  shadow(ctx, p, sky, Math.max(o.w, o.h) * 0.5);
  box(ctx, p, -U - 0.06, U + 0.06, -V - 0.06, V + 0.06, 0, 0.04, trim.top, trim.l, trim.r);
  box(ctx, p, -U, U, -V, V, 0.04, H, wall.top, wall.l, wall.r);
  // parapet
  box(ctx, p, -U, U, -V, V, H, H + 0.04, null, trim.l, trim.r);
  if (detail >= 1) {
    for (const [z0, z1] of [[0.18, 0.32], [0.44, 0.58]] as const) {
      windowRow(ctx, p, sky, 'l', V + 0.001, -U, U - 0.3, z0, z1, 4, o.seed + z0 * 10);
      windowRow(ctx, p, sky, 'r', U + 0.001, -V, V, z0, z1, 3, o.seed + 7 + z0 * 10);
    }
    // helipad on the roof
    groundEllipse(ctx, p, -0.1, -0.05, H + 0.041, 0.32);
    ctx.fillStyle = material(sky, SLATE).base;
    ctx.fill();
    const hc = mix(sky.palette.wall, '#ffffff', 0.5);
    fillPoly(ctx, p, [-0.2, -0.13, H + 0.042, -0.16, -0.13, H + 0.042, -0.16, 0.03, H + 0.042, -0.2, 0.03, H + 0.042], hc);
    fillPoly(ctx, p, [-0.04, -0.13, H + 0.042, 0.0, -0.13, H + 0.042, 0.0, 0.03, H + 0.042, -0.04, 0.03, H + 0.042], hc);
    fillPoly(ctx, p, [-0.16, -0.07, H + 0.042, -0.04, -0.07, H + 0.042, -0.04, -0.03, H + 0.042, -0.16, -0.03, H + 0.042], hc);
  }
  // red cross on the front, lit at night
  const red = signColor(sky, RED);
  const cu = U - 0.18, cz = 0.66, s = 0.06, t = 0.02;
  onLeft(ctx, p, V + 0.002, cu - t, cu + t, cz - s, cz + s, red);
  onLeft(ctx, p, V + 0.002, cu - s, cu + s, cz - t, cz + t, red);
  // emergency entrance canopy
  box(ctx, p, U - 0.34, U - 0.02, V, V + 0.16, 0.22, 0.26, material(sky, RED).top, material(sky, RED).l, material(sky, RED).r);
  onLeft(ctx, p, V + 0.001, U - 0.28, U - 0.08, 0.04, 0.22, glassColor(sky, sky.glow > 0.05, 1));
}

export function drawSchool(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, detail: number): void {
  const p = proj(o);
  const U = o.w / 2 - 0.2, V = o.h / 2 - 0.34, H = 0.48;
  const brick = material(sky, BRICK);
  const stone = wallMat(sky, WALLS[1]);
  const roof = material(sky, SLATE);
  shadow(ctx, p, sky, Math.max(o.w, o.h) * 0.5);
  box(ctx, p, -U - 0.06, U + 0.06, -V - 0.06, V + 0.06, 0, 0.04, stone.top, stone.l, stone.r);
  box(ctx, p, -U, U, -V, V, 0.04, H, null, brick.l, brick.r);
  if (detail >= 1) {
    windowRow(ctx, p, sky, 'l', V + 0.001, -U, U, 0.16, 0.36, 5, o.seed);
    windowRow(ctx, p, sky, 'r', U + 0.001, -V, V, 0.16, 0.36, 3, o.seed + 3);
  }
  hipRoof(ctx, p, U + 0.06, V + 0.06, H - 0.01, H + 0.24, U * 0.55, roof);
  // bell tower
  box(ctx, p, -0.1, 0.1, -0.1, 0.1, H + 0.1, H + 0.42, null, stone.l, stone.r);
  if (detail >= 1) {
    onLeft(ctx, p, 0.101, -0.05, 0.05, H + 0.26, H + 0.36, material(sky, sky.palette.edge).base);
    groundEllipse(ctx, p, 0, 0.101, H + 0.3, 0.025);
    ctx.fillStyle = material(sky, COLORS.gold).base;
    ctx.fill();
  }
  fillPoly(ctx, p, [-0.13, 0.13, H + 0.42, 0.13, 0.13, H + 0.42, 0, 0, H + 0.6], roof.l);
  fillPoly(ctx, p, [0.13, 0.13, H + 0.42, 0.13, -0.13, H + 0.42, 0, 0, H + 0.6], roof.r);
  // front door + flag
  onLeft(ctx, p, V + 0.001, -0.08, 0.08, 0.04, 0.26, material(sky, ROOFS[3]).dark);
  if (detail >= 1) {
    const fu = U + 0.02, fv = V + 0.2;
    const x = projX(p, fu, fv), y = projY(p, fu, fv, 0);
    ctx.fillStyle = material(sky, sky.palette.edge).base;
    ctx.fillRect(x - 0.6, y - 0.9 * 64, 1.2, 0.9 * 64);
    fillPoly(ctx, p, [fu, fv, 0.9, fu + 0.18, fv, 0.86, fu, fv, 0.78], signColor(sky, ROOFS[1]));
  }
}

export function drawVet(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, detail: number): void {
  const p = proj(o);
  const pal = sky.palette;
  const E = o.w / 2 - 0.12;
  shadow(ctx, p, sky, Math.max(o.w, o.h) * 0.5, 0.1);
  // dog run on the front half: grass, fence, a kennel, two dogs
  const g = material(sky, pal.park);
  fillPoly(ctx, p, [-E, 0.05, 0.005, E, 0.05, 0.005, E, E, 0.005, -E, E, 0.005], g.base);
  // clinic on the back half
  const wall = wallMat(sky, WALLS[0]);
  const teal = material(sky, ROOFS[3]);
  const U = E - 0.06, V0 = -E + 0.06, V1 = 0.0, H = 0.42;
  const pv = p;
  box(ctx, pv, -U, U, V0, V1, 0, H, null, wall.l, wall.r);
  if (detail >= 1) {
    windowRow(ctx, pv, sky, 'l', V1 + 0.001, -U, U - 0.3, 0.14, 0.32, 3, o.seed);
    windowRow(ctx, pv, sky, 'r', U + 0.001, V0, V1, 0.14, 0.32, 2, o.seed + 5);
  }
  // gable roof along u
  const mid = (V0 + V1) / 2, R = H + 0.24;
  fillPoly(ctx, pv, [-U - 0.05, V0 - 0.05, H, U + 0.05, V0 - 0.05, H, U + 0.05, mid, R, -U - 0.05, mid, R], teal.dark);
  fillPoly(ctx, pv, [-U - 0.05, V1 + 0.05, H, U + 0.05, V1 + 0.05, H, U + 0.05, mid, R, -U - 0.05, mid, R], teal.l);
  fillPoly(ctx, pv, [U + 0.05, V1 + 0.05, H, U + 0.05, V0 - 0.05, H, U + 0.05, mid, R], wall.r);
  // paw sign
  const sc = signColor(sky, ROOFS[3]);
  const sx = projX(pv, U - 0.2, V1 + 0.002), sy = projY(pv, U - 0.2, V1 + 0.002, 0.3);
  ctx.fillStyle = sc;
  ctx.beginPath();
  ctx.arc(sx, sy + 1.5, 2.6, 0, TAU);
  for (const [dx, dy] of [[-3, -2.2], [-1, -3.6], [1.4, -3.6], [3.2, -2]]) {
    ctx.moveTo(sx + dx + 1.1, sy + dy);
    ctx.arc(sx + dx, sy + dy, 1.1, 0, TAU);
  }
  ctx.fill();
  if (detail >= 1) {
    // kennel
    const wood = material(sky, mix(pal.farm, pal.edge, 0.35));
    box(ctx, p, -E + 0.14, -E + 0.34, 0.3, 0.5, 0, 0.14, null, wood.l, wood.r);
    fillPoly(ctx, p, [-E + 0.1, 0.54, 0.14, -E + 0.38, 0.54, 0.14, -E + 0.24, 0.54, 0.24], wood.dark);
    drawPetAt(ctx, p, sky, 'dog', 0.2, 0.45, hash(o.seed, 1));
    drawPetAt(ctx, p, sky, 'golden', 0.5, 0.7, hash(o.seed, 2));
  }
  // fence along the two front edges
  const f = alpha(pal.edge, 0.55);
  const rail = (c: number[]) => fillPoly(ctx, p, c, f);
  rail([-E, E, 0.1, E, E, 0.1, E, E, 0.085, -E, E, 0.085]);
  rail([E, 0.05, 0.1, E, E, 0.1, E, E, 0.085, E, 0.05, 0.085]);
}

// ── stations on the square (landmarks) ───────────────────────────────────────

export function drawPoliceStation(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, detail: number): void {
  const p = proj(o);
  const U = o.w / 2 - 0.22, V = o.h / 2 - 0.42, H = 0.6;
  const wall = wallMat(sky, WALLS[0]);
  const blue = material(sky, POLICE);
  shadow(ctx, p, sky, Math.max(o.w, o.h) * 0.48);
  box(ctx, p, -U, U, -V, V, 0, H, wall.top, wall.l, wall.r);
  box(ctx, p, -U - 0.02, U + 0.02, -V - 0.02, V + 0.02, H - 0.12, H + 0.02, blue.top, blue.l, blue.r);
  if (detail >= 1) {
    windowRow(ctx, p, sky, 'l', V + 0.001, -U, U, 0.18, 0.36, 4, o.seed);
    windowRow(ctx, p, sky, 'r', U + 0.001, -V, V, 0.18, 0.36, 3, o.seed + 2);
  }
  // badge over the door
  const bx = projX(p, 0, V + 0.002), by = projY(p, 0, V + 0.002, H - 0.06);
  ctx.fillStyle = signColor(sky, COLORS.gold);
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? 2.2 : 4.6, a = (k / 10) * TAU - Math.PI / 2;
    if (k === 0) ctx.moveTo(bx + Math.cos(a) * r, by + Math.sin(a) * r);
    else ctx.lineTo(bx + Math.cos(a) * r, by + Math.sin(a) * r);
  }
  ctx.fill();
  onLeft(ctx, p, V + 0.001, -0.1, 0.1, 0, 0.3, blue.dark);
  // patrol car parked out front
  if (detail >= 1) car(ctx, p, sky, 0.28, V + 0.3, '#f4f4f2', POLICE);
}

export function drawFireStation(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, detail: number): void {
  const p = proj(o);
  const U = o.w / 2 - 0.16, V = o.h / 2 - 0.32, H = 0.62;
  const brick = material(sky, RED);
  const stone = wallMat(sky, WALLS[1]);
  shadow(ctx, p, sky, Math.max(o.w, o.h) * 0.5);
  box(ctx, p, -U, U, -V, V, 0, H, brick.top, brick.l, brick.r);
  box(ctx, p, -U - 0.02, U + 0.02, -V - 0.02, V + 0.02, H, H + 0.04, stone.top, stone.l, stone.r);
  // hose tower rising from the back corner of the roof (drawn after the roof so it stands on it)
  box(ctx, p, U - 0.3, U, -V, -V + 0.3, H + 0.04, 1.18, brick.top, brick.l, brick.r);
  box(ctx, p, U - 0.32, U + 0.02, -V - 0.02, -V + 0.32, 1.18, 1.22, stone.top, stone.l, stone.r);
  if (detail >= 1) onLeft(ctx, p, -V + 0.301, U - 0.22, U - 0.08, 0.86, 1.06, glassColor(sky, sky.glow > 0.3, 0.5));
  // two big garage doors on the front; the right one open with the engine's nose showing
  const door = material(sky, mix(SLATE, sky.palette.edge, 0.2));
  const dark = alpha(sky.palette.edge, 0.85);
  onLeft(ctx, p, V + 0.001, -U + 0.1, -0.06, 0.02, 0.42, door.base);
  onLeft(ctx, p, V + 0.001, 0.06, U - 0.1, 0.02, 0.42, dark);
  if (detail >= 1) {
    for (let k = 1; k < 4; k++) onLeft(ctx, p, V + 0.002, -U + 0.1, -0.06, 0.02 + k * 0.1, 0.03 + k * 0.1, door.dark);
    windowRow(ctx, p, sky, 'r', U + 0.001, -V + 0.3, V, 0.2, 0.4, 2, o.seed);
    windowRow(ctx, p, sky, 'l', V + 0.001, -U, U, 0.48, 0.56, 4, o.seed + 1);
    // fire engine
    const truck = material(sky, RED);
    box(ctx, p, 0.12, U - 0.16, V - 0.1, V + 0.14, 0.04, 0.3, truck.top, truck.l, truck.r);
    onLeft(ctx, p, V + 0.141, 0.16, U - 0.2, 0.18, 0.27, glassColor(sky, false, 0));
    fillPoly(ctx, p, [0.14, V + 0.142, 0.08, U - 0.18, V + 0.142, 0.08, U - 0.18, V + 0.142, 0.11, 0.14, V + 0.142, 0.11], material(sky, '#e8e2d0').base);
  }
}

function car(ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, u: number, v: number, body: string, stripe: string): void {
  const b = material(sky, body);
  const s = material(sky, stripe);
  box(ctx, p, u - 0.2, u + 0.2, v - 0.08, v + 0.08, 0.03, 0.1, b.top, b.l, b.r);
  box(ctx, p, u - 0.1, u + 0.08, v - 0.07, v + 0.07, 0.1, 0.16, b.top, b.l, b.r);
  fillPoly(ctx, p, [u - 0.2, v + 0.081, 0.06, u + 0.2, v + 0.081, 0.06, u + 0.2, v + 0.081, 0.08, u - 0.2, v + 0.081, 0.08], s.l);
  onLeft(ctx, p, v + 0.071, u - 0.08, u + 0.06, 0.11, 0.15, glassColor(sky, false, 0));
  // light bar (the flashing is drawn by drawStationLights)
  box(ctx, p, u - 0.04, u + 0.02, v - 0.05, v + 0.05, 0.16, 0.18, null, '#8a8a8a', '#7a7a7a');
}

/** Flashing lights on the patrol car, drawn every frame (red/blue at night, still by day). */
export function drawStationLights(ctx: CanvasRenderingContext2D, o: Obj, sky: SkyState, t: number): void {
  if (o.landmark?.kind !== 'police' || sky.glow < 0.05) return;
  const p = proj(o);
  const V = o.h / 2 - 0.42;
  const u = 0.28, v = V + 0.3;
  const on = Math.floor(t / 420) % 2 === 0;
  for (const [du, c] of [[-0.03, on ? '#ff4d4d' : '#4d7dff'], [0.01, on ? '#4d7dff' : '#ff4d4d']] as const) {
    const x = projX(p, u + du, v), y = projY(p, u + du, v, 0.19);
    const g = ctx.createRadialGradient(x, y, 0, x, y, 9);
    g.addColorStop(0, alpha(c, 0.75 * sky.glow));
    g.addColorStop(1, alpha(c, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, TAU);
    ctx.fill();
  }
}

// ── pets ─────────────────────────────────────────────────────────────────────

const PET_LOOK: Record<Pet, { body: string; head?: string; len: number; tall: number }> = {
  dog: { body: '#8a5a3c', len: 0.12, tall: 0.06 },
  golden: { body: '#d9a54a', len: 0.14, tall: 0.07 },
  cat: { body: '#7d7f88', len: 0.1, tall: 0.05 },
  bunny: { body: '#f2efe9', len: 0.08, tall: 0.06 },
  fox: { body: '#d9682b', len: 0.12, tall: 0.055 },
  owl: { body: '#7a5a3a', len: 0.07, tall: 0.11 },
};

/** A pet in a house's front yard (house tiles are 1x1; the front corner is free grass). */
export function drawPet(ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, pet: Pet, seed: number): void {
  drawPetAt(ctx, p, sky, pet, 0.4, 0.38 - hash(seed, 3) * 0.12, hash(seed, 4));
}

/** Small screen-space sprite standing on the ground at (u, v). `r` varies its pose. */
export function drawPetAt(ctx: CanvasRenderingContext2D, p: Proj, sky: SkyState, pet: Pet, u: number, v: number, r: number): void {
  const look = PET_LOOK[pet];
  const c = material(sky, look.body);
  const s = p.s / 64;
  const x = projX(p, u, v), y = projY(p, u, v, 0);
  const dir = r < 0.5 ? -1 : 1;
  const L = look.len * 64 * s, T = look.tall * 64 * s;
  ctx.fillStyle = alpha(sky.palette.edge, 0.18);
  ctx.beginPath();
  ctx.ellipse(x, y, L * 0.55, L * 0.22, 0, 0, TAU);
  ctx.fill();
  if (pet === 'owl') {
    // perch post + round owl
    ctx.fillStyle = material(sky, mix(sky.palette.farm, sky.palette.edge, 0.4)).base;
    ctx.fillRect(x - 0.8 * s, y - T * 0.9, 1.6 * s, T * 0.9);
    ctx.fillStyle = c.base;
    ctx.beginPath();
    ctx.ellipse(x, y - T * 1.25, L * 0.32, T * 0.42, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = mix(COLORS.glow, '#ffffff', 0.4);
    for (const dx of [-1.1, 1.1]) {
      ctx.beginPath();
      ctx.arc(x + dx * s, y - T * 1.42, 0.9 * s, 0, TAU);
      ctx.fill();
    }
    return;
  }
  // body
  ctx.fillStyle = c.base;
  ctx.beginPath();
  ctx.ellipse(x, y - T * 0.55, L * 0.5, T * 0.45, 0, 0, TAU);
  ctx.fill();
  // legs
  ctx.fillStyle = c.dark;
  for (const dx of [-0.32, 0.28]) ctx.fillRect(x + dx * L - 0.6 * s, y - T * 0.3, 1.2 * s, T * 0.3);
  // head
  const hx = x + dir * L * 0.5, hy = y - T * (pet === 'bunny' ? 0.95 : 0.85);
  ctx.fillStyle = c.base;
  ctx.beginPath();
  ctx.arc(hx, hy, T * (pet === 'cat' ? 0.38 : 0.42), 0, TAU);
  ctx.fill();
  // ears / tail
  ctx.fillStyle = pet === 'fox' ? c.dark : c.base;
  if (pet === 'bunny') {
    ctx.fillRect(hx - 1.2 * s, hy - T * 1.0, 1 * s, T * 0.7);
    ctx.fillRect(hx + 0.4 * s, hy - T * 1.0, 1 * s, T * 0.7);
  } else if (pet === 'cat' || pet === 'fox') {
    for (const dx of [-0.25, 0.25]) {
      ctx.beginPath();
      ctx.moveTo(hx + dx * T - 1.1 * s, hy - T * 0.2);
      ctx.lineTo(hx + dx * T, hy - T * 0.75);
      ctx.lineTo(hx + dx * T + 1.1 * s, hy - T * 0.2);
      ctx.fill();
    }
  }
  const tx = x - dir * L * 0.5;
  ctx.strokeStyle = pet === 'fox' ? c.base : c.dark;
  ctx.lineWidth = (pet === 'fox' || pet === 'golden' ? 2.2 : 1.2) * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(tx, y - T * 0.6);
  ctx.lineTo(tx - dir * L * 0.25, y - T * (pet === 'cat' ? 1.1 : 0.85));
  ctx.stroke();
  if (pet === 'fox') {
    ctx.fillStyle = '#f5efe6';
    ctx.beginPath();
    ctx.arc(tx - dir * L * 0.25, y - T * 0.85, 1.3 * s, 0, TAU);
    ctx.fill();
  }
}
