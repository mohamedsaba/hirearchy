# Problems Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let organization recruiters save, manage, and reuse engineering problems while each interview keeps an independent draft and immutable validated snapshot.

**Architecture:** Add an organization-scoped PostgreSQL problem library with recruiter-authorized operations exposed through the existing R211/R23 persistence boundary. Add equivalent verified staging operations, then connect the library table/detail pages and the assessment builder's save/reuse flows to the existing draft and validation lifecycle.

**Tech Stack:** Next.js App Router, React, TypeScript/ESM, PostgreSQL numbered migrations and R23/R211 adapters, the authenticated staging dispatch SQL API, Vitest, Playwright integration checks.

**Spec:** [Problems Management Design](../../superpowers/specs/2026-11-20-problems-management-design.md)

## Implementation complete — 2026-11-20

Tasks 1–4 are implemented. [ADR 0007](../../decisions/0007-reusable-problem-library.md) records the accepted library and independent draft lifecycle. The checkboxes record completed implementation and executed behavior checks. Pending checks remain open where fixture setup stopped the official integration runs.

- Task 1 (be8bbc3, 7496e6d) added the library and authenticated API, advanced readiness to migration 0018, and preserved the approved template bytes on Windows.
- Task 2 (6feaf6d, 6c89d92) added signed Founder UAT/staging operations and preserved renewed sessions on problem API errors.
- Task 3 (2804522, f0fc371) added the Problems pages and builder save/reuse actions, loaded the copied draft by ID, and delivered refreshed staging credentials during problem page loads.
- Task 4 recorded the decision, updated the documentation indexes and migrations overview, and ran the repository and targeted verification commands.

The final review fix wave gives “Create a problem” a fresh definition for its first save or validation. The staging builder reads the selected definition and reviewers in one authorized context and renews an expiring session through the browser. The problem editor displays the saved canonical fields when returning to an approved template.

### Verification

- `node_modules/.bin/vitest.cmd run tests/unit/problems-management.test.tsx tests/unit/assessment-builder.test.tsx tests/unit/assessment-builder-reviewers.test.tsx tests/unit/staging-api.test.ts tests/unit/r211-template.test.ts tests/unit/staging-readiness-probe.test.mjs tests/unit/observability.test.ts` (exit 0). 61 tests passed across seven files.
- `node .superpowers/sdd/problems-management/verification/task-3-auth-smoke.mjs` (exit 0). The local PGlite harness ran the migration and exercised the authenticated adapter, including recruiter and tenant checks, stale writes, and preservation of copied draft and validated version content.
- `node .superpowers/sdd/problems-management/verification/task-3-staging-smoke.mjs` (exit 0). The local PGlite harness applied the staging privileges and RLS and tested role and tenant checks, stale writes, and copy independence. A local Python bridge, `task-2-dispatch-bridge.py`, extracted the PL/Python body from the staging installer and called its internal `dispatch(...)` entry point directly with test identity and session arguments. The bridge ran the handler queries against PGlite. The official journey exercises the signed SQL function `staging.dispatch(bytea, bytea)` with in-server PL/Python, GoTrue, and Chromium.
- `npm run lint` (exit 0). 0 errors and 31 warnings.
- `npm run typecheck` (exit 0). Route types generated and TypeScript completed.
- `npm run build` (exit 1 in the sandbox, exit 0 on the host). Turbopack initially failed to create its Windows `pg` junction with “Access is denied. (os error 5)”. The host retry generated 22 of 22 static pages and emitted four tracing warnings.
- `npm run verify` (exit 1). Stopped at `npm run format:check` with “Code style issues found in 676 files.” The worktree contains CRLF conversions and ignored local tooling that Prettier scans. The changed-file Prettier checks passed separately.
- `npm test` (exit 1). 1,165 passed, 64 failed, and 42 skipped across 161 files on the standalone rerun. The native Better SQLite3 module opens a database, while candidate-token backups fail with “The staged backup permissions are not private” at the POSIX mode 0600 check. Other failures include POSIX artifact mode checks, `EPERM: operation not permitted, fsync` on directory sync, and Docker-dependent cases.
- `docker version --format '{{.Server.Version}}'` (exit 1). `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.`
- `node scripts/test-r211-integration.mjs` (exit 1). “R2.11 failed during startup (fixture/protocol)” at Docker image inspection, line 74. The PostgreSQL, GoTrue, and HTTPS/Chromium behavior checks did not run.
- `node scripts/test-staging-integration.mjs` (exit 1). “Staging integration failed at setup (Error; source=scripts/test-staging-integration.mjs:71:3)” at the Docker server check. The signed entry point and staging journey checks did not run.
- `node scripts/test-release-rollback.mjs` (exit 1). The rollback rehearsal stopped when the unavailable Docker engine prevented creation of the fixture network.
- `npm run test:executor` (exit 1). The first stage reported “Disposable PostgreSQL fixture setup failed during container startup.” The dispatch and service stages did not run.

