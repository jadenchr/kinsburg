#!/usr/bin/env node
// Make finished videos loop seamlessly (see loopVideo in lib.mjs):
//   node scripts/reel/loop.mjs reels/**/*.mp4
// Videos that already loop (tagged, or listed in EXACT because their last frame already is their
// first) are left alone.
import { loopVideo } from './lib.mjs';

const EXACT = ['in-this-town-02-six-seven']; // built as an exact loop: its last frame is its first
const files = process.argv.slice(2).filter((f) => f.endsWith('.mp4'));
if (!files.length) {
  console.error('usage: node scripts/reel/loop.mjs <video.mp4> [...]');
  process.exit(1);
}
for (const f of files) {
  if (EXACT.some((e) => f.includes(e))) { console.log(`[loop] ${f}: already an exact loop, left alone`); continue; }
  const did = await loopVideo(f, { ffmpeg: process.env.FFMPEG ?? 'ffmpeg', ffprobe: process.env.FFPROBE ?? 'ffprobe' });
  console.log(`[loop] ${f}: ${did ? 'now loops' : 'already looped'}`);
}
