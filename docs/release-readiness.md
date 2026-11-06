# MVP release readiness

- **As of:** 2026-11-06
- **Authority:** [active MVP release program](plans/active/mvp-release-program.md)
- **Status:** **NO-GO for a complete internal demo, external-candidate beta, or public MVP.** PR #5 is an accepted internal staging foundation. PR #6 remains draft and unmerged; its candidate and human-review workflow is not accepted.

This is the single current record for release status and evidence. It contains no credentials, candidate data, private recovery artifact locations, or unverified commercial claims.

## Supported release direction

The master development mandate selects PostgreSQL for the release product path. The target is one Next.js modular monolith, GoTrue user identity, the verified app-signed proof boundary, PostgreSQL persistence, and a separately controlled candidate execution boundary. Legacy SQLite schemas and data remain preserved until a migration or retirement is tested and recoverable; no SQLite fallback is part of the release path.

The proposed internal demo uses expiring and revocable candidate and reviewer links shown to an authorized team member. It sends no invitation email; GoTrue signup confirmation and password recovery still require configured SMTP. Live AI and code execution remain disabled in the durable staging profile until their service, privacy, security, and operational gates are separately accepted.

## Current PR #5 evidence

**Merged source head:** `2bf59713e3d6ccd9c18e46db71d2de8dba467524`

