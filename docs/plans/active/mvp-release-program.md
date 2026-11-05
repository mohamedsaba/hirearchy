# MVP release program

Status: Active. Updated: 2026-11-05.

This is the single active plan for the MVP release program. The existing R2.15 plan at `docs/plans/active/160-r2-15-staging-foundation.md` remains scoped to PR #5 until consolidation; move it to `completed/` with its final evidence after acceptance. The current release evidence and go/no-go state live in [release readiness](../../release-readiness.md). Update that file as source, CI, browser, recovery, or hosting evidence changes; do not create a sequence of R2.x status reports.

## Objective and architecture

Deliver a credible internal demo of one complete recruiter → candidate → evidence → human-review journey, then close the separate gates for supervised alpha, external-candidate beta, and public MVP. The initial buyer hypothesis is small and mid-sized software companies hiring junior-to-mid-level engineers; validate it with current market sources before making commercial claims.

The release architecture is a Next.js modular monolith with PostgreSQL as the durable product store, GoTrue for user identity, and the verified application-signed identity proof for database operations. Reuse the current PostgreSQL assessment authoring, issuance, candidate workspace, evidence, assignment, and human-review domains. Keep candidate execution as a separate restricted runtime boundary.

Preserve legacy SQLite data and migration history while a tested, recoverable transition is designed. PostgreSQL is the product authority for the release journey. Do not add a SQLite fallback or dual-write path.

Evidence remains separate from evaluator judgment. Do not add candidate scores, rankings, automatic competence labels, pass/reject decisions, or an AI verdict.

## Current integration boundary

PR #5, R2.15, is an authenticated internal staging foundation. Its recruiter path supports GoTrue sign-in, organization selection, assessment draft/validation/issuance, and reviewer assignment through the PostgreSQL proof boundary. It intentionally issues no candidate token or link; candidate activity, execution, live AI, and evaluator review writes are blocked in this profile. Its browser acceptance covers this restricted scope, not the complete product journey. The exact head, CI evidence, and limits are recorded in [release readiness](../../release-readiness.md).

The existing R2.14 PostgreSQL candidate bridge already has the token-scoped workspace and the restricted-executor integration. Reuse those domains and their evidence model. Do not turn on R2.14 disposable flags in the persistent staging profile.

## Delivery sequence

1. **Consolidate PR #5 — accepted scope: internal staging foundation only.** The launcher correction is included, root independently accepted exact head `2bf59713e3d6ccd9c18e46db71d2de8dba467524`, and all four required CI contexts passed. The native mark-ready action was denied with `Resource not accessible by integration`; PR #5 remains open, draft, and unmerged, and merge was not attempted. Protected `main` remains `580c286c9308645aba31a12f2a54d872552b69f3`. Resume only through the normal protected workflow after the access block is resolved; no alternate route or direct-main push. Start the next major product implementation from synchronized protected `main` only after consolidation completes.
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

- **Sol 6.1 Ultra:** owns product/scope/architecture decisions, integration authority, and independent acceptance only.
- **Luna Max:** performs all execution, including repository scans, market research, code, Git operations, tests, and routine delivery. Sol independently accepts the result. Maximum two active Luna workers; no nested delegation.
- Sol assigns non-overlapping files and responsibilities. Workers report changed paths, commands, evidence, limitations, and remaining uncertainty.
- After PR #5 is accepted, start implementation from the synchronized protected main commit in an isolated worktree. Preserve unrelated work and private recovery history; never force-overwrite or clean unknown resources.
- Coordinate database, Docker, browser, and full-suite verification serially. A passing unit or disposable integration test does not certify staging or production.
- Do not commit, push, merge, send customer communications, incur paid services, or deploy publicly without the applicable authorization in the master mandate and protected workflow.

## Documentation to converge with implementation

Update the architecture overview, README, current-state handoff, scenario/runtime documentation, and applicable product requirements when the PostgreSQL release path is accepted. Reconcile legacy SQLite statements and old non-goals against this mandate without deleting historical migration or recovery evidence. Keep one current release evidence record in [release readiness](../../release-readiness.md); move this plan to `docs/plans/completed/` only when the objective and release gates are actually achieved.
