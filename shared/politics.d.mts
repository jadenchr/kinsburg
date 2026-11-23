// Types for politics.mjs (elections, approval, protests, recalls).
import type { Stat } from './sim.mjs';

export declare const TERM_DAYS: number;
export declare const NOMINATION_DAYS: number;
export declare const RECALL_NOMINATION_DAYS: number;
export declare const VOTING_DAYS: number;
export declare const MAX_CANDIDATES: number;
export declare const MIN_RESIDENTS: number;
export declare const PROTEST_MIN: number;
export declare const PROTEST_SHARE: number;
export declare const PROTEST_WINDOW_DAYS: number;
export declare const FUND_COST: number;
export declare const FUND_BOOST: number;
export declare const FUND_STATS: Readonly<Record<string, Stat>>;
export declare function matchesRunForMayor(text: unknown): boolean;
export declare function matchesProtest(text: unknown): boolean;
export declare function parseFund(text: unknown): Stat | null;
export declare function protestThreshold(active: number): number;
export declare function approvalOf(stats: Record<Stat, number>, protesters: number, active: number): number;
