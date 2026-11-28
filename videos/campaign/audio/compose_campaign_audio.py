#!/usr/bin/env python3
"""
Hirearchy Launch Campaign — Studio Acoustic & Tactile Foley Audio Engine (v2 — Cinematic Breathing).

Key creative upgrades after listening QA:
  - Eliminates relentless mechanical 8th-note arpeggios in Acts II–V.
  - Uses human-phrased felt upright piano melodies (micro-timing rubato + velocity contour),
    evolving chamber strings, warm deep sub-bass, and generous negative space.
  - In Act III (IDE), strips melodic clutter so the tactile HHKB mechanical keystrokes,
    soft velvet pulse, and Hirearchy harmonic chimes BECOME the rhythm section.
  - Preserves crystalline breathing silences before "The work is everything." and
    "Evidence informs. People decide."

Outputs 48 kHz 24-bit stereo WAVs mastered to -14.0 LUFS:
  - public/audio/master-16x9.wav (84.0s)
  - public/audio/reel-9x16.wav   (38.0s)
  - public/audio/teaser-16x9.wav (24.0s)
"""

import json
import math
import pathlib
import subprocess
import tempfile
import wave
import numpy as np

SR = 48000
ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "audio"
OUT_DIR.mkdir(parents=True, exist_ok=True)

RNG = np.random.default_rng(20261124)

NOTE_MAP = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4,
    "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9,
    "A#": 10, "Bb": 10, "B": 11,
}


def n2m(name: str) -> int:
    if len(name) >= 2 and name[1] in "#b":
        pc, octv = name[:2], int(name[2:])
    else:
        pc, octv = name[0], int(name[1:])
    return (octv + 1) * 12 + NOTE_MAP[pc]


def n2f(name: str) -> float:
    return 440.0 * (2.0 ** ((n2m(name) - 69.0) / 12.0))


def one_pole_lp(x: np.ndarray, cutoff_hz: float) -> np.ndarray:
    n = len(x)
    if n < 8:
        return x
    freqs = np.fft.rfftfreq(n, d=1.0 / SR)
    h = 1.0 / np.sqrt(1.0 + (freqs / max(cutoff_hz, 20.0)) ** 4)
    return np.fft.irfft(np.fft.rfft(x) * h, n=n)


def bandpass_fft(x: np.ndarray, lo_hz: float, hi_hz: float) -> np.ndarray:
    n = len(x)
    if n < 8:
        return x
    freqs = np.fft.rfftfreq(n, d=1.0 / SR)
    hp = 1.0 / np.sqrt(1.0 + (max(lo_hz, 10.0) / np.maximum(freqs, 1e-6)) ** 4)
    lp = 1.0 / np.sqrt(1.0 + (freqs / max(hi_hz, lo_hz + 20.0)) ** 4)
    return np.fft.irfft(np.fft.rfft(x) * hp * lp, n=n)


def add_stereo(buf: np.ndarray, sig: np.ndarray, start_s: float, pan: float = 0.0, gain: float = 1.0):
    i0 = int(round(start_s * SR))
    if i0 >= buf.shape[1] or i0 + len(sig) <= 0:
        return
    src_start = max(0, -i0)
    dst_start = max(0, i0)
    length = min(len(sig) - src_start, buf.shape[1] - dst_start)
    if length <= 0:
        return
    angle = (np.clip(pan, -1.0, 1.0) + 1.0) * 0.25 * math.pi
    chunk = sig[src_start : src_start + length]
    buf[0, dst_start : dst_start + length] += chunk * (math.cos(angle) * gain)
    buf[1, dst_start : dst_start + length] += chunk * (math.sin(angle) * gain)


