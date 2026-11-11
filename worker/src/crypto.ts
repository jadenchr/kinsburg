// WebCrypto helpers (no SDKs): HMAC-SHA256 and constant-time comparison.
const enc = new TextEncoder();

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  let hex = '';
  for (const b of sig) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Meta webhooks: X-Hub-Signature-256: sha256=<hex HMAC of raw body with the app secret>. */
export async function verifyMetaSignature(appSecret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = await hmacSha256Hex(appSecret, rawBody);
  return safeEqual(expected, header.slice(7).toLowerCase());
}

/**
 * Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]. Signed payload is `${t}.${rawBody}`, key is the
 * whole endpoint secret (whsec_...). Rejects timestamps more than `toleranceSec` away from now.
 */
export async function verifyStripeSignature(
  secret: string,
  rawBody: string,
  header: string | null,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!header) return { ok: false, reason: 'missing header' };
  let t = '';
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v.toLowerCase());
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts)) return { ok: false, reason: 'no timestamp' };
  if (!v1.length) return { ok: false, reason: 'no v1 signature' };
  if (Math.abs(nowSec - ts) > toleranceSec) return { ok: false, reason: 'timestamp outside tolerance' };
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  return v1.some((s) => safeEqual(expected, s)) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}
