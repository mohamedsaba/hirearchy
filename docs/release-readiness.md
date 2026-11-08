# MVP release readiness

- **As of:** 2026-11-08
- **Authority:** [active MVP release program](plans/active/mvp-release-program.md)
- **Status:** **NO-GO for a complete internal demo, external-candidate beta, or public MVP.** PR #6 is merged with accepted technical browser and recovery evidence. Authenticated visual review, the approved-template walkthrough, first-team onboarding and later release gates remain incomplete.

This is the single current record for release status and evidence. It contains no credentials, candidate data, private recovery artifact locations, or unverified commercial claims.

## Supported release direction

The master development mandate selects PostgreSQL for the release product path. The target is one Next.js modular monolith, GoTrue user identity, the verified app-signed proof boundary, PostgreSQL persistence, and a separately controlled candidate execution boundary. Legacy SQLite schemas and data remain preserved until a migration or retirement is tested and recoverable; no SQLite fallback is part of the release path.

The proposed internal demo uses expiring and revocable candidate and reviewer links shown to an authorized team member. It sends no invitation email; GoTrue signup confirmation and password recovery still require configured SMTP. Live AI and code execution remain disabled in the durable staging profile until their service, privacy, security, and operational gates are separately accepted.

## Historical PR #5 foundation

**Merged source head:** `2bf59713e3d6ccd9c18e46db71d2de8dba467524`

