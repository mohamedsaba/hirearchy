"""Master the generated speech, original score, and frame-aligned Foley."""
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

RATE = 48000
LENGTH = 45 * RATE
PUBLIC = Path(__file__).resolve().parents[1] / "public"
WORK = Path(sys.argv[1])
rng = np.random.default_rng(8317)
score = np.zeros((LENGTH, 2), dtype=np.float64)
effects = np.zeros_like(score)
voice = np.zeros(LENGTH)


def clock(length):
    return np.arange(round(length * RATE)) / RATE


def envelope(t, attack, decay, release):
    return (1 - np.exp(-t / attack)) * np.exp(-t / decay) * np.clip((t[-1] - t) / release, 0, 1)


def tone(t, hz, phase=0):
    return np.sin(2 * np.pi * hz * t + phase)


def place(stem, at, signal, gain, pan=0):
    first = round(at * RATE)
    count = min(len(signal), len(stem) - first)
    if count > 0:
        stem[first:first + count] += signal[:count, None] * gain * np.sqrt([1 - pan, 1 + pan])


def hz(midi):
    return 440 * 2 ** ((midi - 69) / 12)


def knock(at, pitch, gain, dest=effects):
    t = clock(.38)
    bend = pitch * t + 38 * .022 * (1 - np.exp(-t / .022))
    signal = np.sin(2 * np.pi * bend) + .16 * tone(t, pitch * 2.12)
    place(dest, at, signal * envelope(t, .004, .087, .12), gain)


def tick(at, gain, pan=0, frequency=1750):
    t = clock(.083)
    noise = rng.standard_normal(len(t))
    noise = .18 * (noise - np.roll(noise, 1))
    signal = noise + .52 * tone(t, frequency) + .24 * tone(t, frequency * 2.28)
    place(effects, at, signal * envelope(t, .0007, .011, .025), gain, pan)


def chime(at, notes, level):
    t = clock(1.64)
    for index, note in enumerate(notes):
        rate = hz(note)
        signal = tone(t, rate) + .21 * tone(t, rate * 2.007) + .09 * tone(t, rate * 4.021)
        signal *= envelope(t, .007, .36 - index * .026, .30)
        place(effects, at + .037 * index, signal, level, -.23 + index * .19)
        place(effects, at + .16 + .037 * index, signal, level * .19, .31 - index * .21)


def swipe(ends, duration, level, pan):
    t = clock(duration)
    grain = rng.standard_normal(len(t))
    moving = np.cumsum(185 + 2300 * (t / duration) ** 2) / RATE
    cloud = .10 * (grain - np.roll(grain, 5)) + .55 * np.sin(2 * np.pi * moving)
    shape = (t / duration) ** 2.1 * np.clip((duration - t) / .026, 0, 1)
    place(effects, ends - duration, cloud * shape, level, pan)


# Slow polyphonic movement under a half-time pulse. The final chord resolves at 44 seconds.
chords = [
    (0, 7.2, (38, 50, 57, 60, 64), .80),
    (8, 7.8, (38, 50, 57, 60, 64), .88),
    (15, 9.4, (34, 46, 53, 57, 60), .94),
    (24, 6.6, (41, 53, 57, 60, 64), 1.02),
    (30, 6.4, (36, 48, 55, 62, 64), 1.09),
    (36, 6.7, (38, 50, 57, 62, 65), 1.03),
    (41.4, 2.6, (41, 53, 57, 60, 65), 1.12),
]
for start, duration, notes, level in chords:
    t = clock(duration)
    attack = .36 if start else 1.28
    sustain = np.clip(t / attack, 0, 1) ** 1.5 * np.clip((duration - t) / (1.25 if start else .65), 0, 1)
    swell = .74 + .26 * np.sin(np.pi * t / duration) ** 2
    for index, note in enumerate(notes):
        pitch = hz(note)
        for pan, detune in [(-.71, -.0017), (.71, .0017)]:
            signal = tone(t, pitch * (1 + detune), index * .48) + .25 * tone(t, pitch * 2.003)
            signal += .09 * tone(t, pitch * 3.008, pan * 2)
            pad = signal * sustain * swell
            gain = level * (.036 if index == 0 else .012)
            place(score, start, pad, gain, pan)
            if start == 41.4:
                for delay, reflection in [(.16, .22), (.38, .14), (.64, .10), (.99, .07)]:
                    place(score, start + delay, pad, gain * reflection, -pan)

