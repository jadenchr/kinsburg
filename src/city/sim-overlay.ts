// Simulation overlay: open incidents (fire, police, ambulance, scaffolding…), the station vehicles
// that drive to them along the roads, and the little commuters walking to work. Everything here is
// drawn every frame in world space on top of the chunk layer (like the billboard), so it stays
// animated and crisp; nothing is cached into the chunks.
//
// Performance: road paths come from one BFS per start tile (cached, parent pointers), computed when
// the incident list or the model changes — never per frame. Per frame the work is a handful of
// vehicles/incidents plus at most 80 walkers, all culled to the view rectangle.
import { COLORS, FONTS, alpha, mix, type SkyState } from '../theme';
import type { TownIncident } from '../data/town';
import { INCIDENTS } from '../../shared/sim.mjs';
import { SERVICE_STAFF } from '../../shared/city-layout.mjs';
import { HH, HW, clamp, fillPoly, groundEllipse, hash, material, projX, projY, type Mat, type Proj } from './iso';
import { T_PLAZA, T_ROAD, type Model, type Obj } from './model';
import { projFor } from './objects';

const TAU = Math.PI * 2;

/** Vehicle speed in tiles per second. */
const SPEED_LIVE = 1.5;
/** Reels are short: drive a bit faster so the arrival shows. */
const SPEED_REEL = 2.4;
/** Commuters stroll at this many tiles per second. */
const WALK_SPEED = 0.8;
const MAX_WALKERS = 120;

export interface View {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}
/** Repaint what stands in front of grid tile (tx, ty) inside a world-space box (cx, cy, half w, half h). */
export type FrontFn = (tx: number, ty: number, cx: number, cy: number, hw: number, hh: number) => void;

export interface DrawOpts {
  reel: boolean;
  front: FrontFn;
}

export interface SimOverlay {
  setModel(m: Model | null): void;
  setIncidents(list: TownIncident[]): void;
  draw(ctx: CanvasRenderingContext2D, sky: SkyState, t: number, S: number, v: View, o: DrawOpts): void;
}

type BadgeIcon = 'fire' | 'star' | 'bang' | 'cross' | 'paw' | 'book' | 'hammer';
const BADGE: Record<string, { icon: BadgeIcon; color: string }> = {
  fire: { icon: 'fire', color: '#d9382c' },
  burglary: { icon: 'star', color: '#2f5fb8' },
  crash: { icon: 'bang', color: '#2f5fb8' },
  flu: { icon: 'cross', color: '#d63a3a' },
  lostpet: { icon: 'paw', color: '#1f9d8f' },
  exam: { icon: 'book', color: '#e9b824' },
  repair: { icon: 'hammer', color: '#e8782a' },
};

type VehicleKind = 'engine' | 'police' | 'ambulance';

interface Anchor {
  /** world position of the base centre and height of the thing above it */
  cx: number;
  cy: number;
  top: number;
  obj: Obj | null;
  /** grid position of the anchor (road tile for crashes) */
  gx: number;
  gy: number;
}

interface Prepared {
  inc: TownIncident;
  kind: string;
  a: Anchor;
  vehicle: VehicleKind | null;
  /** tile indices from the station to the incident (length ≥ 1) */
  path: Int32Array | null;
  /** index in path where the vehicle parks */
  stopAt: number;
  created: number;
  seed: number;
}

interface Walker {
  handle: string;
  home: Obj;
  work: Obj;
  color: string;
  leave: number;
  back: number;
  lane: number;
  path: Int32Array | null;
  failed: boolean;
}

const JOB_COLOR: Record<string, string> = {
  'Police officer': '#243b6b',
  Firefighter: '#c8463d',
  Doctor: '#f2f2ee',
  Nurse: '#f2f2ee',
  Teacher: '#4c9a5a',
  Vet: '#2a9d9a',
  Librarian: '#7a5aa8',
};

const strHash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
};

