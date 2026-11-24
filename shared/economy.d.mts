export declare const CASH_PER_FOLLOWER: number;
export declare const CASH_PER_MOVE_IN: number;
export declare const HOUSE_VALUE: number;
export declare const PRICE_TIERS: number[];
export declare const BUILD_TIER: Record<string, number>;
export declare function buildPrice(kind: string): number;
export declare const HOME_PRICE: { villa: number; skyscraper: number };
export declare function planSpend<T extends { price: number }>(cash: number, items: T[], max?: number): { bought: T[]; waiting: T | null; cashAfter: number };
export declare function money(n: number): string;