for beat in np.arange(.48, 41.4, .5):
    if 6.9 < beat < 8:
        continue
    gain = .12 if beat > 23.9 else .085
    if round(beat * 2) % 4 in (0, 1):
        knock(beat, 49 if beat < 15 else 45, gain, score)
    if beat > 8:
        t = clock(.31)
        step = int(beat * 2) % 8
        note = (62, 69, 72, 76, 69, 74, 76, 81)[step]
        pluck = tone(t, hz(note)) + .37 * tone(t, hz(note) * 2)
        env = envelope(t, .006, .072, .07)
        place(score, beat + .225, pluck * env, .016 + .002 * (beat > 23.9), (-1)**step * .53)

# Exact picture cues in seconds. Fractional values fall on the nearest frame.
knock(.10, 69, .19)
knock(.26, 81, .15)
tick(1.62, .14)
knock(3, 53, .19)
tick(5, .13)
swipe(8.02, .02, .12, 0)
chime(8.02, (57, 69, 76), .059)
for at, pan in [(8.93, -.26), (9.63, .10), (10.33, .33)]:
    tick(at, .14, pan, 1320)
# The toggle label changes on frame 685.
tick(685 / 60, .27, .31, 1120)
tick(685 / 60 + .027, .15, .36, 2000)
swipe(15, .43, .18, -.28)
for at in [17.54, 17.64, 17.78, 17.88, 19.29, 19.4, 19.52, 20.87, 21.03, 21.18, 21.31, 21.44]:
    tick(at, .075, (rng.random() - .5) * .75)
knock(19.85, 42, .27)
tick(19.85, .095, 0, 820)
chime(1335 / 60, (69, 74, 81), .109)
swipe(24, .42, .16, -.18)
for index, at in enumerate([24.46, 25.81, 27.17, 28.55]):
    for offset in [-.16, -.08, 0]:
        tick(at + offset, .17 if offset == 0 else .055, -.40 + index * .26, 1550 + index * 180)
swipe(30.08, .57, .10, -.22)
tick(30.53, .15, .22)
swipe(1838 / 60, .19, .23, -.28)
chime(1838 / 60, (72, 74), .059)
swipe(1886 / 60, .19, .19, .25)
chime(1886 / 60, (76, 81), .063)
swipe(36, .50, .19, 0)
chime(40.2, (57, 65, 69, 77), .053)

# Honor the opening silence at the sample level, including all effect tails.
score[round(7.2 * RATE):8 * RATE] = 0
effects[round(7.2 * RATE):8 * RATE] = 0
for index, start in enumerate([.35, 8.53, 15.38, 24.63, 36.34, 40.34], 1):
    pcm = subprocess.check_output([
        "ffmpeg", "-nostdin", "-v", "error", "-i", str(WORK / f"vo{index}.wav"),
        "-af", "highpass=f=74,equalizer=f=150:t=q:w=.85:g=1.5,equalizer=f=3100:t=q:w=1.2:g=1.6,"
               "acompressor=threshold=0.12:ratio=2:attack=10:release=110",
        "-ar", str(RATE), "-ac", "1", "-f", "f32le", "-",
    ])
    samples = np.frombuffer(pcm, dtype="<f4").copy()
    samples *= .222 / np.max(np.abs(samples))
    ramp = np.linspace(0, 1, 480)
    samples[:len(ramp)] *= ramp
    samples[-len(ramp):] *= ramp[::-1]
    first = round(start * RATE)
    voice[first:first + len(samples)] = samples
    assert start + len(samples) / RATE <= [7.2, 15, 24, 36, 40, 44][index - 1]
    duck = np.ones(len(samples) + RATE // 4)
    duck[:RATE // 12] = np.linspace(1, .45, RATE // 12)
    duck[RATE // 12:-RATE // 6] = .45
    duck[-RATE // 6:] = np.linspace(.45, 1, RATE // 6)
    duck_start = first - RATE // 12
    # Keep the score full when the independent narration stem is disabled in Studio.
    score[duck_start:duck_start + len(duck)] *= (.42 + .58 * duck[:, None])

fade = np.linspace(1, 0, RATE)
score[-RATE:] *= fade[:, None]
bed = score * .91 + effects
voice *= 1.39
bed *= 2.31
voice *= 2.31
combined = bed + voice[:, None]
assert not np.any(combined[round(7.2 * RATE):8 * RATE])
assert np.max(np.abs(combined)) < .88


def write(name, data, channels):
    with wave.open(str(PUBLIC / name), "wb") as file:
        file.setparams((channels, 2, RATE, 0, "NONE", ""))
        file.writeframes((data * 32767).astype("<i2").tobytes())


write("score-and-foley.wav", bed, 2)
write("narration.wav", voice, 1)
