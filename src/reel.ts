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
  const keys = poster ? posterPath(rc, W, H) : buildPath(rc, focusTargets, D, W, H);

  // Time of day: most of the change happens while the camera is wide, so the viewer
  // watches the whole town switch its lights on; then it settles into night.
  const span = hourTo - hourFrom;
  const hourAt = (t: number) => {
    const u = clamp01(t / D);
    const shape = u < 0.38 ? lerp(0, 0.55, easeInOut(u / 0.38)) : u < 0.75 ? lerp(0.55, 0.96, (u - 0.38) / 0.37) : lerp(0.96, 1, (u - 0.75) / 0.25);
    return hourFrom + span * shape;
  };

  const canvas = document.getElementById('city') as HTMLCanvasElement;
  const renderFrame = (t: number): Promise<void> => {
    const tt = Math.max(0, Math.min(D, Number(t) || 0));
    const camera = cameraAt(keys, tt, W);
    rc.render({ t: tt, sky: skyForHour(hourAt(tt)), camera, highlights: stats.focus });
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
    async captureFrame(t, type = 'image/jpeg', quality = 0.92) {
      await renderFrame(t);
      return canvas.toDataURL(type, quality);
    },
  };
  // handy when poking at it by hand
  console.info('[kinsburg] reel mode', { duration: D, fps, W, H, stats });
}
