"""Original stereo score and Foley for Follow the Work. Requires NumPy and FFmpeg."""

import json
from pathlib import Path
import subprocess
import tempfile
import wave

import numpy as np

RATE = 48_000
LENGTH = 43.2
TAU = 2 * np.pi
rng = np.random.default_rng(827)
music = np.zeros((round(LENGTH * RATE), 2))
foley = np.zeros_like(music)


def time(seconds):
    return np.arange(round(seconds * RATE)) / RATE


def place(bus, start, sound, level, pan=0.0):
    first = round(start * RATE)
    samples = min(len(sound), len(bus) - first)
    balance = np.array([np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)])
    bus[first:first + samples] += level * sound[:samples, None] * balance


def hz(midi):
    return 440 * 2 ** ((midi - 69) / 12)


def attack(t, duration):
    return np.sin(np.clip(t / duration, 0, 1) * np.pi / 2) ** 2


def felt(midi, duration):
    t = time(duration)
    f = hz(midi)
    tone = sum(
        level * np.sin(TAU * f * partial * t + phase)
        * np.exp(-decay * t)
        for partial, level, decay, phase in (
            (1, .62, 1.5, 0), (2.001, .22, 2.8, .1),
            (3.003, .11, 4., .4), (4.01, .05, 8., .1), (5.02, .018, 11., .15)
        )
    )
    felt_noise = np.diff(rng.normal(0, 1, len(t) + 1))
    return (tone + .025 * felt_noise * np.exp(-70 * t)) * attack(t, .014)


def bow(midi, duration, swell):
    t = time(duration)
    f = hz(midi)
    vibrato = .22 * np.sin(TAU * 4.15 * t)
    tone = sum(
        level * np.sin(TAU * f * partial * t + vibrato * partial / 2)
        for partial, level in ((1, .64), (2, .18), (3, .085), (4, .034))
    )
    return tone * attack(t, swell) * attack(duration - t, 1.4)


def knock(kind, duration=.23):
    t = time(duration)
    if kind == 'key':
        return (
            .62 * np.sin(TAU * 680 * t) * np.exp(-125 * t)
            + .42 * rng.normal(0, 1, len(t)) * np.exp(-170 * t)
        ) * attack(t, .001)
    phase = TAU * (72 * t + 38 * (1 - np.exp(-21 * t)) / 21)
    return (
        .78 * np.sin(phase) * np.exp(-18 * t)
        + .23 * np.sin(TAU * 330 * t) * np.exp(-55 * t)
        + .11 * rng.normal(0, 1, len(t)) * np.exp(-38 * t)
    ) * attack(t, .004)


def paper(duration, opening):
    t = time(duration)
    grit = rng.normal(0, 1, len(t))
    window = np.hanning(15)
    rustle = np.convolve(grit, window / window.sum(), mode='same')
    env = np.sin(np.pi * t / duration) ** (1.8 if opening else 3)
    return (rustle * 1.8 + grit * .11) * env


# The felt motif grows into a restrained chamber arrangement and returns to one voice.
motif = [
    (.32, 62), (1.12, 69), (2.30, 74), (3.30, 76),
    (4.80, 65), (5.46, 72), (6.15, 77), (7.15, 79), (8.55, 76),
    (9.55, 62), (10.21, 69), (10.88, 74), (11.88, 76), (12.88, 69),
    (13.55, 65), (14.21, 72), (15.22, 77), (16.10, 79),
    (17.25, 62), (18.10, 69), (18.80, 74), (19.45, 76),
    (20.45, 57), (21.13, 64), (21.80, 69), (22.47, 72), (23.13, 76),
    (24.13, 74), (25.46, 65), (26.14, 72), (26.80, 77), (27.47, 81),
    (28.14, 79), (29.14, 76), (30.20, 74),
    (31.47, 64), (32.48, 71), (33.48, 74), (34.82, 78), (35.75, 76),
    (36.76, 62), (37.42, 69), (38.12, 74), (38.80, 76), (39.48, 81),
    (40.82, 74),
]
for i, (at, note) in enumerate(motif):
    place(music, at, felt(note, 2.8), .15 + .04 * (i % 4 == 0), -.15 + .3 * (i % 3) / 2)

