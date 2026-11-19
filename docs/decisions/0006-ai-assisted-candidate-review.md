# 0006 — Advisory AI Candidate Review Assistant

- **Status:** Accepted (2026-11-19)
- **Supplements / Modifies:** [0001 — No candidate scoring](0001-no-candidate-scoring.md), [0003 — AI does not judge](0003-ai-does-not-judge.md)

## Context

Earlier product constraints (ADRs 0001 and 0003) prohibited any AI-generated score or accept/reject recommendation anywhere in the evaluator workflow. During Founder Product Journey Review, teams evaluating realistic engineering sessions requested an optional, high-signal **Platform AI Candidate Review** report directly inside the evaluator workbench so reviewers can rapidly synthesize large code diffs, save histories, and verification runs before inspecting line-by-line evidence and finalizing the human review packet.

## Decision

Hirearchy Software now provides an **advisory AI Candidate Review component** (`<R27AiReviewPanel>`) backed by `/r27/api/organizations/[organizationId]/sessions/[sessionId]/ai-review` and `apps/web/src/r27-evidence/ai-review.ts`:

1. **Advisory Score & Recommendation:** Generates a `0–100` evidence-grounded rating, a `Should Accept` / `Should Reject` recommendation badge, an executive `"Why"` rationale citing concrete files/events, and structured lists of **Observed Strengths** and **Weaknesses & Verification Risks**.
2. **Multi-Provider Support + Offline Preview Fallback:**
   - Supports **NVIDIA NIM** (`NVIDIA_API_KEY`) with selectable presets including `moonshotai/kimi-k2-instruct` (Kimi K2 / 3.1), `nvidia/nemotron-3-super-120b-a12b`, `qwen/qwen3-235b-a22b`, or custom model slugs.
   - Supports **OpenRouter** (`OPENROUTER_KEY`) including `google/gemini-2.5-flash` and `anthropic/claude-3.7-sonnet`.
   - When no active API key is present (or offline preview is chosen), deterministically synthesizes an evidence-grounded preview directly from starter-vs-submitted diffs, save checkpoints, timeline events, and execution runs.
3. **Strict Isolation from Authoritative Evidence & Human Review Packets:**
   - The underlying PostgreSQL evidence store (`r27`), revision trail (`r28`), anchored observations (`r29`), and human review packet (`r210`) remain score-free and free of automatic verdicts.
   - The AI Review report is strictly advisory and displayed separately above/alongside human review controls; only the assigned human evaluator authors and finalizes the official `r210` review packet.

## Consequences

- Evaluators gain immediate clarity on candidate diffs, strengths, risks, and accept/reject signal without waiting on manual diff triage.
- Existing invariants on immutable evidence projections and human-owned review packets (`r210`) remain intact and tested.
