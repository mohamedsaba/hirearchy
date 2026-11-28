"""Original 120 BPM electronic score and Foley for the Hirearchy hiring cut."""

import json
from pathlib import Path
import subprocess
import tempfile
import wave

import numpy as np

RATE = 48_000
SECONDS = 68
TAU = 2 * np.pi
rng = np.random.default_rng(97)
mix = np.zeros((SECONDS * RATE, 2))


def time(seconds):
    return np.arange(round(RATE * seconds)) / RATE


def attack(t, seconds):
    return np.clip(t / seconds, 0.0, 1.0) ** 2


def add(start, samples, gain, pan=0):
    i = round(start * RATE)
    n = min(len(samples), len(mix) - i)
    angle = (pan + 1) * np.pi / 4
    mix[i:i + n] += samples[:n, None] * gain * np.array((np.cos(angle), np.sin(angle)))


def frequency(note):
    return 440.0 * 2 ** ((note - 69) / 12)


def kick():
    t = time(.40)
    phase = TAU * (48 * t + 118 * (-np.expm1(-42 * t)) / 42)
    click = rng.normal(0, 1, len(t)) * np.exp(-245 * t)
    return np.tanh(1.32 * np.sin(phase)) * np.exp(-11 * t) * attack(t, .003) + .026 * click


def rim():
    t = time(.22)
    wallop = (.61 * np.sin(TAU * t * 253) + .26 * np.sin(TAU * t * 843)) * np.exp(-42 * t)
    grain = rng.normal(0, 1, len(t))
    clap = sum(attack(t - start, .001) * np.exp(-70 * np.maximum(0, t - start))
               for start in (0, .012, .024))
    return wallop * attack(t, .002) + .18 * np.tanh(grain) * clap


def hat(duration=.12):
    t = time(duration)
    grain = np.diff(rng.uniform(-1, 1, len(t) + 1))
    metal = sum(np.sin(TAU * t * f) for f in (3749, 4567, 5923, 7253, 8311))
    return (grain * .3 + metal * .071) * attack(t, .002) * np.exp(-t / (duration * .17))


def bass(note, duration):
    t = time(duration)
    phase = TAU * t * frequency(note)
    sound = np.sin(phase) + .22 * np.sin(2 * phase) + .075 * np.sin(3 * phase)
    return np.tanh(sound * .9) * attack(t, .019) * attack(duration - t, .023)


def synth(note, duration):
    t = time(duration)
    f = frequency(note)
    bright = np.exp(-8.6 * t)
    first = np.sin(TAU * f * t + .79 * bright * np.sin(TAU * f * 2.01 * t))
    octave = .16 * bright * np.sin(TAU * (2 * f + 1.2) * t)
    return (first + octave) * np.exp(-5.4 * t) * attack(t, .006) * attack(duration - t, .029)


def branded(start, root, gain):
    for i, (offset, note) in enumerate(((0, root), (.25, root + 7), (.625, root + 12))):
        sound = synth(note, .72)
        pan = (-.28, .20, .05)[i]
        add(start + offset, sound, gain * (1 - i * .092), pan)
        add(start + offset + .19, sound, gain * .17, -pan)


def click(duration):
    t = time(duration)
    grit = rng.normal(0, 1, len(t))
    return np.exp(-115 * t) * (np.sin(TAU * 822 * t) * .49 + grit * .29) * attack(t, .001)


def fibre(duration):
    t = time(duration)
    noise = rng.normal(0, 1, len(t))
    smoothing = np.hanning(11)
    rustle = np.convolve(noise, smoothing / smoothing.sum(), mode='same')
    return (rustle - np.roll(rustle, 2)) * np.sin(np.pi * t / duration) ** 2


drum = kick()
clap = rim()
branded(.16, 62, .16)
for at in (.12, 2.02, 3.51):
    add(at, fibre(.37), .14, -.35)

