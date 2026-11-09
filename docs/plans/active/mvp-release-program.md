# MVP release program

Status: Active; zero-cost release preparation and exact-head acceptance are in progress. No hosting, paid services, domains, APIs, public activation, real prospect data, or outreach are authorized. Updated: 2026-11-09.

This is the single active plan for the MVP release program. The R2.15 internal staging foundation plan is complete and preserved at `docs/plans/completed/160-r2-15-staging-foundation.md`. The current release evidence and go/no-go state live in [release readiness](../../release-readiness.md). Update that file as source, CI, browser, recovery, or hosting evidence changes; do not create a sequence of R2.x status reports.

## Objective and architecture

The internal demo and previous local supervised-alpha rehearsal are complete. This plan remains active to complete the zero-cost release-preparation PR and its exact-head browser/package/recovery CI, then record the remaining founder decisions. The initial buyer hypothesis is unvalidated; use only the synthetic internal demo and do not contact real prospects in this task.

The release architecture is a Next.js modular monolith with PostgreSQL as the durable product store, GoTrue for user identity, and the verified application-signed identity proof for database operations. Reuse the current PostgreSQL assessment authoring, issuance, candidate workspace, evidence, assignment, and human-review domains. Keep candidate execution as a separate restricted runtime boundary.

Preserve legacy SQLite data and migration history while a tested, recoverable transition is designed. PostgreSQL is the product authority for the release journey. Do not add a SQLite fallback or dual-write path.

Evidence remains separate from evaluator judgment. Do not add candidate scores, rankings, automatic competence labels, pass/reject decisions, or an AI verdict.

## Current integration boundary

The protected-main baseline is PR #17 merge `bbaf2458557389e6ca5291586c08a8deb21a5dea`, which includes PR #18; PRs #15–18 merged normally, with four required jobs green on the baseline. [PR #19](https://github.com/mohamedsaba/hirearchy/pull/19) adds product retention controls, local readiness alerts, and CI browser/package tests. Prior Stage A browser/package checks and Stage B end-to-end/recovery/rollback rehearsals were local; the new exact-head CI is pending. Neither stage is hosted. No deployment follows from passing CI. Exact baseline evidence, current limits, and founder decisions are in [release readiness](../../release-readiness.md).

The existing R2.14 PostgreSQL candidate bridge already has the token-scoped workspace and the restricted-executor integration. Reuse those domains and their evidence model. Do not turn on R2.14 disposable flags in the persistent staging profile.

## Delivery sequence

1. **Consolidate PR #5 — complete, internal staging foundation only.** The launcher correction is included in source head `2bf59713e3d6ccd9c18e46db71d2de8dba467524`; all four required CI contexts passed on that exact commit. PR #5 merged through the normal protected workflow as `1a919b40ab45f9788a8cf0f785d33449379b7098`. Protected `main` was fast-forwarded locally to this merge commit while preserving the pre-existing dirty `apps/web/next-env.d.ts`. This acceptance does not complete the candidate-to-human-review workflow or change any release gate.
2. **Build the internal demo — complete on protected main.** PRs #6, #8, #10, and #18 cover the durable recruiter, candidate, assigned-reviewer, approved-template, visual, keyboard, and responsive flow. The demo sends no email, uses no live AI, and does not enable candidate execution.
3. **Prove the complete journey and isolation — complete in local integration and packaged alpha.** The recruiter, candidate, and assigned-reviewer journey, authorization denials, outage recovery, durable restart, consent, submission finality, evidence provenance, independent PostgreSQL restore, and image/snapshot rollback passed. See the dated [release evidence](../../release-readiness.md); these rehearsals do not certify a hosted service.
4. **Prepare a buyer-facing demo — complete for synthetic, supervised discovery.** Competitive positioning, discovery script, honest capability disclosures, and pricing hypothesis are in `docs/product/competitive-positioning.md` and `docs/product/buyer-demo-and-discovery.md`; no interviews, testimonials, or outcome metrics are claimed.
5. **Complete zero-cost release preparation — active.** Run the buyer browser suite and actual Compose/local-CA TLS, readiness outage/recovery, receipt replay, resource-sample package check on the combined PR head through the four required standard GitHub-hosted checks. Record its exact-head evidence in the PR. Do not deploy, purchase hosting/domains/services, activate public traffic, or use real prospect data. Any later hosted or external access requires separate founder decisions for privacy/retention, host/domain/IP policy, secret/backup custody, alerting, and support ownership.

