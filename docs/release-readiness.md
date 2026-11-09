# MVP release readiness

- **As of:** 2026-11-09
- **Authority:** [active MVP release program](plans/active/mvp-release-program.md)
- **Status Summary:**
  - **Stage A (Public Preview):** **SOURCE, BROWSER, AND LOCAL PACKAGE ACCEPTANCE COMPLETE; NOT PUBLICLY HOSTED.** The locked marketing and early-access profile has passed the synthetic buyer browser/visual acceptance and local packaged smoke. Public DNS, a paid host, and production TLS have not been provisioned. The [single-host activation guide](../deploy/staging/README.md) is included in PR #17; deploy only its protected merge after all four required checks pass.
  - **Stage B (Supervised Alpha):** **LOCALLY REHEARSED; NOT HOSTED.** The combined alpha package passed the synthetic recruiter → candidate → assigned-reviewer workflow, availability/outage checks, independent backup restore, and image/snapshot rollback on loopback with local TLS. No external users or public service were enabled.
  - **Stage C (External-Candidate Beta):** **GATED.** Founder and legal approval for privacy, retention and deletion; approved external access; production host, domain/IP policy, secret and backup custody, off-host retention, and an alert owner remain open. Untrusted execution, live AI, email delivery, and public signup stay disabled.

This is the single authoritative release record for release status and verification evidence. It contains no credentials, candidate personal data, private recovery artifact locations, or unverified commercial claims.

---

## Verification update — 2026-11-09