def synth_felt_piano(note: str, dur: float = 3.4, vel: float = 0.68) -> np.ndarray:
    """Physical-modeled Nils Frahm felt upright piano (warm wool hammer, 3 unison strings, subtle inharmonicity)."""
    f0 = n2f(note)
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float64) / SR
    sig = np.zeros(n, dtype=np.float64)
    B = 0.00014 * (f0 / 261.63) ** 0.35
    max_partials = min(9, int((SR * 0.40) / max(f0, 40.0)))
    detunes = (-0.00024, 0.0, 0.00028)
    atk_s = 0.012 + (1.0 - vel) * 0.011
    atk_env = 1.0 - np.exp(-t / atk_s)

    for k in range(1, max_partials + 1):
        fk = k * f0 * math.sqrt(1.0 + B * k * k)
        if fk > 8500.0:
            break
        rolloff = 1.0 / (k ** (1.78 + (1.0 - vel) * 0.45))
        if k == 2:
            rolloff *= 0.84
        elif k == 3:
            rolloff *= 0.60
        tau = (dur * 0.64) / ((k ** 1.28) * (0.65 + (f0 / 500.0) ** 0.45))
        env = atk_env * np.exp(-t / max(tau, 0.04))
        fade_len = min(int(0.20 * SR), n // 4)
        if fade_len > 0:
            env[-fade_len:] *= np.linspace(1.0, 0.0, fade_len)
        psum = np.zeros(n, dtype=np.float64)
        for d in detunes:
            psum += np.sin(2.0 * math.pi * fk * (1.0 + d) * t + RNG.uniform(0.0, 0.3))
        sig += (psum / 3.0) * rolloff * env

    thud_n = min(n, int(0.055 * SR))
    thud = bandpass_fft(RNG.standard_normal(thud_n) * np.exp(-np.arange(thud_n) / (0.009 * SR)), 90.0, 480.0) * (0.08 * vel)
    sig[:thud_n] += thud

    sig = one_pole_lp(sig, 1550.0 + vel * 1900.0)
    peak = np.max(np.abs(sig)) + 1e-9
    return (sig / peak) * (0.44 * vel)


def add_felt_chord(wet: np.ndarray, notes: list[str], start_s: float, dur: float = 3.6, vel: float = 0.62, spread: float = 0.032):
    """Plays an expressive arpeggiated-micro-rolled felt piano chord with realistic pianist stereo spread."""
    for i, note in enumerate(notes):
        midi = n2m(note)
        pan = float(np.clip((midi - 60) / 36.0, -0.45, 0.45))
        jitter = float(RNG.uniform(-0.005, 0.005))
        v = vel * (0.92 if i == 0 else (0.85 + 0.14 * (i == len(notes) - 1)))
        add_stereo(wet, synth_felt_piano(note, dur, v), start_s + i * spread + jitter, pan=pan, gain=0.90)


def synth_muted_harp(note: str, dur: float = 1.15, vel: float = 0.50) -> np.ndarray:
    """Delicate palm-muted felt harp / acoustic pizzicato pluck — sparse accent, NEVER buzzy."""
    f0 = n2f(note)
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float64) / SR
    sig = (
        1.00 * np.sin(2 * math.pi * f0 * t) * np.exp(-t / (0.30 + 0.10 * vel))
        + 0.28 * np.sin(2 * math.pi * f0 * 2.0 * t + 0.15) * np.exp(-t / 0.11)
        + 0.09 * np.sin(2 * math.pi * f0 * 3.0 * t + 0.3) * np.exp(-t / 0.045)
    )
    atk = min(int(0.004 * SR), n)
    sig[:atk] *= np.linspace(0.0, 1.0, atk)
    sig = one_pole_lp(sig, 2400.0)
    peak = np.max(np.abs(sig)) + 1e-9
    return (sig / peak) * (0.22 * vel)


