// Permission to appear in videos ("CAST ME"). Kept apart from MOVE IN: a comment can carry either
// or both. Only the comment's author is granted; removal is by admin after a DM (see admin.ts).
import { matchesCastMe } from '../../shared/residents-format.mjs';
import { checkHandle, eventStmt } from './city';
import { type Env, json } from './env';
import type { IgComment } from './instagram';

export async function processCastComments(env: Env, comments: IgComment[]) {
  const db = env.DB;
  const own = env.CITY_ACCOUNT.toLowerCase();
  const byId = new Map<string, { id: string; handle: string }>();
  for (const c of comments) {
    if (!c.id || !c.username || c.username.toLowerCase() === own || !matchesCastMe(c.text)) continue;
    const { handle, bad } = checkHandle(c.username);
    if (!bad) byId.set(c.id, { id: c.id, handle });
  }
  const report = { cast: [] as string[] };
  if (!byId.size) return report;
  const ids = [...byId.keys()];
  const seen = new Set<string>();
  const reads: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const c = ids.slice(i, i + 90);
    reads.push(db.prepare(`SELECT comment_id FROM cast_seen WHERE comment_id IN (${c.map(() => '?').join(',')})`).bind(...c));
  }
  for (const r of await db.batch<{ comment_id: string }>(reads)) for (const row of r.results) seen.add(row.comment_id);
  const fresh = ids.filter((id) => !seen.has(id)).map((id) => byId.get(id)!);
  if (!fresh.length) return report;
  const stmts: D1PreparedStatement[] = [];
  for (const c of fresh) {
    stmts.push(db.prepare('INSERT INTO cast_seen (comment_id, handle) VALUES (?1, ?2) ON CONFLICT(comment_id) DO NOTHING').bind(c.id, c.handle));
    stmts.push(db.prepare('INSERT INTO cast_ok (handle, comment_id) VALUES (?1, ?2) ON CONFLICT(handle) DO NOTHING').bind(c.handle, c.id));
    if (!report.cast.includes(c.handle)) {
      report.cast.push(c.handle);
      stmts.push(eventStmt(env, 'cast_ok', c.handle, { comment: c.id }));
    }
  }
  await db.batch(stmts);
  return report;
}

/** GET /admin/cast (everyone who may appear) · POST /admin/cast { handle, remove? } */
export async function castAdmin(env: Env, req: Request, body: any): Promise<Response> {
  if (req.method === 'GET') {
    const r = await env.DB.prepare('SELECT c.handle, c.granted_at, r.number FROM cast_ok c LEFT JOIN residents r ON r.handle = c.handle ORDER BY c.granted_at').all<{ handle: string; granted_at: string; number: number | null }>();
    return json({ cast: r.results.map((x) => ({ handle: x.handle, grantedAt: x.granted_at, resident: x.number ?? null })) });
  }
  const { handle, bad } = checkHandle(String(body?.handle ?? ''));
  if (bad || !handle) return json({ error: `handle ${bad ?? 'required'}` }, 400);
  if (body?.remove) {
    await env.DB.batch([env.DB.prepare('DELETE FROM cast_ok WHERE handle = ?1').bind(handle), eventStmt(env, 'cast_removed', handle, { by: 'admin' })]);
    return json({ handle, cast: false });
  }
  await env.DB.batch([env.DB.prepare('INSERT INTO cast_ok (handle) VALUES (?1) ON CONFLICT(handle) DO NOTHING').bind(handle), eventStmt(env, 'cast_ok', handle, { by: 'admin' })]);
  return json({ handle, cast: true });
}
