// Reel mode (?reel=1): turns the live city into a deterministic frame renderer for the
// daily Instagram Reel. scripts/reel/record.mjs drives it from headless Chrome.
//
//   ?reel=1                 turn reel mode on (nothing in this file runs without it)
//   &duration=20            seconds (default 20)
//   &fps=30                 frames per second the recorder will sample (default 30)
//   &w=1080&h=1920          exact canvas size in device px, DPR 1 (default 1080×1920)
//   &hour=21.5              fixed time of day … or &hour=17.4-21.7 for a time-lapse
//                           (default 18.2-21.7: golden hour → night, so the lights come on)
//   &focus=a,b              residents to fly to and ring (default: today's newest, ≤ 3)
//   &day=14                 override the city day used for "new today"
//
// Everything on screen is a function of t (seconds): camera path, sky, water shimmer,
// windmill, lighthouse, stars and highlight pulses. The wall clock is never read while
// rendering, so a slow CI runner produces the same video as a fast laptop.
//
// The page exposes:
//   window.kinsburgReel = { ready, duration, fps, width, height, stats, colors,
//                           renderFrame(t), captureFrame(t, type?, quality?) }
import type { CityData, Resident } from './types';
import type { CityView, ReelCamera, ReelControl, ReelTarget } from './city/api';
import { COLORS, FONTS, alpha, skyAt, type SkyState } from './theme';
import { renderShareCard } from './ui/share';
import { addressOf } from './ui/lookup';
import { drawJadie, JADIE_HEIGHT, type JadiePose } from './reel-jadie';

export interface ReelStats {
  city: string;
  account: string;
  day: number;
  residents: number;
  newToday: number;
  /** today's newest residents, newest first (at most 12) */
  newResidents: { handle: string; job: string; street: string | null; number: number }[];
  /** resident ids the camera visits */
  focus: string[];
  /** focus handles from the URL that aren't residents */
  missingFocus: string[];
  newestStreet: string | null;
  demo: boolean;
  /** time of day at the start and end of the reel (hours) */
  hourFrom: number;
  hourTo: number;
}

export interface KinsburgReel {
  ready: Promise<void>;
  duration: number;
  fps: number;
  width: number;
  height: number;
  stats: ReelStats;
  colors: typeof COLORS;
  renderFrame(t: number): Promise<void>;
  captureFrame(t: number, type?: string, quality?: number): Promise<string>;
  /** a resident card PNG (data URL), optionally with fields overridden (for launch reels) */
  card(id: string, overrides?: Partial<Resident>): Promise<string>;
  /** scripted camera for the launch reels; returns targets it couldn't find */
  setScript(s: { duration: number; keys: { t: number; target: string; zoom?: number; y?: number }[]; hours?: { t: number; h: number }[]; dark?: { id: string; until: number }[]; rings?: { id: string; from: number; to?: number }[]; labels?: ReelLabel[]; actors?: ReelActor[]; ease?: 'cubic' | 'sine' }): string[];
  /** world position of a resident's home (to pick neighbours) */
  where(id: string): { x: number; y: number } | null;
  /** every resident with their address, for choosing who to feature */
  residents: { id: string; handle: string; job: string; number: number; level: number; perks: string[]; address: string | null }[];
}

declare global {
  interface Window {
    kinsburgReel?: KinsburgReel;
  }
}

