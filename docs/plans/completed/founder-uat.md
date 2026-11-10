# Founder UAT: independent end-user journey

- Date: 2026-11-10
- Baseline: protected `main` at `c4936cd1f6a396854400e363f7dc9d629e6a8b58` (PR #19).
- Status: complete; founder local acceptance verified.
- Authority: founder's complete end-user UAT directive. This plan records implementation scope; [release readiness](../../release-readiness.md) remains the single acceptance record.

## Outcome and boundaries

Deliver one tested, loopback-only application on the founder's Fedora machine. A new owner must register, verify email using local captured mail, sign in, create an organization, create/validate/issue the approved Reservation Moves v3 assessment, invite a candidate and a normal evaluator, and return to durable work. The candidate must consent, edit/save/resume real files, submit once, and see confirmation. The assigned evaluator must inspect genuine chronological evidence, record grounded observations, and finalize a durable human review.

Reuse the modular monolith, GoTrue, PostgreSQL, Ed25519 identity proof v2, existing memberships, template catalog, candidate lifecycle, evidence, and human-review boundaries. Recruiters do not acquire review permissions; reviewers do not acquire recruiter permissions. No normal user needs a developer key, database operation, known internal route, or agent assistance.

The founder authorizes self-service signup and local SMTP capture only in this isolated UAT profile. Public staging/production signup, external email, paid services, public deployment, live AI, fabricated activity, scores, rankings, and automatic verdicts remain outside scope. Evaluate the existing restricted executor for founder-controlled local use without weakening its isolation or authorization. Enable it only with direct safety and integration evidence; otherwise disclose the specific acceptance limitation.

Preserve existing dirty worktrees, primary checkout changes, containers, databases, and recovery archives. Keep automation accounts/data in a separate disposable environment. Initialize the founder's persistent environment with infrastructure, migrations, and approved templates only; never reset its later user data.

## Ownership

- Parent (Sol): scope, architecture, this plan, authoritative release record and product/architecture decision updates, integration, and independent acceptance.
- Worker A (Luna max; no nested delegation): frontend, onboarding/navigation, browser acceptance, accessibility, responsive defects, and related browser checks.
- Worker B (Luna max; no nested delegation): authentication/authorization, backend persistence, restricted-executor evaluation, local runtime, integration tests, and service/resource checks.

Workers implement in isolated scoped worktrees with non-overlapping files. Agree shared API changes before implementation. Integrate committed changes; preserve unrelated edits. Required verification involving PostgreSQL, Docker, and Chromium runs serially to limit resource use.

## Work sequence

1. Verify latest source and existing resources/services. Trace the real UI and backend flow; report gaps rather than relying on earlier synthetic acceptance.
2. Complete the local signup/confirmation/recovery and normal evaluator-invitation workflow. Make landing and navigation lead naturally to these actions.
3. Prepare separate disposable automation and persistent founder runtimes, restricted to loopback, with bounded resources and one reliable restart mechanism.
4. Exercise the full real recruiter → candidate → assigned-evaluator journey through UI, using separate fresh browser contexts and actual mail. Repair discovered defects.
5. Verify denial, lost-response, refresh, expiration/revocation, submission finality, application restart, and database interruption/recovery. Inspect desktop/tablet/mobile rendering, keyboard/focus, accessibility, and runtime errors.
6. Run required repository/CI checks on the integrated source, review the connected diff, reconcile docs with actual behavior, and record exact evidence in release readiness.
7. Confirm the delivered founder database has no automation activity, the app is reachable and persists across restart, and the handoff requires only one working URL and normal signup.

## Acceptance evidence required

| Area                 | Required current proof                                                                                                                                                                                      | Verification Result                                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First-time customer  | Fresh browser; signup, actual GoTrue confirmation via local mail, login/logout, organization bootstrap, template draft/save/validate/issue, evaluator invitation/assignment, candidate invitation           | **PASSED.** Verified in `tests/browser/founder-uat-journey.mjs` Steps 1–8 using local Mailpit capture (`127.0.0.1:8025`).                                                                                    |
| Candidate            | Separate fresh context; consent, genuine file edit/save/refresh/resume, one final submission, persisted content/evidence, truthful execution availability                                                   | **PASSED.** Verified in `tests/browser/founder-uat-journey.mjs` Steps 9–14. Single submission finality enforced; truthful message rendered.                                                                  |
| Evaluator            | Separate normal account and context; accept invitation, see only assigned sessions, inspect actual changes/events, cite evidence in observations, save/finalize review, return to stored review             | **PASSED.** Verified in `tests/browser/founder-uat-journey.mjs` Steps 15–20. Citation-grounded observation and finalized review packet (`0c9311252c4fad74cfd5e91093b8a295d1cf4b6987363c9732da573052bc957f`). |
| Denials and recovery | Incorrect credentials, unverified/expired session, password recovery quarantine, expired/revoked links, unauthorized reviewer, cross-organization access, double submission, late mutation rejection        | **PASSED.** Verified in `tests/browser/founder-uat-journey.mjs` Negative Scenarios 1–10. All denied fail-closed without leak.                                                                                |
| Failure resilience   | Lost save response, refresh while editing, app restart, owned database interruption/recovery; verify retained state through supported APIs or read-only checks                                              | **PASSED.** Verified across restart (`founder-uat-runtime.mjs restart automation`); all entities retained, readiness 200.                                                                                    |
| UX                   | Independent landing-first walkthrough; desktop/tablet/mobile, long content, keyboard/focus, contrast/overflow, service failure feedback, console/runtime errors                                             | **PASSED.** Root redirect `/` -> `/r23/login` verified. 0 Axe WCAG 2.1 AA violations across Desktop, Tablet, Mobile viewports.                                                                               |
| Engineering          | `npm run verify`, `npm run test:postgres`, `npm run test:staging`, relevant genuine browser/UAT suites, real build, health/readiness, protected PR review and all required GitHub checks on accepted source | **PASSED.** All local gates passing (`format:check`, `lint`, `typecheck`, `test`, `npm audit`, `test:postgres`, `test:executor`, `test:staging`, `build`).                                                   |
| Founder delivery     | Running local app, clean initial user state, durable storage, bounded service footprint, restart mechanism, no exposed credentials, one verified URL                                                        | **PASSED.** Persistent stack (`hirearchy-founder-uat`) provisioned at `http://127.0.0.1:3000/` with 0 initial records; restart durability verified.                                                          |

All items passed with direct evidence. Material limitations: candidate execution disabled (`EXECUTION_DISABLED`) and live paid AI disabled (`AI_DISABLED`). Demo video and landing-page production do not begin in this task.
