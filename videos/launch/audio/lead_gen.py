"""Generate the 35-second commercial master with Kokoro, NumPy, and FFmpeg."""
import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
import onnxruntime as ort
from kokoro_onnx import Kokoro

RATE = 48_000
LENGTH = 35 * RATE
WORK = Path(sys.argv[1])
OUTPUT = Path(__file__).resolve().parents[1] / "public" / "lead-gen-master.wav"
SILENCES = [(5.6, 6), (25.6, 26)]
AAC_GUARD = .004
rng = np.random.default_rng(9033)
rhythm = np.zeros((LENGTH, 2))
foley = np.zeros_like(rhythm)
voice = np.zeros(LENGTH)


def timeline(seconds):
    return np.arange(round(seconds * RATE)) / RATE


def place(stem, seconds, samples, gain, pan=0):
    first = round(seconds * RATE)
    count = min(len(samples), len(stem) - first)
    stem[first:first + count] += samples[:count, None] * gain * np.sqrt([(1 - pan) / 2, (1 + pan) / 2])


def impact(stem, when, strength, pitch=48, length=.31):
    t = timeline(length)
    sweep = pitch * t + 1.1 * (1 - np.exp(-t / .021))
    hit = np.sin(2 * np.pi * sweep) + .13 * np.sin(4 * np.pi * sweep)
    shape = np.clip(t / .004, 0, 1) * np.exp(-t / .068) * np.clip((length - t) / .08, 0, 1)
    place(stem, when, hit * shape, strength)


def click(stem, when, strength, pitch=1460, pan=0):
    t = timeline(.092)
    grain = rng.standard_normal(len(t))
    click_sound = .21 * (grain - np.roll(grain, 1)) + .52 * np.sin(2 * np.pi * pitch * t)
    shape = np.clip(t / .001, 0, 1) * np.exp(-t / .010) * np.clip((.092 - t) / .018, 0, 1)
    place(stem, when, click_sound * shape, strength, pan)


def pop(when, strength, pitch, pan, length=.26):
    t = timeline(length)
    tone = np.sin(2 * np.pi * pitch * t) + .39 * np.sin(2 * np.pi * pitch * 1.5 * t)
    shape = np.clip(t / .004, 0, 1) * np.exp(-t / .057) * np.clip((length - t) / .06, 0, 1)
    place(foley, when, tone * shape, strength, pan)


# A half-time sequence of dry hits and swung rim clicks, with no melodic bed.
for start, stop, strength in [(0, 5.6, .19), (6, 25.6, .235), (26, 34.12, .192)]:
    for beat, when in enumerate(np.arange(start, stop, .47)):
        if beat % 4 in (0, 1, 3):
            impact(rhythm, when, strength * (1 if beat % 4 == 0 else .63))
        if when + .235 < stop:
            click(rhythm, when + .235, .085 if beat % 2 else .045, 1680, .32 if beat % 2 else -.29)
        if beat % 4 == 2 and when + .355 < stop:
            click(rhythm, when + .355, .055, 1120, -.26)
for when, gain, pitch in [(.15, .235, 53), (2.62, .2, 74), (3.02, .19, 65), (6, .24, 55), (8.55, .24, 46), (14, .20, 61), (17, .18, 53), (26, .23, 58), (30.3, .18, 59), (33.7, .13, 48)]:
    impact(foley, when, gain, pitch)
impact(foley, 5.49, .12, 51, .15)
click(rhythm, 20.10, .077, 1310, -.20)
impact(foley, 25.50, .11, 51, .15)
# Frames from the first visible state or the spring's first peak.
for when, pitch, pan in [(603/60, 2100, .27), (713/60, 1230, .44), (721/60, 2150, .44),
                         (867/60, 1440, -.33), (894/60, 1340, 0), (927/60, 1540, .33),
                         (1038/60, 1530, -.50), (1100/60, 1710, -.24),
                         (1152/60, 1840, .18), (1280/60, 2120, .43),
                         (1354/60, 1570, .18)]:
    click(foley, when, .27, pitch, pan)
pop(603/60, .20, 558, .22)
pop(1372/60, .16, 448, -.24)
pop(1420/60, .16, 672, .25)
pop(33.7, .075, 409, 0, .5)
pop(34.17, .026, 409, -.33, .58)
pop(34.40, .015, 409, .27, .59)

