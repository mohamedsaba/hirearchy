# R2.15 internal staging foundation

Status: investigation and implementation in progress. No deployment or external candidates are authorized.

## Acceptance

Select and document a persistent, authenticated internal product slice; fail closed for execution and AI before side effects; prove database recovery, release rollback, authorization, and disabled capabilities on final source. Retain private recovery state and preserve uncertain resources. Deliver through a protected PR without merging before founder acceptance.

## Current constraints

- The R2.3 authentication and later PostgreSQL product routes require disposable development configuration; their supporting fixture SQL explicitly is not a production migration. Their mere presence does not establish a supported persistent staging backend.
- The legacy SQLite evaluator uses a shared credential and the candidate lifecycle is coupled to Docker. This is not a tenant-aware external-user identity boundary.
- Dependency PRs change scenario requirements, while the CI base image installs packages from Alpine instead. Verify actual installed versions and scenario behavior before merging.

## Work sequence

1. Trace supported runtime, auth, persistence and all execution entry points. Define the internal-only capability boundary and its prerequisites.
2. Implement server-enforced restrictions and startup/readiness semantics with focused bypass tests.
3. Establish persistent identity and schema procedure for the chosen slice; rehearse backup, restore and artifact rollback with synthetic data.
4. Verify final source, review resource ownership and dependency changes, then open a PR for founder acceptance. Do not claim deployment from a local rehearsal.

## First implementation boundary

Introduce an explicitly named staging lockdown, with only liveness accessible and no legacy startup reconciliation, execution, AI, or development routes. This is an incomplete safety foundation, not a supported staging product or readiness claim. Product routes must remain blocked until their identity and durable storage contracts are established and verified. Existing profiles must retain their behavior.

## Evidence and remaining work (2026-10-30)

- Base: `580c286c9308645aba31a12f2a54d872552b69f3`. The `staging-lockdown` profile is a temporary deny-all product boundary, not a staging-ready configuration. It exposes only liveness; startup skips legacy SQLite initialization and Docker reconciliation. Execution, AI, and all product workflows remain unavailable.
- `npm run verify` passed on the implementation: 1,099 Vitest tests passed, 13 skipped; executor acceptance 29/29, dispatch 6/6, and service 7/7 passed; production build passed. Existing lint and build tracing warnings remain.
- A separately started production server with no Docker on `PATH` and a nonexistent database path returned liveness with execution disabled, rejected five direct legacy and PostgreSQL execution, AI, generation, and development-route POSTs (including a middleware-subrequest header), and did not create the database. This is not an authentication, restore, or staging product rehearsal.
- Candidate path to investigate: R23 builder/issuance, R26 database-backed editing/submission, and R27/R210 review. R23 authentication is explicitly restricted to development/test and loopback disposable configuration; its fixture SQL and later fixture functions explicitly forbid production migration. Before opening routes, establish reviewed durable schema and roles, explicit test identity provisioning and revocation, server-side execution/AI admission gates before side effects, and authenticated end-to-end isolation tests. The legacy shared evaluator key is not an external-user identity model.
- Backup, restore, failed-release rollback, supported authenticated read/write journey, hosting sizing, deployment, and final staging acceptance remain unperformed. Do not promote the lockdown to a supported staging release or claim beta readiness.
- Dependabot PRs #3 and #4 only update scenario 002's copied requirements. The image inherits Flask and pytest from Alpine packages instead of installing those requirements, so passing CI does not prove those updates change the installed runtime. Do not merge them until installed versions and scenario behavior are tested and fixture versioning is addressed. Four required checks passed on each PR; six Python alerts were open during inspection.
- Nine preexisting worktrees were inspected for branch divergence and dirty state. All have divergent commits, dirty or ignored state, or active/uncertain ownership; the executor-public-review checkout has processes with its working directory. No worktree was removed. Ignored files have not been individually classified.
- Docker inventory at inspection: 65 running containers, 868 exited, one created; 901 volumes, four networks and 20 image IDs. Three running PostgreSQL acceptance containers (`c6d78d0e740a4576`, `4e3d21074dcf495a`, `a73a90ab48c04c4a`) each mount a distinct `hirearchy-rex-pg-data-<id>` volume and have matching restricted-executor acceptance labels. Contents and ownership have not been fully established; all were preserved. Other resources remain unclassified; no cleanup was performed.
