import sys
import wave
from pathlib import Path
import onnxruntime as ort
from kokoro_onnx import Kokoro
import numpy as np

work = Path(sys.argv[1])
opts = ort.SessionOptions()
opts.intra_op_num_threads = 2
opts.inter_op_num_threads = 1
model = ort.InferenceSession(str(work / "kokoro.onnx"), opts, providers=["CPUExecutionProvider"])
voice = Kokoro.from_session(model, str(work / "voices.bin"))
style = 0.65 * voice.get_voice_style("am_michael") + 0.35 * voice.get_voice_style("am_onyx")
lines = [
    "A.I. made final answers cheap. A hundred percent score doesn't tell you who can actually engineer.",
    "Define the real stack, the real bug, and clear A.I. rules, in minutes.",
    "Candidates work in a real multi-file workspace, run real tests, and use A.I. transparently.",
    "Inspect the full work chronology, review A.I. prompts, and ask targeted follow-ups right on the code, in three minutes.",
    "Evidence informs. People decide.",
    "Try the interactive demo at Hire-archy dot I O."
]
for index, line in enumerate(lines, 1):
    samples, rate = voice.create(line, voice=style, speed=.95, lang="en-us")
    audible = np.flatnonzero(np.abs(samples) > .0015)
    samples = samples[max(0, audible[0]-480):audible[-1]+720]
    with wave.open(str(work / f"vo{index}.wav"), "wb") as file:
        file.setparams((1, 2, rate, 0, "NONE", ""))
        file.writeframes((np.clip(samples,-1,1) * 32767).astype("<i2").tobytes())
    print(index, round(len(samples)/rate, 2), flush=True)
