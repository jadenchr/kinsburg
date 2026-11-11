// Stripe Payment Links -> cosmetic perks. Signature checked with WebCrypto (no SDK).
import { checkHandle, eventStmt, isPerk, joinMany, setPerk, writeSnapshots, type Perk } from './city';
import { verifyStripeSignature } from './crypto';
import { type Env, json, log } from './env';
import { PERK_BIT } from '../../shared/residents-format.mjs';

const HANDLED = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

function perkMap(env: Env): Record<string, string> {
  if (typeof env.STRIPE_PERKS === 'object' && env.STRIPE_PERKS) return env.STRIPE_PERKS;
  try { return JSON.parse(env.STRIPE_PERKS || '{}'); } catch { return {}; }
}

/** The buyer's handle: the required custom text field, else client_reference_id. */
function handleFrom(env: Env, s: any): string | null {
  const key = (env.STRIPE_HANDLE_FIELD_KEY || 'instagramhandle').toLowerCase();
  const fields: any[] = Array.isArray(s?.custom_fields) ? s.custom_fields : [];
  const f =
    fields.find((x) => String(x?.key ?? '').toLowerCase() === key) ??
    fields.find((x) => /instagram/i.test(String(x?.label?.custom ?? '')));
  const v = f?.text?.value ?? f?.dropdown?.value ?? null;
  if (typeof v === 'string' && v.trim()) return v;
  return typeof s?.client_reference_id === 'string' && s.client_reference_id ? s.client_reference_id : null;
}

function perkFrom(env: Env, s: any): Perk | null {
  if (isPerk(s?.metadata?.perk)) return s.metadata.perk;
  const map = perkMap(env);
  for (const k of [s?.payment_link, s?.metadata?.price, s?.metadata?.product]) {
    if (typeof k === 'string' && isPerk(map[k])) return map[k] as Perk;
  }
  return null;
}

export async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response('webhook not configured', { status: 503 });
  const raw = await req.text();
  const sig = await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, raw, req.headers.get('stripe-signature'));
  if (!sig.ok) {
    log('stripe_bad_signature', { reason: sig.reason });
    return new Response(`bad signature: ${sig.reason}`, { status: 400 });
  }
  let ev: any;
  try { ev = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  if (typeof ev?.id !== 'string' || typeof ev?.type !== 'string') return new Response('bad event', { status: 400 });
  if (!HANDLED.has(ev.type)) return json({ ok: true, ignored: ev.type });

  const db = env.DB;
  // Idempotency: claim the event id first; a duplicate delivery is a no-op.
  const claim = await db
    .prepare(`INSERT INTO stripe_events (event_id, type) VALUES (?1, ?2) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`)
    .bind(ev.id, ev.type)
    .first();
  if (!claim) return json({ ok: true, duplicate: true });

  const finish = (status: string, handle: string | null, perk: string | null, detail?: unknown) =>
    db.prepare('UPDATE stripe_events SET status = ?2, handle = ?3, perk = ?4, detail = ?5 WHERE event_id = ?1')
      .bind(ev.id, status, handle, perk, detail === undefined ? null : JSON.stringify(detail));

  try {
    const s = ev.data?.object ?? {};
    if (s.payment_status && s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') {
      await db.batch([finish('pending', null, null, { payment_status: s.payment_status })]);
      return json({ ok: true, pending: true }); // async_payment_succeeded will follow
    }
    const rawHandle = handleFrom(env, s);
    const perk = perkFrom(env, s);
    const { handle, bad } = checkHandle(rawHandle ?? '');
    if (!rawHandle || bad || !perk) {
      const detail = { rawHandle, perk, reason: !rawHandle ? 'no handle' : bad ?? 'unknown perk', session: s.id, payment_link: s.payment_link };
      log('stripe_manual_review', detail);
      await db.batch([finish('review', handle || null, perk, detail), eventStmt(env, 'stripe_review', handle || null, detail)]);
      return json({ ok: true, review: true }); // 200 so Stripe stops retrying; owner fixes by hand
    }
    // Auto-join the buyer if needed (perk set in the same insert), else OR the perk in.
    const [j] = await joinMany(env, [{ raw: handle, source: 'stripe', perks: PERK_BIT[perk] }]);
    let row = j.status === 'joined' ? j.row! : null;
    if (j.status === 'exists') row = await setPerk(env, handle, perk);
    if (!row) {
      const detail = { reason: j.status, session: s.id };
      await db.batch([finish('review', handle, perk, detail), eventStmt(env, 'stripe_review', handle, detail)]);
      return json({ ok: true, review: true });
    }
    await writeSnapshots(env, [row], [
      finish('done', handle, perk, { joined: j.status === 'joined', number: row[1] }),
      eventStmt(env, 'perk', handle, { perk, source: 'stripe', event: ev.id, joined: j.status === 'joined' }),
    ]);
    log('stripe_perk', { handle, perk, joined: j.status === 'joined' });
    return json({ ok: true, handle, perk, number: row[1] });
  } catch (err) {
    // Release the claim so Stripe's retry can process it.
    log('stripe_failed', { event: ev.id, error: String(err) });
    await db.prepare('DELETE FROM stripe_events WHERE event_id = ?1').bind(ev.id).run().catch(() => {});
    return new Response('retry later', { status: 500 });
  }
}