**Pull request:** [#5](https://github.com/mohamedsaba/hirearchy/pull/5) is merged. Its source head is `2bf59713e3d6ccd9c18e46db71d2de8dba467524`; the protected merge commit is `1a919b40ab45f9788a8cf0f785d33449379b7098` (merged 2026-11-05). The normal merge included the accepted source head. `origin/main` now points to the merge commit; the old base was `580c286c9308645aba31a12f2a54d872552b69f3`.

**Accepted scope:** authenticated internal staging foundation only. PR #5 did not integrate candidate activity or evaluator review writes. The complete recruiter-to-candidate-to-evidence-to-human-review demo and all later release levels remain NO-GO.

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

## Current PR #6 evidence

**Pull request:** [#6](https://github.com/mohamedsaba/hirearchy/pull/6) remains draft and unmerged. The last verified public head is `02bba91a289f767754e0609db5cce0d35eb9f1f5`. The following workflow results apply to that head; a later path-limited source update is pending fresh CI and must not be treated as a passed or merged version.

- [Verify run 42199508267](https://github.com/mohamedsaba/hirearchy/actions/runs/42199508267) failed on three legacy R2.14 execution-UI fixtures that lacked capability fields; 132 test files and 1,111 tests passed.
- [Executor PostgreSQL run 42199507362](https://github.com/mohamedsaba/hirearchy/actions/runs/42199507362): dependency audit and PostgreSQL checks passed. The real-Docker job passed executor checks and built the production app, then failed on a PostgreSQL proof-security permission error (`42501`) before the browser journey.
- The fixture correction at local source commit `958b4e9` passed its focused check 9/9. The SQL failure has safe fixed-label diagnostics for investigation, but its cause is unknown and the permission issue is not verified as fixed. Combined local privacy, candidate-key, and launcher checks passed 16/16; these checks do not replace CI or browser acceptance.
- The eight-image privacy-guarded synthetic screenshot export is implemented locally, but GitHub rejected publishing the workflow-file change because the connected write credential lacks workflow scope. The path-limited PR update omits that workflow change. The founder chose to defer screenshot export/upload for now; no artifact was uploaded or visually reviewed. No further workflow authorization is pending, and this does not block core CI or browser acceptance.

Fresh CI on the next exact public SHA and the complete browser/recovery journey remain pending. Visual review of screenshots is also pending because export is deferred, but it is not a blocker for the core engineering checks. Do not infer success from the local focused checks or earlier PR #5 CI.

## Reusable next integration seam

- **Recruiter:** `/r23/login` and `/r23/organizations/...` use GoTrue authentication, organization membership, assessment draft/validate/issue, and reviewer assignment.
- **Candidate:** `apps/web/src/r26-candidate/server.ts` and the R26 PostgreSQL adapter implement bearer-token scoped activation, workspace read/save/submit, and finality. Migrations 0003–0005 define the candidate token envelope, workspace, event, operation, submission, and revision data.
- **Restricted execution:** R2.14 connects approved execution operations to the restricted executor service. `node scripts/test-r214-integration.mjs` is a disposable development integration, not the durable staging profile or a production security certification.
- **Evaluator evidence and review:** R27 provides submitted evidence reads; R210 stores structured human review packets. PR #5's R2.15 staging allowlist blocks candidate operations and evaluator writes. PR #6's source bridges these operations but remains unaccepted; never accept a browser-supplied subject or enable disposable runtime flags in durable mode.

The immediate gate is to obtain fresh CI on the exact published PR #6 head, then complete the candidate/reviewer browser and recovery acceptance. Keep AI and execution visibly disabled.

## Release gates

| Release level           | Status        | Evidence needed                                                                                                                                                                                                     |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internal workflow demo  | **Not ready** | Complete browser journey through candidate invitation, consent, persistent workspace, submission, assigned reviewer evidence, and saved human review.                                                               |
| Supervised alpha        | **Not ready** | Internal journey accepted; first-team setup, supported single-team hosting, migration/restore/rollback, monitored operation, and privacy disclosures verified.                                                      |
| External-candidate beta | **No-go**     | Beta environment and recovery accepted; invitation expiry/revocation and delivery path verified; execution threat boundary accepted before enabling candidate code execution; support and incident process defined. |
| Public MVP              | **No-go**     | Beta gates plus approved legal/privacy copy, market and competitor evidence, public onboarding, reliable delivery, monitoring, backups, and founder-approved production activation.                                 |

## Required checks and verification boundary

Run these on the accepted post-PR base, serially where they use Docker, PostgreSQL, Auth, or Chromium:

- `npm run verify` — format, lint, typecheck, unit/integration suite, executor checks, and production build.
- `npm run test:postgres` — role, migration, PostgreSQL authorization, and storage foundation.
- `npm run test:staging` — authenticated persistent staging, browser acceptance, and recovery rehearsal. Extend this acceptance to cover the new candidate and review path before calling the demo complete.
- `node scripts/test-r214-integration.mjs` — existing disposable PostgreSQL and real-Docker candidate/execution bridge; supplemental evidence only.

No tests, servers, migrations, database reads, or deployment were run for this documentation refresh. The four green required contexts listed above are historical PR #5 evidence only. PR #6's current failed and pending checks are recorded in the section above. Hosting and any currently running external deployment were not verified in this review.

## Blocking operational and product decisions

- **Deployment:** No production or cloud deployment is evidenced by PR #5. Choose and approve a supported hosting/reverse-proxy/TLS design; establish persistent PostgreSQL and GoTrue operations, secret rotation, monitoring, and rollback before external use. Do not incur charges or publish a service without the mandate's approval.
- **Recovery:** The local staging suite records separate-instance restore and release rollback coverage. Off-host backup independence, backup retention, managed-provider restore, and rollback on a production-like host remain unverified. Database dumps alone do not restore cluster roles or encryption/signing keys.
- **Authentication and provisioning:** First-team self-service and reviewer invitations remain proposed, not implemented; initial staging organization provisioning is administrator-managed. Keep identity proof bound to verified GoTrue sessions and current membership. Signup confirmation and password recovery require GoTrue SMTP; team invitations do not send email. See the [proposed onboarding ADR](decisions/mvp-first-team-onboarding.md).
- **Candidate delivery and privacy:** The internal demo may expose an expiring/revocable copy link in the authenticated product UI; it must state that no email is sent. External delivery provider, candidate notice/consent, retention policy, and approved legal text remain release gates.
- **Execution and AI:** Keep off in durable staging. External candidate code execution needs an independent security and operations acceptance, not only the disposable R2.14 Docker run. Live AI needs a separate privacy/provider and cost decision.
- **Product truth:** `README.md`, the system overview, current-state handoff, and non-goals now describe the PostgreSQL/GoTrue release direction and preserve SQLite as historical prototype work. First-team onboarding remains a proposal; do not claim self-service setup until its implementation is independently accepted.

## Decision rule

A green build, disposable browser path, or staging recovery test does not establish external beta or public-MVP readiness. Update this record with the exact accepted source SHA and directly supporting CI/browser/recovery evidence. Leave unknown items marked unknown; do not claim a deployment, backup, customer result, or security certification that was not verified.
