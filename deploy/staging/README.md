# Single-Team Staging Deployment Guide

## 1. Overview & Architecture

This package provides reproducible single-team staging deployment assets for Hirearchy Software MVP.
The architecture enforces strict least-privilege security boundaries:

- **Primary Data Store**: Dedicated PostgreSQL instance (managed via migrations `0001` through `0017` by restricted `hirearchy_migrator`).
- **Identity & Authentication**: GoTrue v2 auth service + application-level signed Ed25519 identity proof v2 (`r23_gateway`).
- **Secret Custody**: Candidate token encryption via AES-256-GCM; asymmetric operation proofs via Ed25519.
- **Truthful Capability Restrictions**:
  - `liveCodeExecutionEnabled: false` (candidate untrusted code execution remains disabled until container sandboxing release gates are met).
  - `liveAiAssistanceEnabled: false` (live AI remains disabled until provider evaluation gates are met).
  - `emailDeliveryEnabled: false` (automated external SMTP remains disabled; invitations and recovery handoffs are explicitly surfaced as non-SMTP staging handoffs).
  - `managedSupabaseSupported: false` (strict self-hosted PostgreSQL compatibility; unverified Supabase extensions are not used).

## 2. Prerequisites

1. **Docker Engine**: Docker 24+ with compose capability.
2. **Container Images**:
   - `hirearchy-staging-postgres-local:latest`
   - `supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b`
3. **Node.js**: v20+ with npm dependencies installed.

## 3. Environment Configuration

Copy `env.staging.example` to `.env.staging` and configure secrets:

```bash
cp deploy/staging/env.staging.example .env.staging
```

Key environment variables:

- `STAGING_DATABASE_URL`: Gateway connection URL (`postgres://r23_gateway:<password>@127.0.0.1:5432/<dbname>`).
- `STAGING_MIGRATOR_DATABASE_URL`: Migrator URL (`postgres://hirearchy_migrator:<password>@127.0.0.1:5432/<dbname>`).
- `STAGING_AUTH_URL`: GoTrue service endpoint (`http://127.0.0.1:9998`).
- `STAGING_PROOF_PRIVATE_KEY`: Base64-encoded PKCS#8 DER Ed25519 private key.
- `HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY`: Base64-encoded 32-byte AES-256 key.
- `HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED`: Set to `'true'` to enable supervised self-service onboarding. Defaults to `'false'`.
- `HIREARCHY_RATE_LIMIT_ENABLED`: Set to `'true'` (default) to enforce rate limiting on auth and staging endpoints.

## 4. Preflight & Deployment Steps

Run the deployment runner to execute preflight verification, apply database migrations, and confirm operational readiness:

```bash
node scripts/deploy-single-team-staging.mjs
```

## 5. Operational Verification Endpoints

- **Operational Readiness Probe**:
  `GET /api/staging/readiness`
  Returns HTTP 200 with complete database readiness, migration level `0017`, durable installation markers (`r211`, `r214`, `0017`), and truthful capability flags.
- **Service Liveness**:
  `GET /api/health`
  Returns HTTP 200 `{ status: "ok" }`.

## 6. Rate Limiting & Abuse Controls

Rate limiting is enforced automatically on:

- `/api/auth/signup` (default: 20 req/min)
- `/api/auth/verify-email` (default: 20 req/min)
- `/api/auth/recover` (default: 20 req/min)
- `/api/auth/reset-password` (default: 20 req/min)
- `/api/staging/v1` (default: 100 req/min)
- `/api/candidate/sessions/*` (default: 60 req/min)

When a rate limit is exceeded, the server returns HTTP `429 Too Many Requests` with a `Retry-After: <seconds>` header.

## 7. Safe Restart & Compatible Release Rollback

- **Additive Migrations**: Schema migrations are strictly additive. Migration `0017` introduces new tables and nullable columns without dropping or modifying legacy columns.
- **Rollback Procedure**: In the event of an application rollback from release N to release N-1, the database schema remains fully compatible with release N-1 code without requiring destructive database rollbacks.
- **Rollback Verification**:
  Run the automated rollback rehearsal test:
  ```bash
  npm run test:rollback
  ```
