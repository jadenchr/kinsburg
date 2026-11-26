// Types for residents-format.mjs (compact resident list served by the Worker).
import type { CityData, HomeKind, Job, Perk, Pet, Resident } from '../src/types';

export declare const FORMAT: 1;
export declare const DEFAULT_SHARD_SIZE: number;
export declare const DEFAULT_PACK_SIZE: number;
export declare const JOBS: readonly Job[];
/** Random jobs for new residents come from JOBS[0..BASE_JOBS-1]; the rest are given on request. */
export declare const BASE_JOBS: number;
export declare const PERKS: readonly Perk[];
export declare const PERK_BIT: Readonly<Record<Perk, number>>;

/** [handle, number, joinedDay, jobIndex, houseStyle, perkMask] */
export type Row = [handle: string, number: number, joinedDay: number, job: number, houseStyle: number, perks: number, level?: number, follower?: number, pet?: number, coins?: number, home?: number, homeNo?: number];
export declare const HOMES: readonly ('house' | HomeKind)[];
export declare const HOME_LIMIT: Readonly<Record<HomeKind, number>>;
export declare function parseHomeCommand(text: unknown): HomeKind | null;
export declare const PETS: readonly ('none' | Pet)[];
export declare const FREE_PETS: readonly Pet[];
export declare const RARE_PETS: readonly Pet[];
export declare const PET_NAMES: Readonly<Record<'none' | Pet, string>>;
export declare function petBit(pet: Pet): number;
export declare function parseJobCommand(text: unknown): number | null;
export declare function parsePetCommand(text: unknown): Pet | 'none' | null;
export declare function withTail(row: Row, tail: number[]): Row;
export declare const LEVEL_AT: readonly number[];
export declare function levelFor(engagement: number): number;

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
export declare function matchesCastMe(text: unknown): boolean;
export declare function traitsFor(handle: string): { job: number; houseStyle: number };
export declare function cityDayAt(foundedISO: string, ms?: number): number;
export declare function encodeResident(r: {
  handle: string;
  number: number;
  joinedDay: number;
  job: Job | number;
  houseStyle: number;
  perks: readonly Perk[] | number;
  level?: number;
  follower?: boolean;
  pet?: Pet | number;
  coins?: number;
  home?: HomeKind | 'house';
  homeNo?: number;
}): Row;
export declare function decodeRow(row: Row): CompactResident;
export declare function shardOf(number: number, shardSize?: number): number;
export declare function encodeShards(residents: ReadonlyArray<Parameters<typeof encodeResident>[0]>, shardSize?: number): Row[][];
export declare function planRequests(manifest: Manifest, base?: string): PlannedRequest[];
export declare function decodeShards(manifest: Manifest, shardBodies: readonly Row[][]): CompactResident[];
export declare function cityDataFromCompact(manifest: Manifest, residents: readonly CompactResident[]): CityData;
