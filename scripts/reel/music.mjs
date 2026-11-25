// A small upbeat music bed for text-driven Reels, made from scratch (no samples, nothing licensed):
// a I–V–vi–IV progression in C at 104 BPM with a marimba-like arpeggio, a soft pad, bass and light
// drums. Bars are exact, so a Reel can cut on them, and the track loops: notes still ringing at the
// end are wrapped onto the start, so the last sample runs straight into the first.
//
//   import { writeMusic, BAR } from './music.mjs';
//   writeMusic('bed.wav', { bars: 20, dropBar: 2 });   // soft intro for 2 bars, then the drums come in
import { writeFileSync } from 'node:fs';

export const BPM = 104;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;
const SR = 48000;

const midi = (n) => 440 * 2 ** ((n - 69) / 12);
// C, G, Am, F: [bass root, pad/arp tones]
const CHORDS = [
  [36, [60, 64, 67, 72]],
  [43, [59, 62, 67, 71]],
  [45, [57, 60, 64, 69]],
  [41, [57, 60, 65, 69]],
];

/** A tiny deterministic noise source, so every render is identical. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/**
 * Render `bars` bars to a 48 kHz stereo WAV. Before `dropBar` only the pad and arpeggio play (under a
 * voice-over); a short noise swell leads into the drop, where bass and drums come in.
 */