for at, seconds, chord in (
    (.15, 4.95, (38, 57, 60, 65)), (4.45, 5.32, (41, 57, 60, 64)),
    (9.23, 4.88, (38, 53, 57, 64)), (13.28, 4.42, (41, 57, 60, 67)),
    (16.97, 3.45, (38, 53, 57, 60)), (20.28, 5.64, (33, 52, 55, 60)),
    (25.16, 6.24, (41, 53, 60, 64)), (30.96, 5.80, (40, 55, 59, 62)),
    (36.45, 6.72, (38, 57, 64, 69)),
):
    for i, note in enumerate(chord):
        place(music, at, bow(note, seconds, 1.12 + i * .18), (.12, .050, .042, .035)[i], (0, -.50, .48, .24)[i])

for start, end, root in ((9.55, 19.70, 38), (20.46, 30.60, 41)):
    for i, at in enumerate(np.arange(start, end, 2 / 3)):
        place(music, at, felt(root + (0, 12, 7, 12)[i % 4], .58), .060 if i % 4 else .098, -.24)

for at in (4.8, 9.55, 20.45, 25.46, 36.76):
    place(foley, at, knock('wood'), .28)
    place(foley, at - .36, paper(.68, True), .120, .32)

for i, at in enumerate((13.78, 14.99, 15.09, 15.19)):
    place(foley, at, knock('key'), .095, .29 if i % 2 else -.31)
for at in (15.24, 17.10, 19.25, 22.12, 27.08, 34.96):
    place(foley, at, knock('key'), .13)
    place(foley, at + .012, knock('wood', .13), .08)
for at in (1.05, 12.28, 22.0, 24.82, 31.37, 35.04):
    place(foley, at, paper(.58, False), .088, -.38)

# Short asymmetric reflections create a space without a cloud of high frequencies.
score = music.copy()
for lag, gain in ((.031, .125), (.071, .088), (.119, .073), (.193, .053), (.283, .035), (.421, .021)):
    offset = round(lag * RATE)
    score[offset:] += gain * music[:-offset, ::-1]
breath = 1 - .80 * np.exp(-((time(LENGTH) - 20.18) / .19) ** 2)
mix = (score * breath[:, None] + foley)
mix *= attack(time(LENGTH), .15)[:, None] * attack(LENGTH - time(LENGTH), 1.48)[:, None]
assert mix.shape == (2_073_600, 2) and 0.10 < np.max(np.abs(mix)) < 1.0
assert np.max(np.abs(mix[-480:])) < .003 and np.mean(mix ** 2) > .001

target = Path(__file__).resolve().parents[1] / 'public' / 'first-look' / 'the-thread.wav'
target.parent.mkdir(parents=True, exist_ok=True)
loudnorm = 'loudnorm=I=-15.5:TP=-1.6:LRA=10'
with tempfile.TemporaryDirectory(prefix='hirearchy-first-look-score-') as scratch:
    raw = Path(scratch) / 'mix.wav'
    with wave.open(str(raw), 'wb') as file:
        file.setparams((2, 2, RATE, 0, 'NONE', 'not compressed'))
        file.writeframes(np.round(mix * 30_000).astype('<i2').tobytes())
    base = ['ffmpeg', '-nostdin', '-hide_banner', '-i', str(raw)]
    analysis = subprocess.run(base + ['-af', loudnorm + ':print_format=json', '-f', 'null', '-'],
                              capture_output=True, check=True, text=True).stderr
    stats = json.JSONDecoder().raw_decode(analysis[analysis.rfind('{'):])[0]
    measured = ':'.join('measured_' + name + '=' + stats['input_' + name] for name in ('i', 'tp', 'lra', 'thresh'))
    subprocess.run(base + ['-v', 'error', '-y', '-af',
                           loudnorm + ':' + measured + ':offset=' + stats['target_offset'] + ':linear=true',
                           '-ar', str(RATE), '-c:a', 'pcm_s16le', str(target)], check=True)
