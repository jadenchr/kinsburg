// Loads the live city: compact resident list from the Worker, layout computed here in the browser
// with the shared engine (a resident's plot depends only on seed + move-in order).
// Falls back to the static demo file /residents.json when the API is missing (plain `vite` dev),
// broken, or when the page is opened with ?demo=1.
import type { CityData } from '../types';
import {
  FORMAT,
  cityDataFromCompact,
  decodeShards,
  planRequests,
  type Manifest,
  type Row,
} from '../../shared/residents-format.mjs';

export interface LoadOptions {
  /** 0..1 progress for a loading bar. */
  onProgress?: (p: number) => void;
  /** API root, default "/api/city". */
  apiBase?: string;
  /** Force the static demo file. Default: true when the URL has ?demo=1. */
  demo?: boolean;
}

async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  // Vite's dev server answers unknown paths with index.html (200), so insist on JSON.
  if (!(res.headers.get('content-type') ?? '').includes('json')) throw new Error(`not JSON: ${url}`);
  return (await res.json()) as T;
}

function isManifest(m: unknown): m is Manifest {
  const x = m as Partial<Manifest> | null;
  return !!x && x.format === FORMAT && typeof x.count === 'number' && Array.isArray(x.shards) && typeof x.seed === 'string';
}

/** Live city from the Worker API. Throws if the API is unavailable. */
export async function loadLiveCity(apiBase = '/api/city', onProgress?: (p: number) => void): Promise<CityData> {
  const manifest = await getJSON<unknown>(`${apiBase}/manifest.json`);
  if (!isManifest(manifest)) throw new Error('bad manifest');
  onProgress?.(0.25);
  const plan = planRequests(manifest, apiBase);
  let done = 0;
  const parts = await Promise.all(
    plan.map(async (req) => {
      const body = await getJSON<Row[] | Row[][]>(req.url);
      onProgress?.(0.25 + (0.5 * ++done) / Math.max(1, plan.length));
      return req.kind === 'pack' ? (body as Row[][]) : [body as Row[]];
    }),
  );
  const residents = decodeShards(manifest, parts.flat());
  const data = cityDataFromCompact(manifest, residents);
  onProgress?.(0.9);
  return data;
}

/** The static CityData file shipped with the site (demo residents). */
export async function loadStaticCity(onProgress?: (p: number) => void): Promise<CityData> {
  const data = await getJSON<CityData>('/residents.json', { cache: 'no-cache' });
  onProgress?.(0.9);
  return data;
}

/** Live city if the API answers, otherwise the static demo city. */
export async function loadCity(opts: LoadOptions = {}): Promise<CityData> {
  const { onProgress, apiBase = '/api/city' } = opts;
  const demo = opts.demo ?? new URLSearchParams(location.search).get('demo') === '1';
  onProgress?.(0.1);
  if (!demo) {
    try {
      return await loadLiveCity(apiBase, onProgress);
    } catch (err) {
      console.warn('Kinsburg: live city unavailable, showing the demo city', err);
    }
  }
  return loadStaticCity(onProgress);
}
