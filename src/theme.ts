// Kinsburg theme: the single place for shared values.
// Colours come in key frames across a day; skyAt() blends them for any clock time.
// The city renderer, the UI and the share card all read colours from here — never
// write a hex literal elsewhere.

export type Phase = 'night' | 'dawn' | 'day' | 'golden' | 'dusk';

/** Colours for one moment of the day. */
export interface Palette {
  skyTop: string;
  skyBottom: string;
  grass: string;
  grassShade: string;
  road: string;
  roadLine: string;
  water: string;
  waterShine: string;
  park: string;
  farm: string;
  sand: string;
  tree: string;
  treeShade: string;
  /** walls of buildings, lit side */
  wall: string;
  /** walls of buildings, shaded side */
  wallShade: string;
  /** tile edge / outline */
  edge: string;
}

export interface SkyState {
  phase: Phase;
  /** 0 = full daylight, 1 = deepest night */
  darkness: number;
  /** 0..1 how strongly windows and streetlights glow */
  glow: number;
  /** -1..1 horizontal direction the light comes from (for shadows) */
  sunX: number;
  palette: Palette;
  /** which UI surface set to use */
  ui: 'light' | 'dark';
}

// ── Key frames ──────────────────────────────────────────────────────────────
const NIGHT: Palette = {
  skyTop: '#0b1430', skyBottom: '#28346a',
  grass: '#2c4a3a', grassShade: '#223b2f',
  road: '#3b4160', roadLine: '#6c7397',
  water: '#16305a', waterShine: '#3a5f99',
  park: '#2f5440', farm: '#4a4a3c', sand: '#5b5872',
  tree: '#1f3b31', treeShade: '#162b24',
  wall: '#7d84a8', wallShade: '#5a6088',
  edge: '#1a2240',
};
const DAWN: Palette = {
  skyTop: '#7e8fd1', skyBottom: '#f7b9a8',
  grass: '#7aa86a', grassShade: '#668f59',
  road: '#a7a3b4', roadLine: '#e8e2ef',
  water: '#6b9bd0', waterShine: '#c9dcf3',
  park: '#86b574', farm: '#c9b27c', sand: '#e7ccb5',
  tree: '#4f7c55', treeShade: '#3f6747',
  wall: '#efe4ea', wallShade: '#c7bccd',
  edge: '#5d6a72',
};
const DAY: Palette = {
  skyTop: '#5fa8e6', skyBottom: '#cfe9f7',
  grass: '#86c062', grassShade: '#71a952',
  road: '#b7b9bf', roadLine: '#f3f4f6',
  water: '#3e9bd6', waterShine: '#a9dcf5',
  park: '#93cd6a', farm: '#d8c271', sand: '#efdcae',
  tree: '#4c8f47', treeShade: '#3c7639',
  wall: '#f6f3ee', wallShade: '#d5d2cf',
  edge: '#5a6b5c',
};
const GOLDEN: Palette = {
  skyTop: '#f08a5d', skyBottom: '#ffd88a',
  grass: '#a3b45a', grassShade: '#899a4a',
  road: '#b9a493', roadLine: '#f6e2c6',
  water: '#4f8fc4', waterShine: '#ffd2a0',
  park: '#acc05d', farm: '#e2b862', sand: '#f2cf9b',
  tree: '#5f7f3c', treeShade: '#4b6830',
  wall: '#fbe6cc', wallShade: '#d9b897',
  edge: '#6a5a48',
};
const DUSK: Palette = {
  skyTop: '#3a3f86', skyBottom: '#d77a8f',
  grass: '#557a55', grassShade: '#466747',
  road: '#6d6d8a', roadLine: '#b5aec7',
  water: '#2f4f86', waterShine: '#9a86b8',
  park: '#5e8a58', farm: '#8a7a5a', sand: '#9d8a99',
  tree: '#35573f', treeShade: '#294533',
  wall: '#b9b2cc', wallShade: '#8c86a6',
  edge: '#2d3354',
};