The two PGlite harnesses and their Python bridge were worktree-local verification tools. The R211, staging, rollback, and executor commands above use Docker fixtures.

## Global Constraints

- “Only active recruiters in the selected organization can list, view, create, edit, delete, or reuse library records.”
- “Data must not be available to another organization.”
- “The library record and resulting draft have independent lifecycles after the copy.”
- “The candidate session is still issued only from a validated version, as it is today.”
- “Keep the Next.js/PostgreSQL modular monolith and support both the authenticated application runtime and the Founder UAT/staging operation path.”
- “Persist the complete authoring unit: template identifier, title, brief, expected behavior, acceptance criteria, primary file path, starter files, duration, terminal and integrated AI settings, and rubric.”
- Add no new dependency; preserve recruiter/reviewer separation and immutable validated versions.

## Review Focus

1. A recruiter submits a problem ID from another organization; all read/write/reuse operations must deny it. Pin in Task 1's Postgres authorization checks and Task 2's staging security journey.
2. A reviewer or inactive member reaches the problem routes directly; every operation must deny them. Pin in Task 1's API/adapter checks and Task 2's staging authorization checks.
3. Two recruiters edit the same library version; the stale write must return a conflict and retain the newer content. Pin in Task 1's Postgres concurrency check and Task 3's UI conflict state.
4. A saved problem has invalid or unsupported authoring content; the API must reject it without creating a library row or assessment draft. Pin in Task 1's route and validation checks.
5. A library problem is edited or deleted after reuse or interview issuance; the copied draft and immutable validated version must remain unchanged. Pin in Task 1's copy/snapshot integration check and Task 3's browser journey.

---

## File Map

- `database/postgres/migrations/0018_reusable_problems.sql` creates the durable organization-scoped library table and its constraints, privileges, and RLS boundary.
- `database/postgres/r211/fixture.sql`, `adapter.mjs`, `adapter.d.mts`, and `contract.d.mts` provide disposable authoring-fixture operations and typed storage methods, matching existing R211 patterns.
- `database/postgres/r23/adapter.mjs` and `adapter.d.mts` expose the library operations through authenticated organization authorization.
- `apps/web/src/r211-builder/contract.ts` defines reusable problem content and library record contracts.
- `apps/web/src/r23-auth/server.ts` provides authenticated and staging-backed problem APIs with recruiter checks, CSRF/origin enforcement, validation, and reuse-to-new-draft behavior.
- `apps/web/app/r23/api/organizations/[organizationId]/problems/route.ts`, `[problemId]/route.ts`, and `[problemId]/reuse/route.ts` expose list/create, read/update/delete, and create-independent-draft endpoints.
- `apps/web/src/staging/server.ts`, `browser.ts`, and `database/postgres/staging/install-api.sql` implement equivalent authenticated staging operations and browser page entry points.
- `apps/web/app/r23/organizations/[organizationId]/problems/page.tsx`, `problems-client.tsx`, and `[problemId]/page.tsx` implement the focused table and management detail experience.
- `apps/web/app/r23/organizations/[organizationId]/builder/page.tsx` and `builder/assessment-builder-client.tsx` add Save for reuse, library selection/reuse navigation, and loading of the newly copied draft.
- `tests/r211/postgres-builder-check.mjs`, `tests/r211/browser-builder-check.mjs`, `tests/staging/journey.mjs`, and `tests/staging/security.mjs` pin persistence, authorization, reuse independence, and browser behavior.
- `docs/decisions/0007-reusable-problem-library.md`, `docs/decisions/README.md`, and `docs/plans/{active,completed}/problems-management.md` record the rule and plan lifecycle.