def synth_chamber_strings(notes: list[str], dur: float, vel: float = 0.38, attack: float = 1.8, release: float = 2.4) -> np.ndarray:
    """Warm, intimate chamber cello/viola ensemble pad — lush emotional weight."""
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float64) / SR
    sig = np.zeros(n, dtype=np.float64)
    for idx, note in enumerate(notes):
        f0 = n2f(note)
        vib = 1.0 + 0.0020 * np.sin(2 * math.pi * (4.3 + idx * 0.31) * t + idx)
        ph = 2 * math.pi * np.cumsum(f0 * vib) / SR
        for k in range(1, 7):
            if f0 * k > 2200:
                break
            amp = (1.0 / (k ** 1.62)) * (0.72 if k % 2 == 0 else 1.0)
            det = 1.0 + (0.00055 if idx % 2 else -0.00055)
            sig += amp * np.sin(ph * k * det + idx * 0.9)
    env = np.ones(n, dtype=np.float64)
    a_n = min(int(attack * SR), n // 2)
    r_n = min(int(release * SR), n // 2)
    if a_n > 0:
        env[:a_n] = 0.5 - 0.5 * np.cos(np.linspace(0, math.pi, a_n))
    if r_n > 0:
        env[-r_n:] = 0.5 + 0.5 * np.cos(np.linspace(0, math.pi, r_n))
    sig = one_pole_lp(sig * env, 1050.0)
    peak = np.max(np.abs(sig)) + 1e-9
    return (sig / peak) * (0.28 * vel)


def synth_sub_breath(note: str, dur: float = 2.1, vel: float = 0.50) -> np.ndarray:
    """Warm analog low bass swell (smooth, velvety foundation)."""
    f0 = n2f(note)
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float64) / SR
    env = (1.0 - np.exp(-t / 0.05)) * np.exp(-t / (dur * 0.72))
    fade = min(int(0.18 * SR), n // 4)
    env[-fade:] *= np.linspace(1.0, 0.0, fade)
    sig = (np.sin(2 * math.pi * f0 * t) + 0.18 * np.sin(4 * math.pi * f0 * t)) * env
    sig = one_pole_lp(sig, 220.0)
    return sig * (0.34 * vel)


def synth_brand_chime(cue: str, vel: float = 0.65) -> np.ndarray:
    """Acoustic evolution of Hirearchy's exact in-app sound palette (apps/web/src/ui/sound.ts)."""
    patterns = {
        "confirm":  [("D5", 0.0, 1.3), ("A5", 0.08, 1.7)],
        "dispatch": [("E5", 0.0, 1.2), ("B5", 0.09, 1.8)],
        "submit":   [("D5", 0.0, 1.8), ("F#5", 0.075, 2.0), ("A5", 0.15, 2.5)],
        "complete": [("F#5", 0.0, 1.5), ("A5", 0.085, 2.0), ("D6", 0.18, 2.4)],
        "error":    [("E4", 0.0, 0.34), ("C#4", 0.09, 0.44)],
    }
    steps = patterns[cue]
    total_dur = max(off + d for _, off, d in steps) + 0.1
    out = np.zeros(int(total_dur * SR), dtype=np.float64)
    for note, off, d in steps:
        f = n2f(note)
        n = int(d * SR)
        t = np.arange(n, dtype=np.float64) / SR
        if cue == "error":
            tone = (np.sin(2 * math.pi * f * t) + 0.18 * np.sin(4 * math.pi * f * t)) * (1 - np.exp(-t / 0.01)) * np.exp(-t / 0.14)
            tone = one_pole_lp(tone, 620.0) * 0.34
        else:
            tone = (
                0.80 * np.sin(2 * math.pi * f * t) * np.exp(-t / (d * 0.44))
                + 0.20 * np.sin(2 * math.pi * f * 2.0 * t) * np.exp(-t / (d * 0.15))
            ) * (1.0 - np.exp(-t / 0.008))
            tone = one_pole_lp(tone, 3600.0) * 0.28
        i0 = int(off * SR)
        out[i0 : i0 + n] += tone
    peak = np.max(np.abs(out)) + 1e-9
    return (out / peak) * (0.24 * vel)


def foley_tick(vel: float = 0.42, bright: bool = False) -> np.ndarray:
    n = int(0.045 * SR)
    t = np.arange(n) / SR
    noise = RNG.standard_normal(n) * np.exp(-t / 0.0020)
    click = bandpass_fft(noise, 1300.0 if bright else 750.0, 4800.0 if bright else 2600.0)
    body = np.sin(2 * math.pi * (160.0 if not bright else 265.0) * t) * np.exp(-t / 0.0055) * 0.32
    sig = click * 0.65 + body
    return (sig / (np.max(np.abs(sig)) + 1e-9)) * (0.16 * vel)


def foley_brush_pulse(vel: float = 0.32) -> np.ndarray:
    """Whisper-soft jazz-brush / felt shaker whisper for human forward momentum."""
    n = int(0.095 * SR)
    t = np.arange(n) / SR
    env = (1.0 - np.exp(-t / 0.008)) * np.exp(-t / 0.026)
    sig = bandpass_fft(RNG.standard_normal(n) * env, 2400.0, 7200.0)
    return (sig / (np.max(np.abs(sig)) + 1e-9)) * (0.075 * vel)


def foley_velvet_kick(vel: float = 0.52) -> np.ndarray:
    n = int(0.20 * SR)
    t = np.arange(n) / SR
    freq = 46.0 + 68.0 * np.exp(-t / 0.020)
    ph = 2 * math.pi * np.cumsum(freq) / SR
    env = (1.0 - np.exp(-t / 0.004)) * np.exp(-t / 0.070)
    sig = np.sin(ph) * env
    tap_n = min(n, int(0.012 * SR))
    sig[:tap_n] += bandpass_fft(RNG.standard_normal(tap_n), 180.0, 820.0) * np.exp(-np.arange(tap_n) / (0.0025 * SR)) * 0.12
    sig = one_pole_lp(sig, 200.0)
    return (sig / (np.max(np.abs(sig)) + 1e-9)) * (0.34 * vel)


def foley_keystroke(vel: float = 0.50, pitch_jitter: float = 0.0) -> np.ndarray:
    """Authentic HHKB tactile PBT keystroke thock."""
    n = int(0.042 * SR)
    t = np.arange(n) / SR
    click = bandpass_fft(RNG.standard_normal(n), 1700.0 + pitch_jitter * 220, 5200.0) * np.exp(-t / 0.0018)
    thock = np.sin(2 * math.pi * (205.0 + pitch_jitter * 24.0) * t) * np.exp(-t / 0.0055)
    sig = click * 0.52 + thock * 0.58
    return (sig / (np.max(np.abs(sig)) + 1e-9)) * (0.16 * vel)


def foley_paper_turn(dur: float = 0.50, vel: float = 0.48) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    white = RNG.standard_normal(n)
    freqs = np.fft.rfftfreq(n, d=1.0 / SR)
    pink = np.fft.irfft(np.fft.rfft(white) / np.maximum(freqs, 30.0) ** 0.58, n=n)
    env = np.sin(math.pi * np.clip(t / dur, 0, 1)) ** 1.65
    grain = 0.86 + 0.14 * np.sin(2 * math.pi * 15.0 * t + 0.4)
    sig = bandpass_fft(pink * env * grain, 260.0, 1950.0)
    return (sig / (np.max(np.abs(sig)) + 1e-9)) * (0.16 * vel)


def foley_silk_swell(note: str = "A4", dur: float = 1.6, vel: float = 0.36) -> np.ndarray:
    f = n2f(note)
    n = int(dur * SR)
    t = np.arange(n) / SR
    env = np.sin(math.pi * (t / dur)) ** 1.6
    sig = (0.65 * np.sin(2 * math.pi * f * t) + 0.25 * np.sin(2 * math.pi * f * 1.5 * t) + 0.12 * np.sin(2 * math.pi * f * 2.0 * t)) * env
    sig = one_pole_lp(sig, 2900.0)
    return (sig / (np.max(np.abs(sig)) + 1e-9)) * (0.14 * vel)


def build_studio_ir(rt60: float = 2.1) -> np.ndarray:
    n = int(rt60 * SR)
    t = np.arange(n, dtype=np.float64) / SR
    ir = np.zeros((2, n), dtype=np.float64)
    early_l = [(0.012, 0.40), (0.021, 0.30), (0.033, 0.24), (0.048, 0.18), (0.068, 0.13)]
    early_r = [(0.014, 0.38), (0.025, 0.28), (0.037, 0.22), (0.052, 0.17), (0.074, 0.12)]
    for ch, taps in enumerate((early_l, early_r)):
        for sec, amp in taps:
            idx = int(sec * SR)
            if idx < n:
                ir[ch, idx] += amp
    decay = np.exp(-6.907 * t / rt60) * (1.0 - np.exp(-t / 0.050))
    for ch in range(2):
        ir[ch] += one_pole_lp(RNG.standard_normal(n) * decay * 0.28, 3000.0)
        ir[ch] /= math.sqrt(np.sum(ir[ch] ** 2) + 1e-9)
    return ir


STUDIO_IR = build_studio_ir(2.1)


def convolve_reverb(stereo: np.ndarray, wet: float = 0.40) -> np.ndarray:
    n_sig = stereo.shape[1]
    n_ir = STUDIO_IR.shape[1]
    n_fft = 1 << (n_sig + n_ir - 1).bit_length()
    out = np.zeros_like(stereo)
    for ch in range(2):
        conv = np.fft.irfft(np.fft.rfft(stereo[ch], n=n_fft) * np.fft.rfft(STUDIO_IR[ch], n=n_fft), n=n_fft)[:n_sig]
        out[ch] = stereo[ch] * (1.0 - wet * 0.35) + conv * wet
    return out


def master_and_write(dry: np.ndarray, wet_bus: np.ndarray, out_path: pathlib.Path):
    reverb_bus = convolve_reverb(wet_bus, wet=0.42)
    mix = dry + reverb_bus
    n = mix.shape[1]
    room_air = np.vstack([
        bandpass_fft(RNG.standard_normal(n), 55.0, 820.0),
        bandpass_fft(RNG.standard_normal(n), 55.0, 820.0),
    ]) * 0.0005
    mix += room_air
    mix = np.tanh(mix * 1.08) / 1.08

    fi = min(int(0.04 * SR), n // 8)
    fo = min(int(0.55 * SR), n // 4)
    mix[:, :fi] *= np.linspace(0.0, 1.0, fi)
    mix[:, -fo:] *= np.linspace(1.0, 0.0, fo)
    mix = mix * (0.79 / (np.max(np.abs(mix)) + 1e-9))

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        raw_wav = pathlib.Path(tf.name)
    pcm = np.clip(mix.T * 32767.0, -32768, 32767).astype(np.int16)
    with wave.open(str(raw_wav), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(pcm.tobytes())

    af_base = "highpass=f=28,equalizer=f=300:t=q:w=1.1:g=-1.5,treble=g=1.2:f=7500"
    pass1 = subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-i", str(raw_wav), "-af", f"{af_base},loudnorm=I=-14:TP=-1.0:LRA=10:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    stderr = pass1.stderr
    stats = json.loads(stderr[stderr.rfind("{") : stderr.rfind("}") + 1])
    loudnorm2 = (
        f"loudnorm=I=-14:TP=-1.0:LRA=10:linear=true:"
        f"measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
        f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:"
        f"offset={stats['target_offset']}"
    )
    subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(raw_wav), "-af", f"{af_base},{loudnorm2}", "-ar", str(SR), "-ac", "2", "-c:a", "pcm_s24le", str(out_path)],
        check=True,
    )
    raw_wav.unlink(missing_ok=True)
    print(f"[MASTERED v2] {out_path} ({out_path.stat().st_size:,} bytes, in={stats['input_i']} -> -14.0 LUFS)")


# ==============================================================================
# FILM 1: HERO LAUNCH FILM (84.0s) — Dynamic Breathing Nils Frahm / Anthropic Score
# ==============================================================================
def compose_hero_master_84s():
    dur = 84.0
    n = int(dur * SR)
    dry = np.zeros((2, n), dtype=np.float64)
    wet = np.zeros((2, n), dtype=np.float64)
    beat = 60.0 / 98.0  # 0.6122s — calm, poised, architectural!

    # --- ACT I: THE ILLUSION (0.0 – 11.5s) ---
    add_felt_chord(wet, ["B1", "F#2", "D4"], 0.15, dur=5.2, vel=0.56, spread=0.06)
    add_stereo(wet, synth_felt_piano("A4", 3.6, 0.44), 1.45, pan=0.26)
    # Crisp horological pulse during the two 100% cards (1.0 – 7.2s)
    t_tick = 1.05
    ti = 0
    while t_tick < 7.20:
        add_stereo(dry, foley_tick(0.42 if ti % 2 == 0 else 0.24, bright=(ti % 4 == 0)), t_tick, pan=0.06 if ti % 2 else -0.06)
        t_tick += beat * 0.5
        ti += 1

    # X-ray contrast reveal (4.15s)
    add_stereo(dry, foley_paper_turn(0.42, 0.52), 4.10, pan=-0.18)
    add_felt_chord(wet, ["G1", "D3", "F#4"], 4.20, dur=3.2, vel=0.52, spread=0.04)
    add_stereo(wet, synth_felt_piano("E4", 2.2, 0.44), 5.85, pan=0.18)

    # 7.35 – 8.15s: CRYSTALLINE BREATHING SILENCE + cotton paper turn
    add_stereo(dry, foley_paper_turn(0.56, 0.54), 7.58, pan=0.0)
    # 8.2s: "The answer is cheap."
    add_felt_chord(wet, ["D3", "A3"], 8.20, dur=2.6, vel=0.54, spread=0.03)
    # 9.4s: "The work is everything." — luminous blooming Dmaj9 + mint silk swell
    add_felt_chord(wet, ["D2", "A2", "F#3", "E4", "A4"], 9.38, dur=4.4, vel=0.68, spread=0.042)
    add_stereo(wet, foley_silk_swell("A4", 2.0, 0.52), 9.55, pan=0.18)

    # --- ACT II: THE REAL TASK (11.5 – 21.5s) — Sparse Architectural Piano + Dry Pulse ---
    add_stereo(dry, foley_paper_turn(0.52, 0.54), 11.45, pan=0.12)
    add_stereo(wet, synth_chamber_strings(["D3", "A3", "E4"], 10.4, vel=0.34, attack=1.8, release=2.2), 11.6)

    # Sparse, expressive felt piano voicings (4 distinct bars, LOTS of air!)
    act2_bars = [
        (11.9, "D2", ["D3", "A3", "F#4"], [("A4", 0.62), ("E5", 1.54)]),
        (14.35, "B1", ["B2", "F#3", "D4"], [("A4", 0.62), ("F#4", 1.54)]),
        (16.80, "G1", ["G2", "D3", "B3", "F#4"], [("A4", 0.92)]),
        (19.25, "A1", ["A2", "E3", "C#4"], [("E4", 0.62), ("A4", 1.24)]),
    ]
    for bt, bass, chord, melody in act2_bars:
        add_stereo(dry, synth_sub_breath(bass, 2.2, 0.44), bt)
        add_felt_chord(wet, chord, bt, dur=2.9, vel=0.54, spread=0.03)
        for mn, off in melody:
            if bt + off < 21.2:
                add_stereo(wet, synth_felt_piano(mn, 2.1, 0.46), bt + off, pan=0.22)
        # Understated architectural heartbeat (2 soft kicks + subtle brush per bar)
        add_stereo(dry, foley_velvet_kick(0.38), bt)
        add_stereo(dry, foley_brush_pulse(0.45), bt + beat)
        if bt + beat * 2.5 < 21.3:
            add_stereo(dry, foley_velvet_kick(0.28), bt + beat * 2.5)
            add_stereo(dry, foley_tick(0.32, bright=True), bt + beat * 3.0, pan=0.16)

    # UI Sync Foley for Act II
    add_stereo(dry, foley_tick(0.56, bright=True), 13.15, pan=-0.1)
    add_stereo(dry, foley_tick(0.56, bright=True), 15.30, pan=0.1)
    add_stereo(wet, synth_brand_chime("confirm", 0.58), 17.30, pan=0.22)
    add_stereo(wet, synth_brand_chime("dispatch", 0.80), 19.45, pan=0.15)

    # --- ACT III: THE AUTHENTIC IDE (21.5 – 39.0s) — Deep Velvet Groove + Mechanical Typing AS Percussion ---
    add_stereo(dry, foley_paper_turn(0.50, 0.48), 21.45)
    add_stereo(wet, synth_chamber_strings(["B2", "F#3", "D4"], 17.2, vel=0.40, attack=1.6, release=2.2), 21.7)

    # Sparse, deep bass & spaced piano harmonics (leaving center stage for tactile IDE Foley!)
    ide_bars = [
        (21.8, "B1", ["B2", "F#3", "D4"], [("F#4", 1.22)]),
        (24.25, "G1", ["G2", "D3", "B3"], [("A4", 1.22)]),
        (26.70, "D2", ["D3", "A3", "E4"], [("F#4", 0.92), ("A4", 1.84)]),
        (29.15, "F#1", ["F#2", "C#3", "A3"], []),          # Macro coding zoom: pure space for HHKB typing!
        (31.60, "G1", ["G2", "D3", "B3"], []),             # Pure space for HHKB typing!
        (34.05, "A1", ["A2", "E3", "C#4"], [("E5", 0.92)]),
        (36.50, "D2", ["D3", "A3", "F#4", "A4"], []),      # Resolution for 4 passed + submit!
    ]
    for bt, bass, chord, melody in ide_bars:
        is_macro = 29.0 <= bt <= 33.8
        add_stereo(dry, synth_sub_breath(bass, 2.3, 0.56), bt)
        add_felt_chord(wet, chord, bt, dur=3.0, vel=0.48 if not is_macro else 0.36, spread=0.032)
        for mn, off in melody:
            add_stereo(wet, synth_felt_piano(mn, 2.2, 0.46), bt + off, pan=0.20)
        # Gentle syncopated velvet pulse
        add_stereo(dry, foley_velvet_kick(0.48), bt)
        add_stereo(dry, foley_brush_pulse(0.44), bt + beat)
        if not is_macro and bt + beat * 2.5 < 38.0:
            add_stereo(dry, foley_velvet_kick(0.32), bt + beat * 2.5)
            add_stereo(dry, foley_tick(0.32, bright=False), bt + beat * 3.0, pan=-0.16)

    # Frame-exact IDE Foley:
    add_stereo(wet, synth_brand_chime("error", 0.72), 24.45)              # pytest 2 failed
    add_stereo(dry, foley_paper_turn(0.36, 0.44), 25.55, pan=0.35)       # Workspace AI drawer opens
    add_stereo(wet, foley_silk_swell("E5", 1.4, 0.36), 26.80, pan=0.32)  # Kimi reply streams in
    # 30.25 – 33.55s: HHKB mechanical typing rhythm (organic human cadence, NOT robotic!)
    key_times = [
        30.25, 30.38, 30.50, 30.65, 30.77, 30.94, 31.07, 31.19, 31.34,
        31.56, 31.69, 31.81, 31.95, 32.09, 32.22, 32.38, 32.51, 32.64,
        32.82, 32.96, 33.09, 33.24, 33.38,
    ]
    for ki, kt in enumerate(key_times):
        add_stereo(dry, foley_keystroke(0.54 + 0.14 * (ki % 4 == 0), (ki % 5) - 2), kt, pan=-0.14 + (ki % 3) * 0.14)
    add_stereo(wet, synth_brand_chime("confirm", 0.80), 33.80, pan=0.18) # Saved v2
    add_stereo(wet, synth_brand_chime("complete", 0.88), 36.35, pan=0.0) # 4 passed in 0.14s!
    add_stereo(wet, synth_brand_chime("submit", 0.92), 37.90, pan=0.0)   # Submit assessment!
    add_stereo(wet, foley_silk_swell("D5", 1.6, 0.50), 38.05, pan=0.0)

    # --- ACT IV: CHRONOLOGY, DIFF & PEER REVIEW (39.0 – 55.0s) — Lyrical Piano + Crisp Focus ---
    add_stereo(dry, foley_paper_turn(0.56, 0.54), 38.95, pan=-0.12)
    add_stereo(wet, synth_chamber_strings(["D3", "F#3", "A3", "E4"], 16.0, vel=0.38, attack=1.6, release=2.2), 39.2)

    act4_bars = [
        (39.4, "D2", ["D3", "A3", "F#4"], [("A4", 0.30), ("B4", 0.92), ("A4", 1.54)]),
        (41.85, "B1", ["B2", "F#3", "D4"], [("F#4", 0.30), ("A4", 1.22)]),
        (44.30, "G1", ["G2", "D3", "B3"], [("D4", 0.30), ("F#4", 0.92), ("A4", 1.54)]),
        (46.75, "A1", ["A2", "E3", "C#4"], [("E4", 0.62), ("A4", 1.54)]),
        # Lilac Peer Review (47.5s): warm conversational duet register!
        (49.20, "G1", ["G2", "D3", "B3", "F#4"], [("B4", 0.45), ("A4", 1.22), ("F#4", 1.84)]),
        (51.65, "A1", ["A2", "E3", "C#4", "A4"], [("E5", 0.45), ("D5", 1.22), ("C#5", 1.84)]),
    ]
    for bt, bass, chord, melody in act4_bars:
        add_stereo(dry, synth_sub_breath(bass, 2.3, 0.50), bt)
        add_felt_chord(wet, chord, bt, dur=3.1, vel=0.56, spread=0.03)
        for mi, (mn, off) in enumerate(melody):
            if bt + off < 54.6:
                add_stereo(wet, synth_felt_piano(mn, 2.3, 0.50), bt + off, pan=0.18 if mi % 2 == 0 else -0.14)
        # Delicate sparse harp accent on beat 2 only (NOT relentless!)
        add_stereo(wet, synth_muted_harp(chord[-1], 1.1, 0.42), bt + beat * 1.5, pan=-0.26)
        add_stereo(dry, foley_velvet_kick(0.44), bt)
        add_stereo(dry, foley_brush_pulse(0.46), bt + beat)
        add_stereo(dry, foley_velvet_kick(0.30), bt + beat * 2.5)

    # Chronology node ticks (6 crisp ticks)
    for ni in range(6):
        add_stereo(dry, foley_tick(0.46, bright=(ni == 4)), 39.75 + ni * 0.52, pan=-0.26)
    add_stereo(wet, synth_brand_chime("confirm", 0.68), 44.60, pan=0.24)  # Anchored observation
    add_stereo(dry, foley_paper_turn(0.52, 0.52), 47.45)                   # Lilac turn
    add_stereo(wet, synth_brand_chime("dispatch", 0.72), 49.00, pan=-0.30) # Sam sends peer request
    add_stereo(wet, foley_silk_swell("F#5", 1.4, 0.40), 49.40)
    add_stereo(wet, synth_brand_chime("complete", 0.80), 52.05, pan=0.30)  # Jordan approves +1

    # --- ACT V: AI SYNTHESIZES. PEOPLE DECIDE. + CONTINUITY (55.0 – 71.0s) ---
    add_stereo(dry, foley_paper_turn(0.54, 0.50), 54.95)
    add_stereo(wet, synth_chamber_strings(["B2", "F#3", "A3", "D4"], 15.8, vel=0.46, attack=1.4, release=2.6), 55.1)

    act5_bars = [
        (55.40, "B1", ["B2", "F#3", "D4", "A4"], [("F#5", 0.62), ("E5", 1.54)]),
        (57.85, "G1", ["G2", "D3", "B3", "F#4"], [("D5", 0.62), ("B4", 1.54)]),
        (60.30, "D2", ["D3", "A3", "E4", "F#4"], [("A4", 0.62)]),   # Strips down for Human Verdict seal!
        # 64.0s: Candidate Portal & Managerial Handoff — clear, uplifting daylight!
        (64.20, "G1", ["G2", "D3", "B3", "F#4"], [("A4", 0.62), ("D5", 1.45)]),
        (66.65, "A1", ["A2", "E3", "C#4", "A4"], [("E5", 0.62), ("C#5", 1.45)]),
        (69.10, "B1", ["B2", "F#3", "D4"], []),                      # Graceful exhale into Act VI
    ]
    for bt, bass, chord, melody in act5_bars:
        is_seal_or_tail = bt in (60.30, 69.10)
        add_stereo(dry, synth_sub_breath(bass, 2.4, 0.54 if not is_seal_or_tail else 0.36), bt)
        add_felt_chord(wet, chord, bt, dur=3.4, vel=0.60 if not is_seal_or_tail else 0.50, spread=0.036)
        for mn, off in melody:
            add_stereo(wet, synth_felt_piano(mn, 2.4, 0.52), bt + off, pan=0.22)
        if not is_seal_or_tail:
            add_stereo(dry, foley_velvet_kick(0.46), bt)
            add_stereo(dry, foley_brush_pulse(0.46), bt + beat)
            add_stereo(dry, foley_velvet_kick(0.32), bt + beat * 2.5)
            add_stereo(wet, synth_muted_harp(chord[-1], 1.1, 0.38), bt + beat * 3.0, pan=-0.22)

    add_stereo(wet, synth_brand_chime("complete", 0.78), 57.15, pan=-0.26) # Kimi 92/100 bloom
    add_stereo(wet, synth_brand_chime("submit", 0.94), 61.55, pan=0.24)    # Human Review Finalized!
    add_stereo(dry, foley_paper_turn(0.54, 0.50), 63.95)                   # Daylight Portal & Handoff
    add_stereo(wet, synth_brand_chime("confirm", 0.72), 67.35, pan=0.25)   # Managerial Fit Report

    # --- ACT VI: COMMON THREAD HORIZON & FINALE (71.0 – 84.0s) ---
    add_stereo(wet, foley_silk_swell("A4", 2.9, 0.52), 71.05)
    add_stereo(wet, synth_chamber_strings(["D2", "A2", "F#3", "A3"], 5.2, vel=0.34, attack=1.4, release=1.4), 71.0)
    # Three delicate ascending piano harmonics for Software / IT / Marketing
    add_stereo(wet, synth_felt_piano("D4", 3.4, 0.50), 71.55, pan=-0.22)
    add_stereo(wet, synth_felt_piano("F#4", 3.2, 0.48), 72.45, pan=0.04)
    add_stereo(wet, synth_felt_piano("A4", 3.0, 0.52), 73.35, pan=0.26)

    # 75.15 – 75.75s: CRYSTALLINE BREATH PAUSE
    # 75.8s: "Evidence informs."
    add_felt_chord(wet, ["D2", "A2", "E4"], 75.80, dur=6.8, vel=0.60, spread=0.045)
    # 77.15s: "People decide." — unforgettable luminous Dmaj9 resolution!
    add_felt_chord(wet, ["D3", "F#3", "A3", "D4", "F#4", "A4"], 77.15, dur=6.5, vel=0.66, spread=0.055)
    add_stereo(wet, synth_chamber_strings(["D2", "A2", "F#3", "D4"], 6.6, vel=0.40, attack=1.5, release=2.8), 77.2)
    # 79.65s: Final Hirearchy [Software] lockup resonant top note
    add_stereo(wet, synth_felt_piano("D5", 4.2, 0.46), 79.65, pan=0.18)

    master_and_write(dry, wet, OUT_DIR / "master-16x9.wav")


# ==============================================================================
# FILM 2: VERTICAL SOCIAL REEL (34.0s — Snappy Tightened Cut)
# ==============================================================================
def compose_social_reel_34s():
    dur = 34.0
    n = int(dur * SR)
    dry = np.zeros((2, n), dtype=np.float64)
    wet = np.zeros((2, n), dtype=np.float64)
    beat = 60.0 / 102.0

    # 0.0 – 7.5s: Hook + X-ray contrast + "The work is everything."
    add_felt_chord(wet, ["B1", "F#2", "D4"], 0.10, dur=4.2, vel=0.58, spread=0.05)
    for ti in range(10):
        add_stereo(dry, foley_tick(0.42 if ti % 2 == 0 else 0.24, bright=(ti % 4 == 0)), 0.4 + ti * (beat * 0.5), pan=0.06 if ti % 2 else -0.06)
    add_stereo(dry, foley_paper_turn(0.38, 0.52), 2.85)
    add_felt_chord(wet, ["G1", "D3", "F#4"], 2.95, dur=2.5, vel=0.52, spread=0.03)
    add_felt_chord(wet, ["D2", "A2", "F#3", "E4", "A4"], 5.35, dur=3.4, vel=0.66, spread=0.04)
    add_stereo(wet, foley_silk_swell("A4", 1.7, 0.48), 5.60)

    # 7.5 – 27.7s: Breathing expressive progression (IDE -> Chronology/Advisory -> Human Seal)
    add_stereo(wet, synth_chamber_strings(["B2", "F#3", "D4"], 19.8, vel=0.40, attack=1.4, release=2.2), 7.6)
    bars = [
        (7.7,  "B1", ["B2", "F#3", "D4"], [("F#4", 0.9)]),
        (10.05,"G1", ["G2", "D3", "B3"], []),            # HHKB typing space!
        (12.40,"D2", ["D3", "A3", "E4"], [("F#4", 0.9)]),
        (14.75,"A1", ["A2", "E3", "C#4"], [("A4", 0.9)]),
        (17.10,"D2", ["D3", "A3", "F#4"], [("B4", 0.6), ("A4", 1.4)]),
        (19.45,"B1", ["B2", "F#3", "D4", "A4"], [("F#4", 0.6), ("A4", 1.4)]),
        (21.80,"G1", ["G2", "D3", "B3", "F#4"], [("D5", 0.55)]),
        (24.15,"A1", ["A2", "E3", "C#4"], []),           # Exhale into Immutable Human Seal!
    ]
    for bt, bass, chord, melody in bars:
        quiet = bt in (10.05, 24.15)
        add_stereo(dry, synth_sub_breath(bass, 2.2, 0.54 if not quiet else 0.40), bt)
        add_felt_chord(wet, chord, bt, dur=2.9, vel=0.54 if not quiet else 0.44, spread=0.032)
        for mn, off in melody:
            if bt + off < 27.2:
                add_stereo(wet, synth_felt_piano(mn, 2.1, 0.50), bt + off, pan=0.20)
        if not quiet:
            add_stereo(dry, foley_velvet_kick(0.46), bt)
            add_stereo(dry, foley_brush_pulse(0.46), bt + beat)
            if bt + beat * 2.5 < 27.0:
                add_stereo(dry, foley_velvet_kick(0.32), bt + beat * 2.5)

    # Frame-exact synced Foley for 34.0s cut
    add_stereo(dry, foley_paper_turn(0.42, 0.50), 7.45)
    add_stereo(wet, synth_brand_chime("error", 0.68), 9.45)
    for ki in range(14):
        add_stereo(dry, foley_keystroke(0.54, (ki % 5) - 2), 10.6 + ki * 0.155, pan=-0.12 + (ki % 3) * 0.12)
    add_stereo(wet, synth_brand_chime("complete", 0.88), 14.35)
    add_stereo(dry, foley_paper_turn(0.44, 0.52), 16.45)          # Chronology & Workspace AI enter
    add_stereo(wet, synth_brand_chime("complete", 0.80), 19.65)   # STRONG SIGNAL · ADVISORY ONLY blooms
    add_stereo(dry, foley_paper_turn(0.44, 0.52), 22.95)          # Peer Review & Human Verdict enter
    add_stereo(wet, synth_brand_chime("submit", 0.92), 25.40)     # Finalized Immutable Seal locks

    # 27.7 – 34.0s: Finale breath + Dmaj9 lockup
    add_felt_chord(wet, ["D2", "A2", "F#3", "E4", "A4"], 28.05, dur=5.7, vel=0.66, spread=0.05)
    add_stereo(wet, synth_chamber_strings(["D2", "A2", "F#3", "D4"], 5.6, vel=0.38, attack=1.1, release=2.2), 28.0)
    add_stereo(wet, synth_felt_piano("D5", 3.4, 0.46), 30.20, pan=0.18)

    master_and_write(dry, wet, OUT_DIR / "reel-9x16.wav")


# ==============================================================================
# FILM 3: PRE-LAUNCH MANIFESTO TEASER (24.0s)
# ==============================================================================
def compose_teaser_24s():
    dur = 24.0
    n = int(dur * SR)
    dry = np.zeros((2, n), dtype=np.float64)
    wet = np.zeros((2, n), dtype=np.float64)
    beat = 60.0 / 98.0

    # 0.0 – 5.0s: Quiet velvet tension
    add_felt_chord(wet, ["B1", "F#2", "D4"], 0.12, dur=4.8, vel=0.56, spread=0.055)
    add_stereo(wet, synth_felt_piano("A4", 3.4, 0.46), 1.45, pan=0.22)
    for ti in range(14):
        add_stereo(dry, foley_tick(0.38 if ti % 2 == 0 else 0.22, bright=(ti % 4 == 0)), 1.0 + ti * (beat * 0.5), pan=0.05 if ti % 2 else -0.05)

    # 5.0 – 10.5s: Two 100% contrast
    add_stereo(dry, foley_paper_turn(0.45, 0.52), 4.92)
    add_felt_chord(wet, ["G1", "D3", "F#4"], 5.05, dur=3.4, vel=0.54, spread=0.04)
    add_stereo(wet, synth_felt_piano("A4", 2.8, 0.50), 7.35, pan=0.24)
    add_stereo(wet, foley_silk_swell("A4", 1.9, 0.46), 7.55)

    # 10.5 – 15.5s: 3 crisp editorial flashes (IDE -> Chronology -> Kimi + Human Seal)
    for idx, (st, bass_n, chord, cue) in enumerate([
        (10.50, "B1", ["B2", "F#3", "D4"], "complete"),
        (12.15, "G1", ["G2", "D3", "B3"], "confirm"),
        (13.80, "A1", ["A2", "E3", "C#4"], "submit"),
    ]):
        add_stereo(dry, foley_velvet_kick(0.50), st)
        add_stereo(dry, synth_sub_breath(bass_n, 1.5, 0.52), st)
        add_stereo(dry, foley_paper_turn(0.34, 0.48), st - 0.05)
        add_felt_chord(wet, chord, st, dur=1.8, vel=0.54, spread=0.025)
        add_stereo(wet, synth_brand_chime(cue, 0.72), st + 0.65, pan=0.14)

    # 15.5 – 16.1s: Breath pause!
    # 16.1 – 24.0s: "Evidence informs. People decide." + Lockup
    add_felt_chord(wet, ["D2", "A2", "E4"], 16.15, dur=7.2, vel=0.62, spread=0.045)
    add_felt_chord(wet, ["D3", "F#3", "A3", "D4", "F#4"], 17.50, dur=6.2, vel=0.64, spread=0.052)
    add_stereo(wet, synth_chamber_strings(["D2", "A2", "F#3", "D4"], 6.8, vel=0.40, attack=1.4, release=2.5), 17.1)
    add_stereo(wet, synth_felt_piano("D5", 3.8, 0.46), 19.75, pan=0.18)

    master_and_write(dry, wet, OUT_DIR / "teaser-16x9.wav")


if __name__ == "__main__":
    import sys
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    if only in ("all", "master"):
        compose_hero_master_84s()
    if only in ("all", "reel"):
        compose_social_reel_34s()
    if only in ("all", "teaser"):
        compose_teaser_24s()
    print("[AUDIO MASTERS COMPLETE]")