## Acceptance for the internal demo

- A recruiter can sign in, select an authorized organization, create/edit/validate an approved assessment, issue it, and assign an evaluator.
- The recruiter receives a usable invitation link from the product UI. The token is random, session-scoped, expiring and revocable; only a protected digest and recoverable encrypted envelope are stored. Candidate access cannot read or mutate another session or organization.
- Candidate token encryption requires canonical base64 for exactly 32 random bytes. Keep the protected key stable while encrypted invitations remain; missing key material with stored invitations fails closed instead of generating a replacement.
- The candidate sees task instructions, time limits, data-use disclosure, and consent before activation; can edit, save/autosave, resume after refresh/restart, and submit; and receives confirmation only after durable submission.
- PostgreSQL remains authoritative across application restarts. Submission is final and retry-safe. The assigned evaluator can inspect the factual chronology and source evidence and save/finalize a retained human review. Unassigned reviewers and recruiters without evaluator scope are denied.
- AI and execution remain visibly disabled in the durable profile. No external email is sent. Errors are factual and do not claim delivery, persistence, or completion that did not occur.
- Browser acceptance covers the whole flow, keyboard and responsive behavior, privacy disclosure, failure recovery, and the authorization negatives above. PostgreSQL/security and migration/recovery checks run against fresh disposable infrastructure; the completed candidate/reviewer session is included in the backup restored by the acceptance run.

## Priorities

**P0 — Complete product contract:** PostgreSQL recruiter-to-candidate-to-evidence-to-human-review flow; secure candidate invitation and consent; durable submission; tenant and reviewer isolation; restart/recovery; supported single-team deployment path. The proposed first-team flow in [the onboarding ADR](../../decisions/mvp-first-team-onboarding.md) is limited to a confirmed GoTrue identity with no active organization memberships; the founder keeps the recruiter role and an immutable owner binding. Team display names are trimmed to 1–120 Unicode code points (PostgreSQL `char_length` / JavaScript code-point count), reject controls, and are escaped for output; no slug or uniqueness rule is required. Owner-copied invitations grant reviewer only, default to seven days, and allow an explicit expiry up to 30 days; they send no invitation email. GoTrue signup confirmation and password recovery still require provisioned SMTP. In proof-bound PostgreSQL staging, derive recovery eligibility only from every AMR entry on the exact bearer after live GoTrue `/user` verification; missing, empty, or malformed AMR denies proof issuance. Recovery credentials may update the password only, then require fresh login; cookie isolation does not protect the direct bearer API. Require `isRecovery` in proof v2 and strict `false` in SQL before any product operation, with no v1 fallback, while retaining existing signature, replay, subject, live-session, and expiry checks. Verify the Auth custom access-token hook preserves AMR; do not add `auth.mfa_amr_claims` grants, policies, helper roles, or claim that SQL independently rechecks AMR. These checks apply only to proof-bound PostgreSQL staging; preserve legacy SQLite and disposable behavior. Until the ADR is accepted and implemented, organization provisioning remains administrator-only.

**P1 — Credible market demo — complete for supervised synthetic use:** clear recruiter and candidate onboarding, responsive and accessible screens, professional empty/error states, accurate public product claims, sourced competitive positioning, and buyer demo materials are prepared. Founder/legal privacy and terms approval remains pending before publication or external candidate use.

**P2 — Post-MVP:** live AI providers, multiple technology stacks, ATS and enterprise integrations, advanced analytics, billing, and broad customization. These are deferred product options, not launch gates for the current supervised alpha. Any later addition requires a validated requirement and separate security/operational acceptance. Candidate execution remains disabled.

## Ownership and working rules

