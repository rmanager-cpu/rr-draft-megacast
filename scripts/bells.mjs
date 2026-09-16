// Church bells, synthesized here rather than shipped as a sample.
//
// Pure Node on purpose: the show machine is not guaranteed to have Python, and a
// bell is easy enough to build from first principles. A bell sounds like a bell
// and not like a test tone because its partials are *inharmonic* - they are not
// whole multiples of the fundamental - and because the minor-third partial (the
// tierce) is what makes a big bell sound funereal rather than cheerful.
//
//   node scripts/bells.mjs                    26 seconds to data/audio/bells.wav
//   node scripts/bells.mjs 40 out.wav
//
// Output is 44.1 kHz mono 16-bit WAV, which is what ffmpeg wants downstream.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SR = 44100;

// ratio to the fundamental, amplitude, decay time in seconds
const PARTIALS = [
  [0.5, 1.0, 6.0], // hum
  [1.0, 0.8, 4.5], // prime
  [1.2, 0.5, 3.5], // tierce: the minor third
  [1.5, 0.35, 3.0], // quint
  [2.0, 0.5, 2.5], // nominal
  [2.5, 0.2, 1.8],
  [3.0, 0.25, 1.5],
  [4.2, 0.12, 1.0],
  [5.4, 0.08, 0.8],
];

/** Seeded, so two runs of the show produce the same bells. */
function rand(seed = 7) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** One strike, added into buf at t0 seconds. */
function strike(buf, t0, f0, amp, rnd) {
  const start = Math.floor(t0 * SR);
  const len = Math.min(buf.length - start, Math.floor(8 * SR));
  if (len <= 0) return;
  const phases = PARTIALS.map(() => rnd() * Math.PI * 2);
  const detune = PARTIALS.map(() => 1 + (rnd() - 0.5) * 0.004);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let v = 0;
    for (let p = 0; p < PARTIALS.length; p++) {
      const [ratio, a, tau] = PARTIALS[p];
      v += a * Math.exp(-t / tau) * Math.sin(2 * Math.PI * f0 * ratio * detune[p] * t + phases[p]);
    }
    // The clapper itself: a burst of noise that dies almost immediately.
    v += Math.exp(-t * 60) * (rnd() - 0.5) * 0.6;
    // Take the click off the very front so it swells rather than pops.
    v *= 1 - Math.exp(-t * 400);
    buf[start + i] += amp * v * 0.14;
  }
}

/** Feedback delays. Not a real reverb, but a big empty stone room is mostly delay. */
function reverb(buf, taps = [[0.091, 0.35], [0.173, 0.28], [0.311, 0.22], [0.457, 0.15]]) {
  for (const [time, gain] of taps) {
    const k = Math.floor(time * SR);
    let g = gain;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = buf.length - 1; i >= k; i--) buf[i] += buf[i - k] * g;
      g *= 0.55;
    }
  }
}

export function renderBells(seconds = 26) {
  const n = Math.floor(seconds * SR);
  const buf = new Float64Array(n);
  const rnd = rand();

  // A slow toll, and a second, higher bell answering off the beat. The answers
  // walk downward, which is what makes it sound like it means something bad.
  const answers = [130.81, 130.81, 123.47, 130.81, 123.47, 116.54];
  for (let i = 0, t = 0; t < seconds; i++, t += 3.2) {
    strike(buf, t, 110, 0.9, rnd);
    if (t + 1.7 < seconds) strike(buf, t + 1.7, answers[i % answers.length], 0.45, rnd);
  }

  reverb(buf);

  // A drone underneath, breathing slowly, plus a little wind.
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    buf[i] += 0.1 * Math.sin(2 * Math.PI * 55 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.13 * t));
    buf[i] += 0.05 * Math.sin(2 * Math.PI * 82.4 * t);
  }

  // Fade in slowly so it arrives under the voice rather than announcing itself,
  // and fade the tail so the hard cut at the end is the only hard edge.
  const fi = Math.floor(2.5 * SR);
  for (let i = 0; i < fi && i < n; i++) buf[i] *= i / fi;
  const fo = Math.floor(2.0 * SR);
  for (let i = 0; i < fo && i < n; i++) buf[n - 1 - i] *= i / fo;

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
  // Deliberately below full scale: this is a bed, it sits under Model 7.
  const scale = peak > 0 ? 0.55 / peak : 0;

  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf[i] * scale * 32767))), i * 2);
  return pcm;
}

export function writeBells(path = "data/audio/bells.wav", seconds = 26) {
  const pcm = renderBells(seconds);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([head, pcm]));
  return path;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("bells.mjs")) {
  const seconds = Number(process.argv[2]) || 26;
  const out = process.argv[3] || "data/audio/bells.wav";
  writeBells(out, seconds);
  console.log(`wrote ${out}, ${seconds}s`);
}
