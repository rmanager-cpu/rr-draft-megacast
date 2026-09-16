#!/usr/bin/env python3
"""Render a booth recap script (booth/recaps/*.md) to one MP3 with offline Piper voices.

Usage: python3 scripts/recap-tts.py booth/recaps/2026-week01.md out.mp3 [--voices DIR]

Script format: header text, then lines of "SPEAKER: text" plus markers [STING], [BELLS],
[SCREAM], [HARD CUT]. Voices are Piper ONNX models (rhasspy/piper via the sherpa-onnx
GitHub release). Model 7 is a Piper voice run through pitch drop, ring modulation,
bit-crush and reverb. Bells and the scream are synthesized in numpy (no samples needed).
"""
import re, sys, os, wave, io, argparse, subprocess
import numpy as np
from scipy.signal import resample_poly, butter, sosfilt
from piper import PiperVoice, SynthesisConfig

SR = 44100
rng = np.random.default_rng(7)

ap = argparse.ArgumentParser()
ap.add_argument('script'); ap.add_argument('out')
ap.add_argument('--voices', default=os.environ.get('PIPER_VOICES', 'voices'))
args = ap.parse_args()
V = args.voices

CAST = {  # speaker -> (model dir, file stem, length_scale, speaker_id)
    'WARREN':  ('vits-piper-en_US-ryan-high',     'en_US-ryan-high',     0.93, None),
    'ALLISON': ('vits-piper-en_US-kristin-medium','en_US-kristin-medium',0.97, None),
    'ELDRIN':  ('vits-piper-en_US-hfc_male-medium','en_US-hfc_male-medium',1.08, None),
    'MODEL 7': ('vits-piper-en_US-joe-medium',    'en_US-joe-medium',    1.35, None),
}
_voices = {}
def voice(sp):
    if sp not in _voices:
        d, stem, _, _ = CAST[sp]
        _voices[sp] = PiperVoice.load(os.path.join(V, d, stem + '.onnx'))
    return _voices[sp]

def tts(sp, text):
    d, stem, ls, sid = CAST[sp]
    v = voice(sp)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        v.synthesize_wav(text, w, syn_config=SynthesisConfig(length_scale=ls, noise_scale=0.667, noise_w_scale=0.8, speaker_id=sid))
    buf.seek(0)
    with wave.open(buf, 'rb') as w:
        sr = w.getframerate(); n = w.getnframes()
        y = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768
    if sr != SR:
        y = resample_poly(y, SR, sr)
    return y

def silence(sec): return np.zeros(int(SR * sec), dtype=np.float32)

def reverb(x, taps=((0.061, 0.35), (0.137, 0.25), (0.251, 0.18), (0.409, 0.12)), wet=0.35):
    out = x.copy()
    for d, g in taps:
        k = int(d * SR); y = np.zeros_like(x); y[k:] = x[:-k] * g
        for _ in range(3):
            z = np.zeros_like(x); z[k:] = y[:-k] * 0.6; y = y + z
        out = out + wet * y
    return out

def model7_fx(y, stage):
    """stage 0..2: escalating corruption."""
    # pitch drop by resampling (also slows)
    f = [0.86, 0.80, 0.72][stage]
    y = resample_poly(y, int(1000 * 1 / f), 1000) if f != 1 else y
    t = np.arange(len(y)) / SR
    # ring modulation
    rm = [28, 34, 41][stage]; depth = [0.45, 0.6, 0.75][stage]
    y = y * ((1 - depth) + depth * np.sign(np.sin(2 * np.pi * rm * t)) * 0.5 + depth * 0.5 * np.sin(2 * np.pi * rm * 1.5 * t))
    # detuned double
    k = int(0.022 * SR); dbl = np.zeros_like(y); dbl[k:] = y[:-k]
    dbl = resample_poly(dbl, 1000, 1010)[:len(y)]; dbl = np.pad(dbl, (0, len(y) - len(dbl)))
    y = y + 0.6 * dbl
    # sub layer follows the envelope
    env = np.abs(y); sos = butter(2, 30, 'low', fs=SR, output='sos'); env = sosfilt(sos, env)
    y = y + [0.15, 0.3, 0.45][stage] * env / (env.max() + 1e-9) * np.sin(2 * np.pi * 55 * t)
    # bit crush
    bits = [8, 6, 5][stage]; q = 2 ** (bits - 1)
    y = np.round(np.tanh(y * [1.4, 2.0, 3.0][stage]) * q) / q
    # band limit like a bad intercom, then reverb
    sos = butter(3, [140, [5200, 4200, 3400][stage]], 'band', fs=SR, output='sos'); y = sosfilt(sos, y)
    y = reverb(y, wet=[0.3, 0.45, 0.6][stage])
    return y / (np.max(np.abs(y)) + 1e-9) * [0.7, 0.82, 0.95][stage]