- **Sol 6.1 Ultra:** owns product/scope/architecture decisions, integration authority, and acceptance. The founder's 2026-11-06 continuation authorizes direct bounded implementation while Luna is unavailable; do not claim independent worker verification for that work.
- **Luna Max:** preferred for repository scans, market research, code, Git operations, tests, and routine delivery when available. Maximum two active Luna workers; no nested delegation. Do not repeatedly retry quota-exhausted workers or silently substitute models.
- Sol assigns non-overlapping files and responsibilities. Workers report changed paths, commands, evidence, limitations, and remaining uncertainty.
- The common implementation base is protected main at merge commit `6f144045a3dcfa523fd7d79112c09721011b4871`; use an isolated worktree and preserve unrelated work. Begin backend implementation only after root accepts the API contract and assigns ownership. Never force-overwrite or clean unknown resources.
- Coordinate database, Docker, browser, and full-suite verification serially. A passing unit or disposable integration test does not certify staging or production.
- Do not commit, push, merge, send customer communications, incur paid services, or deploy publicly without the applicable authorization in the master mandate and protected workflow.

## Documentation to converge with implementation

Update the architecture overview, README, current-state handoff, scenario/runtime documentation, and applicable product requirements when the PostgreSQL release path is accepted. Reconcile legacy SQLite statements and old non-goals against this mandate without deleting historical migration or recovery evidence. Keep one current release evidence record in [release readiness](../../release-readiness.md); move this plan to `docs/plans/completed/` only when the objective and release gates are actually achieved.

## Accepted internal-demo rules and implementation contract

Root accepted these product and security rules and assigned the backend implementation. The contract below is implemented by merged PR #6 with the technical acceptance above; it is not a deployment or release certification.

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

## Prior CI repair — 2026-11-06 through 2026-11-08

The interrupted candidate/UI work was preserved before repair. PR #6's accepted source retains the exact candidate-command/lifecycle-probe allowlist, bootstrap-role setting checks, disposable-schema refusal, browser privacy guards and proof-bound authorization. The founder approved eight masked synthetic PNG artifacts but later deferred upload because the existing credential lacks workflow scope. Keep upload deferred; do not modify workflows or export screenshots/private diagnostics through another route. Full technical browser and recovery CI now passes; authenticated visual and later release acceptance remain pending.

## Recovery credentials cannot authorize product operations

- **Status:** Active; root accepted this bounded security contract on 2026-11-08.
- **Implementation base:** accepted PR #6 merge `6f144045a3dcfa523fd7d79112c09721011b4871`. This does not accept or implement the remaining first-team onboarding proposal.

### Problem and outcome

A recovery-issued GoTrue bearer can reach the direct staging API. A separate recovery cookie cannot prevent that. Require an eligible normal login before creating a staging browser session or issuing any product proof. Recovery credentials remain available only to GoTrue password update, followed by fresh login.

### Accepted boundary

1. Preserve exact-token live GoTrue `/user`, subject, session and expiry verification. Classify its Auth-signed AMR only after live verification. Inspect every entry: any recovery method is recovery-only. Missing, empty or malformed AMR is ineligible. Valid entries require a nonempty method and nonnegative safe-integer timestamp; do not silently select the first entry or default to normal login.
2. Carry the classification in the existing branded verified identity. Preserve legacy SQLite and disposable verification behavior; an identity with ineligible AMR cannot issue a staging proof.
3. Require proof version 2 with exact keys and `isRecovery: false`. Deny recovery and ineligible identities in the shared issuer. Deny both before the staging login writes a browser session. The direct bearer API and all browser product operations continue through this shared issuer.
4. PostgreSQL requires strict boolean false and rejects v1. Retain signature, key, independent live Auth subject/session/expiry, principal, membership, operation and nonce checks. No fallback, Auth AMR-table privileges or migration changes.
5. Deploy the application and privileged verifier installer together in the existing staging rehearsal. A mismatched version fails closed; do not introduce compatibility acceptance of v1.

### Ownership and checks

Luna owns identity/proof/login guards, SQL proof validation and affected fixtures in an isolated checkout. Root owns the contract, review, integration and acceptance. Preserve unrelated work, earlier migration bytes, source workflows and disabled AI/execution/email capabilities.

Cover normal password login; recovery in any AMR entry; missing/empty/malformed AMR; proof issuance and browser-session denial; direct API denial; strict SQL rejection of true/missing/null/string/numeric recovery fields and v1; and continued nonce/live-session enforcement. Use existing focused suites and the actual migrated SQL fixture before full CI. Record exact source and evidence in release readiness. Do not claim signup, SMTP, first-team setup, managed-Supabase compatibility, deployment or public readiness from this slice.