const num = (v: string | null, def: number, min: number, max: number) => {
  const n = v === null || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
const normalise = (q: string) => q.trim().replace(/^@+/, '').toLowerCase();

function cityDay(data: CityData, now: Date): number {
  const start = new Date(data.foundedISO + 'T00:00:00');
  return Math.max(1, Math.floor((now.getTime() - start.getTime()) / 86_400_000) + 1);
}

/** "21.5" → fixed hour; "17.4-21.7" → time-lapse; anything else → default dusk-to-night. */
function parseHours(v: string | null): [number, number] {
  const m = v?.match(/^\s*(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*$/);
  if (!m) return [18.2, 21.7];
  const a = Math.min(24, Number(m[1]));
  const b = m[2] === undefined ? a : Math.min(24, Number(m[2]));
  return [a, b];
}

function skyForHour(h: number): SkyState {
  const d = new Date(2000, 0, 1, 0, 0, 0, 0);
  d.setMilliseconds(Math.round(((h % 24) + 24) % 24 * 3_600_000));
  return skyAt(d);
}

// ── camera path ──────────────────────────────────────────────────────────────
interface Key {
  t: number;
  cam: ReelCamera;
  /** how this segment (key → next key) moves */
  move: 'hold' | 'glide' | 'hop';
}

/**
 * A character walking the map in a scripted reel (only 'jadie' for now). Keys place him at a target
 * (resident id, 'lot:<id>', 'landmark:<kind>') plus an offset in world units; between two keys at
 * different spots he walks, otherwise he holds the key's pose. `talk` spans open and close his mouth.
 */
export interface ReelActor {
  id: 'jadie';
  keys: { t: number; at: string; dx?: number; dy?: number; pose?: JadiePose; face?: 1 | -1 }[];
  talk?: { from: number; to: number }[];
}

/** A name tag pinned above a home in a scripted reel (fades in and out, stays the same size on screen). */
export interface ReelLabel { id: string; text: string; sub?: string; from: number; to: number; lift?: number }

/**
 * Glide between two cameras keeping the closer shot's centre on a straight screen path
 * (like the live map's flyTo), so zooming in feels like descending onto the target.
 */
function glide(a: ReelCamera, b: ReelCamera, e: number): ReelCamera {
  const z = Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), e));
  if (b.zoom >= a.zoom) {
    const sx = (b.x - a.x) * a.zoom * (1 - e), sy = (b.y - a.y) * a.zoom * (1 - e);
    return { x: b.x - sx / z, y: b.y - sy / z, zoom: z };
  }
  const sx = (a.x - b.x) * b.zoom * e, sy = (a.y - b.y) * b.zoom * e;
  return { x: a.x - sx / z, y: a.y - sy / z, zoom: z };
}

/** Travel between two close shots: pull up enough that both fit, then drop back down. */
function hop(a: ReelCamera, b: ReelCamera, e: number, width: number): ReelCamera {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const zMid = Math.min(Math.min(a.zoom, b.zoom), (width * 0.9) / Math.max(1, dist));
  const zLine = Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), e));
  const bump = Math.max(0, Math.log(Math.sqrt(a.zoom * b.zoom) / zMid));
  return { x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e), zoom: zLine * Math.exp(-bump * Math.sin(Math.PI * e)) };
}

function cameraAt(keys: Key[], t: number, width: number): ReelCamera {
  if (t <= keys[0].t) return keys[0].cam;
  for (let i = 0; i < keys.length - 1; i++) {
    const A = keys[i], B = keys[i + 1];
    if (t > B.t) continue;
    const u = clamp01((t - A.t) / Math.max(1e-6, B.t - A.t));
    switch (A.move) {
      case 'hold': return glide(A.cam, B.cam, u); // slow constant drift
      case 'glide': return glide(A.cam, B.cam, easeInOut(u));
      case 'hop': return hop(A.cam, B.cam, easeInOut(u), width);
    }
  }
  return keys[keys.length - 1].cam;
}

