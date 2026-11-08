# Hirearchy Software

Hirearchy Software helps a hiring team review realistic engineering work. A candidate completes a task in a controlled workspace; the system records observable activity and evidence; an assigned human evaluator decides what that evidence means. The product does not score, rank, or make hiring decisions.

## Current release state

PR #5 is merged to protected `main` as `1a919b40ab45f9788a8cf0f785d33449379b7098`. It provides the authenticated PostgreSQL staging foundation for recruiter assessment authoring, issuance, and reviewer assignment. It does not provide the complete candidate-to-human-review journey.

PR #6 is merged to protected `main` at `6f144045a3dcfa523fd7d79112c09721011b4871`, from accepted source `74d523c91ecd4bc547cfa1fbe4c85b87cf2de749`. All four required CI contexts, the positive and negative browser journey, and late separate-instance restore passed. This is technical acceptance, not a release or deployment approval: authenticated visual review, the approved-template walkthrough, first-team onboarding, and operational release gates remain open. See [release readiness](docs/release-readiness.md) for the sole current source of release status and evidence.

## Product and architecture

The release path is a Next.js modular monolith with PostgreSQL as its durable product store. GoTrue verifies user identity; an app-signed, one-use proof scopes trusted PostgreSQL operations. Organization membership uses recruiter and reviewer roles, with evidence access restricted by organization and reviewer assignment. The accepted PR #6 candidate path uses a distinct opaque invitation token and database-checked lifecycle rather than recruiter credentials. Its AI and code-execution capabilities remain disabled.

Legacy SQLite prototype code, data, and migration history remain preserved. SQLite is not a release fallback and there is no dual-write path. Candidate AI, code execution, and candidate invitation email are off in the internal demo. Basic first-team onboarding is proposed, not implemented; initial organization provisioning still requires an administrator.

## Development checks

Use Node.js 22 or later and npm 10 or later. Run the repository checks with:

```bash
npm run verify
```

Staging verification requires its provisioned PostgreSQL and GoTrue environment. Follow the [active release plan](docs/plans/active/mvp-release-program.md) and [readiness record](docs/release-readiness.md); do not treat a local SQLite run or the disposable R2.14 executor as durable staging acceptance.

## Project map

- [Product principles](docs/product/product-principles.md), [thesis](docs/product/product-thesis.md), and [non-goals](docs/product/non-goals.md)
- [System overview](docs/architecture/system-overview.md) and [architecture decisions](docs/decisions/README.md)
- [Active MVP release plan](docs/plans/active/mvp-release-program.md) and [single release-readiness record](docs/release-readiness.md)
- [Current-state handoff](docs/handoff/current-state.md)
- [Scenario rules](docs/scenarios/constitution.md)

The earlier SQLite prototype and engineering slices remain in the completed plans as historical implementation evidence.
