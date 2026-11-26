// Worker bindings, vars and secrets (see wrangler.jsonc). Secrets are optional so a missing one
// disables its feature instead of crashing the Worker.
export interface Env {
  DB: D1Database;
  /** daily Reel videos + covers, served at /media/<file> */
  REELS: KVNamespace;

  CITY_NAME: string;
  CITY_ACCOUNT: string;
  CITY_SEED: string;
  CITY_FOUNDED_ISO: string;
  SITE_URL: string;
  SHARD_SIZE: string;
  PACK_SIZE: string;
  /** "false" skips the Cache API (tests). */
  EDGE_CACHE?: string;

  IG_API_BASE: string;
  /** Meta app id (public), used with IG_APP_SECRET to inspect tokens. */
  META_APP_ID?: string;
  IG_MEDIA_LIMIT: string;
  IG_REPLY_ENABLED: string;
  /** "false" stops incidents starting on their own (tests; admin can still start them) */
  SIM_RANDOM_INCIDENTS?: string;
  /** "false" stops @kinsburgtown announcing calls and elections under its latest post */
  IG_CALLS_ENABLED?: string;
  /** tests only: a smaller limit for each limited-edition home (default 100) */
  HOMES_LIMIT?: string;
  /** paid villas/skyscrapers bought per day at most (default 3) */
  HOMES_PER_DAY?: string;
  /** how often the follower count is read for city cash, in minutes (default 60) */
  FOLLOWERS_CHECK_MINUTES?: string;
  IG_REPLY_MAX_PER_RUN: string;
  IG_REPLY_MAX_PER_DAY?: string;
  /** Seconds per reply pacing window; IG_REPLY_MAX_PER_RUN replies per window in total (default 600). */
  IG_REPLY_WINDOW_SECONDS?: string;
  /** Most posts listed for comment scans (default 100); IG_MEDIA_LIMIT newest + a rotating batch are scanned. */
  IG_MEDIA_SCAN_MAX?: string;
  /** UTC hour after which the day's most-liked build requests are built (default 12). */
  BUILD_HOUR_UTC?: string;
  /** Builds per day (default BUILDS_PER_DAY in shared/builds.mjs). */
  BUILDS_PER_DAY?: string;
  /** "true" after App Review: join / move out by DM, with the follower badge */
  IG_DM_ENABLED?: string;
  /** "true" after App Review: one private reply to each commenter who moves in */
  IG_PRIVATE_REPLY_ENABLED?: string;
  STRIPE_PERKS: string | Record<string, string>;
  STRIPE_HANDLE_FIELD_KEY: string;

  // secrets
  IG_ACCESS_TOKEN?: string;
  IG_USER_ID?: string;
  IG_APP_SECRET?: string;
  IG_VERIFY_TOKEN?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  ADMIN_TOKEN?: string;
}

export function intVar(v: string | undefined, def: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export const shardSize = (env: Env) => intVar(env.SHARD_SIZE, 5000);
export const packSize = (env: Env) => intVar(env.PACK_SIZE, 10);

/** One JSON log line per event (shows up in Workers Logs / `wrangler tail`). Never log tokens. */
export function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
