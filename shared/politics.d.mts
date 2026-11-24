// Types for politics.mjs (elections, approval, the mayor's fund).
import type { Stat } from './sim.mjs';

export declare const TERM_DAYS: number;
export declare const NOMINATION_DAYS: number;
export declare const VOTING_DAYS: number;
export declare const MAX_CANDIDATES: number;
export declare const MIN_RESIDENTS: number;
export declare const FUND_COST: number;
export declare const FUND_BOOST: number;
export declare const FUND_STATS: Readonly<Record<string, Stat>>;
export declare function matchesRunForMayor(text: unknown): boolean;
export declare function parseFund(text: unknown): Stat | null;
export declare function approvalOf(stats: Record<Stat, number>): number;