function buildPath(rc: ReelControl, focus: ReelTarget[], D: number, W: number, H: number): Key[] {
  const b = rc.homesBounds();
  // Opening: the whole town fills the frame's width, sitting a little low so the sky shows.
  const zWide = Math.max(0.12, Math.min(0.6, W / ((b.maxX - b.minX) * 0.86)));
  const wide: ReelCamera = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 - (H * 0.04) / zWide, zoom: zWide };
  const wideIn: ReelCamera = { ...wide, zoom: zWide * 1.1 };
  const shot = (p: ReelTarget, zoom: number): ReelCamera => ({ x: p.x, y: p.y - p.height * 0.4, zoom });
  const ZF = 2.0; // a home fills ~13% of the width, its street around it
  const th = rc.landmark('townhall');
  const end: ReelCamera = th ? shot(th, 1.05) : { ...wide, zoom: zWide * 2.2 };
  const endIn: ReelCamera = { ...end, zoom: end.zoom * 1.08 };

  const keys: Key[] = [
    { t: 0, cam: wide, move: 'hold' },
    { t: 0.24 * D, cam: wideIn, move: 'glide' },
  ];
  if (focus.length) {
    const blockStart = 0.38 * D, blockEnd = 0.7 * D;
    const part = (blockEnd - blockStart) / focus.length;
    focus.forEach((p, i) => {
      const c = shot(p, ZF);
      const t0 = blockStart + i * part;
      if (i > 0) keys.push({ t: t0 + part * 0.45, cam: c, move: 'hold' });
      else keys.push({ t: t0, cam: c, move: 'hold' });
      keys.push({ t: blockStart + (i + 1) * part, cam: { ...c, zoom: ZF * 1.05 }, move: 'hop' });
    });
  } else {
    // nobody new today: settle over the middle of town instead
    const mid: ReelCamera = { ...wide, zoom: zWide * 2.4 };
    keys.push({ t: 0.38 * D, cam: mid, move: 'hold' }, { t: 0.7 * D, cam: { ...mid, zoom: mid.zoom * 1.1 }, move: 'hop' });
  }
  // (each key's `move` describes how the camera travels from it to the next key)
  keys.push({ t: 0.84 * D, cam: end, move: 'hold' }, { t: D, cam: endIn, move: 'hold' });
  return keys;
}

// ── single scripted shots (?shot=push|hold|pull|wide|timelapse) ─────────────────
function shotPath(rc: ReelControl, kind: string, target: ReelTarget | null, zClose: number, D: number, W: number, H: number): Key[] {
  const b = rc.homesBounds();
  const zWide = Math.max(0.12, Math.min(0.6, W / ((b.maxX - b.minX) * 0.86)));
  const wide: ReelCamera = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 - (H * 0.04) / zWide, zoom: zWide };
  const at = (z: number): ReelCamera => (target ? { x: target.x, y: target.y - target.height * 0.4, zoom: z } : { ...wide, zoom: z });
  switch (kind) {
    case 'push': // from the neighbourhood down onto the target
      return [{ t: 0, cam: at(zClose * 0.32), move: 'glide' }, { t: D, cam: at(zClose), move: 'hold' }];
    case 'pull': // from the target back along its streets
      return [{ t: 0, cam: at(zClose), move: 'glide' }, { t: D, cam: at(zClose * 0.4), move: 'hold' }];
    case 'hold': // nearly still, a slow drift in
      return [{ t: 0, cam: at(zClose), move: 'hold' }, { t: D, cam: at(zClose * 1.07), move: 'hold' }];
    default: // 'wide' / 'timelapse': the whole town
      return [{ t: 0, cam: wide, move: 'hold' }, { t: D, cam: { ...wide, zoom: zWide * 1.12 }, move: 'hold' }];
  }
}

// ── name tags (scripted reels) ──
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Size of a tag's plate and where its roof is on screen, for layout and drawing. */
function labelBox(ctx: CanvasRenderingContext2D, l: ReelLabel, p: ReelTarget, cam: ReelCamera, W: number, H: number) {
  const u = W / 1080;
  ctx.font = `800 ${36 * u}px ${FONTS.ui}`;
  const tw = ctx.measureText(l.text).width;
  ctx.font = `700 ${23 * u}px ${FONTS.ui}`;
  const sw = l.sub ? ctx.measureText(l.sub).width : 0;
  const w = Math.max(tw, sw) + 52 * u, h = (l.sub ? 92 : 64) * u;
  const rx = W / 2 + (p.x - cam.x) * cam.zoom;
  const roof = H / 2 + (p.y - p.height * 0.95 - cam.y) * cam.zoom;
  return { u, w, h, rx, roof };
}

/**
 * Lift tags so none overlap, measured once at the camera where they're read (so nothing jumps
 * while the camera moves). Left to right; each rises in small steps until it clears the others.
 */
