// Kinsburg entry point: loads the city, wires the map to the UI, keeps the clock.
import type { CityData, Resident } from './types';
import { skyAt, COLORS, type SkyState } from './theme';
import { createCityView } from './city';
import { createUI } from './ui';
import { loadCity } from './data/load';

const canvas = document.getElementById('city') as HTMLCanvasElement;
const ui = createUI(document.getElementById('ui') as HTMLElement);
const city = createCityView(canvas);

const params = new URLSearchParams(location.search);
/** ?hour=21.5 previews a time of day (for testing and for recording reels). */
const hourOverride = params.get('hour');

function now(): Date {
  const d = new Date();
  if (hourOverride !== null && !Number.isNaN(Number(hourOverride))) {
    const h = Number(hourOverride);
    d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
  }
  return d;
}

/** Expose the sky to CSS so plain stylesheets can follow the time of day. */
function applySkyVars(sky: SkyState) {
  const s = document.documentElement.style;
  const dark = sky.ui === 'dark';
  s.setProperty('--sky-top', sky.palette.skyTop);
  s.setProperty('--sky-bottom', sky.palette.skyBottom);
  s.setProperty('--ink', dark ? COLORS.nightInk : COLORS.ink);
  s.setProperty('--ink-soft', dark ? COLORS.nightInkSoft : COLORS.inkSoft);
  s.setProperty('--paper', dark ? COLORS.nightPaper : COLORS.paper);
  s.setProperty('--accent', COLORS.accent);
  s.setProperty('--accent-ink', COLORS.accentInk);
  s.setProperty('--gold', COLORS.gold);
  s.setProperty('--glow', COLORS.glow);
  s.setProperty('--danger', COLORS.danger);
  s.setProperty('--focus', dark ? COLORS.glow : COLORS.accent);
  document.documentElement.dataset.ui = sky.ui;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', sky.palette.skyTop);
}

function tick() {
  const d = now();
  const sky = skyAt(d);
  applySkyVars(sky);
  city.setSky(sky);
  ui.setSky(sky, d);
}

function cityDay(data: CityData): number {
  const start = new Date(data.foundedISO + 'T00:00:00');
  return Math.max(1, Math.floor((Date.now() - start.getTime()) / 86_400_000) + 1);
}

const normalise = (q: string) => q.trim().replace(/^@+/, '').toLowerCase();

/** Live city from the Worker API (falls back to the static demo city; ?demo=1 forces it). */
const load = (): Promise<CityData> => loadCity({ onProgress: (p) => ui.setLoading(p) });

async function start() {
  tick();
  let data: CityData;
  try {
    data = await load();
  } catch (err) {
    console.error('Kinsburg failed to load', err);
    ui.showError(() => location.reload());
    return;
  }

  const byId = new Map<string, Resident>(data.residents.map((r) => [r.id, r]));
  city.setData(data);
  // ── Reel mode hook (?reel=1): owned by src/reel.ts / scripts/reel/. Hides the UI and hands
  // the canvas to a deterministic frame renderer for the daily Reel. Never loaded otherwise.
  if (params.has('reel')) return void import('./reel').then((m) => m.startReel(city, data, params));
  ui.setStats({ day: cityDay(data), residents: data.residents.length, demo: data.demo });
  tick();
  ui.ready();

  const open = (r: Resident) => {
    city.focusResident(r.id);
    ui.openResident(r, data);
    const url = new URL(location.href);
    url.searchParams.set('r', r.id);
    history.replaceState(null, '', url);
  };

  city.onSelect((r) => (r ? open(r) : ui.closeCard()));
  ui.onCardClosed(() => {
    city.clearHighlight();
    const url = new URL(location.href);
    url.searchParams.delete('r');
    history.replaceState(null, '', url);
  });
  ui.onSearch((q) => {
    const id = normalise(q);
    if (!id) return;
    const r = byId.get(id);
    if (r) open(r);
    else ui.showNotFound(id, data.account);
  });

  // Deep link: kinsburg.com/?r=handle
  const linked = params.get('r');
  if (linked) {
    const r = byId.get(normalise(linked));
    if (r) open(r);
    else {
      ui.showNotFound(normalise(linked), data.account);
      // drop the dead link so a reload or re-share doesn't show the note again
      const url = new URL(location.href);
      url.searchParams.delete('r');
      history.replaceState(null, '', url);
    }
  }

  setInterval(tick, 60_000);
}

start();
