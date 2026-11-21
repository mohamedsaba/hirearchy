# Hirearchy Software — Complete Project Documentation

Welcome. This directory is the single source of truth for understanding, running, designing, and extending **Hirearchy Software**—both for human engineers and AI coding agents onboarding for the first time.

---

## What Hirearchy Software Is

Hirearchy Software evaluates software engineers through **realistic debugging & engineering tasks** instead of algorithmic trivia:

1. **Recruiters / Evaluators Sign Up & Author Assessments (`/r23/*`)**: Sign up -> verify email via OTP -> bootstrap an organization -> configure a realistic scenario & assign reviewers -> invite a candidate.
   - On the organization **Problems** page (`/r23/organizations/[organizationId]/problems`), active recruiters can view, edit, and delete saved problems. In the builder, **Save for reuse** captures the current authoring content. **Start from saved problem** opens an independent draft for normal validation and issuance.
2. **Candidates Work in an Authentic IDE (`/r26/candidate/[sessionId]`)**: Read the concise task brief -> accept data-capture notice -> inspect repository folder tree & starter files -> edit code with durable save checkpoints -> run sandboxed tests (`r213` / `packages/restricted-executor`) -> optionally consult recorded AI assistance (`r212`) -> submit final work.
3. **Evaluators Inspect Evidence & AI Review (`/r27/organizations/[orgId]/sessions/[sessionId]`)**:
   - **AI Candidate Review (`<R27AiReviewPanel>`):** One-click AI analysis producing a `0–100` score, `Should Accept` or `Should Reject` recommendation, clear `"Why"` rationale, and Strengths vs. Weaknesses grounded in actual code diffs and session events (powered by **NVIDIA NIM** including Kimi/Nemotron/Qwen, **OpenRouter**, or offline **Evidence-Grounded Preview**).
   - **Chronological Reconstruction & Code Diffs:** Line-numbered unified diffs (`code-diff-viewer.tsx`), intermediate file revision history (`R28`), execution logs, AI transcripts, anchored evaluator observations (`R29`), and finalized human review packets (`R210`).

---

## Documentation Index

| Area                      | Document                                                                                                                                                                                            | What You Learn                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **System & Backend**      | [System Overview](architecture/system-overview.md)                                                                                                                                                  | Next.js modular monolith, PostgreSQL `R2.3–R2.15` slices, migrations `0001–0018`, auth/CSRF, AI configuration, API routes |
| **Frontend, UI & Brand**  | [Frontend & Brand System](design/frontend-and-brand-system.md)                                                                                                                                      | Common Thread color tokens, DM Sans & Mono typography, SVGs/assets, Candidate IDE layout, Diff Viewer, AI Review UI       |
| **Product Rules**         | [Thesis](product/product-thesis.md) · [Principles](product/product-principles.md) · [Non-Goals](product/non-goals.md) · [Positioning](product/competitive-positioning.md)                           | Core philosophy, candidate ergonomics, separation between AI advice & human judgment                                      |
| **Decisions (ADRs)**      | [Decisions Index](decisions/README.md) · [ADR 0006 — AI Review](decisions/0006-ai-assisted-candidate-review.md) · [ADR 0007 — Reusable Problem Library](decisions/0007-reusable-problem-library.md) | Product and architecture decisions, including advisory AI review and reusable problem authoring                           |
| **Scenarios & Sandbox**   | [Scenario Constitution](scenarios/constitution.md) · [Sandbox Contract](architecture/sandbox.md) · [Timing Contract](architecture/candidate-timing-contract.md)                                     | How tasks are authored, validated, timed, and isolated in Docker                                                          |
| **Security & Operations** | [AI Boundaries](architecture/ai-boundaries.md) · [Trusted Proxy Policy](architecture/trusted-proxy-policy.md) · [Release Readiness](release-readiness.md)                                           | Threat boundaries, proxy header trust, Staging / Founder UAT operations                                                   |

---

## Quick Orientation for AI Agents

- **Active Development Path:** Focus on the PostgreSQL `R2.3–R2.15` slices (`apps/web/app/r23/`, `r26/`, `r27/`, `apps/web/src/r23-auth/`, `r26-candidate/`, `r27-evidence/`, `staging/`). Do **not** expand the legacy SQLite `/evaluator` routes unless fixing shared UI components.
- **Test-Referenced Assets:** Several test suites directly read files under `docs/scenarios/examples/reservation-moves/`, `docs/scenarios/specimens/duplicate-confirmations.json`, and `docs/artifacts/evaluator-briefing/{C,D,F,G}.{json,md}`. Keep those fixtures intact.
- **Git Worktree Discipline:** Check `git status` before edits and implement in isolated worktrees (`.worktrees/*`) without touching unrelated local work in the primary checkout.
- **Required Verification Gate:** Always run `npm run verify` (`format:check`, `lint`, `typecheck`, `test`, `test:executor`, `build`) before committing or pushing.
