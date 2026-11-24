# Hirearchy Software launch film

Open Remotion Studio with `npm ci` and `npm run studio` from this directory. Both masters run 45 seconds at 60 fps, with separate layouts for 1920×1080 and 1080×1920. The `voiceover` prop switches narration on or off in either master.

Run `npm run render` to export both H.264 masters to the repository's `launch-renders/` directory. Pass `-- 16x9` or `-- 9x16` to export one. `HIREARCHY_RENDER_CONCURRENCY` controls render workers and `HIREARCHY_RENDER_CHROME` selects an existing Chromium binary if needed.

| Time        | Picture                                                               |
| ----------- | --------------------------------------------------------------------- |
| 00:00–00:08 | Two scores, three editorial beats, and a mint cursor in silence       |
| 00:08–00:15 | Role-aligned assessment and AI policy                                 |
| 00:15–00:24 | File tree, logged prompt, code change, and failing then passing tests |
| 00:24–00:36 | Work chronology and the line 7 follow-up                              |
| 00:36–00:45 | Evidence, human judgment, and the demo end card                       |

The TypeScript code and file names come from the landing-page Node.js demo. The chronology timings, prompt wording, and reply are staged examples from the brief. The end card uses the publicly listed founding-pilot offer. The Hirearchy Software wordmark follows the product header and uses the bundled DM Sans font. Code uses JetBrains Mono.

The included 48 kHz stems are ready to render. To regenerate the narration, run `audio/narrate.py` with Python, `kokoro-onnx==0.6.1`, and a scratch directory containing the [Kokoro ONNX model](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1) as `kokoro.onnx` and voice bank as `voices.bin`. Pass that directory to `audio/mix.py` with NumPy and FFmpeg installed to rebuild both stems. The mix script checks the 7.2–8.0 second silence, narration windows, and peak headroom.

## 35-second lead-gen ad

Open `HirearchyAd16x9` or `HirearchyAd9x16` in Studio. Run `npm run render -- --ad` to export both lead-gen cuts. Add `16x9` or `9x16` after `--ad` to export a single cut. The exporter muxes the finished mix as AAC-LC at 48 kHz stereo and a 192 kbps target.

| Time        | Picture                               |
| ----------- | ------------------------------------- |
| 00:00–00:06 | Hiring pain and a mint cursor         |
| 00:06–00:14 | Files, terminal checks, and logged AI |
| 00:14–00:17 | Node.js scenario setup                |
| 00:17–00:22 | Chronology and the logged AI prompt   |
| 00:22–00:26 | Line 7 and an illustrative follow-up  |
| 00:26–00:35 | Editorial close and early-access CTA  |

The ad uses the same Node.js demo code as the flagship film. The chronology and follow-up show observable steps in a sample run. The end card leads directly with early access.

The included `public/lead-gen-master.wav` contains the faster narration, percussive score, and frame-timed Foley. Run `audio/lead_gen.py` with the same Kokoro model directory, NumPy, and FFmpeg to regenerate the mix. The script applies two-pass loudness normalization to −14 LUFS and checks the silence windows at 5.6–6.0 and 25.6–26.0 seconds.

## Follow the Work

`HirearchyFirstLook` is a 43.2-second 1920×1080 product introduction at 30 fps. The English on-screen copy follows a single revision in Reservation Moves. A mint silk strand carries the eye from the opening into the candidate workspace, the recorded chronology, the submitted diff, and the reviewer’s question. Warm paper, plum and lilac follow the Software identity.

| Time      | Scene                                            |
| --------- | ------------------------------------------------ |
| 0–4.8     | Follow the work                                  |
| 4.8–9.5   | Define the Reservation Moves assessment          |
| 9.5–20.4  | Edit `src/state.py`, save and submit             |
| 20.4–25.5 | See the recorded events                          |
| 25.5–31.5 | Compare the submitted file with the starter      |
| 31.5–36.8 | Save an observation anchored to the changed file |
| 36.8–43.2 | Hirearchy Software and early access              |

Product imagery in `public/first-look` comes from a disposable authenticated staging run. The candidate and reviewer are synthetic. The highlighted revision and anchored observation were saved through the product. The edit illustrates one part of the task. The demonstrated actions cover editing, saving, submission and review. `thread.jpg` is a generated macro photograph. The stereo score and Foley are composed for this cut, with no voice-over. Regenerate the mix with `python audio/first-look.py` using NumPy and FFmpeg.

Run `npm run studio` and open `HirearchyFirstLook` to edit or preview the composition. From this directory, export the cut with:

```sh
npx remotion render src/index.tsx HirearchyFirstLook ../../launch-renders/first-look/Hirearchy_Follow_the_Work.mp4 --crf=16 --audio-bitrate=320k
```

## Follow the Work — hiring cut

`HirearchyHiringCut` runs 68 seconds at 1920×1080 and 30 fps. It carries the original Common Thread opening into the team’s workflow. The candidate’s workspace appears in two angles over six seconds. The cut spends the most time showing how the team uses the submission.

| Time  | On screen                                                                               |
| ----- | --------------------------------------------------------------------------------------- |
| 0–4   | Introducing Hirearchy Software                                                          |
| 4–12  | Select, preview and reuse a role-relevant assessment. Assign an evaluator and issue it. |
| 12–18 | Candidate repository, workspace controls and submission                                 |
| 18–28 | Saved revision, submitted diff and source-linked observation                            |
| 28–42 | Request, respond to and read a teammate’s peer review                                   |
| 42–48 | Offline evidence summary and finalized human review packet                              |
| 48–56 | Publish the decision and see the next step and feedback in the Candidate Portal         |
| 56–64 | Handoff to the next interviewer with notes and a link back to evidence                  |
| 64–68 | Hirearchy Software and early access                                                     |

New captures in `public/hiring-cut` come from an isolated authenticated staging run using synthetic accounts and a Reservation Moves submission. The candidate tool controls are shown with staging availability. The AI Candidate Review insert uses its offline evidence summary. The team peer request and response were recorded in the workspace, and publication, candidate feedback and interviewer handoff were verified in the app.

The original 120 BPM electronic mix uses a short synth motif, syncopated bass, dry percussion and Foley aligned to the cut. Run `python audio/hiring-cut.py` with NumPy and FFmpeg to regenerate it. Open `HirearchyHiringCut` in Studio for the editable timeline.