## Task 1: Durable Problem Library and Authenticated API

**Files:**

- Create: `database/postgres/migrations/0018_reusable_problems.sql`
- Modify: `database/postgres/r211/fixture.sql`
- Modify: `database/postgres/r211/adapter.mjs`
- Modify: `database/postgres/r211/adapter.d.mts`
- Modify: `database/postgres/r211/contract.d.mts`
- Modify: `database/postgres/r23/adapter.mjs`
- Modify: `database/postgres/r23/adapter.d.mts`
- Modify: `apps/web/src/observability/readiness.mjs` and `readiness.d.mts`
- Modify: `apps/web/src/r211-builder/contract.ts`
- Modify: `apps/web/src/r23-auth/server.ts`
- Create: `apps/web/app/r23/api/organizations/[organizationId]/problems/route.ts`
- Create: `apps/web/app/r23/api/organizations/[organizationId]/problems/[problemId]/route.ts`
- Create: `apps/web/app/r23/api/organizations/[organizationId]/problems/[problemId]/reuse/route.ts`
- Test: `tests/r211/postgres-builder-check.mjs`
- Test: `tests/r211/browser-builder-check.mjs`
- Test: `tests/unit/staging-readiness-probe.test.mjs`
- Test: `scripts/test-release-rollback.mjs`

**Interfaces:**

- Produces `R211ReusableProblemContent`, equivalent to a complete `R211AssessmentDraftInput` without `definitionId` or draft `expectedVersion`.
- Produces `R211ReusableProblem`: `{ id, organizationId, authorPrincipalId, version, content, createdAt, updatedAt }`.
- Adds R23 authorization methods `createReusableProblem(identity, organizationId, content)`, `listReusableProblems(identity, organizationId)`, `getReusableProblem(identity, organizationId, problemId)`, `updateReusableProblem(identity, organizationId, problemId, expectedVersion, content)`, and `deleteReusableProblem(identity, organizationId, problemId, expectedVersion)`.
- Adds API methods: `GET|POST /problems`, `GET|PATCH|DELETE /problems/{problemId}`, and `POST /problems/{problemId}/reuse`; reuse returns the newly persisted `R211AssessmentDraft` created by saving the library content without a definition ID.

- [x] **Step 1: Add PostgreSQL behavior assertions**

Extend `runR211PostgresBuilderChecks` to prove recruiter create/list/read/update/delete, stale update conflict, reviewer denial, cross-organization denial, and that deleting/updating a library record leaves a previously copied draft and validated version unchanged. Add a readiness regression check proving the current schema migration (`0018`) is accepted, not marked stale.

- [x] **Step 2: Check the pre-change storage boundary with PGlite**

The local `node .superpowers/sdd/problems-management/verification/problem-smoke.mjs --baseline` run exited 1 with SQLSTATE `42883` for the missing library operation. The official pre-implementation R211 attempt exited 1 at Docker image inspection before the behavior assertions.

- [x] **Step 3: Add migration and R211 storage methods**

Create an organization-scoped `hirearchy.reusable_problems` record with complete validated content, author, timestamps, and monotonically increasing version. Add RLS/privileges and narrowly scoped functions. Implement adapter methods with UUID validation and an explicit concurrency-conflict error; mirror fixture grants and policies in `database/postgres/r211/fixture.sql`.

Update the operational readiness target and rollback/readiness fixtures to the latest numbered migration. Preserve the approved Reservation Moves template bytes across checkout platforms with a narrowly scoped `.gitattributes` rule; do not weaken its digest validation.

- [x] **Step 4: Add R23 adapter contract and API handlers**

Expose the storage methods through `R23Authorization`, checking active organization membership and recruiter role before writes. Validate content with `validateAssessmentDraft`, require same-origin and CSRF for mutations, use private no-store responses, return 409 for stale updates, and return 404 for identifiers outside the selected organization. Implement reuse by loading a library record and calling the existing `saveAssessmentDraft` without `definitionId` so it always creates a new assessment definition.

- [x] **Step 5: Add authenticated browser and API assertions and run the local persistence check**

