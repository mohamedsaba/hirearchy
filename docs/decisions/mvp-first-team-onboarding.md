# Proposed decision: first-team onboarding and reviewer invitations

- **Status:** Proposed; do not implement until reviewed and accepted.
- **Date:** 2026-11-06
- **Baseline:** PR #5 is merged to protected `main` at `1a919b40ab45f9788a8cf0f785d33449379b7098`. PR #6 remains draft and unmerged. Migration `0016_candidate_invitation_lifecycle.sql` is in the PR #6 source, not the merged baseline. Any onboarding schema must be additive after `0016`; preserve all existing migration bytes and checksums.

## Context

The current R23 flow signs in with GoTrue and verifies the live user before creating the application session. Its signed proof is checked again in PostgreSQL against a live `auth.sessions` row. The staging dispatcher then requires an `application_principals` row before any operation, so a confirmed identity with no principal cannot create a first team or accept a first invitation.

The existing tenant model has organizations, application principals bound to Auth user IDs, and `recruiter` and `reviewer` memberships. PR #5 still uses administrator provisioning. The R23 disposable fixture's principal-binding helpers are fixture-only and are not product onboarding patterns. Existing configured organization IDs and display names must remain historical records; self-service onboarding cannot adopt them.

This proposal adds the smallest confirmed-email first-team path and one reviewer-invitation path while preserving the existing identity proof and strict membership checks.

## Decision

### Identity verification before principal lookup

Keep both independent identity checks:

1. The app verifies the submitted GoTrue bearer through live `GET /user`, checks the subject and session claims, and requires `email_confirmed_at` to be present.
2. PostgreSQL verifies the signature, key, expiry, and matching live Auth session before any onboarding operation. For only the verified `proof.sub`, it independently checks `auth.users.email_confirmed_at` and reads only `id`, `email`, and `email_confirmed_at`.

The browser and operation arguments cannot supply a trusted subject, principal ID, organization ID, email-confirmed state, or role. No onboarding operation bypasses the existing signature or live-session proof. Do not change Auth RLS or expose secret columns.

The narrow `auth.users` column grant and any policy or grant involving the optional `staging_verifier_owner` role belong in the privileged staging installer, not in an ordinary ordered migration. The installer must verify the expected role and columns and grant only what the verifier needs. The web role gets no direct `auth.users` access.

### Recovery eligibility for proof-bound product operations

Recovery-cookie isolation is not an authorization boundary for product APIs: a recovery-issued GoTrue bearer can be presented directly to `POST /api/staging/v1`. After the exact bearer passes live `GET /user` verification and its subject and session match the token claims, derive recovery eligibility from every entry in that token's Auth-signed `amr` claim. If any entry has `method: "recovery"`, the bearer is recovery-only. Missing, empty, or malformed AMR fails closed; do not treat it as a normal login. The GoTrue configuration must be verified not to use a custom access-token hook that silently removes AMR; any such removal remains denied by this rule.

Recovery credentials may call only GoTrue's password-update endpoint (`PUT /user`). They cannot create an R23 application session or issue a product proof. After a successful password update, clear recovery flow state and require a fresh login before product operations. This applies to every operation on the authenticated PostgreSQL proof-bound staging API, including the direct bearer endpoint. Preserve legacy SQLite and disposable behavior outside that proof-bound profile.

Use a required `isRecovery` boolean in staging proof version 2. The app sets it only from the AMR inspected after live `/user` verification. PostgreSQL requires strict boolean `false` before dispatching any product operation and rejects v1 proofs; keep the existing proof signature, replay protection, and independent live Auth subject/session/expiry checks. This is the database's enforcement of the app's verified signed statement, not an independent AMR lookup in Auth. Do not add grants, policies, or helper roles for `auth.mfa_amr_claims`.

### Pre-principal operations

Add only these three operations before the current principal lookup:

- **`onboarding.status`** is read-only and takes no arguments. It reports only `needs_team` or `has_active_membership`; it returns no organization names or IDs and creates nothing. Call it after login and before the current `membership.list`/organization-selection path.
- **`organization.bootstrap`** accepts a display name and a durable idempotency key. It is available only to a confirmed Auth identity with zero active memberships. PostgreSQL serializes bootstrap for the verified subject, creates or resolves only the principal bound to that subject, generates principal and organization IDs, creates the owned team and a founder `recruiter` membership, and records a canonical request receipt in one transaction. The client cannot select IDs, roles, or identity bindings.
- **`organization.invitation.accept`** accepts an invitation bearer for an email-confirmed identity. It runs before principal lookup so a first-time invitee can be bound to their own confirmed Auth subject. The app hashes the bearer before signing the proof; PostgreSQL and receipts never receive plaintext bearer material.

The dispatcher must branch to these operations only after proof signature and live-session validation. Existing operations retain the strict principal lookup, active membership, organization context, assignment, and session checks.

### Team creation and ownership