# Two-second bars. Change the pocket when ownership passes to the next person.
for bar in range(1, 33):
    start = 2 * bar
    reveal = bar in (9, 14, 21, 24, 28)
    pitched = (38, 38, 41, 36)[bar % 4]
    if 14 <= bar < 24:
        pitched = (41, 41, 43, 36)[(bar - 14) % 4]
    if bar >= 24:
        pitched = (38, 41, 36, 43)[(bar - 24) % 4]

    if bar not in (13, 20, 27, 32):
        offsets = (0, .75, 1.25) if bar % 4 == 3 else (0, 1.0)
        for beat in offsets:
            add(start + beat, drum, .50 if reveal else .42)
        add(start + .503, clap, .20, -.07)
        add(start + 1.501, clap, .24, .11)

    if bar not in (13, 20, 27):
        for i, beat in enumerate((.253, .758, 1.253, 1.762)):
            add(start + beat, hat(.17 if i == 3 else .092), .144 if i in (0, 2) else .10, (-.32, .38, -.22, .42)[i])
        if bar % 2 and 5 < bar < 31:
            add(start + 1.879, hat(.063), .071, -.26)

    if bar not in (13, 20, 27, 32):
        add(start + .028, bass(pitched, .27), .223)
        add(start + .761, bass(pitched + (12 if bar % 4 == 3 else 0), .19), .183)
        add(start + 1.283, bass(pitched + (7 if bar % 3 == 0 else 0), .31), .215)

    if bar % 4 in (0, 2) and not reveal and bar not in (20, 32):
        for j, note in enumerate((62, 65, 69) if bar % 4 == 0 else (60, 65, 67)):
            part = synth(note + (12 if bar >= 28 and j == 1 else 0), .57)
            add(start + .27 + .012 * j, part, .051, (-.38, .30, .12)[j])
            add(start + 1.28 + .015 * j, part, .033, (.32, -.27, .06)[j])

for start, pitch, gain in ((4.0, 62, .14), (18.0, 65, .145), (28.0, 60, .17),
                           (42.0, 67, .10), (56.0, 65, .148), (64.15, 62, .18)):
    branded(start, pitch, gain)

for start in (3.74, 11.78, 17.74, 27.78, 41.74, 47.77, 55.76, 63.73):
    add(start, fibre(.47), .193, -.26)
for i, start in enumerate((7.49, 10.50, 14.76, 15.03, 15.26, 16.48, 21.00, 24.26, 32.49, 36.50, 39.49, 53.50, 58.49, 60.75)):
    add(start, click(.12), .13 if i in (3, 4, 5) else .18, -.24 if i % 2 else .23)

add(64.0, drum, .44)
add(64.03, bass(38, .63), .20)
add(65.35, synth(74, 1.62), .077, -.12)
add(65.55, synth(81, 1.52), .043, .22)

t = time(SECONDS)
mix *= (attack(t, .07) * attack(SECONDS - t, 1.07))[:, None]
assert mix.shape == (3_264_000, 2)
assert .20 < np.max(np.abs(mix)) < .96
assert np.max(np.abs(mix[-480:])) < .001

target = Path(__file__).resolve().parents[1] / 'public' / 'hiring-cut' / 'common-thread-beat.wav'
normalizer = 'loudnorm=I=-14:TP=-1.5:LRA=10'
with tempfile.TemporaryDirectory(prefix='hirearchy-beat-') as work:
    raw = Path(work) / 'mix.wav'
    with wave.open(str(raw), 'wb') as file:
        file.setparams((2, 2, RATE, 0, 'NONE', 'not compressed'))
        file.writeframes(np.round(mix * 32767).astype('<i2').tobytes())
    base = ['ffmpeg', '-nostdin', '-hide_banner', '-i', str(raw)]
    log = subprocess.run(base + ['-af', normalizer + ':print_format=json', '-f', 'null', '-'],
                         capture_output=True, check=True, text=True).stderr
    stats = json.JSONDecoder().raw_decode(log[log.rfind('{'):])[0]
    measured = ':'.join('measured_' + k + '=' + stats['input_' + k] for k in ('i', 'tp', 'lra', 'thresh'))
    subprocess.run(base + ['-v', 'error', '-y', '-af',
                           normalizer + ':' + measured + ':offset=' + stats['target_offset'] + ':linear=true',
                           '-ar', str(RATE), '-c:a', 'pcm_s16le', str(target)], check=True)
