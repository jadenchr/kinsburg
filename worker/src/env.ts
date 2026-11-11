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
  IG_MEDIA_LIMIT: string;
  IG_REPLY_ENABLED: string;
  IG_REPLY_MAX_PER_RUN: string;
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
