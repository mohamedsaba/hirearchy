# MVP release program

Status: Active. Updated: 2026-11-05.

This is the single active plan for the MVP release program. The R2.15 internal staging foundation plan is complete and preserved at `docs/plans/completed/160-r2-15-staging-foundation.md`. The current release evidence and go/no-go state live in [release readiness](../../release-readiness.md). Update that file as source, CI, browser, recovery, or hosting evidence changes; do not create a sequence of R2.x status reports.

## Objective and architecture

Deliver a credible internal demo of one complete recruiter → candidate → evidence → human-review journey, then close the separate gates for supervised alpha, external-candidate beta, and public MVP. The initial buyer hypothesis is small and mid-sized software companies hiring junior-to-mid-level engineers; validate it with current market sources before making commercial claims.

The release architecture is a Next.js modular monolith with PostgreSQL as the durable product store, GoTrue for user identity, and the verified application-signed identity proof for database operations. Reuse the current PostgreSQL assessment authoring, issuance, candidate workspace, evidence, assignment, and human-review domains. Keep candidate execution as a separate restricted runtime boundary.

Preserve legacy SQLite data and migration history while a tested, recoverable transition is designed. PostgreSQL is the product authority for the release journey. Do not add a SQLite fallback or dual-write path.

Evidence remains separate from evaluator judgment. Do not add candidate scores, rankings, automatic competence labels, pass/reject decisions, or an AI verdict.

## Current integration boundary

PR #5, R2.15, merged to protected `main` as `1a919b40ab45f9788a8cf0f785d33449379b7098`, from source head `2bf59713e3d6ccd9c18e46db71d2de8dba467524`. It provides an authenticated internal staging foundation: GoTrue sign-in, organization selection, assessment draft/validation/issuance, and reviewer assignment through the PostgreSQL proof boundary. It intentionally issues no candidate token or link; candidate activity, execution, live AI, and evaluator review writes are blocked in this profile. Its browser acceptance covers this restricted scope, not the complete product journey. The complete workflow and later release levels remain NO-GO. Exact CI evidence and limits are in [release readiness](../../release-readiness.md).

The existing R2.14 PostgreSQL candidate bridge already has the token-scoped workspace and the restricted-executor integration. Reuse those domains and their evidence model. Do not turn on R2.14 disposable flags in the persistent staging profile.

## Delivery sequence

1. **Consolidate PR #5 — complete, internal staging foundation only.** The launcher correction is included in source head `2bf59713e3d6ccd9c18e46db71d2de8dba467524`; all four required CI contexts passed on that exact commit. PR #5 merged through the normal protected workflow as `1a919b40ab45f9788a8cf0f785d33449379b7098`. Protected `main` was fast-forwarded locally to this merge commit while preserving the pre-existing dirty `apps/web/next-env.d.ts`. This acceptance does not complete the candidate-to-human-review workflow or change any release gate.
2. **Build the internal demo on the accepted PostgreSQL base.** Connect recruiter issuance to an expiring, revocable, copyable candidate invitation; require clear data-use disclosure and consent before work begins; support candidate activation, editing, save/autosave, refresh recovery, and final submission; make submitted evidence available only to the assigned evaluator; retain a human review packet. The internal demo sends no email, uses no live AI, and does not enable external execution.
3. **Prove the complete journey and isolation.** Exercise recruiter, candidate, and evaluator browser flows against disposable PostgreSQL and GoTrue. Verify token expiry/revocation/replay, submission finality, organization and reviewer-assignment isolation, durable restart, truthful failure/success states, and captured evidence provenance. Run heavyweight checks serially on the shared machine.
4. **Prepare a buyer-facing demo.** Validate the initial buyer segment with sourced competitor research. Provide a short demo script, honest capability disclosures, customer-discovery questions, and a pricing hypothesis. No fabricated interviews, testimonials, or outcome metrics.
5. **Close release-level gates.** Rehearse supported hosting, migration, backup restore, rollback, monitoring, proxy/TLS, and security controls before external candidates or a public launch. Ask for a precise provisioning decision only where an external service, paid infrastructure, or irreversible activation is genuinely required.

## Acceptance for the internal demo