**Pull request:** [#5](https://github.com/mohamedsaba/hirearchy/pull/5) is merged. Its source head is `2bf59713e3d6ccd9c18e46db71d2de8dba467524`; the protected merge commit is `1a919b40ab45f9788a8cf0f785d33449379b7098` (merged 2026-11-05). The normal merge included the accepted source head. Its merge-time `main` commit was `1a919b4`; the old base was `580c286c9308645aba31a12f2a54d872552b69f3`.

**Accepted scope:** authenticated internal staging foundation only. PR #5 did not integrate candidate activity or evaluator review writes. PR #6 subsequently accepted the technical candidate/review browser and recovery journey below. Complete demo and later release gates remain open.

All four required checks passed on the exact merged source head before merge:

- [Verify run 42081956863](https://github.com/mohamedsaba/hirearchy/actions/runs/42081956863) — format, lint, types, tests, build, and scenario-runtime checks passed.
- [Executor PostgreSQL run 42081956900](https://github.com/mohamedsaba/hirearchy/actions/runs/42081956900) — dependency audit, PostgreSQL checks, real-Docker, authenticated staging/recovery, and recruiter-to-evidence checks passed.
- Required contexts: `verify`, `dependency-audit`, `postgres`, and `real-docker`.

The launcher safety correction and Node test naming fix are included in the merged source. `node --test tests/staging/launcher-safety.mjs` passed 3/3; syntax, Prettier, and diff checks passed. That focused check did not launch real Docker. The earlier [Verify run 42073541602](https://github.com/mohamedsaba/hirearchy/actions/runs/42073541602) and [Executor PostgreSQL run 42073541820](https://github.com/mohamedsaba/hirearchy/actions/runs/42073541820) apply only to `94a57bd71be52e5ef6bfafaee50c4d45a8198409` and are historical evidence.

### What PR #5 supports

- GoTrue-authenticated browser sign-in and sign-out, selected organization context, and PostgreSQL-backed recruiter authoring, static validation, issuance, and reviewer assignment through signed identity proofs.
- PostgreSQL tables and restricted operations for tenant membership, assessment authoring and issuance, candidate tokens, candidate workspace/revisions/events/submissions, evidence, observations, and human review.
- A fail-closed authenticated staging profile with a route allowlist.

### What PR #5 deliberately does not support

- No candidate token or candidate workspace link is issued by the R2.15 staging UI. Its own browser acceptance checks that the invitation is unavailable.
- Candidate activity is not produced by its staging journey: the tested issued session remains `CREATED` with empty candidate evidence.
- Candidate workspace operations, execution, and AI are disabled in authenticated staging.
- Evidence reads are limited to permitted/eligible states; observation and human-review packet writes are disabled in that profile.
- Initial recruiter/organization provisioning remains an administrator operation; there is no verified self-service signup or first-organization flow.
- PR #5 does not prove public deployment, external email delivery, production candidate execution, managed-Supabase compatibility, or independent off-host backup acceptance.

Source anchors: `apps/web/src/staging/server.ts`, `apps/web/src/staging/browser.ts`, `apps/web/src/runtime/profile.ts`, `database/postgres/migrations/0014_staging_proof_state.sql`, `database/postgres/migrations/0015_staging_dispatch_api.sql`, and `tests/staging/journey.mjs`.

## Accepted PR #6 technical evidence

[PR #6](https://github.com/mohamedsaba/hirearchy/pull/6) merged normally on 2026-11-08. Its accepted source is `74d523c91ecd4bc547cfa1fbe4c85b87cf2de749`; protected merge commit `6f144045a3dcfa523fd7d79112c09721011b4871` has the exact same tree. The primary checkout was fast-forwarded without changing its unrelated generated-file edit.

- [Verify run 42478976235](https://github.com/mohamedsaba/hirearchy/actions/runs/42478976235) and [Executor PostgreSQL run 42478976277](https://github.com/mohamedsaba/hirearchy/actions/runs/42478976277) pass on that source. All four required contexts pass: `verify`, `dependency-audit`, `postgres`, and `real-docker`. There were no unresolved review threads or requested changes at merge.
- Real GoTrue, PostgreSQL and Chromium acceptance passes invitation creation/recovery/expiry/revocation, affirmative candidate consent, persistent workspace save and lost-response recovery, submission retry, restart/read-only behavior, assigned-reviewer observations, draft reload and final human review. Both unassigned-reviewer writes return `403` without changing observations, packets or history. The forms-page CSP and Secure/HttpOnly cookie protections remain intact.
- Late separate-instance database and application recovery passes after the actual candidate and final-review workflow, including stored-data/API fingerprints and active invitation recovery. The existing R2.14 real-Docker recruiter-to-evidence compatibility journey also passes. These are owned disposable rehearsals, not off-host backup or production-host acceptance.
- The packet-response regression reproduces SQLSTATE `42601` on the old installer and passes corrected draft creation/update, stale-version denial without mutation, history, finalization and immutable replay on actual migrations. The bounded SQL-only fixture used synthetic Auth metadata. All 84 literal dispatcher queries also passed non-executing schema preparation. Full CI above supplies the separate live-authentication/browser evidence.
- The technical journey captured eight masked synthetic workflow screenshots under the privacy guards. Upload remains deferred; no authenticated-workflow screenshot was uploaded or visually inspected. A 900 MiB local build and a separate webpack development attempt stopped by OOM before rendering. Do not repeat those attempts under unchanged capacity.
- Limited static Home, Software and Contact component checks at 1280×900, 834×900 and 390×900 pass all nine overflow/target/text checks; captures were inspected and the public suites pass 13/13. This does not establish Next delivery/hydration/navigation or authenticated visual acceptance.

AI assistance, candidate code execution and email delivery remain disabled in durable staging. The approved Reservation Moves v3 template has a durable source path, but the accepted browser journey used a custom assessment; its approved-template walkthrough remains pending. No deployment, public signup, customer delivery or managed-Supabase compatibility is certified by this merge.

## Current follow-up: recovery-proof eligibility

An isolated, in-progress follow-up requires normal verified AMR before product proof issuance or staging browser-session creation. It emits proof v2 with strict `isRecovery: false`; the SQL verifier rejects v1, missing, true and non-boolean recovery fields. Recovery in any AMR entry and missing/empty/malformed AMR deny product access while preserving legacy verification outside this proof boundary.

Focused identity/proof/direct-API/login tests pass 11/11, including unsafe timestamp denial; typechecking and static checks pass. The actual migrated SQL fixture passes v2 negative proofs, existing authorization/replay checks and review persistence with synthetic Auth metadata. Fresh full CI and live-GoTrue AMR variant checks remain pending. This does not implement signup, SMTP, password-recovery callbacks, team bootstrap or reviewer invitations.

## Reusable next integration seam

- **Recruiter:** `/r23/login` and `/r23/organizations/...` use GoTrue authentication, organization membership, assessment draft/validate/issue, and reviewer assignment.
- **Candidate:** `apps/web/src/r26-candidate/server.ts` and the R26 PostgreSQL adapter implement bearer-token scoped activation, workspace read/save/submit, and finality. Migrations 0003–0005 define the candidate token envelope, workspace, event, operation, submission, and revision data.
- **Restricted execution:** R2.14 connects approved execution operations to the restricted executor service. `node scripts/test-r214-integration.mjs` is a disposable development integration, not the durable staging profile or a production security certification.
- **Evaluator evidence and review:** R27 provides submitted evidence reads; R210 stores structured human review packets. PR #5's R2.15 staging allowlist blocks candidate operations and evaluator writes. PR #6's accepted durable path bridges these operations through verified identity and PostgreSQL authorization; never accept a browser-supplied subject or enable disposable runtime flags in durable mode.

The immediate code gate is recovery-proof eligibility, followed by first-team onboarding. Authenticated visual review and the approved-template walkthrough remain acceptance gates. Keep AI and execution visibly disabled.

## Release gates

| Release level           | Status        | Evidence needed                                                                                                                                                                                                     |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internal workflow demo  | **Not ready** | Technical browser and late recovery gates pass; authenticated visual review and the approved-template walkthrough remain pending.                                                                                   |
| Supervised alpha        | **Not ready** | Internal journey accepted; first-team setup, supported single-team hosting, migration/restore/rollback, monitored operation, and privacy disclosures verified.                                                      |
| External-candidate beta | **No-go**     | Beta environment and recovery accepted; invitation expiry/revocation and delivery path verified; execution threat boundary accepted before enabling candidate code execution; support and incident process defined. |
| Public MVP              | **No-go**     | Beta gates plus approved legal/privacy copy, market and competitor evidence, public onboarding, reliable delivery, monitoring, backups, and founder-approved production activation.                                 |

## Required checks and verification boundary

Run these on the accepted post-PR base, serially where they use Docker, PostgreSQL, Auth, or Chromium:

- `npm run verify` — format, lint, typecheck, unit/integration suite, executor checks, and production build.
- `npm run test:postgres` — role, migration, PostgreSQL authorization, and storage foundation.
- `npm run test:staging` — authenticated persistent staging, candidate/reviewer browser acceptance, denial checks and recovery rehearsal.
- `node scripts/test-r214-integration.mjs` — existing disposable PostgreSQL and real-Docker candidate/execution bridge; supplemental evidence only.

The accepted PR #6 CI above is the technical browser/recovery baseline. Focused checks on the in-progress recovery-proof follow-up do not replace fresh full CI on its final source. Hosting, off-host backup, authenticated visual acceptance and any external deployment remain unverified.

## Blocking operational and product decisions

- **Deployment:** No production or cloud deployment is evidenced by these source merges. Choose and approve a supported hosting/reverse-proxy/TLS design; establish persistent PostgreSQL and GoTrue operations, secret rotation, monitoring, and rollback before external use. Do not incur charges or publish a service without the mandate's approval.
- **Recovery:** The local staging suite records separate-instance restore and release rollback coverage. Off-host backup independence, backup retention, managed-provider restore, and rollback on a production-like host remain unverified. Database dumps alone do not restore cluster roles or encryption/signing keys.
- **Authentication and provisioning:** First-team self-service and reviewer invitations remain proposed, not implemented; initial staging organization provisioning is administrator-managed. Keep identity proof bound to verified GoTrue sessions and current membership. Signup confirmation and password recovery require GoTrue SMTP; team invitations do not send email. See the [proposed onboarding ADR](decisions/mvp-first-team-onboarding.md).
- **Candidate delivery and privacy:** The internal demo may expose an expiring/revocable copy link in the authenticated product UI; it must state that no email is sent. External delivery provider, candidate notice/consent, retention policy, and approved legal text remain release gates.
- **Execution and AI:** Keep off in durable staging. External candidate code execution needs an independent security and operations acceptance, not only the disposable R2.14 Docker run. Live AI needs a separate privacy/provider and cost decision.
- **Product truth:** `README.md`, the system overview, current-state handoff, and non-goals now describe the PostgreSQL/GoTrue release direction and preserve SQLite as historical prototype work. First-team onboarding remains a proposal; do not claim self-service setup until its implementation is independently accepted.

## Decision rule

A green build, disposable browser path, or staging recovery test does not establish external beta or public-MVP readiness. Update this record with the exact accepted source SHA and directly supporting CI/browser/recovery evidence. Leave unknown items marked unknown; do not claim a deployment, backup, customer result, or security certification that was not verified.