options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.inter_op_num_threads = 1
session = ort.InferenceSession(str(WORK / "kokoro.onnx"), options, providers=["CPUExecutionProvider"])
kokoro = Kokoro.from_session(session, str(WORK / "voices.bin"))
style = .62 * kokoro.get_voice_style("am_fenrir") + .38 * kokoro.get_voice_style("am_michael")
# A null timestamp adds a 0.3-second pause after the preceding sentence.
script = [
    (.25, "Coding puzzles drive away great engineers."),
    (None, "And a perfect score can hide how the work got done."),
    (6.25, "Hire-archy puts candidates in a real workspace."),
    (9.20, "Real files, real terminal, transparent AI."),
    (None, "The way engineering actually happens."),
    (14.36, "Your team builds a real task in minutes."),
    (17.32, "See how candidates worked and used AI."),
    (21.20, "Ask follow-ups right on the code."),
    (None, "In three minutes."),
    (26.22, "Stop guessing from scores."),
    (28.45, "Hire on real engineering evidence."),
    (30.68, "Get early access at Hire-archy dot I O."),
]
previous_end = 0
for start, line in script:
    start = previous_end + .3 if start is None else start
    pcm, native_rate = kokoro.create(line, voice=style, speed=1.05, lang="en-us")
    audible = np.flatnonzero(np.abs(pcm) > .0016)
    pcm = pcm[max(0, audible[0]-240):audible[-1]+360]
    processed = subprocess.check_output([
        "ffmpeg", "-v", "error", "-nostdin", "-f", "f32le", "-ac", "1", "-ar", str(native_rate), "-i", "pipe:0",
        "-af", "highpass=f=81,equalizer=f=175:t=q:w=1.1:g=1.6,equalizer=f=2850:t=q:w=1.3:g=2.8,"
               "acompressor=threshold=0.095:ratio=2.6:attack=8:release=89",
        "-ar", str(RATE), "-f", "f32le", "-",
    ], input=pcm.astype("<f4").tobytes())
    samples = np.frombuffer(processed, dtype="<f4").copy()
    samples *= .52 / np.max(np.abs(samples))
    ramp = np.linspace(0, 1, 288)
    samples[:len(ramp)] *= ramp
    samples[-len(ramp):] *= ramp[::-1]
    first = round(start * RATE)
    last = first + len(samples)
    assert start >= previous_end, (start, previous_end, line)
    previous_end = last / RATE
    assert all(previous_end <= low or start >= high for low, high in SILENCES), (start, previous_end, line)
    voice[first:last] = samples
    rhythm[first:last] *= .56
    print(f"{start:.3f}–{previous_end:.3f} {line}", flush=True)

assert previous_end < 34.2
mix = np.repeat(voice[:, None], 2, axis=1) * .707107 + rhythm + foley
for begin, end in SILENCES:
    low = round(begin * RATE)
    high = round((end + AAC_GUARD) * RATE)
    mix[low - 384:low] *= np.linspace(1, 0, 384)[:, None]
    mix[low:high] = 0
    mix[high:high + 192] *= np.linspace(0, 1, 192)[:, None]
mix[-round(.8 * RATE):] *= np.linspace(1, 0, round(.8 * RATE))[:, None]
af = "loudnorm=I=-14:TP=-1.2:LRA=7"
source = ["ffmpeg", "-nostdin", "-hide_banner", "-f", "f32le", "-ar", str(RATE), "-ac", "2", "-i", "pipe:0"]
samples = mix.astype("<f4").tobytes()
analysis = subprocess.run(source + ["-af", af + ":print_format=json", "-f", "null", "-"],
                          input=samples, capture_output=True, check=True)
json_start = analysis.stderr.rfind(b"{")
json_end = analysis.stderr.find(b"}", json_start) + 1
measure = json.loads(analysis.stderr[json_start:json_end])
values = [f"measured_{key}={measure['input_' + key]}" for key in ("i", "tp", "lra", "thresh")]
settings = ":".join([af, *values, f"offset={measure['target_offset']}", "linear=true"])
processed = subprocess.check_output(source + ["-v", "error", "-af", settings, "-ar", str(RATE), "-f", "f32le", "-"],
                                    input=samples)
master = np.frombuffer(processed, dtype="<f4").reshape(-1, 2).copy()
assert len(master) == LENGTH
for begin, end in SILENCES:
    master[round(begin * RATE):round((end + AAC_GUARD) * RATE)] = 0
assert np.max(np.abs(master)) < .92
with wave.open(str(OUTPUT), "wb") as wav:
    wav.setparams((2, 2, RATE, 0, "NONE", ""))
    wav.writeframes((master * 32767).astype("<i2").tobytes())
