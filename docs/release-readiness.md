# Release Readiness & Verification Status

- **Updated:** 2026-11-19
- **Milestone:** [Product Journey Redesign & AI Candidate Review](plans/completed/product-journey-and-ai-review.md)
- **Active Branch:** `codex/product-journey-redesign` (Founder Local UAT & Staging Acceptance)

## Current Verification Baseline

| Area                                            | Status                 | Notes                                                                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Repo Build & Test Gate (`npm run verify`)**   | Passing                | Includes `format:check`, `lint`, `typecheck`, Vitest unit/integration suite, restricted executor suite, and `next build apps/web`.                                                                                                |
| **Founder Local UAT (`http://127.0.0.1:3000`)** | Active                 | Local Docker Compose stack (`web`, `gotrue`, `postgres`, `mailpit`, dispatch verifier) with full signup -> email OTP (`Mailpit :8025`) -> org bootstrap -> assessment -> Candidate IDE -> Evaluator Workbench flow.               |
| **PostgreSQL Slices (`R2.3 – R2.14`)**          | Verified               | Covered by `scripts/test-r23-integration.mjs` through `scripts/test-r214-integration.mjs` + staging integration scripts.                                                                                                          |
| **Evaluator AI Candidate Review (`R27`)**       | Implemented & Verified | Supports NVIDIA NIM (`moonshotai/kimi-k2-instruct`, `nvidia/nemotron-3-super-120b-a12b`, custom slugs), OpenRouter, and offline deterministic preview fallback (`tests/unit/r27-ai-review.test.tsx` + live browser verification). |
| **Public Internet Hosting**                     | Gated                  | Loopback / single-host preview (`127.0.0.1:3000`); public DNS, TLS termination custody, and commercial launch remain separate operational gates.                                                                                  |

## Related Documents

- [System Overview](architecture/system-overview.md)
- [Frontend & Brand System](design/frontend-and-brand-system.md)
- [Staging Package Guide](../deploy/staging/README.md)
