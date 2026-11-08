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

The candidate and assigned-reviewer path is technically accepted in PR #6, merged as `6f144045a3dcfa523fd7d79112c09721011b4871` from source `74d523c91ecd4bc547cfa1fbe4c85b87cf2de749`. Its required CI checks, positive and negative browser journey, and late separate-instance restore passed. This does not establish deployment or authenticated visual acceptance. See [release readiness](../release-readiness.md) for the current evidence and remaining gates.

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
- **Merged PR #6:** adds the durable invitation, consent, candidate workspace, submitted evidence, and assigned human-review bridge. Required CI, positive and negative browser acceptance, and late restore passed. Authenticated visual review, the approved-template walkthrough, first-team onboarding, and deployment remain pending. See [release readiness](../release-readiness.md) for current checks and evidence.
- **Deployment:** no public or production deployment, external candidate workflow, or visual acceptance is established by those source changes.

Do not duplicate release checklists or reports here. Update [the single readiness record](../release-readiness.md) when a source SHA or acceptance result changes.