The source entry baseline for this update is protected `main` at `62bdc5bc05736c3d7b637c50b4decb1df752d974` (PR #18 merge). PR #15, PR #16, and PR #18 were ordinarily merged and each passed all four required checks (`verify`, `postgres`, `real-docker`, `dependency-audit`): [PR #15 checks](https://github.com/mohamedsaba/hirearchy/actions/runs/42532758493) ([other three](https://github.com/mohamedsaba/hirearchy/actions/runs/42532758540)), [PR #16 checks](https://github.com/mohamedsaba/hirearchy/actions/runs/42537169165) ([other three](https://github.com/mohamedsaba/hirearchy/actions/runs/42537169164)), and [PR #18 checks](https://github.com/mohamedsaba/hirearchy/actions/runs/42540126635) ([other three](https://github.com/mohamedsaba/hirearchy/actions/runs/42540126628)). Track PR #17’s live exact-head checks and deploy only its protected merge after all four required checks pass.

- **Stage A:** The public-preview allowlist, buyer form success/error and keyboard flows, responsive visual fix, repeatable synthetic demo launcher, and operator intake export were exercised locally. The packaged app includes only the five approved Reservation Moves assets, whose runtime hashes matched the source; intake survives restart and can be exported through the operator workflow.
- **Stage B:** The packaged loopback/TLS rehearsal completed the full recruiter, candidate-consent, submission, assigned-reviewer, and finalized human-review flow. `npm run test:staging` passed its safety, outage/browser/recovery, 11-stage durable journey, 12-stage onboarding, and four-stage rollback coverage. The packaged web service survived PostgreSQL stop/start with unchanged app PID, readiness `503`→`200`, health `200`, and unchanged data. A GPG-integrity-checked AES-256 backup restored PostgreSQL globals/data, early-access intake, and protected configuration/keys; the assigned reviewer could log in and retrieve the same finalized packet. The prior-image plus matching-snapshot rollback and roll-forward returned the same packet. All of this was local; no remote host, public DNS, production ACME, off-host backup destination, or alert channel was provisioned.
- **Source follow-up:** The early-access storage-log canary fix (`e31911e`) is included in the PR #17 package; it passed its focused 10-unit, lint, and type checks. No candidate code execution, live AI, email, or public signup was enabled.

The entries below preserve the prior merged-PR ledger as historical evidence through PR #13.

## Authoritative Merged Pull Request Ledger (PR #5 – PR #13)

| PR                                                      | Merged Head | Merge Commit | Date       | Scope & Key Verification Evidence                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | ----------- | ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#5](https://github.com/mohamedsaba/hirearchy/pull/5)   | `2bf5971`   | `1a919b4`    | 2026-11-05 | **Authenticated Internal Staging Foundation**: GoTrue authentication, PostgreSQL RLS, signed Ed25519 identity proofs v2, fail-closed route lockdown. CI checks: 4/4 passing (`verify`, `postgres`, `real-docker`, `dependency-audit`).                                                                                                                                                                                                            |
| [#6](https://github.com/mohamedsaba/hirearchy/pull/6)   | `74d523c`   | `6f14404`    | 2026-11-08 | **MVP Durable Workflow & Recovery Baseline**: GoTrue + PostgreSQL + Chromium candidate workspace, affirmative consent, lost-response recovery, reviewer observations/packets, separate-instance database recovery. CI checks: 4/4 passing.                                                                                                                                                                                                        |
| [#7](https://github.com/mohamedsaba/hirearchy/pull/7)   | `c4b4ac0`   | `83a9203`    | 2026-11-08 | **Proof Boundary Hardening & Recovery AMR Quarantine**: Enforced verified AMR recovery-token restrictions (`isRecovery: false`, rejecting recovery AMR entries with 28000 at proof boundary). Dedicated `/api/auth/reset-password` endpoint. CI checks: 4/4 passing.                                                                                                                                                                              |
| [#8](https://github.com/mohamedsaba/hirearchy/pull/8)   | `bb1b11b`   | `ee659ae`    | 2026-11-08 | **Approved-Template Durable Journey (Reservation Moves v3)**: 11-stage durable journey from template catalog exposure to finalized review packet; surviving app restart and separate-instance binary PostgreSQL disaster restore (`pg_dump` / `pg_dumpall`). CI checks: 4/4 passing.                                                                                                                                                              |
| [#9](https://github.com/mohamedsaba/hirearchy/pull/9)   | `5e3ed8a`   | `c3153a3`    | 2026-11-08 | **Priority 6: Self-Service Onboarding Backend**: 12-stage onboarding journey, Migration 0017, GoTrue verified email check, immutable organization ownership (`owner_principal_id`), idempotent team bootstrap, reviewer invitations, server-side session revocation, and disaster restore rehearsal. CI checks: 4/4 passing.                                                                                                                      |
| [#10](https://github.com/mohamedsaba/hirearchy/pull/10) | `6a08270`   | `1825abf`    | 2026-11-08 | **Internal Demo UX & Multi-Viewport Accessibility Acceptance**: 12-step end-to-end visual journey (`scripts/run-demo-ux-acceptance.mjs`, `tests/browser/demo-ux-acceptance.mjs`); 36 screens captured across Desktop (`1440x900`), Tablet (`768x1024`), Mobile (`390x844`); 0 horizontal overflows; 0 Axe WCAG 2.1 AA violations. CI checks: 4/4 passing.                                                                                         |
| [#11](https://github.com/mohamedsaba/hirearchy/pull/11) | `2abd8f0`   | `3c5971a`    | 2026-11-08 | **Market Readiness, Competitive Positioning & Buyer Intake**: Added `docs/product/competitive-positioning.md`, `docs/product/buyer-demo-and-discovery.md`, functional early-access intake (`/early-access`, `/api/early-access`), multi-viewport acceptance (`scripts/run-buyer-journey-acceptance.mjs`, 15 screens, 0 overflows, 0 Axe violations), 16/16 unit tests. CI checks: 4/4 passing.                                                    |
| [#12](https://github.com/mohamedsaba/hirearchy/pull/12) | `c51e314`   | `033f0a9`    | 2026-11-08 | **Wave 3 Backend Hardening, Rate Limiting, Observability & Rollback Rehearsal**: Bounded sliding-window rate limiting (`429` + `Retry-After`), secret-redacted logger (`logger.mjs`), operational readiness probe (`/api/staging/readiness`), single-team staging packaging (`deploy/staging/`), 4-stage Release N -> N-1 -> N rollback rehearsal (`scripts/test-release-rollback.mjs`). CI checks: 4/4 passing.                                  |
| [#13](https://github.com/mohamedsaba/hirearchy/pull/13) | `f3840aa`   | `c4cb5fe`    | 2026-11-08 | **Wave 3 Self-Service Onboarding Frontend UI & Browser Acceptance**: Multi-page onboarding UI (`/r23/signup`, `/r23/verify-email`, `/r23/organization/bootstrap`, `/r23/organizations/[id]/settings`, `/r23/invitations/accept`, `/r23/recover`, `/r23/reset-password`), 21-step acceptance (`scripts/run-onboarding-ux-acceptance.mjs`, 63 screens across 3 viewports, 0 overflows, 0 Axe violations, 10/10 unit tests). CI checks: 4/4 passing. |

---

## Supported Release Architecture

The master development mandate selects PostgreSQL for the release product path. The target is one Next.js modular monolith, GoTrue user identity, application-signed Ed25519 identity proof v2 boundary, PostgreSQL persistence with RLS, and a separately controlled candidate execution sandbox boundary. Legacy SQLite schemas and data remain preserved until a formal migration or retirement is verified; no SQLite fallback is part of the release path.

The internal workflow demo and supervised alpha environments use expiring and revocable candidate and reviewer links shown to authorized team members. Transactional email delivery remains disabled (`emailDeliveryEnabled: false`); GoTrue signup confirmation and reviewer invitations explicitly report that automated email delivery is disabled, supporting truthful manual/supervised token handoff in non-SMTP staging. Live candidate code execution and live AI assistance remain disabled in the durable staging profile until their respective service, security, and operational gates are separately accepted.

---

## Detailed Implementation & Verification Evidence

### 1. Approved-Template Durable Journey: Reservation Moves v3 (PR #8)

The durable staging lifecycle is verified end-to-end on PostgreSQL specifically using the approved template **Reservation Moves v3** (`reservation-moves@v3`, templateId `reservation-moves-v3`, recipe `reservation-moves.pytest`):

1. **Approved-template catalog exposure & selection**: `availableTemplates` exposed on organization context API and client, exporting `expectedWorkspaceDigest` (`c1e172b1...`) and `expectedBriefDigest` (`10d0bb11...`).
2. **Stable scenario/version binding**: `reservation-moves` / `v3` / `Reservation Moves` correctly bound and retained across assessment creation, validation, issuance, candidate read/save/submit, evidence workbench, and review packets.
3. **Static validation**: Template-backed assessment validates brief and workspace digests without requiring untrusted live execution.
4. **Assessment issuance & invitation security**: Candidate token envelope generated with SHA-256 token hashing, AES-256-GCM ciphertext, 30-day lifecycle expiration check, and reviewer assignment.
5. **Affirmative consent enforcement**: Candidate activation strictly rejects string consent (`"true"`) with R2603; affirmative boolean consent (`accepted: true`, notice version `candidate-data-v1`, digest `9bfa590ff...`) persists to `candidate_data_consents`.
6. **Candidate workspace starter files & save/resume**: Unpacks exactly 4 files (`src/sender.py`, `src/service.py`, `src/state.py`, `tests/test_moves.py`) at version 0 with verified content digests. Edits to `src/service.py` persist version 1 revision in `candidate_file_revisions`, record `WORKSPACE_CHANGED` event, and resume cleanly.
7. **Durable submission capture**: Finalizes candidate session with closure reason `candidate_submission`, records `candidate_session_submissions`, and rejects late edits with R2605.
8. **Evidence provenance & truthful restrictions**: Submitted evidence surfaces truthful capability restrictions (`terminalEnabled: false`, `aiCapabilitySnapshot.enabled: false`, capture limitation notice). Factual records contain zero automated scores, candidate rankings, or competence labels.
9. **Evaluator authorization boundaries**: Recruiter denied `evidence.read` (42501), unassigned reviewer denied `evidence.read` and `review.packet.save` (42501), cross-org recruiter denied (42501), recovery credential proof denied (28000).
10. **Human review lifecycle**: Evaluator observations created and updated with citation grounding, draft review packet saved, finalized with SHA-256 digest, review history preserved, and finalized packet mutation rejected (R2105).
11. **Restart & PostgreSQL backup/restore rehearsal**: Survives application disconnect/restart; full binary database backup (`pg_dump -Fc`) and cluster globals (`pg_dumpall -g`) restored into a separate PostgreSQL instance, verifying evidence, revisions, submissions, observations, and finalized review packet intact.

Test coverage: `scripts/test-reservation-moves-durable-journey.mjs` (all 11 stages passing) and automated inclusion in `npm run test:staging`.

---

### 2. Internal Demo UX & Multi-Viewport Accessibility Acceptance (PR #10)

Worker A implemented and verified the complete 12-step internal demo visual and browser journey:

- **Automated UX Verification Script**: `scripts/run-demo-ux-acceptance.mjs` and Playwright suite `tests/browser/demo-ux-acceptance.mjs`.
- **12 Journey Steps Verified**:
  1. Recruiter login (`/r23/login`)
  2. Organization assessment builder (`/r23/organizations/[orgId]/builder`)
  3. Template selection (`Reservation Moves v3`) & static digest validation
  4. Assessment issuance & candidate invitation link display
  5. Reviewer assignment to issued session
  6. Candidate invitation pre-start & affirmative data consent
  7. Candidate workspace file editing (`src/service.py`) & revision persistence
  8. Candidate final submission confirmation
  9. Evaluator review workbench evidence load (`/evaluator/sessions/[sessionId]`)
  10. Observation drafting with code citation grounding
  11. Review packet drafting and SHA-256 digest finalization
  12. Final immutable review packet inspection and mutation rejection
- **Multi-Viewport Visual Checks**: Captured 36 full-page screenshots across:
  - Desktop: `1440x900`
  - Tablet: `768x1024`
  - Mobile: `390x844`
- **Defect Remediation**: 0 horizontal layout overflows; 0 Axe WCAG 2.1 AA violations; resolved Next.js 16 duplicate Turbopack config defect in `next.config.ts`.

---

### 3. Market Readiness, Competitive Positioning & Buyer Intake (PR #11)

Worker A established the market readiness foundation and functional buyer discovery intake:

- **Competitive Positioning Specification**: `docs/product/competitive-positioning.md` analyzing direct competitors (HackerRank, Codility, Karat, CodeSignal) and establishing Hirearchy's defensible moat: evidence precedes judgment, AI neutrality without inferred mental state, human evaluators owning verdicts, and tamper-evident audit trails.
- **Buyer Demo & Discovery Package**: `docs/product/buyer-demo-and-discovery.md` establishing enterprise customer ICPs, qualifying discovery questions, 15-minute scripted demo flow, objections handling runbook, and security/privacy FAQ.
- **Early-Access Intake Pipeline**: Functional `/early-access` form backed by `/api/early-access` validating organization details, role, candidate volume, and technical requirements.
- **Multi-Viewport Browser Acceptance**: `scripts/run-buyer-journey-acceptance.mjs` capturing 15 screenshots across 3 viewports, verifying zero horizontal overflows and 0 Axe WCAG 2.1 AA accessibility violations. 16/16 unit tests passing in `tests/unit/early-access.test.ts`.

---

### 4. Wave 2 Priority 6: Self-Service Onboarding Backend (PR #9)

The backend, database schema, RLS policies, GoTrue integration, and API surface for **Priority 6: Self-Service Onboarding** are fully implemented and verified end-to-end across 12 distinct verification stages:

1. **Operational Signup Gate**:
   - Self-service signup and first-organization creation are **disabled by default** unless explicitly enabled via `HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED=true` (rejecting unconfigured attempts with 403).
   - System truthfully reports capability status (`selfServiceOnboardingEnabled`, `emailDeliveryEnabled: false`).
2. **User Registration & Verified Identity (GoTrue + Ed25519 Proof v2)**:
   - Preserves GoTrue + application-signed Ed25519 identity proof v2 architecture.
   - User identity requires verified email (`email_confirmed_at IS NOT NULL`) before product sessions or pre-principal operations are permitted (unverified identities strictly rejected with 42501).
3. **Truthful Delivery Capability**:
   - External SMTP remains disabled (`emailDeliveryEnabled: false`). Signup, reviewer invitation, and password recovery responses explicitly document disabled delivery, supporting truthful token handoff in non-SMTP staging environments.
4. **First Organization Creation & Immutable Ownership**:
   - Idempotent `organization.bootstrap` creates the user's initial organization with owner governance and recruiter operational capability.
   - PostgreSQL trigger `organizations_owner_principal_immutable` enforces permanent immutability of `owner_principal_id` once established (raising 23514 on attempted mutation).
5. **Idempotent Bootstrap Replay Protection**:
   - Replay with identical idempotency key returns cached receipt. Conflicting parameters with same idempotency key are rejected (22023). Duplicate team creation attempts by an active member are blocked (42501).
6. **Zero Cross-Tenant Leakage & Approved Catalog Exposure**:
   - Newly created organizations immediately see the approved template catalog (`Reservation Moves v3`) and empty assessment list under strict PostgreSQL RLS tenant isolation.
7. **Reviewer Invitation Lifecycle**:
   - Organization owners issue invitations bound to target email, with SHA-256 token hashing, AES-256-GCM ciphertext custody, and future expiry checks (<= 30 days).
   - Authenticated, confirmed users matching the exact canonical target email accept the invitation to gain active `reviewer` membership. Unconfirmed users, mismatched emails, expired invitations, and revoked invitations are strictly rejected (42501).
8. **Explicit Revocation & Session Lifecycle**:
   - Server-side session revocation (`staging_sessions.revoked_at`) and GoTrue `auth.sessions` deletion are enforced in PostgreSQL, rejecting subsequent product proofs with 28000.
9. **Password Recovery & Quarantine Invariant (PR #7)**:
   - Recovery credentials/JWTs (`method: "recovery"`, `isRecovery: true`) are strictly quarantined and rejected (28000) from all product APIs and Ed25519 proof minting.
   - Recovery credentials are valid exclusively at the dedicated `/api/auth/reset-password` endpoint.
10. **Account & Organization Management**:
    - Users can view and update profile display name. Owners can update organization display name and list members with their roles and owner indicators.
    - Owners can revoke reviewer memberships; removal or demotion of the organization owner is strictly rejected (42501).
11. **Migration Idempotency & Separate-Instance Disaster Recovery**:
    - Migration 0017 (`0017_self_service_onboarding.sql`) is fully idempotent on re-run.
    - Full binary database backup (`pg_dump -Fc`) and cluster globals (`pg_dumpall -g`) restored into a separate PostgreSQL instance, verifying organizations, members, revoked invitations, and receipts intact.

Test coverage: `scripts/test-self-service-onboarding.mjs` (all 12 stages passing) and `tests/unit/onboarding.test.ts` (5/5 unit tests passing).

---

### 5. Wave 3: Backend Hardening, Rate Limits, Observability, Staging Packaging & Rollback Rehearsal (PR #12)

Wave 3 implemented comprehensive backend hardening and operational release assets across six key dimensions:

1. **Bounded Deterministic Rate Limiting & Abuse Controls**:
   - Implemented in `apps/web/src/security/rate-limit.ts` using a sliding window algorithm with strict in-memory key bounding (default max 10,000 tracked keys) and LRU/expiration eviction to prevent memory exhaustion.
   - Standard `429 Too Many Requests` responses with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining: 0`, and `X-RateLimit-Reset` headers.
   - Enforced on `/api/auth/signup` (20 req/min), `/api/auth/verify-email` (20 req/min), `/api/auth/recover` (20 req/min), `/api/auth/reset-password` (20 req/min), `/api/staging/v1` (100 req/min), `/api/candidate/sessions/*` (60 req/min).
   - Test coverage: `tests/unit/rate-limit.test.ts` (7/7 tests passing).
2. **Structured Secret-Redacted Observability**:
   - Implemented in `apps/web/src/observability/logger.mjs` with deterministic redaction for DB URLs with credentials, Ed25519 keys, AES-256 keys, Bearer tokens, recovery tokens, and error stack traces.
   - Test coverage: `tests/unit/observability.test.ts` (8/8 tests passing).
3. **Operational Readiness Endpoint**:
   - Exposed `GET /api/staging/readiness` (`apps/web/app/api/staging/readiness/route.ts` & `apps/web/src/observability/readiness.mjs`).
   - Probes PostgreSQL connectivity, migration version `0017`, durable markers (`durable-candidate-lifecycle-v1`, `durable-onboarding-v1`, candidate token storage meta, R211 authoring, R214 execution), and truthfully reports capability boundaries. Returns 200 on healthy readiness, 503 on unready.
4. **Dependency Remediation & Audit Integrity**:
   - `npm audit --audit-level=high` reports **0 vulnerabilities** (exit code 0), matching CI. Documented why `--force` downgrading `eslint-config-next` would regress Next.js 16 peer dependencies.
5. **Single-Team Staging Deployment Packaging**:
   - Packaged in `deploy/staging/`: `README.md` (runbook & rollback guide), `docker-compose.staging.yml` (PostgreSQL + GoTrue stack), `env.staging.example` (configuration template), `preflight.mjs` (preflight environment validator), and `scripts/deploy-single-team-staging.mjs` (staging deployment and verification runner).
6. **Additive Schema Rollback Rehearsal**:
   - Automated rehearsal script `scripts/test-release-rollback.mjs` (`npm run test:rollback`).
   - 4 stages verifying Release N -> N-1 schema compatibility (Release N-1 queries succeed against 0017 schema without column collisions or syntax errors, 0017 additions ignored, zero auth bypass) and Release N roll-forward idempotency.

---

### 6. Wave 3: Self-Service Onboarding Frontend UI & Browser Acceptance (PR #13)

Worker A implemented and verified the complete frontend UI for Priority 6 Self-Service Onboarding:

- **Complete User Facing Routes Wired**:
  - `/r23/signup`: Recruiter registration form with instant password policy validation and clear status reporting.
  - `/r23/verify-email`: Verification code submission and manual token handoff view when email delivery is disabled.
  - `/r23/organization/bootstrap`: First organization creation with idempotent team naming and owner provisioning.
  - `/r23/organizations/[id]/settings`: Team governance, organization display name management, member list with owner badges, and reviewer invitation modal.
  - `/r23/invitations/accept`: Reviewer invitation acceptance flow with token verification and team membership activation.
  - `/r23/recover`: Password recovery request view explicitly confirming disabled SMTP delivery.
  - `/r23/reset-password`: Quarantined recovery JWT handling allowing secure password resets.
- **21-Step Multi-Viewport Browser Acceptance**:
  - Script: `scripts/run-onboarding-ux-acceptance.mjs`.
  - Captured 63 full-page screenshots across Desktop (`1440x900`), Tablet (`768x1024`), and Mobile (`390x844`).
  - 0 horizontal layout overflows across all 63 captures.
  - 0 Axe WCAG 2.1 AA accessibility violations.
  - 10/10 unit tests passing in `tests/unit/onboarding.test.ts`.

---

## Release Gates Status Table

| Stage                          | Status                                                                                   | Evidence and remaining boundary                                                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A: Public Preview**          | **Package ready from PR #17 protected merge after all four required checks; not public** | Source, browser, keyboard, visual, intake persistence/export, and local package checks passed. Actual host, public DNS, and production TLS remain unprovisioned.                                                               |
| **B: Supervised Alpha**        | **Rehearsed locally; not hosted**                                                        | Packaged TLS workflow, outage recovery, independent restore, and image/snapshot rollback passed on loopback. Host, access, privacy/retention, off-host backup, alert ownership, and key custody decisions remain open.         |
| **C: External-Candidate Beta** | **Gated**                                                                                | Requires separate founder authorization for external access and approved privacy/retention/incident handling. Candidate execution, live AI, email delivery, and public signup remain disabled; no activation is included here. |

---

## Required Checks and Verification Boundary

Run these on the accepted post-PR base, serially where they use Docker, PostgreSQL, Auth, or Chromium:

- `npm run verify` — format, lint, typecheck, unit/integration suite (1,148 tests), executor checks, and Next.js production build.
- `npm run test:postgres` — role, migration, PostgreSQL authorization, and storage foundation.
- `npm run test:staging` — authenticated persistent staging, candidate/reviewer browser acceptance, denial checks, Reservation Moves v3 durable journey, self-service onboarding, and release rollback rehearsal.
- `npm run test:onboarding` — self-service onboarding backend, GoTrue integration, PR #7 recovery-token quarantine, and disaster recovery rehearsal (12 stages).
- `npm run test:rollback` — compatible release rollback rehearsal across additive schema migrations (4 stages).
- `node scripts/run-demo-ux-acceptance.mjs` — 12-step internal demo visual UX and multi-viewport browser acceptance (36 screens, 0 overflows, 0 Axe violations).
- `node scripts/run-buyer-journey-acceptance.mjs` — buyer discovery and early-access intake visual journey (15 screens, 0 overflows, 0 Axe violations).
- `node scripts/run-onboarding-ux-acceptance.mjs` — 21-step self-service onboarding frontend visual and accessibility journey (63 screens, 0 overflows, 0 Axe violations).
- `node scripts/test-r214-integration.mjs` — existing disposable PostgreSQL and real-Docker candidate/execution bridge; supplemental evidence only.

---

## Founder and External Operational Decisions

- **Host and access:** Choose provider, region, budget, domain/DNS, approved source IP ranges, and who is authorized to access the supervised alpha. No paid host, public DNS, or production ACME certificate exists.
- **Data and key custody:** Name the operator and alert owner; approve production secret/key custody and rotation, off-host backup destination and retention, and restore access. Local encrypted backup and restore evidence does not establish off-host retention.
- **Privacy and deletion:** Approve the buyer intake notice, retention period, operator access, and deletion procedure, including copies held in backup archives. The application persists intake requests; there is no claim of automatic expiry or legal certification.
- **Scope:** Email delivery, public signup, live AI, and candidate code execution stay disabled. They are not prerequisites for this supervised-alpha rehearsal and require separate authorization before any activation.

---

## Authoritative Decision Rule

A green build, disposable browser path, or staging recovery test does not establish external beta or public-MVP readiness. Update this record with the exact accepted source SHA and directly supporting CI/browser/recovery evidence. Leave unknown items marked unknown; do not claim a deployment, backup, customer result, or security certification that was not verified.
