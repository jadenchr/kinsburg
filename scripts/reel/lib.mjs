// Small shared helpers for scripts/reel/*.mjs (no dependencies).
import { spawn } from 'node:child_process';
import { openSync, readSync, closeSync, statSync } from 'node:fs';

/** --key value / --key=value / --flag / --no-flag → object. Repeats keep the last value. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a.startsWith('--no-')) {
      out[a.slice(5)] = false;
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else out[a.slice(2)] = true;
    }
  }
  return out;
}

/** Run a command, resolve with stdout; reject with stderr on non-zero exit. */
export function run(cmd, args, { quiet = true, input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let so = '', se = '';
    p.stdout.on('data', (d) => (so += d));
    p.stderr.on('data', (d) => {
      se += d;
      if (!quiet) process.stderr.write(d);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(so) : reject(new Error(`${cmd} exited ${code}\n${se.slice(-3000)}`))));
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Top-level MP4 atoms in file order, e.g. ['ftyp','moov','mdat']. */
export function mp4Atoms(file) {
  const fd = openSync(file, 'r');
  const size = statSync(file).size;
  const head = Buffer.alloc(16);
  const atoms = [];
  let pos = 0;
  try {
    while (pos + 8 <= size && atoms.length < 64) {
      readSync(fd, head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      else if (len === 0) len = size - pos;
      atoms.push(type);
      if (len < 8) break;
      pos += len;
    }
  } finally {
    closeSync(fd);
  }
  return atoms;
}

/** ffprobe summary of the things Instagram checks. */
export async function probe(file, ffprobe = 'ffprobe') {
  const json = JSON.parse(
    await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,size,bit_rate:stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,sample_rate,channels,bit_rate', '-of', 'json', file]),
  );
  const v = json.streams.find((s) => s.codec_type === 'video') ?? {};
  const a = json.streams.find((s) => s.codec_type === 'audio') ?? {};
  const atoms = mp4Atoms(file);
  return {
    video: `${v.codec_name} ${v.profile ?? ''} ${v.width}x${v.height} ${v.pix_fmt} ${v.r_frame_rate}`.replace(/\s+/g, ' '),
    audio: a.codec_name ? `${a.codec_name} ${a.sample_rate} Hz ${a.channels}ch ${Math.round((a.bit_rate ?? 0) / 1000)} kb/s` : 'none',
    duration: Number(json.format.duration),
    sizeMB: Number(json.format.size) / 1e6,
    bitrateMbps: Number(json.format.bit_rate) / 1e6,
    faststart: atoms.indexOf('moov') >= 0 && atoms.indexOf('moov') < atoms.indexOf('mdat'),
    atoms: atoms.join(','),
    ok:
      v.codec_name === 'h264' && v.pix_fmt === 'yuv420p' && a.codec_name === 'aac' &&
      Number(json.format.duration) >= 3 && Number(json.format.duration) <= 900 && Number(json.format.size) < 300e6 &&
      atoms.indexOf('moov') < atoms.indexOf('mdat') && v.width <= 1920,
  };
}

/** hex "#rrggbb" + alpha → css rgba() */
export function rgba(hex, a) {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

/** Deterministic 0..1 hash of a string (for picking a melody / track by date). */
export function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1e6) / 1e6;
}

/**
 * ffmpeg args that synthesise a gentle ambient bed (no samples, no copyright): a soft
 * A-major pad with slow swells + a music-box motif in A major pentatonic, echoed.
 * `seed` (0..1) reorders the motif so every day sounds a little different.
 */
export function ambientArgs(duration, outFile, seed = 0) {
  const D = Math.max(3, duration);
  const pad = [
    [110, 0.5, 0, 0],
    [164.81, 0.35, 0.07, 1],
    [220, 0.3, 0.11, 2],
    [277.18, 0.22, 0.05, 3],
    [329.63, 0.18, 0.09, 4],
  ]
    .map(([f, a, lfo, ph]) => `${a}*sin(2*PI*${f}*t)*(0.65+0.35*sin(2*PI*${lfo}*t+${ph}))`)
    .join('+');
  // pentatonic semitones above A4 (A B C# E F#, two octaves)
  const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19];
  const steps = 8;
  const notes = Array.from({ length: steps }, (_, i) => scale[Math.floor(strHash(`${seed}:${i}`) * scale.length)]);
  const beat = 1.6;
  let sel = String(notes[steps - 1]);
  for (let i = steps - 2; i >= 0; i--) sel = `if(eq(mod(floor(t/${beat}),${steps}),${i}),${notes[i]},${sel})`;
  const f = `(440*pow(2,(${sel})/12))`;
  const env = `exp(-2.6*mod(t,${beat}))*(1-exp(-300*mod(t,${beat})))`;
  const bell = `(sin(2*PI*${f}*t)+0.25*sin(4*PI*${f}*t))*${env}`;
  const left = `0.05*(${pad})+0.055*${bell}`;
  const right = `0.05*(${pad})+0.045*${bell}`;
  return [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', `aevalsrc='${left}|${right}':s=48000:d=${D}`,
    '-af', `aecho=0.8:0.6:280|470:0.28|0.18,lowpass=f=4200,volume=13dB,afade=t=in:d=1.2,afade=t=out:st=${Math.max(0, D - 1.8)}:d=1.8,alimiter=limit=0.7`,
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', outFile,
  ];
}

/**
 * Make a video loop seamlessly on Instagram: its last `fade` seconds dissolve into its own first
 * frame (landing on it exactly at the final frame), and the sound gets a tiny fade at both ends so
 * the join doesn't click. Re-encodes in place with the reels' settings and tags the file, so running
 * it twice does nothing. Returns false if the file was already looped.
 */
export async function loopVideo(file, { fade = 0.5, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', maxrate = '8M', bufsize = '16M' } = {}) {
  const { mkdtempSync, renameSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const info = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:format_tags=comment:stream=codec_type,width,height,r_frame_rate', '-of', 'json', file]));
  if (String(info.format?.tags?.comment ?? '').includes('kinsburg-loop')) return false;
  const v = info.streams.find((s) => s.codec_type === 'video');
  const hasAudio = info.streams.some((s) => s.codec_type === 'audio');
  const D = Number(info.format.duration);
  const [num, den] = String(v.r_frame_rate).split('/').map(Number);
  const fps = num / (den || 1);
  const tmp = mkdtempSync(join(tmpdir(), 'kinsburg-loop-'));
  try {
    const out = join(tmp, 'looped.mp4');
    // the dissolve finishes four frames before the end, so the last frames *are* frame one
    // (xfade lands about a frame late; measured)
    const offset = Math.max(0, D - fade - 4 / fps);
    // frame one is taken straight from the stream and repeated (a saved image shifts colours slightly)
    const hold = Math.ceil((fade + 0.5) * fps);
    const vf = `[0:v]format=yuv420p,split[m0][f0];[f0]trim=end_frame=1,loop=loop=${hold}:size=1:start=0,setpts=N/(${fps}*TB),settb=AVTB[s];[m0]settb=AVTB[m];[m][s]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(4)},format=yuv420p[v]`;
    const af = hasAudio ? `;[0:a]afade=t=in:st=0:d=0.06,afade=t=out:st=${(D - 0.06).toFixed(4)}:d=0.06[a]` : '';
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
      '-filter_complex', vf + af, '-map', '[v]', ...(hasAudio ? ['-map', '[a]'] : []), '-t', D.toFixed(4), '-r', String(fps),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-maxrate', maxrate, '-bufsize', bufsize, '-pix_fmt', 'yuv420p', '-color_range', 'tv',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
      '-movflags', '+faststart', '-metadata', 'comment=kinsburg-loop', out,
    ]);
    renameSync(out, file);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return true;
}
