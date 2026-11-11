// Types for residents-format.mjs (compact resident list served by the Worker).
import type { CityData, Job, Perk, Resident } from '../src/types';

export declare const FORMAT: 1;
export declare const DEFAULT_SHARD_SIZE: number;
export declare const DEFAULT_PACK_SIZE: number;
export declare const JOBS: readonly Job[];
export declare const PERKS: readonly Perk[];
export declare const PERK_BIT: Readonly<Record<Perk, number>>;

/** [handle, number, joinedDay, jobIndex, houseStyle, perkMask] */
export type Row = [handle: string, number: number, joinedDay: number, job: number, houseStyle: number, perks: number];

export interface ShardMeta {
  n: number;
  count: number;
  /** City revision at which this shard was last written; doubles as its cache-busting version. */
  rev: number;
}

export interface Manifest {
  format: 1;
  name: string;
  account: string;
  foundedISO: string;
  seed: string;
  demo: boolean;
  count: number;
  rev: number;
  shardSize: number;
  packSize: number;
  shards: ShardMeta[];
}

/** Resident before the engine assigns a plot. */
export type CompactResident = Omit<Resident, 'plotId'>;

export interface PlannedRequest {
  kind: 'pack' | 'shard';
  from: number;
  to: number;
  url: string;
}

export declare function perksToMask(perks: readonly Perk[] | undefined): number;
export declare function maskToPerks(mask: number): Perk[];
export declare function normalizeHandle(raw: unknown): string;
export declare function isValidHandle(h: string): boolean;
export declare function matchesMoveIn(text: unknown): boolean;
export declare function traitsFor(handle: string): { job: number; houseStyle: number };
export declare function cityDayAt(foundedISO: string, ms?: number): number;
export declare function encodeResident(r: {
  handle: string;
  number: number;
  joinedDay: number;
  job: Job | number;
  houseStyle: number;
  perks: readonly Perk[] | number;
}): Row;
export declare function decodeRow(row: Row): CompactResident;
export declare function shardOf(number: number, shardSize?: number): number;
export declare function encodeShards(residents: ReadonlyArray<Parameters<typeof encodeResident>[0]>, shardSize?: number): Row[][];
export declare function planRequests(manifest: Manifest, base?: string): PlannedRequest[];
export declare function decodeShards(manifest: Manifest, shardBodies: readonly Row[][]): CompactResident[];
export declare function cityDataFromCompact(manifest: Manifest, residents: readonly CompactResident[]): CityData;