function layoutLabels(canvas: HTMLCanvasElement, cam: ReelCamera, labels: ReelLabel[], find: (id: string) => ReelTarget | null, W: number, H: number): number[] {
  const ctx = canvas.getContext('2d')!;
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const lifts = labels.map(() => 0);
  const order = labels.map((l, i) => ({ i, p: find(l.id) })).filter((o) => o.p).sort((a, b) => a.p!.x - b.p!.x);
  for (const { i, p } of order) {
    const l = labels[i];
    const b = labelBox(ctx, l, p!, cam, W, H);
    const gap = 14 * b.u;
    let lift = (l.lift ?? 0) * b.u;
    for (let k = 0; k < 60; k++) {
      const y1 = b.roof - 70 * b.u - lift, y0 = y1 - b.h, x0 = b.rx - b.w / 2, x1 = b.rx + b.w / 2;
      if (!placed.some((r) => x0 < r.x1 + gap && x1 > r.x0 - gap && y0 < r.y1 + gap && y1 > r.y0 - gap)) {
        placed.push({ x0, y0, x1, y1 });
        break;
      }
      lift += 8 * b.u;
    }
    lifts[i] = lift / b.u;
  }
  return lifts;
}

/** Tags above homes: a plate with the handle (and a small gold line), on a thin stem down to the roof. */
function drawLabels(canvas: HTMLCanvasElement, cam: ReelCamera, labels: ReelLabel[], lifts: number[], t: number, find: (id: string) => ReelTarget | null, W: number, H: number) {
  const ctx = canvas.getContext('2d')!;
  const u = W / 1080;
  const FADE = 0.4;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const [li, l] of labels.entries()) {
    const a = Math.min(1, Math.max(0, (t - l.from) / FADE), Math.max(0, (l.to - t) / FADE));
    if (a <= 0) continue;
    const p = find(l.id);
    if (!p) continue;
    const e = a * a * (3 - 2 * a); // smoothstep for the fade and the rise
    const rx = W / 2 + (p.x - cam.x) * cam.zoom;
    const roof = H / 2 + (p.y - p.height * 0.95 - cam.y) * cam.zoom;
    const stem = (70 + (lifts[li] ?? 0)) * u;
    const bottom = roof - stem + (1 - e) * 14 * u;
    ctx.globalAlpha = e;
    ctx.font = `800 ${36 * u}px ${FONTS.ui}`;
    const tw = ctx.measureText(l.text).width;
    ctx.font = `700 ${23 * u}px ${FONTS.ui}`;
    const sw = l.sub ? ctx.measureText(l.sub).width : 0;
    const padX = 26 * u, h = (l.sub ? 92 : 64) * u;
    const w = Math.max(tw, sw) + padX * 2;
    const x = Math.min(Math.max(rx - w / 2, 24 * u), W - 24 * u - w);
    const y = bottom - h;
    // stem and roof dot
    ctx.strokeStyle = alpha(COLORS.paper, 0.75);
    ctx.lineWidth = 2.5 * u;
    ctx.beginPath(); ctx.moveTo(rx, bottom); ctx.lineTo(rx, roof - 6 * u); ctx.stroke();
    ctx.fillStyle = COLORS.gold;
    ctx.beginPath(); ctx.arc(rx, roof - 6 * u, 5.5 * u, 0, Math.PI * 2); ctx.fill();
    // plate (flat, neutral shadow)
    ctx.fillStyle = 'rgba(11,20,48,0.35)';
    roundRect(ctx, x, y + 6 * u, w, h, 20 * u); ctx.fill();
    ctx.fillStyle = alpha(COLORS.nightPaper, 0.94);
    roundRect(ctx, x, y, w, h, 20 * u); ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.paper;
    ctx.font = `800 ${36 * u}px ${FONTS.ui}`;
    ctx.fillText(l.text, x + w / 2, y + (l.sub ? 44 : 44) * u);
    if (l.sub) {
      ctx.fillStyle = COLORS.gold;
      ctx.font = `700 ${23 * u}px ${FONTS.ui}`;
      ctx.fillText(l.sub, x + w / 2, y + 76 * u);
    }
  }
  ctx.restore();
}

