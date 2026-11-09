# Early-access retention and legal drafts

Status: Active. Updated: 2026-11-09.

## Objective

Make local early-access export and deletion safe for synthetic preview use, while leaving retention policy and public activation disabled pending founder/privacy review. Complete clearly labeled privacy and terms drafts, and keep demo/discovery materials accurate.

## Accepted product rules

- No public deletion or export route, automatic purge job, or default retention cutoff.
- An authorized host operator may dry-run or apply a deletion for one exact request ID or records received before an explicit UTC cutoff. Applying requires an explicit flag; no-match deletion is an idempotent no-op.
- Export is selected explicitly (all, one ID, or explicit UTC cutoff), defaults to a count-only dry run, and writes only to a new, protected file. Never emit request fields to logs or routine command output.
- Validate the complete stored array and every row before mutation. Corrupt, malformed, or duplicate-ID data fails closed and is left unchanged.
- Serialize web submissions and operator mutations with one adjacent exclusive lock. Wait only for a bounded interval; timeout fails closed. Never remove a stale lock automatically.
- Replace the active JSON file atomically. An applied deletion emits a protected operator receipt containing only opaque record IDs and operation metadata, outside the intake volume, so the same IDs can be deleted from a restored copy before traffic resumes.
- A deletion from the active store is not complete while an export or backup still contains the record. Keep the existing finite-expiry/restrict-copy backup model; no numeric retention period is selected or activated. Founder/privacy review must approve the period and deletion-request owner.
- Use synthetic data for all checks. Do not activate public intake or collect real prospect data.
- Preserve the existing Stage A interest form for later founder-approved activation; do not add a generic synthetic-only feature gate. The current source/preview remains unactivated, and all acceptance fixtures use reserved `.test` addresses.
- Keep public copy accurate for the activated preview path. State current non-activation and synthetic test evidence in dated review/operator materials; do not hardcode a closed intake state that would require an engineering change to activate Stage A.

## Scope

Update the early-access store, operator CLI, focused tests, privacy and terms draft pages, and buyer demo/discovery materials. Do not edit the release readiness ledger, the release program, deployment runbook, or backup implementation; operations owns those and will incorporate the accepted CLI after review.

## Verification

- Focused unit coverage for selection, export permissions, deletion receipts/replay, corrupt-store refusal, lock contention, and concurrent submissions.
- Re-run existing public-preview/early-access browser acceptance with synthetic data and inspect captured screens.
- Coordinate any Docker/PostgreSQL/staging or full demo suite with the operations owner to avoid overlapping heavy resource use.

## Current evidence — 2026-11-09

- `node_modules/.bin/vitest run tests/unit/early-access.test.ts tests/unit/early-access-admin.test.ts` passed: 2 files, 19 tests. The test source resolved from this isolated worktree; its third-party Vitest install is from the primary checkout and reports 5.0.0, while the lockfile pins 5.0.5. Combined CI remains authoritative.
- Prettier was run on the changed product files and `git diff --check` passed.
- `node scripts/run-buyer-journey-acceptance.mjs` is the browser command for the combined PR head. It was not run locally because the shared third-party install lacks the declared Playwright package; the operations owner will run it with the combined presentation checks in CI.
- No deployment, public activation, real intake, outreach, or prospect collection was performed.

## Completion

After combined browser and required release checks pass, record their exact results here and move this plan to `docs/plans/completed/`. The operations owner has the exact CLI invocation, receipt format, backup replay semantics, and browser command for integration.