/** Hour (0..24) → key frame. Wraps around midnight. */
const FRAMES: { h: number; p: Palette; phase: Phase; darkness: number; glow: number }[] = [
  { h: 0, p: NIGHT, phase: 'night', darkness: 1, glow: 1 },
  { h: 4.5, p: NIGHT, phase: 'night', darkness: 1, glow: 1 },
  { h: 6, p: DAWN, phase: 'dawn', darkness: 0.35, glow: 0.4 },
  { h: 8, p: DAY, phase: 'day', darkness: 0, glow: 0 },
  { h: 16.5, p: DAY, phase: 'day', darkness: 0, glow: 0 },
  { h: 18.5, p: GOLDEN, phase: 'golden', darkness: 0.1, glow: 0.15 },
  { h: 20, p: DUSK, phase: 'dusk', darkness: 0.6, glow: 0.75 },
  { h: 21.5, p: NIGHT, phase: 'night', darkness: 1, glow: 1 },
  { h: 24, p: NIGHT, phase: 'night', darkness: 1, glow: 1 },
];

// ── Colour helpers ──────────────────────────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}
/** Same colour with alpha, as rgba(). */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function mixPalette(a: Palette, b: Palette, t: number): Palette {
  const out = {} as Palette;
  for (const k of Object.keys(a) as (keyof Palette)[]) out[k] = mix(a[k], b[k], t);
  return out;
}
const smooth = (t: number) => t * t * (3 - 2 * t);

/** The sky for a given time. Pass ?hour=21.5 in the URL to preview a time. */
export function skyAt(date: Date): SkyState {
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  let i = 0;
  while (i < FRAMES.length - 2 && FRAMES[i + 1].h <= hour) i++;
  const a = FRAMES[i];
  const b = FRAMES[i + 1];
  const t = smooth(b.h === a.h ? 0 : Math.min(1, Math.max(0, (hour - a.h) / (b.h - a.h))));
  const darkness = a.darkness + (b.darkness - a.darkness) * t;
  const glow = a.glow + (b.glow - a.glow) * t;
  // Sun travels east → west from 6:00 to 20:00.
  const sunX = Math.max(-1, Math.min(1, ((hour - 13) / 7)));
  return {
    phase: t < 0.5 ? a.phase : b.phase,
    darkness,
    glow,
    sunX,
    palette: mixPalette(a.p, b.p, t),
    ui: darkness > 0.45 ? 'dark' : 'light',
  };
}

// ── Fixed colours (do not change with time) ─────────────────────────────────
/** Roof colours, indexed by Resident.houseStyle % ROOFS.length */
export const ROOFS = ['#4f6d8f', '#d9a52b', '#c75b7a', '#2f8f87', '#7a5aa8', '#5b7f3a'] as const;
/** Wall tints, indexed by Math.floor(houseStyle / ROOFS.length) % WALLS.length */
export const WALLS = ['#f6f3ee', '#f3e3c8'] as const;

export const COLORS = {
  /** warm light from windows and streetlamps at night */
  glow: '#ffc95c',
  /** supporter gold */
  gold: '#e8b422',
  /** brand accent for primary buttons */
  accent: '#1f6f8b',
  accentInk: '#ffffff',
  ink: '#18233a',
  inkSoft: '#4a5672',
  paper: '#ffffff',
  nightInk: '#eef1fb',
  nightInkSoft: '#b4bcd8',
  nightPaper: '#151d3b',
  danger: '#b3261e',
} as const;

export const FONTS = {
  /** wordmark only */
  display: "'Bagel Fat One', system-ui, sans-serif",
  /** everything else */
  ui: "'Figtree', system-ui, -apple-system, 'Segoe UI', sans-serif",
} as const;

/** Spacing base is 4px. */
export const SPACE = (n: number) => `${n * 4}px`;

/** Isometric tile size in world pixels (2:1 diamond). */
export const TILE_W = 64;
export const TILE_H = 32;
