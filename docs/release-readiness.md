# MVP release readiness

- **As of:** 2026-11-05
- **Authority:** [active MVP release program](plans/active/mvp-release-program.md)
- **Status:** **NO-GO for a complete internal demo, external-candidate beta, or public MVP.** PR #5 is a useful internal staging foundation; it does not yet connect candidate work or human review writes.

This is the single current record for release status and evidence. It contains no credentials, candidate data, private recovery artifact locations, or unverified commercial claims.

## Supported release direction

The master development mandate selects PostgreSQL for the release product path. The target is one Next.js modular monolith, GoTrue user identity, the verified app-signed proof boundary, PostgreSQL persistence, and a separately controlled candidate execution boundary. Legacy SQLite schemas and data remain preserved until a migration or retirement is tested and recoverable; no SQLite fallback is part of the release path.

The accepted internal demo will use an expiring and revocable candidate link shown to an authenticated recruiter. It will not send email. Live AI and code execution remain disabled in the durable staging profile until their service, privacy, security, and operational gates are separately accepted.

## Current PR #5 evidence

**Current source head:** `2bf59713e3d6ccd9c18e46db71d2de8dba467524`

**Pull request:** [#5](https://github.com/mohamedsaba/hirearchy/pull/5) remains open, draft, and unmerged at the current head. Its description still contains a superseded request to keep it draft pending founder acceptance. A PR metadata update returned 403; an issue-API fallback was rejected by automatic review. No workaround was used.

**Consolidation result:** internal acceptance covers this exact head as an authenticated internal staging foundation only. The native mark-ready mutation was denied by GitHub with `Resource not accessible by integration`; PR #5 remains draft. Merge was not attempted. The protected `main` base remains `580c286c9308645aba31a12f2a54d872552b69f3`; no synchronization or bypass occurred. The complete recruiter-to-candidate-to-evidence-to-human-review demo and all later release levels remain NO-GO.

The launcher safety correction and Node test naming fix are included in the current head. All four required checks passed on that exact commit:

- [Verify run 42081956863](https://github.com/mohamedsaba/hirearchy/actions/runs/42081956863) — format, lint, types, tests, build, and scenario-runtime checks passed.
- [Executor PostgreSQL run 42081956900](https://github.com/mohamedsaba/hirearchy/actions/runs/42081956900) — dependency audit, PostgreSQL checks, real-Docker, authenticated staging/recovery, and recruiter-to-evidence checks passed.
- Required contexts are green: `verify`, `dependency-audit`, `postgres`, and `real-docker`.

For the launcher correction, `node --test tests/staging/launcher-safety.mjs` passed 3/3. Syntax, Prettier, and diff checks passed; that focused check did not launch real Docker. The earlier [Verify run 42073541602](https://github.com/mohamedsaba/hirearchy/actions/runs/42073541602) and [Executor PostgreSQL run 42073541820](https://github.com/mohamedsaba/hirearchy/actions/runs/42073541820) apply only to `94a57bd71be52e5ef6bfafaee50c4d45a8198409` and are historical evidence, not checks for the current head. Branch metadata confirms four required contexts: verify, dependency-audit, postgres, and real-docker. Required-review protection details remain unknown because the repository API returned 403.

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

## Reusable next integration seam

- **Recruiter:** `/r23/login` and `/r23/organizations/...` use GoTrue authentication, organization membership, assessment draft/validate/issue, and reviewer assignment.
- **Candidate:** `apps/web/src/r26-candidate/server.ts` and the R26 PostgreSQL adapter implement bearer-token scoped activation, workspace read/save/submit, and finality. Migrations 0003–0005 define the candidate token envelope, workspace, event, operation, submission, and revision data.
- **Restricted execution:** R2.14 connects approved execution operations to the restricted executor service. `node scripts/test-r214-integration.mjs` is a disposable development integration, not the durable staging profile or a production security certification.
- **Evaluator evidence and review:** R27 provides submitted evidence reads; R210 stores structured human review packets. The R2.15 staging proof allowlist and routes currently block candidate operations and evaluator writes. Bridge only explicit proof-bound operations; never accept a browser-supplied subject or enable disposable runtime flags in durable mode.

The immediate next slice is therefore token issue/recovery and revocation through the verified PostgreSQL identity boundary, followed by the existing R26 candidate edit/save/resume/submit service, assigned-reviewer evidence, and retained human review. Keep AI and execution visibly disabled.

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

No tests, servers, migrations, database reads, or deployment were run for this documentation refresh. The focused launcher check and current-head CI above are reported by the orchestrator; all four required contexts passed. Hosting and any currently running external deployment were not verified in this review.

## Blocking operational and product decisions

- **Deployment:** No production or cloud deployment is evidenced by PR #5. Choose and approve a supported hosting/reverse-proxy/TLS design; establish persistent PostgreSQL and GoTrue operations, secret rotation, monitoring, and rollback before external use. Do not incur charges or publish a service without the mandate's approval.
- **Recovery:** The local staging suite records separate-instance restore and release rollback coverage. Off-host backup independence, backup retention, managed-provider restore, and rollback on a production-like host remain unverified. Database dumps alone do not restore cluster roles or encryption/signing keys.
- **Authentication and provisioning:** Prove first-user/organization onboarding and revocation without developer-built database records. Keep identity proof bound to verified GoTrue sessions and current membership.
- **Candidate delivery and privacy:** The internal demo may expose an expiring/revocable copy link in the authenticated product UI; it must state that no email is sent. External delivery provider, candidate notice/consent, retention policy, and approved legal text remain release gates.
- **Execution and AI:** Keep off in durable staging. External candidate code execution needs an independent security and operations acceptance, not only the disposable R2.14 Docker run. Live AI needs a separate privacy/provider and cost decision.
- **Product truth:** `README.md`, `docs/architecture/system-overview.md`, `docs/handoff/current-state.md`, and `docs/product/non-goals.md` still contain the earlier SQLite prototype boundary or product exclusions. Converge them with the accepted mandate and actual integrated implementation before market-facing claims.

## Decision rule

A green build, disposable browser path, or staging recovery test does not establish external beta or public-MVP readiness. Update this record with the exact accepted source SHA and directly supporting CI/browser/recovery evidence. Leave unknown items marked unknown; do not claim a deployment, backup, customer result, or security certification that was not verified.
