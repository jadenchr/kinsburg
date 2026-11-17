#!/usr/bin/env python3
"""Narration for the launch reels, in the same voice as From Day 30 (Kokoro "am_fenrir", 0.86).

    "$KOKORO_PYTHON" -I scripts/reel/voice.py lines.json out.wav out.json

lines.json is a list of {"text": "...", "say"?: "...", "gap"?: seconds-of-silence-after}.
Writes the narration (48 kHz mono WAV, levelled to -18 dB RMS like From Day 30) and a timing
file with every line's and every word's start/end in seconds, for the captions.

Kokoro runs on this computer (no account, no cost). The model files are read from
KOKORO_DIR, by default the From Day 30 project next door.
"""
import json
import os
import pathlib
import re
import sys

import numpy as np
import soundfile
from kokoro_onnx import Kokoro

HERE = pathlib.Path(__file__).resolve()
DEFAULT_DIR = HERE.parents[3] / "thelastone - like" / "from-day-30" / "models" / "kokoro"
KOKORO_DIR = pathlib.Path(os.environ.get("KOKORO_DIR", DEFAULT_DIR))
VOICE = os.environ.get("KOKORO_VOICE", "am_fenrir")
SPEED = float(os.environ.get("KOKORO_SPEED", "0.86"))
TARGET_RMS_DB = -18.0
PEAK_LIMIT_DB = -1.0
OUT_SR = 48000


def trim(samples, sr, threshold_db=-50.0, pad=0.03):
    level = 10 ** (threshold_db / 20)
    loud = np.flatnonzero(np.abs(samples) > level)
    if len(loud) == 0:
        return samples
    margin = int(pad * sr)
    return samples[max(0, loud[0] - margin): min(len(samples), loud[-1] + margin)]


def rms_db(samples):
    return 20 * np.log10(np.sqrt(np.mean(samples ** 2)) + 1e-9)


def word_weight(word):
    return len(re.sub(r"\W", "", word)) + 1.5


def main():
    lines_path, wav_path, json_path = sys.argv[1:4]
    lines = json.loads(pathlib.Path(lines_path).read_text())
    kokoro = Kokoro(str(KOKORO_DIR / "kokoro-v1.0.onnx"), str(KOKORO_DIR / "voices-v1.0.bin"))
    chunks, timing, t = [], [], 0.0
    lead = float(os.environ.get("VOICE_LEAD", "0.35"))
    chunks.append(np.zeros(int(lead * OUT_SR)))
    t = lead
    for line in lines:
        samples, sr = kokoro.create(line.get("say", line["text"]), voice=VOICE, speed=line.get("speed", SPEED), lang="en-us")
        samples = trim(np.asarray(samples, dtype=np.float64), sr)
        if sr != OUT_SR:  # simple resample to 48 kHz for the video
            x = np.linspace(0, len(samples) - 1, int(len(samples) * OUT_SR / sr))
            samples = np.interp(x, np.arange(len(samples)), samples)
        samples *= 10 ** ((TARGET_RMS_DB - rms_db(samples)) / 20)
        dur = len(samples) / OUT_SR
        words = line["text"].split()
        weights = [word_weight(w) for w in words]
        total = sum(weights)
        acc, wt = t, []
        for w, wgt in zip(words, weights):
            d = dur * wgt / total
            wt.append({"w": w, "start": round(acc, 3), "end": round(acc + d, 3)})
            acc += d
        timing.append({"text": line["text"], "start": round(t, 3), "end": round(t + dur, 3), "words": wt})
        chunks.append(samples)
        gap = float(line.get("gap", 0.35))
        chunks.append(np.zeros(int(gap * OUT_SR)))
        t += dur + gap
    audio = np.concatenate(chunks)
    peak = np.max(np.abs(audio)) + 1e-9
    limit = 10 ** (PEAK_LIMIT_DB / 20)
    if peak > limit:
        audio *= limit / peak
    soundfile.write(wav_path, audio.astype(np.float32), OUT_SR)
    pathlib.Path(json_path).write_text(json.dumps({"duration": round(t, 3), "lines": timing}, indent=1))
    print(f"voice: {len(lines)} lines, {t:.2f} s -> {wav_path}")


if __name__ == "__main__":
    main()
