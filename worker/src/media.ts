// Daily Reel hosting in KV. Instagram's Content Publishing API downloads the video from a public
// URL, so the recorder uploads the MP4 + cover here (admin token) and passes /media/<file> as
// video_url / cover_url. Files expire after 7 days; KV's free tier allows 1,000 writes a day.
import { type Env, json, log } from './env';

const NAME = /^reel-\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)?\.(mp4|jpg)$/;
const TYPES: Record<string, string> = { mp4: 'video/mp4', jpg: 'image/jpeg' };
/** KV's per-value limit is 25 MiB. */
const MAX_BYTES = 25 * 1024 * 1024;
const TTL_SECONDS = 7 * 86_400;

export async function putMedia(req: Request, env: Env, path: string): Promise<Response> {
  const name = path.slice('/admin/media/'.length);
  const m = NAME.exec(name);
  if (!m) return json({ error: 'name must look like reel-YYYY-MM-DD.mp4 or .jpg' }, 400);
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_BYTES) return json({ error: `file too large (${len} bytes, max ${MAX_BYTES})` }, 413);
  const body = await req.arrayBuffer();
  if (!body.byteLength) return json({ error: 'empty body' }, 400);
  if (body.byteLength > MAX_BYTES) return json({ error: `file too large (max ${MAX_BYTES} bytes)` }, 413);
  await env.REELS.put(name, body, { expirationTtl: TTL_SECONDS, metadata: { type: TYPES[m[1]], bytes: body.byteLength } });
  log('media_uploaded', { name, bytes: body.byteLength });
  return json({ ok: true, path: `/media/${name}`, bytes: body.byteLength, expiresInDays: TTL_SECONDS / 86_400 });
}

export async function serveMedia(req: Request, env: Env, path: string): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  const name = path.slice('/media/'.length);
  const m = NAME.exec(name);
  if (!m) return new Response('not found', { status: 404 });
  const file = await env.REELS.get(name, 'arrayBuffer');
  if (!file) return new Response('not found', { status: 404 });
  const headers = {
    'content-type': TYPES[m[1]],
    'content-length': String(file.byteLength),
    'cache-control': 'public, max-age=86400',
    'accept-ranges': 'none',
  };
  return new Response(req.method === 'HEAD' ? null : file, { status: 200, headers });
}
