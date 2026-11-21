# Hirearchy / Hirearchy Software agent guide

Hirearchy Software is an end-to-end engineering hiring and evaluation platform built as a **Next.js 16 + PostgreSQL modular monolith** (`apps/web`, `database/postgres`, `packages/restricted-executor`). Candidates complete realistic engineering tasks in an authentic IDE workspace; the system captures observable events and reconstructs them as evidence; advisory AI helps synthesize signals; and human evaluators own final hiring decisions.

## Orientation (read on demand)

Read only the docs relevant to your task instead of scanning the entire `docs/` tree upfront:

- `docs/README.md` — master index of routes, architecture, design tokens, and fixtures.
- `docs/architecture/system-overview.md` — backend, PostgreSQL migrations (`0001`–`0019`+), auth/CSRF, staging, and AI providers.
- `docs/design/frontend-and-brand-system.md` — brand tokens, typography, and UI conventions.
- `docs/decisions/` — key product and architectural ADRs (`0006` AI review, `0007` reusable problems, `0008` generated style probe, `0009` hiring platform).
- `docs/scenarios/constitution.md` — scenario design rules when authoring or modifying tasks.

## Non-negotiable product & engineering rules

- **Evidence precedes judgment.** Keep immutable evidence (`r27`), test outcomes, advisory AI outputs (`ADR 0006`, `ADR 0008`), and human decisions (`r210`, `hiring_decisions`) clearly distinct. Human evaluators always own finalized review packets and hiring outcomes.
- **AI use by candidates is neutral.** Record observable AI interactions; never infer hidden mental state or claim proof of authorship from style heuristics.
- **Keep the modular monolith.** Extend the existing Next.js + PostgreSQL + restricted-executor architecture. Do not introduce microservices or speculative infrastructure.
- **Preserve PostgreSQL security boundaries.** Base migrations (`database/postgres/migrations/`) define tables, constraints, and RLS only; runtime staging/hiring RPCs belong in `database/postgres/staging/install-api.sql` (`staging` schema) so `hirearchy` exposes only `r26_candidate_command` and `r26_candidate_lifecycle_ready` to `app_candidate_gateway`.
- **Fix root causes, not symptoms.** No exception swallowing, authorization bypasses, weakened tests, or brittle shortcuts.

## Pragmatic development workflow

- **Deliver complete, polished work.** Build the full requested feature with cohesive, responsive UI/UX rather than stripped-down placeholders. Make sensible product and UI decisions on minor details and note assumptions concisely; pause to ask only when a decision involves a breaking schema/product-rule change or genuine ambiguity.
- **Use good tools when warranted.** Reuse existing components and styles first; adding a focused, well-maintained dependency is fine when it meaningfully improves UI quality, accessibility, or reliability over hand-rolled code.
- **Keep docs lightweight.** Update relevant docs when architecture, routes, or behavior change. Writing a plan under `docs/plans/` or a new ADR under `docs/decisions/` is only needed for major architectural changes or when explicitly requested.
- **Right-sized verification.** While iterating, run targeted tests, `npm run typecheck`, and `npm run lint` for fast feedback. Before opening a PR or finishing a milestone, run `npm run verify` (plus `npm run test:postgres` / `npm run test:staging` when changing migrations, SQL, or staging/auth flows).

## Repository safety

- Inspect `git status` first and preserve unrelated dirty work.
- Work on a clean feature branch (or directly in the current checkout when clean and requested); use a git worktree only when isolation from parallel work or dirty files is actually needed.
- Never run destructive Git operations (`git reset --hard`, `git clean -fd`, `git restore` over dirty files, unapproved `git stash`, or force-push to `main`) without explicit user approval.