export function writeMusic(file, { bars = 16, dropBar = 2, gain = 0.9 } = {}) {
  const tail = 3; // seconds rendered past the end, then folded back onto the start
  const D = bars * BAR, N = Math.round((D + tail) * SR), loopN = Math.round(D * SR);
  const L = new Float32Array(N), R = new Float32Array(N);
  const add = (i, l, r = l) => { if (i >= 0 && i < N) { L[i] += l; R[i] += r; } };
  const noise = rng(7);
  const drop = dropBar * BAR;

  // pad: four detuned voices per chord, slow attack, ducked after each kick
  for (let b = 0; b < bars; b++) {
    const [, tones] = CHORDS[b % 4];
    const t0 = b * BAR, n0 = Math.round(t0 * SR), len = Math.round((BAR + 0.4) * SR);
    for (const note of tones.slice(0, 3)) {
      for (const det of [-0.0018, 0.0018]) {
        const f = midi(note) * (1 + det);
        for (let k = 0; k < len; k++) {
          const t = k / SR;
          const env = Math.min(1, t / 0.35) * Math.min(1, (BAR + 0.4 - t) / 0.4);
          const s = (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t) + 0.12 * Math.sin(6 * Math.PI * f * t)) * env;
          add(n0 + k, s * (det < 0 ? 0.034 : 0.026), s * (det < 0 ? 0.026 : 0.034));
        }
      }
    }
  }

  // arpeggio: 8ths up and down the chord, two octaves up, marimba-ish, gently panned
  const ARP = [0, 1, 2, 3, 2, 1, 2, 3];
  for (let b = 0; b < bars; b++) {
    const [, tones] = CHORDS[b % 4];
    for (let e = 0; e < 8; e++) {
      const t0 = b * BAR + e * (BEAT / 2);
      const f = midi(tones[ARP[e]] + 12);
      const n0 = Math.round(t0 * SR), len = Math.round(0.9 * SR);
      const amp = (e % 2 ? 0.07 : 0.095) * (t0 < drop ? 0.8 : 1);
      const pan = e % 2 ? 0.35 : -0.35;
      for (let k = 0; k < len; k++) {
        const t = k / SR;
        const env = Math.min(1, t / 0.003) * Math.exp(-t * 7);
        const s = (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 4 * t) * Math.exp(-t * 30)) * env * amp;
        add(n0 + k, s * (1 - pan), s * (1 + pan));
      }
    }
  }

  // bass: root on 1, the "and" of 2, and 3, from the drop
  for (let b = dropBar; b < bars; b++) {
    const f = midi(CHORDS[b % 4][0]);
    for (const beat of [0, 1.5, 2, 3.5]) {
      const t0 = b * BAR + beat * BEAT, n0 = Math.round(t0 * SR), len = Math.round(0.5 * SR);
      for (let k = 0; k < len; k++) {
        const t = k / SR;
        const env = Math.min(1, t / 0.006) * Math.exp(-t * 5);
        const s = Math.tanh(1.6 * (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t))) * env * 0.17;
        add(n0 + k, s);
      }
    }
  }

  // drums from the drop: kick on 1 and 3 (and the "and" of 3 every other bar), clap on 2 and 4, 8th hats
  const kicks = [];
  for (let b = dropBar; b < bars; b++) {
    for (const beat of b % 2 ? [0, 2, 2.5] : [0, 2]) kicks.push(b * BAR + beat * BEAT);
    for (const beat of [1, 3]) {
      const n0 = Math.round((b * BAR + beat * BEAT) * SR);
      let lp = 0;
      for (let k = 0; k < Math.round(0.25 * SR); k++) {
        const t = k / SR, x = noise();
        lp += 0.25 * (x - lp);
        const env = Math.exp(-t * 22) + 0.4 * Math.exp(-Math.max(0, t - 0.012) * 40) * (t > 0.012 ? 1 : 0);
        add(n0 + k, (x - lp) * env * 0.16);
      }
    }
    for (let e = 0; e < 8; e++) {
      const n0 = Math.round((b * BAR + e * (BEAT / 2)) * SR);
      let lp = 0;
      for (let k = 0; k < Math.round(0.06 * SR); k++) {
        const t = k / SR, x = noise();
        lp += 0.6 * (x - lp);
        add(n0 + k, (x - lp) * Math.exp(-t * 70) * (e % 2 ? 0.07 : 0.04), (x - lp) * Math.exp(-t * 70) * (e % 2 ? 0.05 : 0.06));
      }
    }
  }
  for (const t0 of kicks) {
    const n0 = Math.round(t0 * SR);
    let ph = 0;
    for (let k = 0; k < Math.round(0.4 * SR); k++) {
      const t = k / SR;
      ph += (2 * Math.PI * (44 + 90 * Math.exp(-t * 32))) / SR;
      add(n0 + k, Math.sin(ph) * Math.exp(-t * 8) * 0.42);
    }
  }
  // the pad and arpeggio duck a little under each kick (a soft pump)
  if (kicks.length) {
    let ki = 0;
    for (let i = Math.round(drop * SR); i < N; i++) {
      const t = i / SR;
      while (ki + 1 < kicks.length && kicks[ki + 1] <= t) ki++;
      const since = t - kicks[ki];
      if (since >= 0 && since < 0.3) { const g = 1 - 0.18 * Math.exp(-since * 14); L[i] *= g; R[i] *= g; }
    }
  }
  // a noise swell over the bar before the drop
  if (dropBar > 0) {
    const n0 = Math.round((drop - BAR) * SR), len = Math.round(BAR * SR);
    let lp = 0;
    for (let k = 0; k < len; k++) {
      const u = k / len, x = noise();
      lp += (0.02 + 0.5 * u) * (x - lp);
      add(n0 + k, lp * u * u * 0.12);
    }
  }

  // fold the ringing tail onto the start (the loop), soft-clip, write
  const out = Buffer.alloc(44 + loopN * 4);
  for (let i = loopN; i < N; i++) { L[i - loopN] += L[i]; R[i - loopN] += R[i]; }
  for (let i = 0; i < loopN; i++) {
    out.writeInt16LE(Math.round(Math.tanh(L[i] * gain) * 32000), 44 + i * 4);
    out.writeInt16LE(Math.round(Math.tanh(R[i] * gain) * 32000), 46 + i * 4);
  }
  out.write('RIFF', 0); out.writeUInt32LE(36 + loopN * 4, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22);
  out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(loopN * 4, 40);
  writeFileSync(file, out);
  return { file, duration: loopN / SR };
}
