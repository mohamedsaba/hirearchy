# System overview

Hirearchy Software is a Next.js modular monolith. PostgreSQL is the durable store for the release product path. GoTrue supplies user identity, and the application verifies the live Auth session before signing a short-lived, one-use proof for scoped PostgreSQL operations.

```text
Recruiter and evaluator browser sessions
  └─ GoTrue identity → app-signed one-use proof → PostgreSQL tenant dispatcher
       ├─ recruiter authoring, issuance, and assignment
       └─ assigned evaluator evidence and human review

Candidate browser session
  └─ opaque invitation bearer → constrained candidate gateway
       └─ PostgreSQL checks lifecycle, consent, session, and operation

Restricted execution service
  └─ separate runtime boundary; off in the durable internal demo
```

The candidate path is implemented in draft PR #6 but is not yet accepted on `main`; the diagram describes the intended release boundary, not evidence of a passing end-to-end deployment. PR #5, merged as `1a919b40ab45f9788a8cf0f785d33449379b7098`, is the accepted authenticated staging foundation. See [release readiness](../release-readiness.md) for current CI, browser, recovery, and deployment evidence.

## Tenant and identity boundary

Organizations scope recruiter and reviewer memberships. Recruiters author, validate, and issue assessments and assign a reviewer. Reviewers can inspect evidence only for sessions assigned to them. The signed proof binds database operations to a live GoTrue user and session; browser-supplied subject or organization values are not trusted as identity. The existing roles are `recruiter` and `reviewer`; there is no generalized administrator-role expansion.

Initial organization provisioning is currently administrator-managed. [The proposed first-team onboarding decision](../decisions/mvp-first-team-onboarding.md) limits future self-service to a confirmed GoTrue identity with no active organization memberships. It is a proposal pending review and implementation.

## Candidate and evidence flow

The intended internal demo connects an explicitly issued invitation to a single PostgreSQL candidate session. Candidate access uses an opaque bearer token checked by a distinct constrained gateway, not the recruiter/evaluator proof. PostgreSQL owns invitation expiry and revocation, notice consent, activation, workspace persistence, submission finality, and operation replay. Revoking an invitation closes candidate access while retaining saved workspace and evidence.

The candidate lifecycle remains `CREATED → ACTIVE → SUBMITTED`. A candidate sees the canonical data-use notice and must affirm consent before activation. Saved code, revisions, task activity, and submission are evidence; they are not automatic judgments. The durable internal demo keeps AI and execution capabilities disabled and sends no candidate invitation email.

Submitted evidence is read chronologically by the assigned evaluator, who can write and finalize a retained human review. Acceptance criteria, test outcomes, task outcomes, factual evidence, evaluator decision, and candidate competence remain distinct. The system must not create candidate scores, rankings, automatic competence labels, or pass/reject verdicts.

## Data and runtime boundaries

PostgreSQL is the product authority for the release journey. Preserve legacy SQLite prototype code, data, and migration history; do not add a SQLite fallback or dual-write path. A migration or retirement of legacy data requires a tested, recoverable plan.

The restricted R2.14 executor remains separate from the durable recruiter and candidate database paths. Its disposable integration is not a production security certification. External candidate execution requires its own security and operational acceptance; it is not enabled in the internal demo. Live AI providers and external email delivery also remain off pending separate decisions and evidence.

## Current integration boundary

- **Merged PR #5:** GoTrue-authenticated sign-in, organization selection, PostgreSQL recruiter authoring, validation, issuance, and reviewer assignment through the proof boundary. It does not issue candidate links or enable candidate activity, evaluator review writes, AI, or execution in authenticated staging.
- **Draft PR #6:** source for the durable invitation, consent, candidate workspace, submitted evidence, and human-review bridge. It remains unmerged; updated CI and browser acceptance are pending. See [release readiness](../release-readiness.md) for current checks and evidence.
- **Deployment:** no public or production deployment, external candidate workflow, or visual acceptance is established by those source changes.

Do not duplicate release checklists or reports here. Update [the single readiness record](../release-readiness.md) when a source SHA or acceptance result changes.
