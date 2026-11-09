# Single-team staging activation and operations runbook

**Status:** Procedure draft prepared 2026-11-09. Stage A source and local browser acceptance passed, but no public preview is hosted. Stage B’s local Caddy TLS, intake recovery, and synthetic Reservation Moves v3 browser journey passed. At drafting, packaged PostgreSQL outage recovery, independent restore, and release rollback were pending B validation. This runbook is not deployment acceptance; use the current [release-readiness ledger](../../docs/release-readiness.md) and [PR #17 checks](https://github.com/mohamedsaba/hirearchy/pull/17/checks) for the latest exact-head gates before activation.

This guide covers a single Linux host and one supervised team. Read [release readiness](../../docs/release-readiness.md) and the [founder decision packet](../../docs/release-founder-decisions.md) before activation. The local synthetic demo has separate [startup instructions](../../docs/demo/internal-buyer-demo.md).

The entry baseline for this runbook is protected PR #18 merge `62bdc5bc05736c3d7b637c50b4decb1df752d974`; this is provenance, not a permanent pointer to `main`. The full packaged-alpha TLS Reservation Moves flow passed with web image source `a4d32b7cecc07aff42af873da8e2f5895ef08871` on 2026-11-09. Consult [PR #17](https://github.com/mohamedsaba/hirearchy/pull/17) and the release-readiness ledger for its final source SHA, exact-head checks, and operational evidence. Deploy only the protected merge SHA recorded there, not an unmerged branch head.

Stage C external-candidate beta remains gated. Keep public signup, email delivery, AI-provider calls, untrusted code execution, and external candidate activation disabled.

## 1. Host and source requirements

- Use a Linux host. Compose uses host networking so PostgreSQL, GoTrue, and both app processes can bind only to IPv4 loopback; this deployment recipe is not supported on Docker Desktop networking.
- Keep PostgreSQL, GoTrue, the authenticated app, and the public-preview app on loopback. Caddy is the only edge listener. The host firewall should allow SSH only from approved administration networks and web ports 80/443 only after activation. Never open PostgreSQL 5432, GoTrue 9998, or app ports 3000/3001 to the network.
- Use a clean checkout of the exact protected commit whose required checks passed. Build and load images tagged with that same 40-character commit SHA. Compose preflight rejects a dirty checkout or a release tag that differs from `HEAD`.
- Build images on a separate builder when practical. The web Dockerfile runs `npm ci` and the production Next build; the PostgreSQL image contains the reviewed Python/cryptography dependencies. The Compose files pin GoTrue and Caddy by digest.
- Use one root-owned environment file per deployment profile under `/etc/hirearchy`, outside the repository. Do not put secrets in `.env`, shell history, logs, or source control. Use a root shell with tracing disabled when loading it.

On the builder, verify the source and prepare the images:

```sh
set -euo pipefail
npm ci
npm run verify
test -z "$(git status --porcelain)"
export HIREARCHY_RELEASE_SHA="$(git rev-parse HEAD)"
docker build -f deploy/staging/Dockerfile.web -t "hirearchy/web:$HIREARCHY_RELEASE_SHA" .
docker build -f database/postgres/staging/Dockerfile -t "hirearchy/postgres-staging:$HIREARCHY_RELEASE_SHA" .
docker save -o "hirearchy-images-$HIREARCHY_RELEASE_SHA.tar" \
  "hirearchy/web:$HIREARCHY_RELEASE_SHA" \
  "hirearchy/postgres-staging:$HIREARCHY_RELEASE_SHA"
sha256sum "hirearchy-images-$HIREARCHY_RELEASE_SHA.tar"
```

Transfer the image archive using the approved private channel, verify its recorded SHA-256 on the host, then load it with `docker load -i`. Pull the exact Caddy and GoTrue image references from the Compose files. Record the source SHA, archive hash, and loaded image IDs with the deployment evidence. Do not build or tag an unreviewed dirty tree as a release.

## 2. Stage A — public-preview profile

The public-preview profile serves the marketing pages and the early-access form. It has no PostgreSQL, GoTrue, authenticated staging routes, or product data. Intake submissions contain buyer contact details and persist on the named `early-access-data` volume.

Create a private environment file from the non-secret template. Set its release SHA and hostname before preflight:

```sh
sudo install -d -o root -g root -m 0700 /etc/hirearchy
sudo install -o root -g root -m 0600 deploy/staging/env.preview.example /etc/hirearchy/preview.env
sudoedit /etc/hirearchy/preview.env
```

For a local TLS rehearsal, use a `.localhost` preview hostname, loopback Caddy binding, and unused local HTTP/HTTPS ports. Caddy’s local CA must be trusted only on the rehearsal machine. For a hosted preview, configure a founder-approved hostname, public DNS A/AAAA records, and a firewall that exposes only 80/443 before changing `CADDY_BIND_ADDRESS` from `127.0.0.1` to `0.0.0.0 ::`.

Public intake stays disabled until the founder approves the privacy notice, retention and deletion policy, support owner, and incident contact. The current store has no automatic expiry, and no deletion-request process has been accepted. Approval must include how old copies are removed from backups.

From the clean release checkout, in a root shell with command tracing off:

```sh
set -euo pipefail
cd /srv/hirearchy/release
PREVIEW_ENV_FILE=/etc/hirearchy/preview.env
set -a
. "$PREVIEW_ENV_FILE"
set +a
node deploy/staging/preflight.mjs
docker compose --env-file "$PREVIEW_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.preview.yml config --quiet
docker pull caddy:2.11.9-alpine@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee
docker compose --env-file "$PREVIEW_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.preview.yml up -d --no-build --pull never
docker compose --env-file "$PREVIEW_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.preview.yml ps
```

Confirm Caddy has a valid TLS certificate and that `/`, `/products/software`, `/early-access`, `/contact`, and `/api/health` load through the chosen hostname. Confirm the public-preview route boundary denies product, Auth, candidate, evaluator, AI, and execution APIs. `/contact` is informational and does not store messages. Do not use a real buyer’s details as a deployment smoke test.

### Early-access operator export

The export is read-only. Run from the release checkout with the same environment file and project name used to start the stack. Treat the result as personal information:

```sh
umask 077
docker compose --env-file "$PREVIEW_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.preview.yml exec -T web \
  node --experimental-strip-types scripts/export-early-access-requests.mjs
```

To save a private copy, redirect stdout to an access-restricted destination outside the repository and set mode `0600`. An absent store exports an empty list without creating the request file; corrupt or unreadable storage returns an error. The file-backed store supports one app process only.

## 3. Stage A to Stage B — same-project supervised alpha

Stage B adds PostgreSQL, GoTrue, and the authenticated app while retaining public preview. **Keep the exact same `COMPOSE_PROJECT_NAME`** used by Stage A. Both Compose files name the intake volume `${COMPOSE_PROJECT_NAME}-early-access-data`; changing the project name silently selects an empty volume. The authenticated `web` service does not own intake data; Stage B’s `web-preview` service does. Both Compose files also reuse the same named Caddy data/config volumes.

Before the change, record the project’s volume names and export intake using the Stage A command above. Never run `docker compose down -v` during an upgrade. Do not remove volumes or use `--remove-orphans` as routine release steps.

Prepare the alpha environment file with the Stage A project name, preview hostname and ports, then fill in the alpha hostname, fixed team/VPN CIDRs, loopback service ports, release SHA, and public origin. Keep the Caddy listener loopback-only for rehearsal. For real team access, use only founder-approved fixed CIDRs; never use `0.0.0.0/0` or `::/0`. Alpha access is filtered by Caddy; PostgreSQL and GoTrue remain loopback-only.

For a loopback TLS rehearsal, use `.localhost` hostnames and restrict `STAGING_ALLOWED_CIDRS` to `127.0.0.1/32 ::1/128`. For a team rehearsal, replace those entries only with the team’s fixed office/VPN egress CIDRs. Do not treat a successful loopback TLS check as public DNS/TLS acceptance.

```sh
set -euo pipefail
sudo install -o root -g root -m 0600 deploy/staging/env.staging.example /etc/hirearchy/staging.env
sudoedit /etc/hirearchy/staging.env
sudo node scripts/generate-staging-secrets.mjs /etc/hirearchy/staging.env
```

The generator fills only `SET_...` placeholders after ports and non-secret settings are provided. It requires a regular mode-`0600` file and refuses to replace any already-configured value. It prints no secret values. **Do not rerun it to rotate or replace keys.** Preserve the same database passwords, GoTrue JWT secret, proof signing key, and candidate-token encryption key for this database. The candidate-token key is bound to database metadata; an arbitrary replacement makes the stored tokens unreadable.

Build or load the web and PostgreSQL images for the exact commit in `HIREARCHY_RELEASE_SHA`. Source the alpha environment in a root shell with tracing off, then validate both preflight and Compose configuration:

```sh
set -euo pipefail
cd /srv/hirearchy/release
PREVIEW_ENV_FILE=/etc/hirearchy/preview.env
STAGING_ENV_FILE=/etc/hirearchy/staging.env
set -a
. "$STAGING_ENV_FILE"
set +a
node deploy/staging/preflight.mjs
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.staging.yml config --quiet
```

For a Stage A upgrade, stop only the old preview app so its loopback port is free. Keep the existing Caddy process and all volumes:

```sh
docker compose --env-file "$PREVIEW_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.preview.yml stop web
```

Start the database, GoTrue, and Stage B preview service, then run the existing migration and installation runner from the host. It applies numbered migrations with the restricted migrator, installs the privileged verifier after GoTrue is available, verifies the existing candidate-token key binding (or initializes it on first install), registers or checks the Ed25519 verifier key, and checks readiness and truthful capability flags. Do not hand-edit database rows or run installer SQL outside the reviewed runner.

```sh
docker pull caddy:2.11.9-alpine@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee
docker pull supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.staging.yml up -d --no-build --pull never postgres gotrue web-preview
node scripts/deploy-single-team-staging.mjs
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.staging.yml up -d --no-build --pull never web caddy
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.staging.yml ps
```

The `up` operation reuses the project’s existing named volumes. Confirm that `${COMPOSE_PROJECT_NAME}-early-access-data` is the same volume recorded before the transition, then verify the preview still returns its prior requests using the Stage B export command below. Verify the authenticated app’s readiness locally at `http://127.0.0.1:$APP_PORT/api/staging/readiness`; Caddy intentionally denies public access to that endpoint.

### Controlled team provisioning

Public signup remains disabled. Use `node scripts/provision-staging.mjs <private-input.json>` only for founder-approved team members. The mode-`0600` input file holds an organization UUID and `users` entries with approved email, `recruiter` or `reviewer` role, and a one-time password for new GoTrue users. The CLI creates confirmed GoTrue identities and provisions principals/memberships through the supported administrative path; it does not insert product records by hand. Existing memberships are not rebound or reactivated. There is no email delivery, so account/password handoff must use a separately approved private channel.

The CLI requires `STAGING_ADMIN_DATABASE_URL`, loopback `STAGING_AUTH_URL`, and a short-lived `STAGING_AUTH_ADMIN_TOKEN`. The token is a GoTrue HS256 JWT with the same `role: service_role`, `aud: authenticated`, and expiry claims used by the existing integration helper. Create it in a root shell from the protected `GOTRUE_JWT_SECRET`; capture the one-time output directly into a shell variable and never print, save, log, or pass it to the app container:

```sh
set -euo pipefail
trap 'unset STAGING_AUTH_ADMIN_TOKEN' EXIT
export STAGING_AUTH_ADMIN_TOKEN="$(node --input-type=module -e '
import { createHmac } from "node:crypto";
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const header = encode({ alg: "HS256", typ: "JWT" });
const payload = encode({ role: "service_role", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 300 });
const input = `${header}.${payload}`;
process.stdout.write(`${input}.${createHmac("sha256", process.env.GOTRUE_JWT_SECRET).update(input).digest("base64url")}`);
')"
test -n "$STAGING_AUTH_ADMIN_TOKEN"
umask 077
install -d -o root -g root -m 0700 /var/lib/hirearchy
node scripts/provision-staging.mjs /etc/hirearchy/team-provisioning.json \
  > /var/lib/hirearchy/provisioned-organization.json
unset STAGING_AUTH_ADMIN_TOKEN
```

Keep provisioning input/output files mode `0600` under a root-only directory. Remove the short-lived token from the shell immediately after provisioning. B must validate this operator command against the pinned GoTrue image before it is used outside the isolated rehearsal.

## 4. Early-access export and deletion

After Stage B, export from `web-preview`, not the authenticated `web` service:

```sh
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.staging.yml exec -T web-preview \
  node --experimental-strip-types scripts/export-early-access-requests.mjs
```

Redirect to a root-only file if retention is required. The export does not mutate the store; it refuses corrupt data rather than returning a misleading empty list.

**Current retention behavior:** requests persist on the named volume until an authorized operator deletes them. There is no automatic expiry. Backups contain the same personal information and therefore remain in scope until their approved retention period ends. No public intake should be enabled until the founder/privacy reviewer approves a specific retention period, deletion request owner, and backup expiry policy.

**Manual deletion draft; B validation required before operational use.** The store has no delete API/CLI. This draft requires host-side `jq`. Select the matching Compose service and export the store to a private file. For Stage A set `STACK_FILE=deploy/staging/docker-compose.preview.yml`, `INTAKE_SERVICE=web`, and `ENV_FILE=$PREVIEW_ENV_FILE`; for Stage B set `STACK_FILE=deploy/staging/docker-compose.staging.yml`, `INTAKE_SERVICE=web-preview`, and `ENV_FILE=$STAGING_ENV_FILE`.

```sh
set -euo pipefail
umask 077
WORK_DIR="$(mktemp -d /run/hirearchy-intake-delete.XXXXXX)"
chmod 0700 "$WORK_DIR"
CURRENT="$WORK_DIR/before.json"
REVISED="$WORK_DIR/after.json"
docker compose --env-file "$ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f "$STACK_FILE" exec -T "$INTAKE_SERVICE" \
  node --experimental-strip-types scripts/export-early-access-requests.mjs > "$CURRENT"
chmod 0600 "$CURRENT"
read -r -p 'Confirmed request ID to delete: ' REQUEST_ID
jq -e --arg id "$REQUEST_ID" \
  'type == "array" and (map(select(.id == $id)) | length) == 1' \
  "$CURRENT" > /dev/null
jq --arg id "$REQUEST_ID" 'map(select(.id != $id))' "$CURRENT" > "$REVISED"
chmod 0600 "$REVISED"
jq -e --arg id "$REQUEST_ID" \
  'type == "array" and (map(select(.id == $id)) | length) == 0' \
  "$REVISED" > /dev/null
docker compose --env-file "$ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f "$STACK_FILE" stop "$INTAKE_SERVICE"
docker compose --env-file "$ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f "$STACK_FILE" run --rm --no-deps -T --entrypoint node "$INTAKE_SERVICE" \
  --input-type=module -e '
import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
let text = "";
for await (const chunk of process.stdin) text += chunk;
const records = JSON.parse(text);
if (!Array.isArray(records)) throw new Error("Expected a JSON array");
const file = process.env.EARLY_ACCESS_STORAGE_PATH;
const temp = `${file}.${randomUUID()}.tmp`;
await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
await rename(temp, file);
' < "$REVISED"
docker compose --env-file "$ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f "$STACK_FILE" up -d --no-build --pull never "$INTAKE_SERVICE"
docker compose --env-file "$ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f "$STACK_FILE" exec -T "$INTAKE_SERVICE" \
  node --experimental-strip-types scripts/export-early-access-requests.mjs \
  > "$CURRENT"
jq -e --arg id "$REQUEST_ID" \
  'type == "array" and (map(select(.id == $id)) | length) == 0' \
  "$CURRENT" > /dev/null
unset REQUEST_ID
rm -- "$CURRENT" "$REVISED"
rmdir "$WORK_DIR"
```

Do not edit the store while an app process can write it. Keep the ID and the deletion audit record separate from the export; do not log the requester’s name or email. Purge or expire every backup copy containing that record under the approved policy before claiming deletion is complete. If the ID is absent/duplicated, JSON is corrupt, the app does not restart, or backup copies cannot be located, stop and escalate to the privacy owner. The record rewrite command above is a draft, not yet rehearsed against the packaged volume.

## 5. Backup, restore, and release rollback

### Back up

Use a root-only destination outside the repository. PostgreSQL dumps contain application and Auth data; the globals dump contains role definitions/password hashes; the environment file contains application keys and database credentials. Encrypt the completed backup with the founder-approved off-host backup system before transfer. The off-host destination, backup owner, retention period, and restore alert are still founder decisions.

For Stage B, from the repository root with the same alpha environment and Compose project:

```sh
set -euo pipefail
umask 077
BACKUP_DIR="/var/backups/hirearchy/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 0700 /var/backups/hirearchy
mkdir -m 0700 "$BACKUP_DIR"
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.staging.yml exec -T postgres \
  pg_dumpall -U postgres --globals-only > "$BACKUP_DIR/postgres-globals.sql"
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.staging.yml exec -T postgres \
  pg_dump -U postgres -Fc postgres > "$BACKUP_DIR/postgres.dump"
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.staging.yml exec -T web-preview \
  node --experimental-strip-types scripts/export-early-access-requests.mjs \
  > "$BACKUP_DIR/early-access.json"
install -o root -g root -m 0600 "$STAGING_ENV_FILE" "$BACKUP_DIR/staging.env"
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.staging.yml cp caddy:/data "$BACKUP_DIR/caddy-data"
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f deploy/staging/docker-compose.staging.yml cp caddy:/config "$BACKUP_DIR/caddy-config"
git rev-parse HEAD > "$BACKUP_DIR/release.sha"
docker image inspect --format '{{.Id}}' "hirearchy/web:$HIREARCHY_RELEASE_SHA" \
  > "$BACKUP_DIR/web-image-id"
docker image inspect --format '{{.Id}}' "hirearchy/postgres-staging:$HIREARCHY_RELEASE_SHA" \
  > "$BACKUP_DIR/postgres-image-id"
sha256sum "$BACKUP_DIR/postgres-globals.sql" "$BACKUP_DIR/postgres.dump" \
  "$BACKUP_DIR/early-access.json" > "$BACKUP_DIR/data.sha256"
find "$BACKUP_DIR" -type d -exec chmod 0700 {} +
find "$BACKUP_DIR" -type f -exec chmod 0600 {} +
```

For Stage A, omit PostgreSQL dumps and save the early-access export, protected preview environment, Caddy data/config, release SHA, web image ID, and checksums. The Caddy data volume contains TLS/CA private material; keep it encrypted and access-restricted. Do not write dumps, exports, keys, or Caddy volume copies into the repository.

### Restore drill and rollback boundary

The application-level PostgreSQL restore and Release N → N-1 rollback have disposable local/CI coverage. At the last review on 2026-11-09, the packaged Stage B outage/restart, independent restore, and prior-image rollback had **not** passed their operational rehearsal. The steps below are a controlled draft; check the current release-readiness ledger for B’s final validation before relying on them for service recovery.

1. Isolate the failed service at Caddy/firewall while preserving its volumes and backups. Do not run `docker compose down -v`, remove a named volume, or restore over the only database copy.
2. Create a separate recovery project with fresh volumes, unused loopback ports, and the matching PostgreSQL image. Use the protected environment and key versions recorded with that snapshot; adjust only the recovery project name and loopback ports/URLs. Do not run the secret generator for a restore.
3. Restore cluster globals before the custom-format database dump into the isolated instance. The restore target must be a fresh compatible PostgreSQL instance; do not blindly replay role globals into a cluster whose init script already created those roles. Reapply the reviewed bootstrap/verifier and migration state only in the order verified by B.
4. Restore the early-access JSON and Caddy data/config to the recovery project. Keep the same GoTrue JWT secret, Ed25519 signing key/public-key row, and candidate-token encryption key/database binding as the snapshot. Reconcile account revocations or key revocations newer than the snapshot before any traffic is routed.
5. Start the prior application image with the matching restored database snapshot and protected config. Verify liveness, internal readiness, GoTrue health, and a synthetic authenticated recruiter/candidate/reviewer journey before directing the approved team to the recovery service.
6. Record the snapshot ID, source and prior image IDs, restore result, capability flags, and time-to-restore. Keep the original service and volumes intact until the recovery owner accepts the result.

Rollback means moving traffic to a prior compatible application image and its matching database snapshot. Do not run arbitrary schema downgrades or point old code at a newer live database without a specifically accepted compatibility result. Keep a protected prior image/archive and matching database, globals, intake, Caddy, and key/config backup before each migration. The actual packaged rollback commands and restore test remain pending B validation.

## 6. Monitoring, incident handling, and key changes

- Check `docker compose ... ps` and service health after every start/upgrade. Monitor `GET /api/health` for liveness. On Stage B, query `/api/staging/readiness` only through its loopback app port; Caddy intentionally returns `404` for that route. Monitor disk space, memory, Docker volume growth, Caddy certificate renewal, and backup freshness. No hosted alerting destination is configured yet; name an owner before activation.
- Keep Caddy, web, GoTrue, and PostgreSQL logs private. Use `docker compose ... logs --since 15m caddy web web-preview gotrue postgres` for diagnosis; never attach raw logs, exports, environment files, or browser traces to public tickets. App operational logging is redacted, but backups and GoTrue logs can still contain sensitive information.
- For suspected exposure, restrict Caddy/network access first, preserve the affected service and encrypted backups, and notify the named incident owner. Do not delete volumes or regenerate secrets during triage. Restore only into an isolated project until the recovery procedure is accepted.
- `scripts/generate-staging-secrets.mjs` is for first-time setup only; it refuses to overwrite configured secrets. Proof-key rotation requires a new key ID/public key in PostgreSQL, switching the application, verification, and revoking the old key. Database role passwords and the GoTrue JWT secret require coordinated service/database changes. The candidate-token key is database-bound and cannot be replaced independently. No packaged hosted rotation rehearsal is accepted yet; use a reviewed key-specific procedure and record the old/new key IDs without recording key material.

## 7. Activation gates

Before Stage A is public: approve privacy/legal copy and retention/deletion including backup expiry; choose domain/DNS and an encrypted backup destination; name the monitoring, support, and incident owners; restrict host firewall and SSH; use a founder-approved public bind address; and verify TLS and route boundaries.

Before Stage B team access: keep Stage A’s project/volume identity, verify preflight and migration/key binding, use only fixed team/VPN CIDRs, verify the restricted alpha Caddy routes and internal readiness, provision only approved confirmed users through the operator CLI, and validate the full recovery and rollback procedures on an isolated copy. The authenticated staging app does not enable self-service signup, email, AI, code execution, or external-candidate access.

Do not report Stage A/B as hosted-ready or Stage C as available until B’s operational validation and the founder approvals are recorded in [release readiness](../../docs/release-readiness.md).