- A recruiter can sign in, select an authorized organization, create/edit/validate an approved assessment, issue it, and assign an evaluator.
- The recruiter receives a usable invitation link from the product UI. The token is random, session-scoped, expiring and revocable; only a protected digest and recoverable encrypted envelope are stored. Candidate access cannot read or mutate another session or organization.
- The candidate sees task instructions, time limits, data-use disclosure, and consent before activation; can edit, save/autosave, resume after refresh/restart, and submit; and receives confirmation only after durable submission.
- PostgreSQL remains authoritative across application restarts. Submission is final and retry-safe. The assigned evaluator can inspect the factual chronology and source evidence and save/finalize a retained human review. Unassigned reviewers and recruiters without evaluator scope are denied.
- AI and execution remain visibly disabled in the durable profile. No external email is sent. Errors are factual and do not claim delivery, persistence, or completion that did not occur.
- Browser acceptance covers the whole flow, keyboard and responsive behavior, privacy disclosure, failure recovery, and the authorization negatives above. PostgreSQL/security and migration/recovery checks run against fresh disposable infrastructure.

## Priorities

**P0 — Complete product contract:** PostgreSQL recruiter-to-candidate-to-evidence-to-human-review flow; first-team account/organization onboarding or an explicitly bounded administrator-provisioned internal demo; secure candidate invitation and consent; durable submission; tenant and reviewer isolation; restart/recovery; supported single-team deployment path.

**P1 — Credible market demo:** clear recruiter and candidate onboarding, responsive and accessible screens, professional empty/error states, accurate public product claims, sourced competitive positioning, buyer demo materials, and approved privacy/terms copy before publication.

**P2 — Post-MVP:** live AI providers, multiple technology stacks, ATS and enterprise integrations, advanced analytics, billing, and broad customization. These remain gated or deferred until a validated requirement and separate security/operational acceptance exist. Safe execution for external candidates remains an external-beta launch gate; it is not enabled in the internal demo.

## Ownership and working rules

- **Sol 6.1 Ultra:** owns product/scope/architecture decisions, integration authority, and acceptance. The founder's 2026-11-06 continuation authorizes direct bounded implementation while Luna is unavailable; do not claim independent worker verification for that work.
- **Luna Max:** preferred for repository scans, market research, code, Git operations, tests, and routine delivery when available. Maximum two active Luna workers; no nested delegation. Do not repeatedly retry quota-exhausted workers or silently substitute models.
- Sol assigns non-overlapping files and responsibilities. Workers report changed paths, commands, evidence, limitations, and remaining uncertainty.
- The common implementation base is protected main at merge commit `1a919b40ab45f9788a8cf0f785d33449379b7098`; use an isolated worktree and preserve unrelated work. Begin backend implementation only after root accepts the API contract and assigns ownership. Never force-overwrite or clean unknown resources.
- Coordinate database, Docker, browser, and full-suite verification serially. A passing unit or disposable integration test does not certify staging or production.
- Do not commit, push, merge, send customer communications, incur paid services, or deploy publicly without the applicable authorization in the master mandate and protected workflow.

## Documentation to converge with implementation

Update the architecture overview, README, current-state handoff, scenario/runtime documentation, and applicable product requirements when the PostgreSQL release path is accepted. Reconcile legacy SQLite statements and old non-goals against this mandate without deleting historical migration or recovery evidence. Keep one current release evidence record in [release readiness](../../release-readiness.md); move this plan to `docs/plans/completed/` only when the objective and release gates are actually achieved.

## Accepted internal-demo rules and implementation contract

Root accepted these product and security rules and assigned the backend implementation. The contract below is being implemented on the durable-workflow branch; it is not a deployment or release certification.

### Invitation lifecycle and idempotency

- Keep the existing immutable assessment issuance API unchanged. Create an invitation explicitly after issuance through `POST /r23/api/organizations/{organizationId}/sessions/{sessionId}/candidate-token`; require an ISO `expiresAt`, `Idempotency-Key`, verified GoTrue recruiter session, selected organization membership, CSRF, and Origin validation. The recruiter UI defaults expiry to seven days and permits a future time up to 30 days. Do not default a missing expiry on the server.
- Export the client-safe `R23CandidateInvitationResponse` from the existing R23 contract module if appropriate, otherwise `apps/web/src/r23-auth/contract.ts`. `POST` returns `201` on first creation and `200` on an idempotent replay; `GET` is read-only status/recovery. Both return `{ sessionId, status, expiresAt: string | null, candidatePath: string | null }`, where status is `not_created`, `active`, `expired`, `revoked`, or `unmanaged`. `candidatePath` is non-null only when status is currently valid `active`, and otherwise is `null`. `DELETE` explicitly revokes and is repeat-safe, returning `{ sessionId, status: "revoked" }`. Never return token ciphertext. Do not require renewal or token rotation in this first slice; show a clear expired/revoked terminal state and tell the candidate to contact the recruiter.
- Persist a request receipt in PostgreSQL and bind the key to a fingerprint of the logical fields `(organizationId, sessionId, expiresAt)`. Atomically create one token envelope and lifecycle record. A retry with the same key and logical payload returns/recoveries the same invitation; reuse with changed logical fields returns conflict. Concurrent matching requests mint only once. The random token/ciphertext is not part of the fingerprint, and retry state must not live only in process memory.
- Add lifecycle metadata in a new migration after `0015`; do not edit earlier migration bytes or change immutable token hash, ciphertext, or creation time. Existing undated envelopes are not implicitly adopted or given a synthetic expiry. Candidate access remains unavailable until a verified recruiter explicitly creates the lifecycle through the proof-bound flow.
- Expiry and revocation must block every candidate read and write. The database must check lifecycle state atomically with each candidate operation and serialize races with revocation, while preserving saved workspace, events, submissions, evaluator evidence, and review records.

