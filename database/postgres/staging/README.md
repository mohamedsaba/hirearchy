# Internal staging PostgreSQL dispatcher

This provides a private authoring and review lane for one team. It is a prototype, not a production or hostile-code security boundary, and does not certify managed Supabase compatibility.

## Install

1. Build the staging image from the repository root with `docker build -f database/postgres/staging/Dockerfile -t hirearchy-staging-postgres-local .`. The base PostgreSQL image is pinned by digest; the top-level Python and cryptography packages are pinned. Alpine transitive packages still resolve at build time. Record and reuse the resulting image digest for restore.
2. As a database administrator, run `database/postgres/bootstrap-roles.sql`, `database/postgres/bootstrap-internal-roles.sql`, then `database/postgres/staging/bootstrap-verifier.sql`.
3. Apply the numbered migrations with the restricted `hirearchy_migrator` role. The ordered migrations add durable state and the fields connecting an issuance to its assessment version. Owner policies and access grants are installed atomically by the separate administrator installer, so ordinary migration consumers do not require a verifier role or PL/Python.
4. Start GoTrue against the same database and verify its `auth.sessions` table exposes `id`, `user_id`, and `not_after`.
5. As an administrator, run `database/postgres/staging/install-api.sql`. It refuses installation when disposable R23 through R213 fixture schemas exist; it does not remove them.
6. Register an Ed25519 verification key in `hirearchy.staging_verification_keys` as an administrator. Store only the raw 32-byte public key in PostgreSQL; keep its private key in the application secret store.

To rotate a key, insert a new row with its own `key_id`, validity interval, issuer, audience, and public key. Switch the application to that key, confirm traffic, then set `revoked_at` on the old row. Keep the signing key and database state aligned in backups and rollback plans.

## Provision identities

Use `node scripts/provision-staging.mjs <input.json>` with `STAGING_ADMIN_DATABASE_URL`, `STAGING_AUTH_URL`, and `STAGING_AUTH_ADMIN_TOKEN`. The input contains an `organizationId` and `users` entries with `email`, `role` (`recruiter` or `reviewer`), and a password for new Auth users. Existing principals and memberships are not rebound or reactivated automatically. Keep this administrator flow private; it creates accounts through GoTrue's admin API and provisions organization membership in PostgreSQL.

## Application configuration

Run the app with `HIREARCHY_RUNTIME_PROFILE=staging-authenticated` and configure:

- `STAGING_AUTH_URL`, `STAGING_AUTH_ISSUER`, and `STAGING_AUTH_AUDIENCE` for the same GoTrue service.
- `STAGING_DATABASE_URL` with the `r23_gateway` login.
- `STAGING_PROOF_PRIVATE_KEY` as base64 encoded Ed25519 PKCS8 DER, plus `STAGING_PROOF_ISSUER`, `STAGING_PROOF_AUDIENCE`, and `STAGING_PROOF_KEY_ID` matching the public key row.

The current profile accepts only loopback Auth and PostgreSQL URLs. A proof is signed over canonical JSON, expires within 60 seconds, and is consumed once by the database. The `auth_exp` claim records the verified access-token expiry; PostgreSQL clamps the effective application-session expiry to GoTrue `not_after` when set and rejects expired Auth sessions on every operation. A staging session is bound to the Auth session ID, subject, organization, and application principal; valid requests refresh its expiry. `session.revoke` persists revocation for the specified organization context.

`r23_gateway` can execute only `staging.dispatch(bytea, bytea)`. It has no direct product table access and cannot assume the `NOLOGIN` verifier owner. The `SECURITY DEFINER` dispatcher verifies Ed25519 proofs, checks the active GoTrue session and current membership, consumes nonces atomically, and uses fixed search paths and verifier-owner RLS policies. Only the dispatcher sets the owner-scoped RLS context after proof verification. `session.revoke` persists revocation for the specified organization context; other organization contexts for the same GoTrue session remain independent.

## Available operations and limits

- `session.open` and `session.revoke` take `{ organizationId }`.
- `assessment.create` takes `{ organizationId, content }` and may include `assessmentId` when updating an existing draft. `assessment.get` takes `{ organizationId, assessmentId }`.
- `assessment.validate` takes `{ organizationId, assessmentId }`. The app reads the stored draft and runs the R2.11 static validator and approved-template normalization; SQL locks and matches the current draft before persisting the validated digest and snapshot.
- `assessment.issue` takes `{ organizationId, assessmentId, reviewerPrincipalId }`. It creates a real `CREATED` session and reviewer assignment with terminal execution and AI disabled. It issues no candidate token and enables no candidate browser or execution route.
- `evidence.read` and `review.read` take `{ organizationId, sessionId }` and require the assigned active reviewer. Until the candidate session is `SUBMITTED`, they return empty arrays with an explicit availability message. Submitted reads return persisted evidence and review packets; evaluator observations, histories, and packets are scoped to the caller's own authored records. There are no review-write operations.

Candidate execution, AI, candidate token creation, candidate browser access, and review writes remain unavailable. An issued assessment is not evidence of candidate work. The lane does not infer or report competence, scores, or hiring verdicts.

## Recovery and rollback

Run `npm run build` followed by `npm run test:staging`. The harness exercises real GoTrue login without fixture SQL or fake authentication, repeatable provisioning, signature/replay/key rotation denials, persistence through production-app restart, separate-database restore, membership and session revocation, and private reviewer isolation. It packages the production build with generated external dependency links dereferenced, records build/archive/lockfile identities, verifies that a deliberately corrupt release fails startup, and starts the retained release from a separately extracted directory against the matching restored database snapshot. It also tests failed signing-key configuration rollback. This is a failed-release rollback rehearsal, not proof that an arbitrary schema downgrade is compatible. Runtime dependencies must match the recorded lockfile, platform and Node version.

PostgreSQL dumps omit cluster roles and Python packages. Restore requires the same reviewed image, role and extension bootstrap, Auth configuration, and matching application signing keys. The local `.data` dumps and private-key files are private recovery artifacts; protect them and maintain an off-host backup. Reconcile key rotation and revocation state with the restored database before routing traffic. This local rehearsal is not a deployment-readiness claim.

HTTP bodies are bounded to 256 KiB and proofs to 1 MiB to accommodate the existing bounded workspace and signed validation snapshots. The staging profile permits only liveness and the new API; liveness remains explicitly separate from readiness. There is no browser product journey in this API slice. Auth and application data share the database dump, but GoTrue JWT configuration and application private keys require separate protected recovery. A snapshot predating access revocation must have those revocations reconciled before traffic resumes.