def sting():
    dur = 1.6; t = np.arange(int(SR * dur)) / SR
    y = np.zeros_like(t)
    for f, a in [(110, 1), (164.8, 0.7), (220, 0.8), (329.6, 0.5), (440, 0.4), (659, 0.2)]:
        y += a * np.sin(2 * np.pi * f * t + 0.3 * np.sin(2 * np.pi * 5 * t)) * np.exp(-t * 1.6)
    hit = rng.normal(0, 1, len(t)) * np.exp(-t * 18)
    sos = butter(2, [80, 3000], 'band', fs=SR, output='sos'); hit = sosfilt(sos, hit)
    y = np.tanh(1.5 * (y / np.max(np.abs(y)) + 0.6 * hit / np.max(np.abs(hit))))
    return reverb(y, wet=0.25) * 0.8

def bell(f0, dur, amp=1.0):
    parts = [(0.5, 1.0, 6.0), (1.0, 0.8, 4.5), (1.2, 0.5, 3.5), (1.5, 0.35, 3.0), (2.0, 0.5, 2.5), (2.5, 0.2, 1.8), (3.0, 0.25, 1.5), (4.2, 0.12, 1.0), (5.4, 0.08, 0.8)]
    t = np.linspace(0, dur, int(SR * dur), endpoint=False); y = np.zeros_like(t)
    for r, a, tau in parts:
        y += a * np.exp(-t / tau) * np.sin(2 * np.pi * f0 * r * (1 + rng.normal(0, 0.002)) * t + rng.uniform(0, 6.28))
    y += np.exp(-t * 60) * rng.normal(0, 0.3, len(t)); y *= (1 - np.exp(-t * 400))
    return amp * y / np.max(np.abs(y))

def bells_bed(total):
    n = int(SR * total); out = np.zeros(n)
    t0 = 0.0; i = 0
    while t0 < total:
        b = bell(110, 8.0, 0.9); s = int(t0 * SR); e = min(n, s + len(b)); out[s:e] += b[:e - s]
        if t0 + 1.7 < total:
            f = [130.8, 130.8, 123.5, 116.5][i % 4]
            b = bell(f, 6.0, 0.45); s = int((t0 + 1.7) * SR); e = min(n, s + len(b)); out[s:e] += b[:e - s]
        t0 += 3.2; i += 1
    out = reverb(out, taps=((0.091, 0.35), (0.173, 0.28), (0.311, 0.22), (0.457, 0.15)), wet=0.4)
    t = np.arange(n) / SR
    out += 0.12 * np.sin(2 * np.pi * 55 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.13 * t)) + 0.06 * np.sin(2 * np.pi * 82.4 * t)
    w = sosfilt(butter(2, 600, 'low', fs=SR, output='sos'), rng.normal(0, 1, n)) * 0.05 * (0.5 + 0.5 * np.sin(2 * np.pi * 0.21 * t + 1))
    out += w
    fi = int(2.5 * SR); out[:fi] *= np.linspace(0, 1, fi)
    return out / np.max(np.abs(out))