### Candidate notice, activation, and capabilities

Use the canonical notice version `candidate-data-v1` with this exact text:

> This workspace records saved code, revisions, task activity and submission for your assigned hiring team’s review. This demo uses synthetic data; do not enter secrets or real candidate information. AI assistance and code execution are unavailable in this demo.

The R26 candidate GET response proposal is `R26CandidateGetResponse = R26CandidateView & { invitationExpiresAt: string | null; capabilities: { ai: boolean; execution: boolean }; dataNotice: { version: 'candidate-data-v1'; digest: string; text: string } | null }`. In the durable internal demo, `invitationExpiresAt` and `dataNotice` are non-null, and `capabilities.ai` and `capabilities.execution` are both `false`. `invitationExpiresAt: null` and `dataNotice: null` are allowed only for the legacy disposable profile. The page receives authoritative server capabilities; it must skip AI/execution requests and keep controls disabled until that response is known. Do not hardcode capabilities in the UI or invent fallback budgets.

The candidate GET presents the notice before activation and does not start the timer. Durable activation requires affirmative unchecked consent with `{ consent: { version, digest, accepted: true } }`; the durable server validates it against the canonical notice and stores the canonical text or digest, version, and server timestamp atomically with activation. In the legacy disposable profile only, `dataNotice: null` retains the existing `{}` activation input so the R2.14 journey remains compatible. The UI activates durably only after the server supplied notice; backend lifecycle and consent checks remain authoritative and do not trust client capability fields. This records an observable acknowledgement, not proof of understanding or legal compliance. Preserve R26 request ID, version, replay, and submission-finality invariants.

Proposed client-safe DTO exports live in `apps/web/src/r26-candidate/contract.ts`: `R26CandidateGetResponse` (the existing `R26CandidateView` plus `invitationExpiresAt`, `capabilities`, and `dataNotice`) and `R26CandidateActivationInput`, a union of durable `{ consent: { version: 'candidate-data-v1'; digest: string; accepted: true } }` and legacy disposable `{}`. `GET /r26/api/candidate/{sessionId}` returns `R26CandidateGetResponse`; `POST` on that endpoint accepts the profile-appropriate `R26CandidateActivationInput` for activation. A proposed page-eligibility export is `r26CandidatePageIsAvailable()` in `apps/web/src/r26-candidate/config.ts`. It controls access to the page under the supported profile; it does not authorize candidate API operations. Preserve existing `r26IsEnabled()` semantics for its existing callers unless a reviewed caller trace proves safe to change. Candidate API operations continue to require the bearer-token hash and PostgreSQL authorization checks.

### Evaluator boundary

Only the assigned reviewer may inspect evidence for a submitted session. Preserve author-private observations, optimistic review-packet versioning, and existing review finalization semantics. Do not add evaluator scores, rankings, automatic verdicts, or candidate competence labels. Keep AI, code execution, and email disabled in the durable demo; do not enable disposable runtime flags.

The staging verifier owner uses column-only `UPDATE(id)` privileges on assessment sessions and reviewer assignments to acquire the existing `FOR SHARE` locks. Narrow `FOR UPDATE` RLS policies require the verified organization, exact requested session, active reviewer assignment, and submitted status, with `WITH CHECK (false)` denying every row update. Runtime roles receive no added update privilege.

### Proposed backend ownership and DTO map