Add nullable `owner_principal_id` and nullable `display_name` to `organizations`. Both remain unset for every historical row. New self-service teams must set both at creation: `owner_principal_id` to the founder principal, and `display_name` to the validated team name. The owner binding is immutable after creation. Do not rename, adopt, backfill, or transfer configured historical organizations.

The owner is an immutable ownership fact, not a new `admin` membership role. A founder remains a `recruiter`; invitations grant `reviewer` only. A first-team setup is available when the verified identity has zero active memberships. Prior revoked memberships do not block creating an independent new team and are never reactivated.

Validate a new display name after trimming: it must contain 1–120 Unicode code points and no control characters. Use PostgreSQL `char_length` and JavaScript code-point counting for the same limit. Escape it wherever rendered. Do not require a slug or unique name. Preserve existing configured names and IDs for historical organizations.

Bootstrap receipts are bound to subject, operation, idempotency key, and canonical request digest. Same-key/same-payload replay returns the same non-secret creation reference; changed payload conflicts. If that founder's membership has since been revoked, replay may report only the creation reference and current access-denied state. It must not reopen a session, restore membership, or imply current access. A new key may create an independent team only when the subject has no active memberships.

### Reviewer invitations

Only the active immutable owner membership may create, recover, or revoke an invitation for that organization. A copied invitation grants `reviewer` only; the caller cannot choose a role. The internal demo sends no team-invitation email. GoTrue account confirmation and password recovery are separate flows and require configured Auth SMTP.

Persist the organization, canonical invited email, reviewer role, token hash, purpose-bound encrypted token envelope, expiry, revocation and acceptance state, and timestamps. Generate the bearer in the app and encrypt it using the existing authenticated-encryption pattern with a separate invitation purpose/AAD. Store only the digest and ciphertext in PostgreSQL. Authorized owner recovery may decrypt the copyable link; it is read-only and cannot rotate the invitation. Revocation is repeat-safe. Expiry and revocation deny acceptance while retaining the record.

The owner UI defaults invitation expiry to seven days. Fresh creation requires an explicit future expiry no more than 30 days away; do not silently select a server expiry. Perform durable idempotency-receipt lookup before validating the future-expiry window for a fresh invitation. An identical replay remains a replay after its original expiry, reports the current state, and never extends the expiry. A changed request under the same key conflicts.

Acceptance requires the current confirmed email from both identity checks to match the canonical invited address. Create a principal only when the verified Auth subject has none. Insert a reviewer membership without overwriting an existing role. A same-subject retry is idempotent only while both the invitation and the reviewer's membership are active. An expired or revoked invitation denies acceptance, including a retry after prior consumption. Revoking an invitation does not revoke a membership already created by acceptance; that reviewer remains available through normal authorized organization selection until the membership is separately revoked. A revoked membership is never restored; mismatched email, unconfirmed identity, or conflicting role is denied.

If a creation receipt is replayed after the caller loses owner membership, return at most a non-secret reference and current access-denied status. Never return an invitation secret or claim restored authorization. Owner-controlled member revocation and reviewer reassignment are follow-up work. Do not transfer ownership; `owner_principal_id` stays immutable.

### Signup and password recovery

Keep GoTrue email confirmation enabled. Use the pinned GoTrue `v2.197.0` PKCE signup, confirmation, recovery, token-exchange, and password-update APIs. Signup and recovery require configured Auth SMTP and a fixed callback allowlist; do not use auto-confirmation as a workaround. Team-invitation email remains off.

Generate the PKCE verifier server-side. Keep it in a short-lived encrypted, `HttpOnly; Secure; SameSite=Lax` cookie bound to the flow purpose, and consume callback codes once. Do not accept user-selected redirect targets or place credentials in browser storage. Create a normal R23 application session only after PKCE exchange and a fresh live `/user` verification; then call `onboarding.status` before the organization-list flow.

After login, an identity with active memberships follows the existing organization-selection path. An identity with no active memberships is offered first-team creation or acceptance of a pending reviewer invitation. Preserve pending invitation context only in short-lived purpose-bound state; do not create a principal, membership, or session from a URL or receipt alone.

Recovery uses GoTrue's generic recovery response and a separate short-lived purpose-bound flow state. Test that the returned bearer cannot issue any product proof, including through direct `POST /api/staging/v1`; only the password update (`PUT /user`) is allowed before fresh login. Cover recovery in any AMR entry, missing/empty/malformed AMR, strict v2 `isRecovery: false` enforcement, and rejection of v1 proofs. If the current R23 callback rejects query parameters, add a dedicated guarded PKCE confirmation/recovery callback instead of weakening the existing callback contract.

## Implementation seams

