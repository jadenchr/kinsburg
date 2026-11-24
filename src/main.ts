// Kinsburg entry point: loads the city, wires the map to the UI, keeps the clock.
import type { TownSection } from './ui/town';
import type { CityData, Resident } from './types';
import { skyAt, COLORS, type SkyState } from './theme';
import { createCityView } from './city';
import { createUI } from './ui';
import { loadCity } from './data/load';
import { loadTown } from './data/town';
import { SECRETS } from './city/sites';

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
  // Sponsors' billboards appear in the reel too (part of what they pay for).
  if (params.has('reel')) {
    const town = params.has('poster') ? null : await loadTown(data.demo);
    if (town) city.setBillboards(town.sponsors.map((s) => ({ name: s.name, message: s.message })));
    if (town) city.setIncidents(town.sim?.open ?? []);
    if (town) {
      city.setExtras(town.builds ?? [], town.holds ?? []);
      city.setBesties(town.besties ?? []);
      city.setPolitics(town.politics ?? null);
    }
    return void import('./reel').then((m) => m.startReel(city, data, params, town));
  }
  ui.setStats({ day: cityDay(data), residents: data.residents.filter((r) => !r.handle.startsWith('vacant.lot.')).length, demo: data.demo });

  // hidden spots found so far (kept in this browser only; works without storage)
  const STORE = 'kinsburg.secrets';
  const found = new Set<number>();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '[]') as unknown;
    if (Array.isArray(saved)) for (const n of saved) if (Number.isInteger(n) && n >= 0 && n < SECRETS.length) found.add(n as number);
  } catch {
    /* no storage: the counter just starts at 0 each visit */
  }
  const syncSecrets = () => {
    city.setSecretsFound([...found]);
    ui.setSecrets(found.size, SECRETS.length);
  };
  syncSecrets();
  city.onSecret((s) => {
    const fresh = !found.has(s.index);
    found.add(s.index);
    try {
      localStorage.setItem(STORE, JSON.stringify([...found]));
    } catch {
      /* ignore */
    }
    syncSecrets();
    ui.toast(fresh ? `You found the ${s.name}! ${found.size}/${SECRETS.length} secret spots` : `The ${s.name} again. ${found.size}/${SECRETS.length} secret spots found`);
  });
  city.onBuild((b) => {
    city.clearHighlight();
    ui.openBuild(b);
    city.focusBuild(b.id);
  });
  city.onHold((h) => ui.toast(`Saved for a bestie 💛 ${h.days} ${h.days === 1 ? 'day' : 'days'} left`));
  // town hall: mayor, votes, sponsors (billboards) and perk links. Loads after the map is up.
  const applyTown = (town: Awaited<ReturnType<typeof loadTown>>) => {
    city.setBillboards(town.sponsors.map((s) => ({ name: s.name, message: s.message })));
    city.setIncidents(town.sim?.open ?? []);
    city.setExtras(town.builds ?? [], town.holds ?? []);
    city.setBesties(town.besties ?? []);
    city.setPolitics(town.politics ?? null);
    ui.setTown(town, data);
  };
  loadTown(data.demo).then((town) => {
    applyTown(town);
    if (params.get('town') !== null) ui.openTown((params.get('town') || undefined) as TownSection | undefined);
  });
  // the simulation moves on every 15 minutes; refresh what's happening every 2
  setInterval(() => void loadTown(data.demo).then(applyTown), 120_000);
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
  city.onBuilding((b) => {
    city.clearHighlight();
    ui.openBuilding(b, data);
  });
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