// ── poster (?reel=1&poster=1): the whole town on one print, the buyer's house circled ──
function posterPath(rc: ReelControl, W: number, H: number): Key[] {
  const b = rc.homesBounds();
  const zoom = Math.min(W / ((b.maxX - b.minX) * 1.06), (H * 0.76) / ((b.maxY - b.minY) * 1.06));
  // the town sits in the upper ~80%; the bottom is for the title
  const cam: ReelCamera = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 + (H * 0.09) / zoom, zoom };
  return [{ t: 0, cam, move: 'hold' }];
}

function drawPosterMarks(canvas: HTMLCanvasElement, cam: ReelCamera, targets: ReelTarget[], data: CityData, people: Resident[], W: number, H: number) {
  const ctx = canvas.getContext('2d')!;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const u = W / 1000; // poster unit
  // circle each house
  targets.forEach((p, i) => {
    const x = W / 2 + (p.x - cam.x) * cam.zoom;
    const y = H / 2 + (p.y - p.height * 0.4 - cam.y) * cam.zoom;
    const r = Math.max(14 * u, p.height * cam.zoom * 1.6);
    ctx.lineWidth = 3.2 * u;
    ctx.strokeStyle = COLORS.gold;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    const who = people[i];
    if (who) {
      ctx.font = `700 ${15 * u}px ${FONTS.ui}`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 5 * u;
      ctx.strokeStyle = alpha(COLORS.ink, 0.85);
      ctx.strokeText('@' + who.handle, x, y - r - 8 * u);
      ctx.fillStyle = COLORS.paper;
      ctx.fillText('@' + who.handle, x, y - r - 8 * u);
    }
  });
  // title block
  const top = H * 0.86;
  ctx.fillStyle = alpha(COLORS.nightPaper, 0.82);
  ctx.fillRect(0, top - 20 * u, W, H - top + 20 * u);
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.nightInk;
  ctx.font = `${62 * u}px ${FONTS.display}`;
  ctx.fillText(data.name, W / 2, top + 48 * u);
  const who = people[0];
  ctx.font = `600 ${20 * u}px ${FONTS.ui}`;
  ctx.fillStyle = COLORS.nightInkSoft;
  const line = who ? `Home of @${who.handle}, resident #${who.number.toLocaleString('en-US')}` : `${data.residents.length.toLocaleString('en-US')} residents`;
  ctx.fillText(line, W / 2, top + 84 * u);
  ctx.font = `500 ${14 * u}px ${FONTS.ui}`;
  ctx.fillText(`kinsburg.com     @${data.account}`, W / 2, top + 112 * u);
  ctx.restore();
}

