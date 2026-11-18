// Types for sim.mjs (the city simulation rules).
import type { Job } from '../src/types';

export type IncidentKind = 'fire' | 'burglary' | 'crash' | 'flu' | 'lostpet' | 'exam' | 'repair';
export type StationKind = 'firestation' | 'police' | 'hospital' | 'vet' | 'school';
export type Stat = 'health' | 'safety' | 'education' | 'happiness';

export interface IncidentDef {
  label: string;
  jobs: readonly Job[];
  base: number;
  hours: number;
  station: StationKind | null;
  vehicle: 'engine' | 'police' | 'ambulance' | null;
  weight: number;
}

export declare const INCIDENTS: Readonly<Record<IncidentKind, IncidentDef>>;
export declare const INCIDENT_KINDS: readonly IncidentKind[];
export declare const STAT_JOBS: Readonly<Record<'health' | 'safety' | 'education', { jobs: readonly Job[]; share: number }>>;
export declare const STATS: readonly Stat[];
export declare const OUTCOME: Readonly<Record<IncidentKind, { stat: Stat; win: number; lose: number }>>;
export declare const COINS: { respond: number; duty: number; repair: number };
export declare const PET_COIN_PRICE: number;
export declare function neededFor(kind: IncidentKind, residents: number): number;
export declare function matchesRespond(text: unknown): boolean;
export declare function clampStat(x: number): number;
export declare function statTargets(input: {
  residents: number;
  workers: Partial<Record<string, number>>;
  active: Partial<Record<string, number>>;
  pets: number;
  damaged: number;
}): Record<Stat, number>;
