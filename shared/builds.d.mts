export interface BuildDef {
  kind: string;
  label: string;
  emoji: string;
  words: string[];
}
export declare const BUILDS: BuildDef[];
export declare const BUILD_KINDS: string[];
export declare const BUILD_BY_KIND: Record<string, BuildDef>;
export declare const BUILDS_PER_DAY: number;
export declare const REQUEST_DAYS: number;
export declare const BESTIE_HOLD_DAYS: number;
export declare const RESIDENTIAL_ONLY: string[];
export declare function parseBuildRequest(text: string | null | undefined): string | null;
export declare function parseBestie(text: string | null | undefined, ownAccount?: string): string | null;