// ── entry point (called from main.ts only when ?reel is present) ────────────
export function startReel(city: CityView, data: CityData, params: URLSearchParams): void {
  // posters are print size (e.g. 3600×4800 = 12×16 in at 300 dpi)
  const W = Math.round(num(params.get('w'), 1080, 16, 8192));
  const H = Math.round(num(params.get('h'), 1920, 16, 8192));
  const poster = params.has('poster');
  const D = num(params.get('duration'), 20, 3, 900);
  const fps = Math.round(num(params.get('fps'), 30, 1, 60));
  const [hourFrom, hourTo] = parseHours(params.get('hour'));

  // hide every bit of HTML UI; the canvas is the whole picture
  const ui = document.getElementById('ui');
  if (ui) ui.style.display = 'none';
  document.documentElement.dataset.reel = '1';
  document.body.style.overflow = 'hidden';

  const rc = city.enterReel(W, H);

  // ── stats for the overlay + caption ──
  const latest = data.residents.reduce((m, r) => Math.max(m, r.joinedDay), 1);
  let day = Math.round(num(params.get('day'), cityDay(data, new Date()), 1, 1e6));
  // demo data is generated ahead of the calendar: treat its latest day as "today"
  if (data.demo && !params.has('day') && !data.residents.some((r) => r.joinedDay === day)) day = latest;
  const streets = new Map(data.streets.map((s) => [s.id, s.name]));
  const plots = new Map(data.plots.map((p) => [p.id, p]));
  const streetOf = (r: Resident) => streets.get(plots.get(r.plotId)?.streetId ?? -1) ?? null;
  const today = data.residents.filter((r) => r.joinedDay === day).sort((a, b) => b.number - a.number);
  const byId = new Map(data.residents.map((r) => [r.id, r]));
  const asked = (params.get('focus') ?? '').split(',').map(normalise).filter(Boolean);
  const focusIds = asked.length ? asked.filter((id) => byId.has(id) && rc.resident(id)) : today.slice(0, 3).map((r) => r.id);
  const newest = data.residents.reduce<Resident | null>((m, r) => (!m || r.number > m.number ? r : m), null);

  const stats: ReelStats = {
    city: data.name,
    account: data.account,
    day,
    residents: data.residents.length,
    newToday: today.length,
    newResidents: today.slice(0, 12).map((r) => ({ handle: r.handle, job: r.job, street: streetOf(r), number: r.number })),
    focus: focusIds.slice(0, 6),
    missingFocus: asked.filter((id) => !byId.has(id)),
    newestStreet: newest ? streetOf(newest) : null,
    demo: data.demo,
    hourFrom,
    hourTo,
  };

  const focusTargets = stats.focus.map((id) => rc.resident(id)).filter((p): p is ReelTarget => !!p);
  // ?shot=… : one scripted shot for the launch reels (scripts/reel/launch.mjs)
  const shotKind = params.get('shot');
  const shotTargetId = normalise(params.get('target') ?? '');
  const shotTarget = !shotKind ? null
    : shotTargetId.startsWith('landmark:') ? rc.landmark(shotTargetId.slice(9))
    : params.has('lot') ? rc.emptyLotNear(shotTargetId)
    : rc.resident(shotTargetId);
  const darkIds = (params.get('dark') ?? '').split(',').map(normalise).filter(Boolean);
  const lightAt = num(params.get('lightAt'), Infinity, 0, 1e9);
  const ringOn = params.get('ring') === '1';
  const keys = poster ? posterPath(rc, W, H) : shotKind ? shotPath(rc, shotKind, shotTarget, num(params.get('zoom'), 2, 0.1, 6), D, W, H) : buildPath(rc, focusTargets, D, W, H);

  // Time of day: most of the change happens while the camera is wide, so the viewer
  // watches the whole town switch its lights on; then it settles into night.
  const span = hourTo - hourFrom;
  const hourAt = (t: number) => {
    const u = clamp01(t / D);
    const shape = u < 0.38 ? lerp(0, 0.55, easeInOut(u / 0.38)) : u < 0.75 ? lerp(0.55, 0.96, (u - 0.38) / 0.37) : lerp(0.96, 1, (u - 0.75) / 0.25);
    return hourFrom + span * shape;
  };

  const canvas = document.getElementById('city') as HTMLCanvasElement;
  // ── scripted camera (launch reels): set with window.kinsburgReel.setScript() ──
  let script: { duration: number; cams: { t: number; cam: ReelCamera }[]; hours: { t: number; h: number }[]; dark: { id: string; until: number }[]; rings: { id: string; from: number; to: number }[]; labels: ReelLabel[]; lifts?: number[]; actors: { id: string; keys: { t: number; x: number; y: number; pose: JadiePose; face?: 1 | -1 }[]; talk: { from: number; to: number }[] }[]; ease: 'cubic' | 'sine' } | null = null;
  const resolveTarget = (spec: string): ReelTarget | null => {
    const id = normalise(spec);
    if (id === 'wide') return null;
    if (id === 'next') return rc.nextLot();
    if (id.startsWith('landmark:')) return rc.landmark(id.slice(9));
    if (id.startsWith('lot:')) return rc.emptyLotNear(id.slice(4));
    return rc.resident(id);
  };
  const wideCam = (): ReelCamera => {
    const b = rc.homesBounds();
    const z = Math.max(0.12, Math.min(0.6, W / ((b.maxX - b.minX) * 0.86)));
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 - (H * 0.02) / z, zoom: z };
  };
  /** Where an actor is at time t, the pose to draw and which way he faces. */
  const actorAt = (a: { keys: { t: number; x: number; y: number; pose: JadiePose; face?: 1 | -1 }[] }, t: number) => {
    const ks = a.keys;
    if (t <= ks[0].t) return { x: ks[0].x, y: ks[0].y, pose: ks[0].pose, face: ks[0].face ?? 1 };
    for (let i = 0; i < ks.length - 1; i++) {
      const A = ks[i], B = ks[i + 1];
      if (t > B.t) continue;
      const moving = Math.hypot(B.x - A.x, B.y - A.y) > 0.5;
      if (!moving) return { x: A.x, y: A.y, pose: A.pose, face: A.face ?? 1 };
      const u = clamp01((t - A.t) / Math.max(1e-6, B.t - A.t));
      const e = u * u * (3 - 2 * u);
      return { x: lerp(A.x, B.x, e), y: lerp(A.y, B.y, e), pose: 'walk' as JadiePose, face: (B.face ?? (B.x >= A.x ? 1 : -1)) as 1 | -1 };
    }
    const L = ks[ks.length - 1];
    return { x: L.x, y: L.y, pose: L.pose, face: L.face ?? 1 };
  };
  /** Camera between script keys: cubic ease in-out, keeping the closer shot's centre on a straight screen path. */
  const scriptCamera = (t: number): ReelCamera => {
    const ks = script!.cams;
    if (t <= ks[0].t) return ks[0].cam;
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i], b = ks[i + 1];
      if (t > b.t) continue;
      const u = clamp01((t - a.t) / Math.max(1e-6, b.t - a.t));
      // sine eases gently (peak speed ~1.6x the average) for long, calm moves; cubic is snappier (~3x)
      const e = script!.ease === 'sine' ? easeInOut(u) : u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      return glide(a.cam, b.cam, e);
    }
    return ks[ks.length - 1].cam;
  };
  const scriptHour = (t: number): number => {
    const hs = script!.hours;
    if (!hs.length) return hourTo;
    if (t <= hs[0].t) return hs[0].h;
    for (let i = 0; i < hs.length - 1; i++) {
      const a = hs[i], b = hs[i + 1];
      if (t <= b.t) return lerp(a.h, b.h, easeInOut(clamp01((t - a.t) / Math.max(1e-6, b.t - a.t))));
    }
    return hs[hs.length - 1].h;
  };

  const renderFrame = (t: number): Promise<void> => {
    if (script) {
      const tt = Math.max(0, Math.min(script.duration, Number(t) || 0));
      const camera = scriptCamera(tt);
      rc.render({
        t: tt,
        sky: skyForHour(scriptHour(tt)),
        camera,
        highlights: script.rings.filter((r) => tt >= r.from && tt <= r.to).map((r) => r.id),
        dark: script.dark.filter((d) => tt < d.until).map((d) => d.id),
      });
      for (const a of script.actors) {
        const p = actorAt(a, tt);
        const ctx = canvas.getContext('2d')!;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const talk = a.talk.some((r) => tt >= r.from && tt <= r.to);
        drawJadie(ctx, W / 2 + (p.x - camera.x) * camera.zoom, H / 2 + (p.y - camera.y) * camera.zoom, camera.zoom, p.pose, tt, p.face, talk);
        ctx.restore();
      }
      if (script.labels.length) {
        const find = (id: string) => rc.resident(id);
        if (!script.lifts) {
          // lay the tags out where they're read: the middle of the time they're all up
          const tRef = (Math.max(...script.labels.map((l) => l.from)) + Math.min(...script.labels.map((l) => l.to))) / 2;
          script.lifts = layoutLabels(canvas, scriptCamera(tRef), script.labels, find, W, H);
        }
        drawLabels(canvas, camera, script.labels, script.lifts, tt, find, W, H);
      }
      return Promise.resolve();
    }
    const tt = Math.max(0, Math.min(D, Number(t) || 0));
    const camera = cameraAt(keys, tt, W);
    const lit = tt >= lightAt;
    rc.render({
      t: tt,
      sky: skyForHour(shotKind ? hourFrom + (hourTo - hourFrom) * (tt / D) : hourAt(tt)),
      camera,
      highlights: shotKind ? (ringOn && lit ? [shotTargetId] : []) : stats.focus,
      dark: lit ? [] : darkIds,
    });
    if (poster) drawPosterMarks(canvas, camera, focusTargets, data, stats.focus.map((id) => byId.get(id)!).filter(Boolean), W, H);
    return Promise.resolve();
  };

  const ready = (async () => {
    await renderFrame(0); // builds the opening chunks
  })();

  window.kinsburgReel = {
    ready,
    duration: D,
    fps,
    width: W,
    height: H,
    stats,
    colors: COLORS,
    renderFrame,
    setScript(s) {
      const missingActors: string[] = [];
      const actors = (s.actors ?? []).map((a) => ({
        id: a.id,
        talk: a.talk ?? [],
        keys: a.keys.map((k) => {
          const tg = resolveTarget(k.at);
          if (!tg) missingActors.push(k.at);
          return { t: k.t, x: (tg?.x ?? 0) + (k.dx ?? 0), y: (tg?.y ?? 0) + (k.dy ?? 0), pose: k.pose ?? 'idle', face: k.face };
        }),
      }));
      // each key: { t, target: resident id | 'landmark:kind' | 'lot:id' | 'actor:jadie' | 'wide', zoom?, y? (where the subject sits, 0..1 of the height) }
      const cams = s.keys.map((k) => {
        if (k.target.startsWith('actor:')) {
          const a = actors.find((x) => x.id === k.target.slice(6));
          if (a) {
            const p = actorAt(a, k.t);
            const z = k.zoom ?? 4;
            const sy = k.y ?? 0.6;
            return { t: k.t, cam: { x: p.x, y: p.y - JADIE_HEIGHT * 0.5 - (sy - 0.5) * (H / z), zoom: z } };
          }
        }
        const tg = resolveTarget(k.target);
        if (!tg) return { t: k.t, cam: k.zoom ? { ...wideCam(), zoom: k.zoom } : wideCam() };
        const z = k.zoom ?? 2;
        const sy = k.y ?? 0.56; // subject a little below centre: captions live in the upper third
        return { t: k.t, cam: { x: tg.x, y: tg.y - tg.height * 0.35 - (sy - 0.5) * (H / z), zoom: z } };
      });
      script = {
        duration: s.duration,
        cams,
        hours: s.hours ?? [],
        dark: (s.dark ?? []).map((d) => ({ id: normalise(d.id), until: d.until })),
        rings: (s.rings ?? []).map((r) => ({ id: normalise(r.id), from: r.from, to: r.to ?? 1e9 })),
        labels: (s.labels ?? []).map((l) => ({ ...l, id: normalise(l.id) })),
        actors,
        ease: s.ease ?? 'cubic',
      };
      const missing = s.keys.filter((k) => k.target !== 'wide' && !k.target.startsWith('actor:') && !resolveTarget(k.target)).map((k) => k.target);
      return [...missing, ...missingActors];
    },
    where(id) {
      const t = rc.resident(normalise(id));
      return t ? { x: t.x, y: t.y } : null;
    },
    residents: data.residents.map((r) => ({ id: r.id, handle: r.handle, job: r.job, number: r.number, level: r.level ?? 0, perks: r.perks, address: addressOf(r, data) })),
    async card(id, overrides = {}) {
      const r = byId.get(normalise(id));
      if (!r) throw new Error(`no resident ${id}`);
      const blob = await renderShareCard({ ...r, ...overrides }, data, skyForHour(hourTo));
      return await new Promise<string>((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.readAsDataURL(blob);
      });
    },
    async captureFrame(t, type = 'image/jpeg', quality = 0.92) {
      await renderFrame(t);
      return canvas.toDataURL(type, quality);
    },
  };
  // handy when poking at it by hand
  console.info('[kinsburg] reel mode', { duration: D, fps, W, H, stats });
}
