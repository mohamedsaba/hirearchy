# System Overview & Backend Architecture

Hirearchy Software is a **Next.js 16 + PostgreSQL modular monolith** written in TypeScript/ESM (`apps/web`, `database/postgres`, `packages/restricted-executor`). A single web application serves:

1. Public marketing & onboarding pages (Common Thread brand).
2. Authenticated organization/recruiter/evaluator SaaS routes (`/r23/*`, `/r27/*`).
3. Token-authorized candidate assessment workspaces (`/r26/candidate/[sessionId]`, `/r26/api/candidate/[sessionId]/*`).
4. Legacy SQLite prototype routes (`/evaluator/*`, `/candidate/*`) retained for isolated unit/integration compatibility.

---

## 1. Repository Layout

```text
.
├── apps/web/
│   ├── app/
│   │   ├── page.tsx, products/, about/, contact/, early-access/, privacy/, terms/, thinking/
│   │   ├── r23/            # GoTrue auth, email verification, org bootstrap, sessions overview, builder
│   │   ├── r26/            # Candidate IDE workspace & candidate runtime APIs (save, submit, AI, exec)
│   │   ├── r27/            # Assigned-reviewer evidence workbench + AI review + revisions + observations + review packet
│   │   ├── evaluator/      # Shared Evaluator Workbench components (diff viewer, AI review panel, header) & legacy slice
│   │   └── api/            # Legacy APIs + founder-uat mail capture + health/staging probes
│   ├── public/             # Fonts (DM Sans WOFF2), Phosphor SVGs, marketing/software CSS
│   └── src/
│       ├── ai/             # Server AI config (`NVIDIA_API_KEY`, `OPENROUTER_KEY`) & interaction services
│       ├── r23-auth/       # Auth/CSRF/session handling & GoTrue identity verification
│       ├── r26-candidate/  # Candidate workspace contracts & helpers
│       ├── r27-evidence/   # Evidence presentation + AI Candidate Review engine (`ai-review.ts`)
│       ├── r28-revisions/  # File revision timeline helpers
│       ├── r29-observations/ # Evaluator anchored observations
│       ├── r210-review-packets/ # Structured human review packet state & validation
│       ├── r211-builder/   # Assessment builder templates & digest validation
│       ├── r212-ai/        # Candidate AI assistant contracts
│       ├── r213-execution/ # Restricted code execution contracts
│       └── staging/        # Staging & Founder UAT runtime dispatch (`browser.ts`, `onboarding.ts`)
├── database/postgres/
│   ├── migrations/         # Sequential SQL migrations (`0001` .. `0017`)
│   ├── r23/ .. r214/       # PostgreSQL adapter modules & SQL fixtures per vertical slice
│   └── staging/            # Staging SQL verifier / dispatch installer
├── packages/restricted-executor/ # Sandbox runner daemon & container definition for Python test execution
├── scripts/                # Founder UAT start/stop/runtime managers & integration test harnesses
├── docs/                   # Product, Architecture, Brand/Design, ADRs, and test-referenced scenarios
└── tests/                  # Vitest unit/integration suites + Playwright browser verification suites
```

---

## 2. Database & Authorization Architecture (`R2.3 – R2.15`)

PostgreSQL is the durable system of record (`database/postgres/migrations/0001_tenant_foundation.sql` through `0017_self_service_onboarding.sql`):

- **Identity & Organizations (`R2.3`):**
  - GoTrue issues JWTs verified server-side (`apps/web/src/r23-auth/identity.ts`).
  - App-level sessions use `__Host-r23-session` (encrypted HTTP-only cookie) and `__Host-r23-csrf` (double-submit CSRF cookie verified on mutating endpoints alongside same-origin checks).
  - Organization membership (`organization_memberships`) distinguishes `recruiter` (creates/issues assessments, manages reviewer assignments) and `reviewer` (reads assigned submitted evidence, authors observations, finalizes review packets).