The browser harness contains create/list/detail/update/delete/reuse, malformed content, reviewer denial, CSRF denial, and cross-organization 404 assertions. The local PGlite adapter check passed for storage and authorization.

- [ ] **Pending: Verify Docker-backed R211 persistence and authenticated browser/API behavior**

`node scripts/test-r211-integration.mjs` exited 1 at Docker image inspection before the assertions.

## Task 2: Equivalent Founder UAT/Staging Operations

**Files:**

- Modify: `apps/web/src/staging/server.ts`
- Modify: `apps/web/src/staging/browser.ts`
- Modify: `apps/web/src/r23-auth/server.ts` (delegate problem API requests to staging in this task)
- Modify: `apps/web/proxy.ts` (allow only the new organization problem pages and API methods through authenticated staging)
- Modify: `database/postgres/staging/install-api.sql`
- Modify: `tests/staging/journey.mjs`
- Modify: `tests/staging/security.mjs`
- Modify: `tests/unit/staging-api.test.ts`

**Interfaces:**

- Consumes the Task 1 R23 endpoints and the `R211ReusableProblem` response shape.
- Produces signed staging operations `problem.create`, `problem.list`, `problem.get`, `problem.update`, `problem.delete`, and `problem.reuse`, each restricted to the selected organization and active recruiter; `problem.reuse` returns a new assessment ID and full independent draft content.

- [x] **Step 1: Add staging security and journey assertions**

Extend staging security checks to deny reviewer and cross-organization operations. Extend `createJourney` checks to save a problem, list/get/update it, reuse into a different assessment ID, modify/delete the source, and assert the copied assessment content remains unchanged. Add proxy tests proving only the new authenticated problem pages and API methods pass the staging route boundary.

- [x] **Step 2: Reproduce the missing proxy route in the focused tests**

`npm test -- tests/unit/staging-api.test.ts -t 'opens only the problem library routes and methods'` exited 1 before the proxy implementation. The assertion failed on the organization Problems page GET. The Docker-backed pre-implementation staging command exited 1 during fixture setup before the journey assertions.

- [x] **Step 3: Implement signed operation validation and SQL handlers**

Add each operation to the staging server allowlist and to `install-api.sql`'s exact argument schema, role checks, organization-scoped queries, optimistic update version, and dispatch cases. Grant `staging_verifier_owner` only the required columns and apply organization RLS policies to the library table. Add explicit proxy allowances for the organization Problems pages and only the API methods needed for list/read/create/update/delete/reuse, following the existing recruiter staging authorization rules.

- [x] **Step 4: Implement staging browser/API delegates and organization navigation**

Delegate list/create/read/update/delete/reuse API methods through `dispatchVerifiedStagingOperation`, preserving shared response and error behavior. Add a Problems link to the recruiter organization workspace beside the assessment builder entry point.

- [x] **Step 5: Verify focused staging behavior**

The staging boundary tests and the PGlite check using the local Python bridge passed.

- [ ] **Pending: Verify Docker-backed staging security and copy isolation**

`node scripts/test-staging-integration.mjs` exited 1 in setup before the signed SQL entry point and journey assertions.

## Task 3: Problems Table, Detail Editor, and Builder Integration

**Files:**

- Create: `apps/web/app/r23/organizations/[organizationId]/problems/page.tsx`
- Create: `apps/web/app/r23/organizations/[organizationId]/problems/problems-client.tsx`
- Create: `apps/web/app/r23/organizations/[organizationId]/problems/[problemId]/page.tsx`
- Modify: `apps/web/app/r23/organizations/[organizationId]/builder/page.tsx`
- Modify: `apps/web/app/r23/organizations/[organizationId]/builder/assessment-builder-client.tsx`
- Modify: `apps/web/src/r23-auth/server.ts` (load a requested draft definition ID)
- Modify: `apps/web/src/staging/browser.ts` (load a requested staging assessment ID)
- Test: `tests/r211/browser-builder-check.mjs`
- Test: `tests/unit/problems-management.test.tsx`

**Interfaces:**

- Consumes the Task 1 API shapes and Task 2 staging parity.
- Produces `/r23/organizations/{organizationId}/problems` and `/problems/{problemId}` for table/detail editing, a builder **Save for reuse** action, and a **Start from saved problem** flow that navigates to the builder with the independent new draft loaded by its returned definition ID in both runtimes.

