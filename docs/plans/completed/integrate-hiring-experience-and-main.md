# Integrate Hiring Experience with Reusable Problems (PR #25) and Generated Style Probe (PR #26)

## Goal

Reconcile `codex/hiring-experience` with `origin/main` (including PR #25 Reusable Problem Library and PR #26 Generated Assessment Style Probe) so `main` has one cohesive, verified, modular-monolith codebase with zero migration, ADR, route, PostgreSQL-privilege, or AI-pipeline conflicts.

## Delivered Changes

1. **Migration ordering (`0018` + `0019`):**
   - Preserved `database/postgres/migrations/0018_reusable_problems.sql` from `origin/main`.
   - Renumbered `0018_hiring_platform.sql` to `database/postgres/migrations/0019_hiring_platform.sql`.
   - Updated `TARGET_MIGRATION_VERSION`, deploy/rollback scripts, readiness probes, and `scripts/founder-uat-install.mjs` (including `hirearchy.reusable_problems` in known assessment row counts) to `0019`.
2. **PostgreSQL privilege boundary fix (`staging.hiring_r212_*`):**
   - Moved `hiring_r212_get_view`, `hiring_r212_admit`, `hiring_r212_complete`, and `hiring_r212_fail` out of migration `0019_hiring_platform.sql` (schema `hirearchy`) into `database/postgres/staging/install-api.sql` (schema `staging`, owned by `hirearchy_migrator`, granted exclusively to `app_candidate_gateway`) and updated `apps/web/src/r212-ai/server.ts`.
   - Restores the foundation invariant (`tests/postgres/foundation-check.mjs` and `tests/r26/postgres-candidate-check.mjs`) that only `r26_candidate_command` and `r26_candidate_lifecycle_ready` are executable by runtime roles in schema `hirearchy`.
3. **ADR ordering & architecture documentation (`0007`, `0008`, `0009`):**
   - Preserved `0007-reusable-problem-library.md` and `0008-generated-assessment-llm-style-probe.md`.
   - Renumbered hiring platform ADR to `0009-hiring-platform-accounts-plans-and-handoffs.md` and documented the coexistence of `reusable_problems` (R2.11 mutable authoring library) and `assessment_library_entries` (Hiring Platform validated, role-tagged library).
   - Updated `docs/decisions/README.md` and `docs/architecture/system-overview.md`.
4. **Generated assessment style probe across both AI generators:**
   - Wired `GENERATED_TERMS_AND_CONDITIONS_FOOTER` into `apps/web/src/hiring/ai-builder.ts` with non-truncating 5,000-character validation (matching ADR 0008).
   - Preserved footer stripping from both `brief` and recorded `aiInteractions` (prompt and assistant response excerpts) in `apps/web/src/r27-evidence/ai-review.ts` alongside Kimi K3.1 Pro, timing deltas (`Δ`), and hiring role context.
   - Added unit tests in `tests/unit/hiring-ai-builder-and-report.test.ts` and aligned `tests/unit/r27-ai-review.test.tsx`.
5. **Merge conflict resolution:**
   - Resolved conflicts in `apps/web/app/r23/organizations/[organizationId]/builder/page.tsx`, `apps/web/src/staging/browser.ts`, `apps/web/src/r27-evidence/ai-review.ts`, and `docs/decisions/README.md` so both standard authenticated staging (including `/problems`) and Hiring Platform (`isHiringPlatformEnabled()`) work without regressions.

## Verification

- `npm run verify` passed (`format:check`, `lint`, `typecheck`, 1,314 Vitest tests passed / 13 skipped, `test:executor`, and Next.js production `build`).
- `npm run test:postgres` passed (all R2.2 foundation migration `0001`–`0019`, RLS, and runtime privilege boundary checks).
- `npm run test:staging` passed (staging security, PR #25 problems journey, 11-stage Reservation Moves v3 durable journey, 12-stage self-service onboarding, and 4-stage release rollback rehearsal).