def scream(dur=2.6):
    n = int(SR * dur); t = np.arange(n) / SR
    f0 = 380 + 520 * np.clip(t / 0.35, 0, 1) - 260 * np.clip((t - 1.4) / 1.2, 0, 1)
    f0 = f0 * (1 + 0.06 * np.sin(2 * np.pi * 7.5 * t) + 0.02 * np.sin(2 * np.pi * 23 * t))
    f0 = f0 * (1 + 0.08 * np.sin(np.cumsum(rng.normal(0, 0.004, n)) * 3))
    phase = 2 * np.pi * np.cumsum(f0) / SR
    src = sum((1.0 / h) * np.sin(h * phase) for h in range(1, 30))
    src = src + 0.9 * rng.normal(0, 1, n) * (0.3 + 0.7 * np.clip(t / 0.5, 0, 1))
    out = np.zeros(n)
    for fc, bw, g in [(900, 150, 1.0), (1500, 200, 0.8), (2800, 300, 0.9), (3600, 350, 0.6), (4500, 500, 0.4)]:
        out += g * sosfilt(butter(2, [fc - bw / 2, fc + bw / 2], 'band', fs=SR, output='sos'), src)
    out = np.tanh(3.0 * out / np.max(np.abs(out)))
    env = np.clip(t / 0.05, 0, 1) * np.exp(-np.clip(t - 1.6, 0, None) * 2.2)
    env *= 1 - 0.25 * np.clip(np.sin(2 * np.pi * 11 * t), 0, 1) * np.clip((t - 1.2) / 0.5, 0, 1)
    out *= env
    out2 = sosfilt(butter(2, [250, 900], 'band', fs=SR, output='sos'), np.tanh(2 * np.sin(phase * 0.5) + 0.5 * rng.normal(0, 1, n))) * env * 0.5
    out = reverb(out + out2, wet=0.3)
    return out / np.max(np.abs(out)) * 0.98

# ---- parse -------------------------------------------------------------
lines = open(args.script).read().splitlines()
try:
    start = next(i for i, l in enumerate(lines) if l.strip() == '[STING]')
except StopIteration:
    start = 0
items = []
for l in lines[start:]:
    l = l.strip()
    if not l: continue
    m = re.match(r'^\[(.+)\]$', l)
    if m: items.append(('MARK', m.group(1).upper())); continue
    m = re.match(r'^([A-Z][A-Z 0-9]+):\s*(.+)$', l)
    if m and m.group(1) in CAST: items.append((m.group(1), m.group(2))); continue
    print('skip:', l[:60], file=sys.stderr)

# ---- render ------------------------------------------------------------
track = []
def add(x): track.append(x.astype(np.float32))
i = 0
while i < len(items):
    sp, text = items[i]
    if sp == 'MARK' and text == 'STING':
        add(sting()); add(silence(0.4)); i += 1; continue
    if sp == 'MARK' and text == 'BELLS':
        # everything between [BELLS] and [SCREAM] is Model 7 over the bells bed
        j = i + 1; m7 = []
        while j < len(items) and not (items[j][0] == 'MARK' and items[j][1] == 'SCREAM'):
            if items[j][0] == 'MODEL 7': m7.append(items[j][1])
            j += 1
        lead = 3.0; gap = 2.4; tail = 1.2
        clips = [model7_fx(tts('MODEL 7', t), min(k, 2)) for k, t in enumerate(m7)]
        total = lead + sum(len(c) / SR for c in clips) + gap * (len(clips) - 1) + tail
        bed = bells_bed(total) * 0.55
        pos = int(lead * SR)
        for c in clips:
            e = min(len(bed), pos + len(c)); bed[pos:e] += c[:e - pos]; pos = e + int(gap * SR)
        add(bed)
        # the scream, then the hard cut
        sc = scream()
        # let the last bell ring under the scream's first half, then cut everything
        add(sc); add(silence(0.25))
        i = j + 1
        while i < len(items) and items[i][0] == 'MARK': i += 1
        continue
    if sp == 'MARK':
        i += 1; continue
    y = tts(sp, text)
    add(y); add(silence(0.55)); i += 1

mix = np.concatenate(track)
mix = mix / (np.max(np.abs(mix)) + 1e-9) * 0.93
tmp = args.out + '.wav'
import soundfile as sf
sf.write(tmp, mix, SR)
try:
    import imageio_ffmpeg; ff = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    ff = 'ffmpeg'
subprocess.run([ff, '-v', 'error', '-y', '-i', tmp, '-codec:a', 'libmp3lame', '-b:a', '160k', args.out], check=True)
os.remove(tmp)
print(f'{args.out}: {len(mix)/SR:.1f}s')