- [x] **Step 1: Add failing browser/component checks**

Pin recruiter-only table and detail rendering, row navigation, edit with stale-version conflict feedback, delete confirmation/removal, save-for-reuse feedback, and reuse opening a draft with copied content and a new definition ID.

- [x] **Step 2: Run focused UI checks and confirm they fail**

Run: `npx vitest run tests/unit/problems-management.test.tsx`
Expected: FAIL because the management UI and builder actions do not exist.

- [x] **Step 3: Implement authenticated table and detail routes**

Load data through the authenticated APIs, link each table row to its management detail route, display the full saved authoring content, allow edits, expose delete, and keep the page focused on problem management. Provide navigation back to the organization workspace and into assessment authoring.

- [x] **Step 4: Add builder save and reuse actions**

Add **Save for reuse** to the assessment authoring stage using the current in-memory draft content. Add a saved-problem picker/start action; call the reuse endpoint, then open the builder with the returned definition ID. Update standard and staging draft GET paths to honor an optional `definitionId` instead of returning whichever draft happens to be latest; the builder must display the copied draft even if another draft is created before it loads. Ensure the new draft ID replaces no currently edited definition and existing validate/issue controls remain unchanged.

- [x] **Step 5: Verify focused UI behavior**

`npx vitest run tests/unit/problems-management.test.tsx tests/unit/assessment-builder.test.tsx tests/unit/assessment-builder-reviewers.test.tsx` exited 0 with 25 tests passed. The later focused run above also covered the staging session renewal and deferred UI reads.

- [ ] **Pending: Verify the copy and editor flow in the authenticated browser journey**

`node scripts/test-r211-integration.mjs` exited 1 at Docker image inspection before the Chromium assertions.

## Task 4: Decision Record, Documentation, and Full Verification

**Files:**

- Create: `docs/decisions/0007-reusable-problem-library.md`
- Modify: `docs/decisions/README.md`
- Modify: `docs/README.md`
- Modify: `docs/architecture/system-overview.md`
- Modify: `docs/plans/active/problems-management.md`
- Create: `docs/plans/completed/problems-management.md`

**Interfaces:**

- Consumes completed persistence, API, staging, and UI behavior from Tasks 1–3.
- Produces an append-only ADR describing mutable organization-owned library entries, independent copies into drafts, and immutable validated versions; keeps the active plan synchronized and preserves it in completed plans after implementation.

- [x] **Step 1: Add ADR and update documentation indexes**

Document status, context, decision, rationale, and consequences; link the ADR from the decisions index and describe the recruiter Problems page and reuse flow in the master documentation index.

- [x] **Step 2: Attempt repository verification and record the results**

`npm run verify` exited 1 at the format check. The verification table records the standalone gates and Docker fixture blockers.

- [ ] **Pending: Pass the full repository gate**

`npm run verify` still needs a run that reaches and passes every gate. The Docker-backed executor checks are pending.

- [x] **Step 3: Review diff and archive plan**

Check `git diff --check`, review the full diff for tenant or role bypasses and unrelated complexity, move the completed plan from `docs/plans/active/` to `docs/plans/completed/`, then confirm `git status --short --branch` contains only intended feature changes.

## Self-review

- **Spec coverage:** Save for reuse and full content persistence: Task 1 and Task 3. Organization CRUD table and detail editor: Tasks 1 and 3. Independent reuse: Tasks 1 and 3. Recruiter/tenant security and staging parity: Tasks 1 and 2. Immutable validated versions and docs/ADR: Tasks 1 and 4.
- **Step scan:** Tasks 1–3 record completed implementation and focused verification. The official Docker-backed behavior checks remain open.
- **Type consistency:** `R211ReusableProblemContent` feeds create/update/reuse. `R211ReusableProblem` wraps `content` and a library `version`; reuse returns a normal `R211AssessmentDraft` with a new definition ID. Staging operations use the same public record and draft shapes.
- **Review Focus:** Tenant/role access, concurrency, invalid content, and post-copy mutation/deletion are each attached to the owning persistence, staging, API, or browser task.
- **Proportion:** Four tasks cover one integrated feature across the existing database, auth, staging, and UI boundaries; no dependency or general content-management layer is introduced.