- **Assessment Authoring & Issuance (`R2.4`, `R2.5`, `R2.11`):**
  - Built around deterministic versioned scenario snapshots (`scenarioSnapshot` + `snapshotDigest`).
  - Issuance creates a candidate session (`CREATED`), assigns reviewers, and issues an encrypted opaque candidate invitation token (`apps/web/src/sessions/candidate-token-storage.mjs`).
- **Candidate Lifecycle & Workspace Authority (`R2.6`, `R2.12`, `R2.13`):**
  - Strictly follows `CREATED → ACTIVE → SUBMITTED` via database-enforced transitions and idempotency keys (`requestId`).
  - Workspace saves increment file version (`expectedVersion` optimistic concurrency check) and append `WORKSPACE_CHANGED` events to `hirearchy.candidate_session_events`.
  - Candidate AI (`r212`) and code execution (`r213` / `packages/restricted-executor`) record structured transcripts and execution receipts without exposing server secrets or host access.
- **Evaluator Evidence, AI Review & Human Finality (`R2.7`, `R2.8`, `R2.9`, `R2.10`):**
  - `GET /r27/api/organizations/[organizationId]/sessions/[sessionId]/evidence`: read-only assigned-reviewer projection joining starter baseline, frozen submission files, save revisions metadata, execution runs, AI interactions, and paginated events.
  - `GET|POST /r27/api/organizations/[organizationId]/sessions/[sessionId]/ai-review`: advisory AI Candidate Review endpoint (`generateR27AiCandidateReview`) producing a `0–100` score, `Should Accept` / `Should Reject` recommendation, `"Why"` rationale, strengths, and weaknesses.
  - `r28` revisions endpoint: inspects intermediate file save diffs along event sequences.
  - `r29` anchored observations & `r210` review packets: reviewer-owned qualitative notes and finalized immutable review packet digest.

---

## 3. Server AI Provider Configuration (`apps/web/src/ai/server-ai-configuration.ts`)

Both candidate AI interactions (`r212`) and the evaluator AI Candidate Review (`r27-evidence/ai-review.ts`) resolve API keys via `server-ai-configuration.ts`:

- **Automatic Environment Resolution:** Loads `.env` via `@next/env` from the active repository root AND (when running inside `.worktrees/<branch>`) falls back to the primary repository root's `.env`.
- **Supported Providers:**
  - `NVIDIA_API_KEY` -> NVIDIA NIM (`https://integrate.api.nvidia.com/v1/chat/completions`), supporting `moonshotai/kimi-k2-instruct` (default Kimi preset, overridable via `NVIDIA_AI_REVIEW_MODEL_ID` or custom UI slug), `nvidia/nemotron-3-super-120b-a12b`, `qwen/qwen3-235b-a22b`, or any valid NVIDIA NIM model ID.
  - `OPENROUTER_KEY` -> OpenRouter (`https://openrouter.ai/api/v1/chat/completions`), supporting `google/gemini-2.5-flash`, `anthropic/claude-3.7-sonnet`, or custom OpenRouter slugs.
- **Resilient Preview Fallback:** Placeholder/empty keys or upstream HTTP failures cleanly fall back in `generateR27AiCandidateReview` to `buildDeterministicEvidencePreviewReport`, synthesizing strengths, weaknesses, score, and recommendation strictly from local diff/chronology evidence so the UI always remains functional during local UAT or offline demos.

---

## 4. Runtime Profiles (`apps/web/src/runtime/profile.ts`)

1. **Founder UAT / Authenticated Staging (`isAuthenticatedStaging()`)**: Runs Web + GoTrue + PostgreSQL + Mailpit (`127.0.0.1:8025`) + Restricted Executor dispatch via `scripts/founder-uat-runtime.mjs` / `apps/web/src/staging/browser.ts`.
2. **Legacy Local SQLite (`DELIMIT_DB_PATH`)**: Preserved for legacy unit tests and isolated non-Postgres routes.
3. **Production Deployment (`deploy/staging/`)**: Containerized single-host stack fronted by TLS reverse proxy (`docs/architecture/trusted-proxy-policy.md`).
