# Current project state

As of 2026-11-08. This handoff summarizes the implementation boundary; [release readiness](../release-readiness.md) remains the sole source for release gates and accepted evidence.

## Merged baseline

PR #5 is merged to protected `main` at `1a919b40ab45f9788a8cf0f785d33449379b7098`. It provides GoTrue sign-in, organization selection, PostgreSQL-backed recruiter assessment authoring, validation, issuance, and reviewer assignment through the app-signed proof boundary.

PR #5 is an authenticated staging foundation only. Its accepted browser journey does not create a candidate invitation, record candidate work, or write evaluator review packets. It does not establish a public deployment, external email, production execution, or visual acceptance. The earlier frozen SQLite prototype baseline (`4a7c9cdbc342130eeb7c29f3374a96fdbbaf4739`) remains historical work, not the current release baseline; see the [completed engineering plans](../plans/completed/).

## Accepted durable workflow

PR #6 is merged to protected `main` at `6f144045a3dcfa523fd7d79112c09721011b4871`, from source `74d523c91ecd4bc547cfa1fbe4c85b87cf2de749`. The accepted technical workflow includes expiring/revocable candidate invitations, consent-bound PostgreSQL workspace, saved evidence, submitted finality, assigned-reviewer evidence, and retained human review.

All four required CI contexts, positive and negative browser acceptance, and late separate-instance restore passed. Authenticated visual review, the approved-template walkthrough, first-team onboarding, and deployment remain pending. See [release readiness](../release-readiness.md) for exact evidence and gates.

## Current operating limits

- Recruiter and reviewer identities use GoTrue plus the verified app-signed proof boundary. PostgreSQL is authoritative for durable product operations; tenant membership and assignment constrain access.
- Initial organization provisioning is still an administrator operation. The first-team account/organization and reviewer-invitation flow is only a proposal in [the onboarding ADR](../decisions/mvp-first-team-onboarding.md).
- Team invitations in the proposed internal demo are copied by the owner and do not send email. Signup confirmation and password recovery require GoTrue SMTP; that is not a substitute for invitation delivery.
- Candidate AI and code execution stay disabled in the durable internal demo. The disposable R2.14 executor path is separate and does not prove a production execution boundary.
- Legacy SQLite data and migration history are preserved, but SQLite is not a release fallback and there is no dual-write path.
- A separate in-progress follow-up requires verified non-recovery AMR and proof v2 before proof-bound product operations; its CI remains pending.

## Working references

- [Active MVP release program](../plans/active/mvp-release-program.md) — product scope and accepted implementation contract.
- [Release readiness](../release-readiness.md) — exact source SHA, CI/browser/recovery evidence, gates, and unresolved deployment status.
- [System overview](../architecture/system-overview.md) — runtime, identity, tenant, and storage boundaries.

Keep this handoff short. Record status changes and evidence in the readiness file instead of creating another release report.