- Add a migration after `database/postgres/migrations/0016_candidate_invitation_lifecycle.sql`. It owns new organization columns, tables, constraints, and immutability rules. Do not put optional verifier-role grants or `auth.users` grants/policies in this ordinary migration.
- Extend `database/postgres/staging/install-api.sql` for the three pre-principal operations, after proof and live `auth.sessions` validation. The privileged installer owns narrow `auth.users(id, email, email_confirmed_at)` access and any role-specific policies. It must not alter Auth RLS or grant the web role table access.
- Allow only the corresponding operations in `apps/web/src/staging/server.ts`; preserve `verifyR23AccessToken()` and the app-signed proof.
- Reuse `apps/web/src/r23-auth/identity.ts` for live user/session and confirmed-email verification, and the credential-envelope helpers in `apps/web/src/r23-auth/credential-envelope.ts`. Keep the existing login callback behavior in `apps/web/src/r23-auth/server.ts`; add explicit PKCE routes alongside `/r23/auth/` as needed.
- Route verified login through `onboarding.status` before the existing organization list. Extend `resolveOrgDisplay()` in `apps/web/src/r23-auth/server.ts` to prefer a persisted name for new teams while retaining configured names and IDs for historical teams.
- Reuse the AES-GCM envelope pattern in `apps/web/src/sessions/candidate-token-storage.mjs` with a distinct invitation purpose/AAD. Do not reuse `r23.bind_principal` from `database/postgres/r23/fixture.sql` or `restoreOrganizationMembership()` from `database/postgres/r23/adapter.mjs`.

## Acceptance

1. A confirmed identity with no principal can read `onboarding.status`; the operation is read-only and returns no organization ID/name. Stale, unconfirmed, or mismatched live/Auth database identities are denied.
2. Bootstrap creates database-generated IDs, one recruiter membership, non-null persisted `display_name`, and immutable `owner_principal_id`. Both new fields remain null on historical rows. It rejects any active membership and cannot adopt or rename a historical configured team.
3. Display-name length/control validation, output escaping, same-key replay, changed-payload conflict, revoked-membership replay, and new-key/zero-active-membership behavior match this decision.
4. Only an active owner can create, recover, or revoke an invitation. A fresh expiry is explicit, future, and at most 30 days; identical replay after expiry does not extend it. Team invitations do not send email and receipts/logs contain no plaintext bearer.
5. Invitation acceptance requires the original invited email to be confirmed by GoTrue and PostgreSQL. Only the same subject with both an active invitation and active reviewer membership can replay. Expired/revoked invitation retries are denied, but revoking an invitation does not revoke an already created membership; revoked membership and conflicting role are denied without state change.
6. Existing membership, organization selection, candidate, assignment, evidence, and review operations retain their current principal/membership/session checks. No fixture identity binding, historical adoption, or automatic membership restoration is reachable.
7. Signup and password recovery use the pinned PKCE flow, fixed callback allowlist, one-time code exchange, and purpose-bound state. Recovery grants only password update; success clears state and requires a new login.
8. Email-confirmation remains enabled. Tests use disposable mail only; configured SMTP and any public signup activation remain deployment gates.

## Sources

- [Tenant foundation migration](../../database/postgres/migrations/0001_tenant_foundation.sql)
- [PR #6 candidate lifecycle migration 0016](../../database/postgres/migrations/0016_candidate_invitation_lifecycle.sql) — draft/unmerged source, not the current protected-main baseline
- [Privileged staging API installer](../../database/postgres/staging/install-api.sql)
- [GoTrue identity verification](../../apps/web/src/r23-auth/identity.ts)
- [Staging proof dispatch](../../apps/web/src/staging/server.ts)
- [R23 callback, organization display, and application session](../../apps/web/src/r23-auth/server.ts)
- [Credential envelope](../../apps/web/src/r23-auth/credential-envelope.ts)
- [Candidate token encryption pattern](../../apps/web/src/sessions/candidate-token-storage.mjs)
- [Disposable fixture principal binding](../../database/postgres/r23/fixture.sql)
- [Pinned GoTrue image](../../.github/workflows/executor.yml)
- GoTrue `v2.197.0` official sources: [OpenAPI](https://github.com/supabase/auth/blob/v2.197.0/openapi.yaml), [signup](https://github.com/supabase/auth/blob/v2.197.0/internal/api/signup.go), [recovery](https://github.com/supabase/auth/blob/v2.197.0/internal/api/recover.go), [verification](https://github.com/supabase/auth/blob/v2.197.0/internal/api/verify.go), [PKCE token exchange](https://github.com/supabase/auth/blob/v2.197.0/internal/api/token.go), [AMR session model](https://github.com/supabase/auth/blob/v2.197.0/internal/models/amr.go), [session AMR and recovery detection](https://github.com/supabase/auth/blob/v2.197.0/internal/models/sessions.go), [JWT AMR generation](https://github.com/supabase/auth/blob/v2.197.0/internal/tokens/service.go), [email delivery](https://github.com/supabase/auth/blob/v2.197.0/internal/api/mail.go), [redirect validation](https://github.com/supabase/auth/blob/v2.197.0/internal/utilities/request.go), [password update](https://github.com/supabase/auth/blob/v2.197.0/internal/api/user.go), and [configuration](https://github.com/supabase/auth/blob/v2.197.0/README.md).
