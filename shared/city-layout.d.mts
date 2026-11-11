// Types for city-layout.mjs, typed against the shared contract in src/types.ts.
// (TypeScript resolves `./city-layout.mjs` imports to this `.d.mts` file; a plain `.d.ts` is not picked up for `.mjs`.)
import type { CityData, Landmark, Plot, Resident, Street } from '../src/types';

export declare const CHUNK: number;

/** Result of buildCity(). Plots carry no residents until assignResidents(). */
export interface BuiltCity {
  seed: string;
  width: number;
  height: number;
  tiles: string;
  streets: Street[];
  plots: Plot[];
  landmarks: Landmark[];
  /** House plot ids in move-in order: resident #k lives on fillOrder[k-1]. */
  fillOrder: number[];
  originX: number;
  originY: number;
  rings: number;
  chunks: number;
  houseCapacity: number;
  /** Street id per tile (-1 off-road). Not serialised. */
  streetOf: Int32Array;
}

export interface CityStats {
  houses: number;
  occupied: number;
  spare: number;
  sparePct: number;
  shops: number;
  civic: number;
  streets: number;
  landmarks: number;
}

export declare function hashString(str: string): number;
export declare function mulberry32(seed: number): () => number;
export declare function rngFrom(...parts: Array<string | number>): () => number;
export declare function capacityFor(n: number): number;
export declare function buildCity(opts?: { seed?: string; capacity?: number }): BuiltCity;
export declare function assignResidents<R extends { id: string }>(city: BuiltCity, residents: readonly R[]): Array<R & { plotId: number }>;
export declare function nextFreePlot(city: BuiltCity, count: number): number;
export declare function toCityData(
  city: BuiltCity,
  residents: readonly Resident[],
  opts?: { name?: string; account?: string; foundedISO?: string; demo?: boolean },
): CityData;
export declare function validateCityData(d: CityData, opts?: { jobs?: readonly string[]; streetOf?: Int32Array }): CityStats;
export declare function asciiMap(d: CityData, cols?: number, rows?: number): string;
