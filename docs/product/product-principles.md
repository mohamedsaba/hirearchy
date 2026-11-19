# Product principles

1. **Evidence before judgment.** Prefer observable facts and their sources over ungrounded claims.
2. **Task outcome, AI advisory review, and human decision are distinct.** Automated execution results and advisory AI review reports (`0006`) inform the evaluator, but the assigned reviewer owns the final review packet.
3. **AI usage by candidates is neutral.** Record observable AI interactions; do not penalize or infer hidden mental state from prompt frequency.
4. **Authentic IDE ergonomics for candidates.** The candidate workspace follows familiar IDE conventions (folder tree explorer, open editor tabs, clean code canvas, toggleable terminal/AI drawers, concise status bar & timer pill) so cognitive effort goes into solving the engineering task, not learning proprietary chrome.
5. **Chronology is part of the evidence.** Event ordering, saves, and timing make code diffs meaningful.
6. **The scenario creates the signal.** Product quality depends on realistic debugging/engineering tasks that can be understood in 60–90 seconds and allow multiple valid solutions.
7. **Inspectable evidence backing every synthesis.** Any AI review summary, score (`0–100`), or `Should Accept` / `Should Reject` recommendation must coexist cleanly with full file diffs, revision history, and event metadata.