- `apps/web/app/r23/api/organizations/[organizationId]/sessions/[sessionId]/candidate-token/route.ts`: add method-specific POST/GET/DELETE handlers. Export a client-safe `R23CandidateInvitationResponse` with `{ sessionId, status, expiresAt, candidatePath }` for POST/GET and `{ sessionId, status: "revoked" }` for DELETE. Reuse verified R23 recruiter identity, selected organization authorization, CSRF/Origin, and `Idempotency-Key`; do not call legacy SQLite token storage.
- `apps/web/src/r23-auth/server.ts` and `apps/web/src/staging/server.ts`: authenticate the recruiter and dispatch only allowlisted operations through the existing GoTrue verification and app-signed proof. The browser never supplies its own subject or organization authorization. Add exact per-method route entries in `apps/web/proxy.ts`.
- `apps/web/src/staging/dispatch.mjs` and `database/postgres/staging/install-api.sql`: add proof-bound invitation create/status/revoke operations and validate each operation’s arguments, membership, role, and assigned session. The SQL transaction owns the durable idempotency receipt and lifecycle state.
- `database/postgres/migrations/0016_candidate_invitation_lifecycle.sql`: proposed additive lifecycle/receipt schema. Preserve existing encrypted envelope bytes; enforce idempotent creation and lifecycle authorization in PostgreSQL.
- `apps/web/src/r26-candidate/contract.ts` exports `R26CandidateGetResponse` and `R26CandidateActivationInput`; `apps/web/src/r26-candidate/server.ts` returns the GET DTO from `r26CandidateRead` and validates profile-specific activation input. Map the existing adapter view plus server-owned `invitationExpiresAt`, `capabilities`, and `dataNotice`. Candidate GET may not leak token material.
- `apps/web/src/r26-candidate/config.ts`: add `r26CandidatePageIsAvailable()` for the supported candidate page profile while retaining current disposable semantics; add durable config without a disposable flag. Durable candidate requests use an explicit `STAGING_CANDIDATE_DATABASE_URL` for the existing constrained `app_candidate_gateway`, never the recruiter `r23_gateway` pool. It must point to the same PostgreSQL host, port, database, and connection options as `STAGING_DATABASE_URL`, with distinct expected login roles `app_candidate_gateway` and `r23_gateway`. Migration `0016` wraps the existing token-verified `hirearchy.r26_candidate_command` with lifecycle and canonical-consent checks before cached operation receipts. It defines an absent-by-default protected singleton; only the privileged staging installer inserts its fixed durable marker after validating the guard, and runtime roles cannot mutate it. An installed database enforces lifecycle checks regardless of signing-key, membership, invitation, or disposable-runtime flag state. Databases without the marker retain the existing disposable activation contract. Durable readiness requires the marker and exact migration-ledger version/checksum. Candidate access continues to require the opaque bearer token and existing constrained database command.
- Before each durable candidate command, the adapter runs the parameter-free `r26_candidate_lifecycle_ready()` preflight and fails closed unless the protected marker and matching migration ledger entry are present. The candidate gateway's exact runtime execute allowlist is the mutating `r26_candidate_command(...)` and this authenticated read-only probe; PUBLIC, recruiter, and evaluator roles cannot execute the probe. The SQL wrapper still checks the token, expiry/revocation, and consent atomically before calling the internal command.
- B’s UI mapping after this contract is accepted: R23 recruiter UI creates, recovers, copies, and revokes the invitation from the existing issued session; R26 page eligibility calls `r26CandidatePageIsAvailable()`; candidate GET is typed as `R26CandidateGetResponse`; AI/execution controls and fetches follow `response.capabilities`; the consent step renders only `response.dataNotice` and activates only after affirmative acknowledgement. No capability defaults or candidate UI changes to reviewer writes are required.
- Continue through existing R27 submitted-evidence and R210 human-review surfaces. Preserve the existing `writesEnabled` contract, assigned-reviewer checks, submitted-session gate, private observations, and optimistic finalization.

## Current CI repair — 2026-11-06

PR #6 is draft at implementation source `b5bcbf4abc67725da60f070040a18166d28b8132`. Preserve interrupted work before editing. Repair the React state/effect lifecycle, keep the candidate command plus its read-only lifecycle probe as the exact runtime function allowlist, and make the installer accept only the bootstrap role setting `search_path=pg_catalog` while rejecting extra or per-database settings. Preserve the explicit disposable-schema refusal. Run focused lint/types and PostgreSQL checks, then the complete required CI and browser/recovery journey on the new head. The founder approved the eight masked synthetic PNGs as GitHub Actions artifacts for seven days; inspect for credential exposure before upload and keep all other operational files excluded. Full browser, visual, and release acceptance remain pending.