export function createSimOverlay(): SimOverlay {
  let model: Model | null = null;
  let incidents: TownIncident[] = [];
  let prepared: Prepared[] = [];
  let walkers: Walker[] | null = null;
  let walk: Uint8Array | null = null;
  const bfsCache = new Map<number, Int32Array>();
  const front = { gx: 0, gy: 0, dx: 1, dy: 0 };

  // ── grid helpers ──────────────────────────────────────────────────────────
  function walkGrid(m: Model): Uint8Array {
    if (walk) return walk;
    walk = new Uint8Array(m.W * m.H);
    for (let i = 0; i < walk.length; i++) walk[i] = m.tile[i] === T_ROAD || m.tile[i] === T_PLAZA ? 1 : 0;
    return walk;
  }

  /** Nearest road/plaza tile to a footprint (searching outward), or -1. */
  function nearestWalk(m: Model, x: number, y: number, w: number, h: number): number {
    const g = walkGrid(m);
    const cx = x + w / 2, cy = y + h / 2;
    let best = -1, bestD = Infinity;
    for (let r = 1; r <= 8 && best < 0; r++) {
      for (let yy = y - r; yy < y + h + r; yy++)
        for (let xx = x - r; xx < x + w + r; xx++) {
          if (xx < 0 || yy < 0 || xx >= m.W || yy >= m.H) continue;
          if (xx >= x - r + 1 && xx < x + w + r - 1 && yy >= y - r + 1 && yy < y + h + r - 1) continue; // ring only
          const i = yy * m.W + xx;
          if (!g[i]) continue;
          const d = (xx + 0.5 - cx) ** 2 + (yy + 0.5 - cy) ** 2 - (m.tile[i] === T_ROAD ? 0.3 : 0);
          if (d < bestD) { bestD = d; best = i; }
        }
    }
    return best;
  }

  /** Parent pointers of a BFS over the walkable grid from `root` (-2 = unreached, -1 = root). */
  function bfs(m: Model, root: number): Int32Array {
    let par = bfsCache.get(root);
    if (par) return par;
    const g = walkGrid(m);
    par = new Int32Array(m.W * m.H).fill(-2);
    const q = new Int32Array(m.W * m.H);
    let qh = 0, qt = 0;
    par[root] = -1;
    q[qt++] = root;
    while (qh < qt) {
      const i = q[qh++];
      const x = i % m.W, y = (i / m.W) | 0;
      if (x > 0 && g[i - 1] && par[i - 1] === -2) { par[i - 1] = i; q[qt++] = i - 1; }
      if (x < m.W - 1 && g[i + 1] && par[i + 1] === -2) { par[i + 1] = i; q[qt++] = i + 1; }
      if (y > 0 && g[i - m.W] && par[i - m.W] === -2) { par[i - m.W] = i; q[qt++] = i - m.W; }
      if (y < m.H - 1 && g[i + m.W] && par[i + m.W] === -2) { par[i + m.W] = i; q[qt++] = i + m.W; }
    }
    bfsCache.set(root, par);
    return par;
  }

  /** Path from `from` to the BFS root of `par` (inclusive both ends), or null if unreachable. */
  function pathToRoot(par: Int32Array, from: number): Int32Array | null {
    if (from < 0 || par[from] === -2) return null;
    const out: number[] = [];
    for (let i = from; i !== -1; i = par[i]) out.push(i);
    return Int32Array.from(out);
  }

  // ── buildings ─────────────────────────────────────────────────────────────
  // buildings per service, cached per model (scanning every object per resident froze big towns)
  let svcModel: Model | null = null;
  const svcCache = new Map<string, Obj[]>();
  function buildingsOf(m: Model, service: string): Obj[] {
    if (svcModel !== m) { svcModel = m; svcCache.clear(); }
    let list = svcCache.get(service);
    if (!list) {
      list = service === 'police' || service === 'firestation'
        ? m.objs.filter((o) => o.landmark?.kind === service)
        : m.objs.filter((o) => o.kind === 'civic' && o.plot?.service === service);
      svcCache.set(service, list);
    }
    return list;
  }
  const dist = (a: Obj, b: Obj) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  function nearestBuilding(m: Model, service: string, to: Obj): Obj | null {
    let best: Obj | null = null, bd = Infinity;
    for (const o of buildingsOf(m, service)) {
      const d = dist(o, to);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  function anchorAt(o: Obj): Anchor {
    const p = projFor(o);
    return { cx: p.cx, cy: p.cy, top: o.height, obj: o, gx: o.x + o.w / 2, gy: o.y + o.h / 2 };
  }

  // ── incidents ─────────────────────────────────────────────────────────────
  function prepare() {
    prepared = [];
    const m = model;
    if (!m) return;
    for (const inc of incidents) {
      const def = (INCIDENTS as Record<string, { station: string | null; vehicle: VehicleKind | null }>)[inc.kind];
      if (!def) continue;
      const home = inc.target ? m.byResident.get(inc.target.toLowerCase()) : undefined;
      let obj: Obj | null = home !== undefined ? m.objs[home] : null;
      if (inc.kind === 'flu' || inc.kind === 'exam') {
        const svc = inc.kind === 'flu' ? 'hospital' : 'school';
        obj = buildingsOf(m, svc)[0] ?? obj;
      } else if (!obj) {
        obj = (def.station && buildingsOf(m, def.station)[0]) || m.objs.find((o) => o.landmark?.kind === 'townhall') || null;
      }
      if (!obj) continue;
      let a = anchorAt(obj);
      let tgt = -1;
      if (inc.kind === 'crash') {
        tgt = nearestWalk(m, obj.x, obj.y, obj.w, obj.h);
        if (tgt >= 0) {
          const tx = tgt % m.W, ty = (tgt / m.W) | 0;
          a = { cx: (tx - ty) * HW, cy: (tx + ty + 1) * HH, top: 14, obj: null, gx: tx + 0.5, gy: ty + 0.5 };
        }
      } else if (def.vehicle) tgt = nearestWalk(m, obj.x, obj.y, obj.w, obj.h);

      let path: Int32Array | null = null;
      let stopAt = 0;
      if (def.vehicle && def.station && tgt >= 0) {
        const st = inc.kind === 'flu' ? obj : nearestBuilding(m, def.station, obj);
        if (st) {
          if (st === obj) path = Int32Array.of(tgt);
          else {
            const root = nearestWalk(m, st.x, st.y, st.w, st.h);
            if (root >= 0) path = pathToRoot(bfs(m, root), tgt);
            if (path) path = path.reverse();
          }
          if (!path) path = Int32Array.of(tgt);
          stopAt = inc.kind === 'crash' ? Math.max(0, path.length - 2) : path.length - 1;
        }
      }
      const created = Date.parse(inc.createdAt);
      prepared.push({
        inc, kind: inc.kind, a, vehicle: path ? def.vehicle : null, path, stopAt,
        created: Number.isFinite(created) ? created : Date.now(), seed: inc.id * 7 + 3,
      });
    }
  }

  // ── commuters ─────────────────────────────────────────────────────────────
  function buildWalkers(m: Model): Walker[] {
    const staff = new Map<string, string>();
    for (const [svc, jobs] of Object.entries(SERVICE_STAFF)) for (const j of jobs) staff.set(j, svc);
    const out: Walker[] = [];
    for (const r of m.data.residents) {
      const svc = staff.get(r.job);
      const oi = m.byResident.get(r.id);
      if (!svc || oi === undefined) continue;
      const home = m.objs[oi];
      const work = nearestBuilding(m, svc, home);
      if (!work) continue;
      const k = strHash(r.handle);
      out.push({
        handle: r.handle, home, work, color: JOB_COLOR[r.job] ?? '#6b6b6b',
        leave: 450 + k * 90, back: 990 + strHash(r.handle + '~') * 120,
        lane: (strHash(r.handle + '#') - 0.5) * 0.5, path: null, failed: false,
      });
    }
    out.sort((a, b) => strHash(b.handle + '^') - strHash(a.handle + '^'));
    return out.slice(0, MAX_WALKERS);
  }

  function walkerPath(m: Model, w: Walker): Int32Array | null {
    if (w.path || w.failed) return w.path;
    const root = nearestWalk(m, w.work.x, w.work.y, w.work.w, w.work.h);
    const start = nearestWalk(m, w.home.x, w.home.y, w.home.w, w.home.h);
    const p = root >= 0 && start >= 0 ? pathToRoot(bfs(m, root), start) : null;
    if (!p || p.length < 2) w.failed = true;
    else w.path = p;
    return w.path;
  }

  // ── position along a path ─────────────────────────────────────────────────
  function along(m: Model, path: Int32Array, d: number) {
    const n = path.length;
    if (n === 1) {
      const i = path[0];
      front.gx = (i % m.W) + 0.5;
      front.gy = ((i / m.W) | 0) + 0.5;
      const r = m.road[i];
      const vert = (r & 12) !== 0 && (r & 3) === 0;
      front.dx = vert ? 0 : 1;
      front.dy = vert ? 1 : 0;
      return front;
    }
    const k = Math.min(n - 2, Math.max(0, Math.floor(d)));
    const f = clamp(d - k, 0, 1);
    const a = path[k], b = path[k + 1];
    const ax = a % m.W, ay = (a / m.W) | 0, bx = b % m.W, by = (b / m.W) | 0;
    front.gx = ax + 0.5 + (bx - ax) * f;
    front.gy = ay + 0.5 + (by - ay) * f;
    front.dx = bx - ax;
    front.dy = by - ay;
    return front;
  }

  // ── drawing: public ───────────────────────────────────────────────────────
  function draw(ctx: CanvasRenderingContext2D, sky: SkyState, t: number, S: number, v: View, o: DrawOpts) {
    const m = model;
    if (!m) return;
    const inView = (x: number, y: number, pad: number) => x > v.minX - pad && x < v.maxX + pad && y > v.minY - pad && y < v.maxY + pad;

    if (!o.reel && S >= 0.45) drawWalkers(ctx, m, sky, S, v, o);

    if (!prepared.length) return;
    const vis: Prepared[] = [];
    for (const p of prepared) if (inView(p.a.cx, p.a.cy - p.a.top / 2, 160 + p.a.top)) vis.push(p);
    // vehicles can be anywhere along the route: include incidents whose vehicle is on screen
    vis.sort((a, b) => a.a.cy - b.a.cy);
    const speed = o.reel ? SPEED_REEL : SPEED_LIVE;
    const nowMs = Date.now();
    for (const p of vis) drawIncidentBase(ctx, sky, p, t);
    for (const p of prepared) {
      if (!p.vehicle || !p.path) continue;
      const elapsed = (o.reel ? t : nowMs - p.created) / 1000;
      const d = Math.min(p.stopAt, Math.max(0, elapsed * speed));
      const pos = along(m, p.path, d);
      const { dx, dy } = pos;
      const lane = 0.15;
      const gx = pos.gx - dy * lane, gy = pos.gy + dx * lane;
      const wx = (gx - gy) * HW, wy = (gx + gy) * HH;
      if (!inView(wx, wy, 80)) continue;
      const ang = Math.atan2(dy, dx);
      drawVehicle(ctx, sky, p.vehicle, wx, wy, ang, t, true, p.seed);
      if (S >= 0.5) o.front(Math.floor(gx), Math.floor(gy), wx, wy - 8, 22, 24);
    }
    // crash scene cars
    for (const p of vis) if (p.kind === 'crash' && p.a.obj === null) drawCrashCars(ctx, sky, p, t, S, o.front);
    // badges and bubbles on top
    const k = clamp(1 / S, 0.7, 3.2);
    for (const p of vis) drawMarker(ctx, p, t, k);
  }

  // ── commuters ─────────────────────────────────────────────────────────────
  function drawWalkers(ctx: CanvasRenderingContext2D, m: Model, sky: SkyState, S: number, v: View, o: DrawOpts) {
    if (!walkers) walkers = buildWalkers(m);
    if (!walkers.length) return;
    const d = new Date();
    const mins = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60000;
    if (mins < 440 || mins > 1130) return;
    const tNow = d.getTime();
    const dark = sky.darkness;
    let repainted = 0;
    const seen = new Set<number>();
    for (const w of walkers) {
      let rev: boolean;
      let since: number;
      if (mins >= w.back) { rev = true; since = (mins - w.back) * 60; }
      else if (mins >= w.leave) { rev = false; since = (mins - w.leave) * 60; }
      else continue;
      // walking only while the trip lasts (a trip is path.length / WALK_SPEED seconds)
      if (since * WALK_SPEED > 400) continue;
      const path = walkerPath(m, w);
      if (!path) continue;
      const n = path.length;
      const dist = since * WALK_SPEED;
      if (dist >= n - 1) continue; // arrived (at work, or home again)
      const pos = along(m, path, rev ? n - 1 - dist : dist);
      let dx = pos.dx, dy = pos.dy;
      if (rev) { dx = -dx; dy = -dy; }
      const gx = pos.gx - dy * w.lane, gy = pos.gy + dx * w.lane;
      const wx = (gx - gy) * HW, wy = (gx + gy) * HH;
      if (wx < v.minX - 20 || wx > v.maxX + 20 || wy < v.minY - 20 || wy > v.maxY + 40) continue;
      const bob = Math.abs(Math.sin(tNow / 170 + w.lane * 20)) * 0.9;
      const body = mix(w.color, sky.palette.skyTop, 0.4 * dark);
      ctx.fillStyle = alpha(sky.palette.edge, 0.2);
      ctx.beginPath();
      ctx.ellipse(wx, wy, 2.6, 1.2, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = body;
      ctx.fillRect(wx - 1.5, wy - 6 - bob, 3, 5.2);
      ctx.fillStyle = mix('#e6c3a0', sky.palette.skyTop, 0.4 * dark);
      ctx.beginPath();
      ctx.arc(wx, wy - 7.7 - bob, 1.7, 0, TAU);
      ctx.fill();
      const key = Math.floor(gy) * m.W + Math.floor(gx);
      if (S >= 0.6 && repainted < 24 && !seen.has(key)) {
        seen.add(key);
        repainted++;
        o.front(Math.floor(gx), Math.floor(gy), wx, wy - 5, 6, 9);
      }
    }
  }

  // ── incident visuals ──────────────────────────────────────────────────────
  function drawIncidentBase(ctx: CanvasRenderingContext2D, sky: SkyState, p: Prepared, t: number) {
    switch (p.kind) {
      case 'fire': drawFire(ctx, sky, p, t); break;
      case 'repair': if (p.a.obj) drawScaffold(ctx, sky, p.a.obj); break;
      case 'flu': drawCrossGlow(ctx, sky, p, t); break;
    }
  }

  function drawFire(ctx: CanvasRenderingContext2D, sky: SkyState, p: Prepared, t: number) {
    const { cx, cy, top } = p.a;
    const by = cy - top * 0.58;
    const dark = sky.darkness;
    // warm glow on the house
    const g = ctx.createRadialGradient(cx, by - 8, 0, cx, by - 8, 46);
    g.addColorStop(0, `rgba(255,150,50,${0.3 + 0.3 * dark})`);
    g.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, by - 8, 46, 0, TAU);
    ctx.fill();
    // smoke rising and drifting
    for (let i = 0; i < 8; i++) {
      const ph = (t / 3200 + i / 8) % 1;
      const x = cx + Math.sin(ph * 5 + i * 1.9) * 5 + ph * 16;
      const y = by - 8 - ph * 78;
      const r = 5 + ph * 11;
      const a = (1 - ph) * (0.42 + 0.2 * dark) * Math.min(1, ph * 6);
      ctx.fillStyle = mix('#8d8c92', '#c9c8d2', 0.55 * dark);
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // flame tongues, back to front
    for (let i = 0; i < 6; i++) {
      const ox = (i - 2.5) * 4.6 + Math.sin(t / 310 + i * 2.1) * 1.4;
      const h = 15 + hash(p.seed, i) * 9 + Math.sin(t / 95 + i * 1.7) * 4.5 - Math.abs(i - 2.5) * 2;
      const w = 11;
      const sway = Math.sin(t / 150 + i * 2.3) * 2.2;
      const y0 = by + Math.abs(i - 3) * 1.3;
      flame(ctx, cx + ox, y0, w, h, sway, '#e5452b');
      flame(ctx, cx + ox, y0, w * 0.62, h * 0.72, sway * 0.8, '#ffab2e');
      flame(ctx, cx + ox, y0, w * 0.3, h * 0.42, sway * 0.5, '#fff3a6');
    }
  }

  function flame(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, sway: number, c: string) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y);
    ctx.quadraticCurveTo(x - w * 0.62, y - h * 0.55, x + sway, y - h);
    ctx.quadraticCurveTo(x + w * 0.62, y - h * 0.55, x + w / 2, y);
    ctx.closePath();
    ctx.fill();
  }

  function drawScaffold(ctx: CanvasRenderingContext2D, sky: SkyState, o: Obj) {
    const p = projFor(o);
    const H = o.height / 64;
    // Villas and skyscrapers aren't house-shaped: the house numbers below would put the tarp and
    // planks in mid-air across the building. They get scaffolding round the ground floors instead.
    const special = !!o.resident?.home;
    const Hs = special ? Math.min(H * 0.56, 0.62) : H * 0.56;
    const e = 0.46;
    const wood = material(sky, '#b98a50');
    if (!special) {
      // blue tarp draped over the roof
      const tarp = material(sky, '#2f78c4');
      const zt = H * 0.6;
      // a flat tarp lashed over the roof, with a fold line and a lighter corner
      fillPoly(ctx, p, [-0.26, -0.22, zt, 0.26, -0.22, zt, 0.26, 0.22, zt, -0.26, 0.22, zt], tarp.top);
      fillPoly(ctx, p, [-0.26, -0.22, zt, 0.02, -0.22, zt, -0.1, 0.22, zt, -0.26, 0.22, zt], tarp.l);
      ctx.strokeStyle = alpha('#ffffff', 0.5);
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(projX(p, -0.26, 0), projY(p, -0.26, 0, zt));
      ctx.lineTo(projX(p, 0.26, 0), projY(p, 0.26, 0, zt));
      ctx.stroke();
    }
    // poles at the three outward corners
    ctx.strokeStyle = wood.dark;
    ctx.lineWidth = 1.7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [u, vv] of [[e, e], [-e, e], [e, -e]] as const) {
      ctx.moveTo(projX(p, u, vv), projY(p, u, vv, 0));
      ctx.lineTo(projX(p, u, vv), projY(p, u, vv, Hs));
    }
    ctx.stroke();
    // planks at two levels and a diagonal brace
    ctx.strokeStyle = wood.base;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const z of [Hs * 0.42, Hs]) {
      ctx.moveTo(projX(p, -e, e), projY(p, -e, e, z));
      ctx.lineTo(projX(p, e, e), projY(p, e, e, z));
      ctx.lineTo(projX(p, e, -e), projY(p, e, -e, z));
    }
    ctx.stroke();
    ctx.strokeStyle = wood.dark;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(projX(p, -e, e), projY(p, -e, e, Hs * 0.42));
    ctx.lineTo(projX(p, e, e), projY(p, e, e, Hs));
    ctx.moveTo(projX(p, e, e), projY(p, e, e, Hs * 0.42));
    ctx.lineTo(projX(p, e, -e), projY(p, e, -e, Hs));
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  function drawCrossGlow(ctx: CanvasRenderingContext2D, sky: SkyState, p: Prepared, t: number) {
    const o = p.a.obj;
    if (!o) return;
    const pr = projFor(o);
    const pulse = 0.5 + 0.5 * Math.sin(t / 380);
    const x = projX(pr, 0, 0), y = projY(pr, 0, o.h / 2, 0.42);
    const r = 36 + pulse * 10;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,70,70,${(0.28 + 0.3 * pulse) * (0.7 + 0.3 * sky.glow)})`);
    g.addColorStop(1, 'rgba(255,70,70,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }

  function drawCrashCars(ctx: CanvasRenderingContext2D, sky: SkyState, p: Prepared, t: number, S: number, front: FrontFn) {
    const gx = p.a.gx, gy = p.a.gy;
    const defs: [number, number, number, string][] = [
      [-0.12, -0.08, 0.5 + hash(p.seed, 1) * 0.5, '#6aa0c8'],
      [0.14, 0.1, 2.3 + hash(p.seed, 2) * 0.6, '#d9a54a'],
    ];
    for (const [du, dv, ang, col] of defs) {
      const x = (gx + du - (gy + dv)) * HW, y = (gx + du + gy + dv) * HH;
      drawCar(ctx, sky, x, y, ang, { hl: 0.17, hw: 0.08, h: 0.1, body: col, accent: null, cabin: [-0.08, 0.1, 0.06], bar: false }, t, false);
      // amber hazard blinkers
      if (Math.floor(t / 450) % 2 === 0) {
        ctx.fillStyle = alpha('#ffb020', 0.5 + 0.4 * sky.glow);
        ctx.beginPath();
        ctx.arc(x, y - 9, 1.6, 0, TAU);
        ctx.fill();
      }
    }
    if (S >= 0.5) front(Math.floor(gx), Math.floor(gy), (gx - gy) * HW, (gx + gy) * HH - 8, 30, 24);
  }

  // ── vehicles ──────────────────────────────────────────────────────────────
  interface CarSpec {
    hl: number;
    hw: number;
    h: number;
    body: string;
    accent: string | null;
    /** cabin from, to (local length axis) and extra height */
    cabin: [number, number, number];
    bar: boolean;
    ladder?: boolean;
  }
  const SPECS: Record<VehicleKind, CarSpec> = {
    engine: { hl: 0.27, hw: 0.1, h: 0.2, body: '#c8463d', accent: '#f1e6c8', cabin: [0.04, 0.25, 0.09], bar: true, ladder: true },
    police: { hl: 0.2, hw: 0.085, h: 0.12, body: '#f4f4f2', accent: '#2c4f8f', cabin: [-0.1, 0.08, 0.08], bar: true },
    ambulance: { hl: 0.24, hw: 0.1, h: 0.23, body: '#f6f4f0', accent: '#d63a3a', cabin: [0.1, 0.24, 0.0], bar: true },
  };

  function drawVehicle(ctx: CanvasRenderingContext2D, sky: SkyState, kind: VehicleKind, x: number, y: number, ang: number, t: number, flash: boolean, seed: number) {
    void seed;
    drawCar(ctx, sky, x, y, ang, SPECS[kind], t, flash);
  }

  function shade(mat: Mat, w: number): string {
    return mix(mat.l, mat.r, w);
  }

  /** Prism with a rotated rectangular footprint (centre cu,cv; angle via ca/sa; half sizes hl,hw). */
  function prism(ctx: CanvasRenderingContext2D, p: Proj, cu: number, cv: number, ca: number, sa: number, hl: number, hw: number, z0: number, z1: number, mat: Mat) {
    const cs: number[] = [];
    for (const [lx, ly] of [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]] as const) cs.push(cu + lx * ca - ly * sa, cv + lx * sa + ly * ca);
    const nl = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (let i = 0; i < 4; i++) {
      const nu = nl[i][0] * ca - nl[i][1] * sa, nv = nl[i][0] * sa + nl[i][1] * ca;
      if (nu + nv <= 0.001) continue;
      const j = (i + 1) % 4;
      const w = clamp((nu - nv) * 0.5 + 0.5, 0, 1);
      fillPoly(ctx, p, [cs[i * 2], cs[i * 2 + 1], z0, cs[j * 2], cs[j * 2 + 1], z0, cs[j * 2], cs[j * 2 + 1], z1, cs[i * 2], cs[i * 2 + 1], z1], shade(mat, w));
    }
    fillPoly(ctx, p, [cs[0], cs[1], z1, cs[2], cs[3], z1, cs[4], cs[5], z1, cs[6], cs[7], z1], mat.top);
  }

  function drawCar(ctx: CanvasRenderingContext2D, sky: SkyState, x: number, y: number, ang: number, s: CarSpec, t: number, flash: boolean) {
    const p: Proj = { cx: x, cy: y, s: 64 * 1.3 };
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const body = material(sky, s.body);
    const glass = material(sky, mix('#9db8c8', '#243044', 0.35 + 0.4 * sky.darkness));
    groundEllipse(ctx, p, 0, 0, 0, s.hl * 1.15);
    ctx.fillStyle = alpha(sky.palette.edge, 0.18);
    ctx.fill();
    prism(ctx, p, 0, 0, ca, sa, s.hl, s.hw, 0.03, s.h, body);
    if (s.accent) {
      const ac = material(sky, s.accent);
      prism(ctx, p, 0, 0, ca, sa, s.hl + 0.004, s.hw + 0.004, 0.06, 0.08, ac);
    }
    const [c0, c1, ch] = s.cabin;
    const co = (c0 + c1) / 2;
    const top = s.h;
    if (ch > 0) {
      prism(ctx, p, co * ca, co * sa, ca, sa, (c1 - c0) / 2, s.hw - 0.012, top, top + ch, body);
      // windscreen / side glass as a darker band
      prism(ctx, p, co * ca, co * sa, ca, sa, (c1 - c0) / 2 + 0.003, s.hw - 0.008, top + ch * 0.25, top + ch * 0.8, glass);
    } else {
      // box ambulance: glass cab at the front
      prism(ctx, p, c1 * 0.96 * ca, c1 * 0.96 * sa, ca, sa, 0.03, s.hw - 0.006, 0.09, s.h - 0.03, glass);
    }
    let barZ = top + (ch > 0 ? ch : 0);
    if (s.ladder) {
      const lad = material(sky, '#d8d2c0');
      prism(ctx, p, -0.08 * ca, -0.08 * sa, ca, sa, 0.17, 0.035, top, top + 0.035, lad);
      barZ = top + ch;
    }
    if (s.bar) {
      const bo = s.accent === '#d63a3a' ? -0.02 : co;
      prism(ctx, p, bo * ca, bo * sa, ca, sa, 0.035, s.hw - 0.02, barZ, barZ + 0.025, material(sky, '#7a7a7a'));
      if (flash) {
        const on = Math.floor(t / 280) % 2 === 0;
        const k = 0.5 + 0.5 * sky.glow;
        for (const side of [-1, 1]) {
          const lx = bo * ca - side * (s.hw - 0.04) * sa, ly = bo * sa + side * (s.hw - 0.04) * ca;
          const sx = projX(p, lx, ly), sy = projY(p, lx, ly, barZ + 0.03);
          const c = (side > 0) === on ? '#ff4a4a' : '#4a80ff';
          const lit = (side > 0) === on;
          const r = lit ? 11 : 4;
          const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
          g.addColorStop(0, alpha(c, (lit ? 0.85 : 0.35) * k));
          g.addColorStop(1, alpha(c, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, TAU);
          ctx.fill();
          ctx.fillStyle = c;
          ctx.fillRect(sx - 1, sy - 1, 2, 2);
        }
      }
    }
  }

  // ── marker badges ─────────────────────────────────────────────────────────
  function drawMarker(ctx: CanvasRenderingContext2D, p: Prepared, t: number, k: number) {
    const b = BADGE[p.kind];
    if (!b) return;
    const bob = Math.sin(t / 520 + p.seed) * 1.6 * k;
    const bubble = p.kind === 'lostpet' || p.kind === 'exam';
    let y = p.a.cy - p.a.top - 12;
    if (bubble) {
      // speech bubble sitting just above the roof (world size)
      const by = y - 14 + Math.sin(t / 700 + p.seed) * 2;
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = alpha(COLORS.ink, 0.55);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(p.a.cx - 13, by - 11, 26, 20, 6);
      ctx.moveTo(p.a.cx - 3, by + 9);
      ctx.lineTo(p.a.cx, by + 15);
      ctx.lineTo(p.a.cx + 3, by + 9);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = p.kind === 'lostpet' ? '#1f9d8f' : '#c68a00';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${p.kind === 'lostpet' ? 17 : 12}px ${FONTS.ui}`;
      ctx.fillText(p.kind === 'lostpet' ? '?' : 'A+', p.a.cx, by - 0.5);
      ctx.restore();
      y = by - 18;
    }
    const r = 11 * k;
    const bx = p.a.cx, by = y - r - 6 * k + bob;
    ctx.save();
    // soft shadow + disc + white ring
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(bx, by + r + 3 * k, r * 0.7, r * 0.22, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, TAU);
    ctx.fill();
    ctx.lineWidth = 1.7 * k;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    // pointer
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(bx - 3 * k, by + r - 0.5 * k);
    ctx.lineTo(bx, by + r + 4.5 * k);
    ctx.lineTo(bx + 3 * k, by + r - 0.5 * k);
    ctx.fill();
    ctx.translate(bx, by);
    ctx.scale(r, r);
    icon(ctx, b.icon);
    ctx.restore();
  }

  /** Icon in a unit circle (radius 1), white (dark on the yellow book badge). */
  function icon(ctx: CanvasRenderingContext2D, ic: BadgeIcon) {
    ctx.fillStyle = '#ffffff';
    switch (ic) {
      case 'fire':
        ctx.beginPath();
        ctx.moveTo(0.04, -0.68);
        ctx.bezierCurveTo(0.55, -0.2, 0.56, 0.12, 0.44, 0.3);
        ctx.bezierCurveTo(0.34, 0.6, -0.34, 0.6, -0.44, 0.3);
        ctx.bezierCurveTo(-0.55, 0.05, -0.28, -0.1, -0.2, -0.38);
        ctx.bezierCurveTo(-0.05, -0.28, 0, -0.45, 0.04, -0.68);
        ctx.fill();
        ctx.fillStyle = '#d9382c';
        ctx.beginPath();
        ctx.moveTo(0, -0.02);
        ctx.bezierCurveTo(0.25, 0.18, 0.28, 0.36, 0.18, 0.46);
        ctx.bezierCurveTo(0.08, 0.54, -0.1, 0.54, -0.18, 0.44);
        ctx.bezierCurveTo(-0.27, 0.3, -0.12, 0.2, 0, -0.02);
        ctx.fill();
        break;
      case 'star':
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const r = i % 2 ? 0.28 : 0.68, a = (i / 10) * TAU - Math.PI / 2;
          if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.fill();
        break;
      case 'bang':
        ctx.beginPath();
        ctx.roundRect(-0.12, -0.58, 0.24, 0.72, 0.1);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0.42, 0.14, 0, TAU);
        ctx.fill();
        break;
      case 'cross':
        ctx.fillRect(-0.15, -0.55, 0.3, 1.1);
        ctx.fillRect(-0.55, -0.15, 1.1, 0.3);
        break;
      case 'paw':
        ctx.beginPath();
        ctx.ellipse(0, 0.22, 0.32, 0.26, 0, 0, TAU);
        ctx.fill();
        for (const [x, y, r] of [[-0.4, -0.08, 0.14], [-0.14, -0.36, 0.15], [0.14, -0.36, 0.15], [0.4, -0.08, 0.14]] as const) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, TAU);
          ctx.fill();
        }
        break;
      case 'book':
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#6b4a00';
        ctx.lineWidth = 0.1;
        ctx.beginPath();
        ctx.moveTo(-0.62, -0.32);
        ctx.lineTo(-0.04, -0.2);
        ctx.lineTo(-0.04, 0.5);
        ctx.lineTo(-0.62, 0.38);
        ctx.closePath();
        ctx.moveTo(0.62, -0.32);
        ctx.lineTo(0.04, -0.2);
        ctx.lineTo(0.04, 0.5);
        ctx.lineTo(0.62, 0.38);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      case 'hammer':
        ctx.rotate(0.7);
        ctx.fillRect(-0.07, -0.2, 0.14, 0.8);
        ctx.fillRect(-0.4, -0.52, 0.8, 0.3);
        break;
    }
  }

  return {
    setModel(m) {
      model = m;
      walk = null;
      bfsCache.clear();
      walkers = null;
      prepare();
    },
    setIncidents(list) {
      incidents = list.slice();
      prepare();
    },
    draw,
  };
}
