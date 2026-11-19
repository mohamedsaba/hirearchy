# Architecture Map

Hirearchy Software is a **Next.js 16 + PostgreSQL modular monolith** (`apps/web`, `database/postgres`, `packages/restricted-executor`). All product surfaces—marketing pages, organization auth/onboarding, recruiter authoring, candidate IDE, evaluator evidence reconstruction, advisory AI Candidate Review, and restricted execution—share a unified codebase and deployment unit.

See **[docs/architecture/system-overview.md](docs/architecture/system-overview.md)** for the full technical deep-dive and **[docs/design/frontend-and-brand-system.md](docs/design/frontend-and-brand-system.md)** for the Common Thread UI, CSS tokens, and IDE layout.

---

## 1. Active PostgreSQL Architecture (`R2.3 – R2.15`)

- **Identity & Organization Scope (`R2.3 – R2.5`):** GoTrue authentication paired with encrypted HTTP-only session cookies (`__Host-r23-session`), double-submit CSRF tokens (`__Host-r23-csrf`), and Postgres migrations `0001`–`0017` enforcing organization-scoped `recruiter` vs. `reviewer` authorization.
- **Assessment Builder & Issuance (`R2.11`):** Versioned scenario snapshots (`scenarioSnapshot` + SHA-256 `snapshotDigest`), encrypted candidate invitation links, and reviewer assignments.
- **Candidate IDE Workspace (`R2.6`, `R2.12`, `R2.13`):**
  - Strictly enforces the `CREATED → ACTIVE → SUBMITTED` lifecycle with optimistic file versioning (`expectedVersion`) and idempotent mutation/submission `requestId` keys.
  - Append-only event capture (`hirearchy.candidate_session_events`) records activation, `WORKSPACE_CHANGED` saves, execution requests/completions, AI prompts, and final submission.
  - Restricted Python test execution runs inside an isolated container bridge (`packages/restricted-executor`) without exposing host environment state.
- **Evaluator Evidence Workbench & AI Review (`R2.7 – R2.10`):**
  - `GET /r27/api/organizations/[orgId]/sessions/[sessionId]/evidence`: read-only assigned-reviewer projection joining starter baseline, submitted files, diff patches, revision metadata, execution logs, AI transcripts, and paginated events.
  - `GET|POST /r27/api/organizations/[orgId]/sessions/[sessionId]/ai-review`: advisory AI Candidate Review service (`apps/web/src/r27-evidence/ai-review.ts`) supporting **NVIDIA NIM** (Kimi K2 / 3.1, Nemotron Super 120B, Qwen 3 235B, custom slugs), **OpenRouter**, and an offline deterministic **Evidence-Grounded Preview** returning a `0–100` score, `Should Accept` / `Should Reject` recommendation, rationale, strengths, and weaknesses ([ADR 0006](docs/decisions/0006-ai-assisted-candidate-review.md)).
  - `R2.8` file revision inspection, `R2.9` anchored evaluator observations, and `R2.10` finalized human review packets remain untouched and score-free in PostgreSQL.

## 2. Legacy SQLite Prototype Routes

Historical routes (`/evaluator/*`, `/candidate/[token]`, `/api/evaluator/*`, `/api/candidate/*`) backed by SQLite (`DELIMIT_DB_PATH`) remain in place for legacy integration/unit suites (`tests/unit/task-assessment-scoring.test.ts`, `tests/unit/evaluator-v2-rendering.test.tsx`). New product features target the PostgreSQL `R2.3–R2.15` slices while sharing UI primitives under `apps/web/app/evaluator/sessions/[sessionId]/`.

## 3. Key Verification Gates

- `npm run verify`: Prettier format check, ESLint, Next/TypeScript check, Vitest unit & integration suites, Restricted Executor suite, and Next production build.
- `npm run test:founder-uat:css`: Live browser CSS/layout gate against the Founder UAT server (`http://127.0.0.1:3000`).
