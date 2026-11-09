# Single-team staging activation and operations runbook

**Status:** The previous local synthetic release rehearsal passed on 2026-11-09; no preview or alpha is hosted. [PR #19](https://github.com/mohamedsaba/hirearchy/pull/19) is the authoritative location for the latest exact-head checks, package/TLS/operator/readiness results, and resource sample. Nothing in this runbook authorizes deployment, public activation, purchases, real prospect data, or outreach. See the [release-readiness ledger](../../docs/release-readiness.md). Off-host backup, public TLS/domain, access/monitor owners, privacy/legal approval, and founder activation remain open.

This guide covers a single Linux host and one supervised team. Read [release readiness](../../docs/release-readiness.md) and the [founder decision packet](../../docs/release-founder-decisions.md) before activation. The local synthetic demo has separate [startup instructions](../../docs/demo/internal-buyer-demo.md).

The protected-main entry baseline is PR #17 merge `bbaf2458557389e6ca5291586c08a8deb21a5dea`, which includes PR #18. That exact SHA passed the four required checks; the new release-preparation PR must pass the same four checks on its final combined head. The earlier packaged-alpha TLS Reservation Moves flow passed with synthetic data. Use this as an operations reference only; no deploy action is authorized.

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

For a local TLS rehearsal, use a `.localhost` preview hostname, loopback Caddy binding, and unused local HTTP/HTTPS ports. Caddy’s local CA must be trusted only on the rehearsal machine. For a hosted preview, configure a founder-approved hostname, public DNS A/AAAA records, and a firewall that exposes only 80/443 before changing `CADDY_BIND_ADDRESS` from `127.0.0.1` to `0.0.0.0 ::`. **Never source either environment file into a shell.** The templates contain space-delimited values; use Node’s `--env-file` for host Node commands, Compose’s `--env-file` for Compose, and extract only non-secret scalar values when a shell variable is required.

Public intake stays disabled until the founder approves the privacy notice, retention and deletion policy, support owner, and incident contact. The current store has no automatic expiry. An authorized operator can use the CLI below to dry-run or apply a selected deletion, but there is no approved numeric retention period or public deletion-request process. Approval must include how old copies are inventoried and removed from backups.

From the clean release checkout, in a root shell with command tracing off:

```sh
set -euo pipefail
cd /srv/hirearchy/release
PREVIEW_ENV_FILE=/etc/hirearchy/preview.env
COMPOSE_PROJECT_NAME="$(node --env-file="$PREVIEW_ENV_FILE" -p 'process.env.COMPOSE_PROJECT_NAME')"
node --env-file="$PREVIEW_ENV_FILE" deploy/staging/preflight.mjs
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

Export is explicit and private. The CLI prints counts and file mode only; it writes request rows to a protected file. Use a root-only host directory outside `/app/data` and outside the ordinary operator log path. The one-shot container runs as root only to write into that root-owned directory; the web service remains UID 1000. For Stage A set `STACK_FILE=deploy/staging/docker-compose.preview.yml`, `INTAKE_SERVICE=web`, and `ENV_FILE=/etc/hirearchy/preview.env`; for Stage B use `deploy/staging/docker-compose.staging.yml`, `web-preview`, and `/etc/hirearchy/staging.env`.

```sh
set -euo pipefail
umask 077
OPERATOR_DIR=/var/lib/hirearchy/operator
install -d -o root -g root -m 0700 "$OPERATOR_DIR"
COMPOSE_PROJECT_NAME="$(node --env-file="$ENV_FILE" -p 'process.env.COMPOSE_PROJECT_NAME')"
docker compose --env-file "$ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
  -f "$STACK_FILE" run --rm --no-deps -T --user 0:0 \
  --volume "$OPERATOR_DIR:/run/hirearchy/operator:rw" \
  --entrypoint node "$INTAKE_SERVICE" \
  --experimental-strip-types scripts/manage-early-access-requests.mjs \
  export --all --apply --output /run/hirearchy/operator/export.json
test "$(stat -c '%a' "$OPERATOR_DIR")" = 700
test "$(stat -c '%a' "$OPERATOR_DIR/export.json")" = 600
```

Keep export files out of source control and out of automatic host backups unless explicitly selected as an encrypted snapshot. Corrupt or wrong-shaped stores fail closed. The file-backed intake store is for one app process on one shared filesystem, not multi-host writes.

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

Build or load the web and PostgreSQL images for the exact commit in `HIREARCHY_RELEASE_SHA`. Use Node’s `--env-file` for the host preflight and Compose’s `--env-file` for configuration; never shell-source the environment file. Validate both preflight and Compose configuration:

```sh
set -euo pipefail
cd /srv/hirearchy/release
PREVIEW_ENV_FILE=/etc/hirearchy/preview.env
STAGING_ENV_FILE=/etc/hirearchy/staging.env
COMPOSE_PROJECT_NAME="$(node --env-file="$STAGING_ENV_FILE" -p 'process.env.COMPOSE_PROJECT_NAME')"
node --env-file="$STAGING_ENV_FILE" deploy/staging/preflight.mjs
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
node --env-file="$STAGING_ENV_FILE" scripts/deploy-single-team-staging.mjs
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
export STAGING_AUTH_ADMIN_TOKEN="$(node --env-file="$STAGING_ENV_FILE" --input-type=module -e '
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
node --env-file="$STAGING_ENV_FILE" scripts/provision-staging.mjs /etc/hirearchy/team-provisioning.json \
  > /var/lib/hirearchy/provisioned-organization.json
unset STAGING_AUTH_ADMIN_TOKEN
```

Keep provisioning input/output files mode `0600` under a root-only directory. Remove the short-lived token from the shell immediately after provisioning. This exact token-generation and read-only GoTrue admin request was validated against the pinned `v2.197.0` image; it returned HTTP 200 without printing or storing the token. It is only a local operator prerequisite, not approval to provision a hosted team.

## 4. Early-access export and deletion

Use the private CLI for Stage A and Stage B. Set `STACK_FILE`, `INTAKE_SERVICE`, and `ENV_FILE` to the matching profile described above. Create a separate root-only operator directory outside the intake volume and ordinary backups; do not source the environment file. The one-shot operator container is run as root only so it can access the root-owned host directory. The live web process continues to run as UID 1000.

```sh
set -euo pipefail
umask 077
OPERATOR_DIR=/var/lib/hirearchy/operator
install -d -o root -g root -m 0700 "$OPERATOR_DIR"
COMPOSE_PROJECT_NAME="$(node --env-file="$ENV_FILE" -p 'process.env.COMPOSE_PROJECT_NAME')"
run_operator() {
  docker compose --env-file "$ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" \
    -f "$STACK_FILE" run --rm --no-deps -T --user 0:0 \
    --volume "$OPERATOR_DIR:/run/hirearchy/operator:rw" \
    --entrypoint node "$INTAKE_SERVICE" \
    --experimental-strip-types scripts/manage-early-access-requests.mjs "$@"
}

# Export is explicit; stdout contains operation/count/mode only.
run_operator export --all --apply \
  --output /run/hirearchy/operator/export.json
test "$(stat -c '%a' "$OPERATOR_DIR")" = 700
test "$(stat -c '%a' "$OPERATOR_DIR/export.json")" = 600

# Dry-run first. Select an exact ID or an operator-approved canonical UTC cutoff.
read -r -p 'Authorized record UUID: ' REQUEST_ID
run_operator delete --id "$REQUEST_ID"
# Alternatively, read an approved canonical UTC cutoff and use:
# run_operator delete --before "$APPROVED_UTC_CUTOFF"

# Apply only after reviewing the count-only dry-run; the receipt is written and fsynced before deletion.
RECEIPT_NAME="delete-$(date -u +%Y%m%dT%H%M%SZ).json"
run_operator delete --id "$REQUEST_ID" --apply \
  --receipt-out "/run/hirearchy/operator/$RECEIPT_NAME"
test "$(stat -c '%a' "$OPERATOR_DIR/$RECEIPT_NAME")" = 600
unset REQUEST_ID
```

The CLI supports `export --all|--id UUID|--before UTC`, `delete --id UUID|--before UTC`, and `replay --receipt FILE`; mutations require `--apply`. A delete receipt contains version, request time, selector, and opaque affected IDs but no request fields. Keep receipts restricted outside the intake volume and outside ordinary intake snapshots so they can be applied to a restored copy. Do not include raw IDs or exported rows in terminal transcripts, tickets, or logs.

**Retention remains a founder decision.** Requests persist until an authorized operator deletes them; there is no automatic expiry and no numeric retention period is approved. Deleting from the active store does not delete existing exports, backups, or other copies. Inventory each copy and securely remove or expire it under an approved policy before claiming complete erasure. A restored copy must receive all applicable deletion receipts before Caddy routes traffic. No public intake or real prospect data is authorized by this runbook.

## 5. Backup, restore, and release rollback

### Back up

Use a root-only destination outside the repository. PostgreSQL dumps contain application and Auth data; the globals dump contains role definitions/password hashes; the environment file and Caddy data contain key material. The local rehearsal used GPG symmetric AES-256 and verified the encrypted archive plus file checksums. The command requires an existing mode-0600 passphrase file at /etc/hirearchy/backup-passphrase, provisioned and held separately by the authorized key custodian. If it is absent, stop and request that decision; never generate or replace it during a backup. No off-host destination, separate backup account, owner, retention period, or restore alert is configured; those remain activation gates. Never store the passphrase beside the encrypted archive or include it in the archive.

For Stage B, from the repository root with the same alpha environment and Compose project:

```sh
set -euo pipefail
umask 077
STAGING_ENV_FILE=/etc/hirearchy/staging.env
COMPOSE_PROJECT_NAME="$(node --env-file="$STAGING_ENV_FILE" -p 'process.env.COMPOSE_PROJECT_NAME')"
BACKUP_DIR="/var/backups/hirearchy/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 0700 /var/backups/hirearchy
mkdir -m 0700 "$BACKUP_DIR"
PG_PORT="$(node --env-file="$STAGING_ENV_FILE" -p 'process.env.PG_PORT')"
COMPOSE_FILE=deploy/staging/docker-compose.staging.yml
WEB_PREVIEW_CONTAINER="$(docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" ps -q web-preview)"
CADDY_CONTAINER="$(docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" ps -q caddy)"
test -n "$WEB_PREVIEW_CONTAINER" && test -n "$CADDY_CONTAINER"
STACK_STOPPED=0
restart_backup_services() {
  if [ "$STACK_STOPPED" = 1 ]; then
    docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" up -d --no-build --pull never --no-deps web-preview
    docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" up -d --no-build --pull never --no-deps caddy
    STACK_STOPPED=0
  fi
}
trap 'restart_backup_services' EXIT
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres sh -c \
  "export PGPASSWORD=\"\$POSTGRES_PASSWORD\"; exec pg_dumpall -h 127.0.0.1 -p $PG_PORT -U postgres --globals-only" \
  > "$BACKUP_DIR/postgres-globals.sql"
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres sh -c \
  "export PGPASSWORD=\"\$POSTGRES_PASSWORD\"; exec pg_dump -h 127.0.0.1 -p $PG_PORT -U postgres -Fc postgres" \
  > "$BACKUP_DIR/postgres.dump"
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" exec -T postgres sh -c \
  "export PGPASSWORD=\"\$POSTGRES_PASSWORD\"; exec psql -h 127.0.0.1 -p $PG_PORT -U postgres -d postgres -A -t -F '|' -c 'SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls FROM pg_roles ORDER BY rolname'" \
  > "$BACKUP_DIR/role-attributes.txt"
STACK_STOPPED=1
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" stop web-preview caddy
docker cp "$CADDY_CONTAINER:/data" "$BACKUP_DIR/caddy-data"
docker cp "$CADDY_CONTAINER:/config" "$BACKUP_DIR/caddy-config"
install -o root -g root -m 0600 "$STAGING_ENV_FILE" "$BACKUP_DIR/staging.env"
install -o root -g root -m 0600 deploy/staging/Caddyfile.staging "$BACKUP_DIR/Caddyfile.staging"
git rev-parse HEAD > "$BACKUP_DIR/release.sha"
for service in web postgres gotrue caddy; do
  container="$(docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" ps -a -q "$service")"
  docker inspect --format '{{.Config.Image}} {{.Image}}' "$container" > "$BACKUP_DIR/$service-image.txt"
done
printf 'Source checkout: %s\n' "$(git rev-parse HEAD)" > "$BACKUP_DIR/manifest.txt"
printf 'Classification: confidential; includes database/Auth records, intake, secrets, and TLS private keys\n' >> "$BACKUP_DIR/manifest.txt"
# Export validated intake while its writer remains stopped. The output stays inside the encrypted snapshot.
chmod 0700 "$BACKUP_DIR"
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" run --rm --no-deps -T --user 0:0 \
  --volume "$BACKUP_DIR:/run/hirearchy/operator:rw" --entrypoint node web-preview \
  --experimental-strip-types scripts/manage-early-access-requests.mjs \
  export --all --apply --output /run/hirearchy/operator/early-access.json
test "$(stat -c '%a' "$BACKUP_DIR/early-access.json")" = 600
find "$BACKUP_DIR" -type d -exec chmod 0700 {} +
find "$BACKUP_DIR" -type f -exec chmod 0600 {} +
(cd "$BACKUP_DIR" && find . -type f ! -name checksums.sha256 -print0 | sort -z | xargs -0 sha256sum > checksums.sha256)
chmod 0600 "$BACKUP_DIR/checksums.sha256"
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" up -d --no-build --pull never --no-deps web-preview
docker compose --env-file "$STAGING_ENV_FILE" --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" up -d --no-build --pull never --no-deps caddy
STACK_STOPPED=0
trap - EXIT
BACKUP_PASSPHRASE_FILE=/etc/hirearchy/backup-passphrase
tar -czf - -C "$(dirname "$BACKUP_DIR")" "$(basename "$BACKUP_DIR")" \
  | gpg --batch --yes --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
      --symmetric --cipher-algo AES256 --output "$BACKUP_DIR.tar.gpg"
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
  --decrypt "$BACKUP_DIR.tar.gpg" | tar -tzf - > /dev/null
(
  cd "$(dirname "$BACKUP_DIR")"
  sha256sum "$(basename "$BACKUP_DIR").tar.gpg" > "$(basename "$BACKUP_DIR").tar.gpg.sha256"
)
chmod 0600 "$BACKUP_DIR.tar.gpg" "$BACKUP_DIR.tar.gpg.sha256"
rm -rf -- "$BACKUP_DIR"
```

For Stage A, omit PostgreSQL dumps and use the same protected operator CLI export against the stopped `web` service to write `early-access.json` into the snapshot directory. Include the protected preview environment, Caddy data/config, Caddyfile, release SHA, image reference/ID, and checksums. Caddy data contains TLS/CA private material. Keep the passphrase in separate restricted custody. Do not write dumps, exports, keys, or Caddy volume copies into the repository.

### Off-host transfer preparation

These commands are prepared for an already existing founder-approved SSH destination. Do not create an account, select a provider, purchase storage, or run the transfer until the destination, custodian, retention period, and restore owner are approved. Pin the destination host key through a trusted channel; do not use `ssh-keyscan` as first-contact trust.

```sh
set -euo pipefail
umask 077
ARCHIVE=/var/backups/hirearchy/replace-with-encrypted-archive.tar.gpg
BACKUP_HOST=approved-user@approved-existing-host
REMOTE_DIR=/srv/hirearchy/encrypted
SSH_KEY_FILE=/etc/hirearchy/backup-transfer.key
KNOWN_HOSTS_FILE=/etc/hirearchy/backup-transfer-known-hosts
ARCHIVE_NAME="$(basename "$ARCHIVE")"
CHECKSUM_NAME="$ARCHIVE_NAME.sha256"
test -f "$ARCHIVE" && test -f "$ARCHIVE.sha256"
test "$(stat -c '%a' "$SSH_KEY_FILE")" = 600
test "$(stat -c '%a' "$KNOWN_HOSTS_FILE")" = 600
(cd "$(dirname "$ARCHIVE")" && sha256sum -c "$CHECKSUM_NAME")
SSH_OPTIONS=(-i "$SSH_KEY_FILE" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS_FILE")
ssh "${SSH_OPTIONS[@]}" "$BACKUP_HOST" "install -d -m 0700 -- '$REMOTE_DIR'"
rsync --recursive --times --protect-args --chmod=F600,D700 \
  -e "ssh -i $SSH_KEY_FILE -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS_FILE" \
  "$ARCHIVE" "$ARCHIVE.sha256" "$BACKUP_HOST:$REMOTE_DIR/"
ssh "${SSH_OPTIONS[@]}" "$BACKUP_HOST" \
  "cd '$REMOTE_DIR' && sha256sum -c '$CHECKSUM_NAME'"

# Retrieve to a new private local directory and validate before any restore.
FETCH_DIR="$(mktemp -d /run/hirearchy/offhost-restore.XXXXXX)"
chmod 0700 "$FETCH_DIR"
rsync --recursive --times --protect-args \
  -e "ssh -i $SSH_KEY_FILE -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS_FILE" \
  "$BACKUP_HOST:$REMOTE_DIR/$ARCHIVE_NAME" \
  "$BACKUP_HOST:$REMOTE_DIR/$CHECKSUM_NAME" "$FETCH_DIR/"
(cd "$FETCH_DIR" && sha256sum -c "$CHECKSUM_NAME")
gpg --batch --pinentry-mode loopback \
  --passphrase-file /etc/hirearchy/backup-passphrase \
  --decrypt "$FETCH_DIR/$ARCHIVE_NAME" | tar -tzf - > /dev/null
```

Replace the archive placeholder with a real encrypted snapshot path; keep host, key, and known-host files root-only. After transport, compare the remote checksum and test retrieval/decryption. A checksum and decrypt test prove transfer integrity only: independent off-host PostgreSQL/Auth/application restore, readiness, and packet comparison remain untested until performed on an approved independent destination. Keep deletion receipts outside the intake archive and ensure applicable receipts are available before any restored copy receives traffic.

### Restore drill and rollback boundary

The packaged local rehearsal passed on 2026-11-09. The current web artifact was source commit `c97c24375544efeeeedb6458e92bf708bff9f5eb`, image tag `c97c243`, image ID `sha256:ee472b05f167aeb6ce672996e1d7802ae387afa10323e9d00eb61e2c67172eac`. The prior web artifact was source commit `a4d32b7cecc07aff42af873da8e2f5895ef08871`, image tag `a4d32b7cecc07aff42af873da8e2f5895ef08871`, image ID `sha256:e5d720709154b37d4000bb153af0de5f0a11d76645f139582c6b0e77cd3a6212`. With web image c97c243, stopping PostgreSQL returned readiness 503 while app health stayed live; readiness recovered after PostgreSQL restart without restarting web. A separate strict PostgreSQL restore verified role attributes, GoTrue authentication, app readiness, and the assigned reviewer’s finalized packet digest. Prior web image a4d32b7 and current image c97c243 both read the same finalized packet after rollback/roll-forward. The full TLS browser journey passed on image a4d32b7. This is local synthetic-data evidence only; no hosted recovery destination or production recovery acceptance exists.

1. Isolate the failed service at Caddy/firewall while preserving its volumes and backups. Do not run `docker compose down -v`, remove a named volume, or restore over the only database copy.
2. Create a separate recovery project with fresh volumes, unused loopback ports, and the matching PostgreSQL image. Use the protected environment and key versions recorded with that snapshot; adjust only the recovery project name and loopback ports/URLs. Do not run the secret generator for a restore.
3. Restore cluster globals before the custom-format database dump into the isolated instance. Use a fresh compatible PostgreSQL container with a new volume and no staging bootstrap SQL mounted. The only environment passed to this bare database is its original PostgreSQL bootstrap password; do not pass the JWT secret, Ed25519 private key, candidate-token key, or full application environment. PostgreSQL creates its built-in postgres role at initialization. Remove exactly that one statement from globals; awk fails unless exactly one match is removed. Import with ON_ERROR_STOP, restore with --exit-on-error, then compare the saved non-secret role attributes.

   From a root shell, with an encrypted archive, its separate passphrase file, an unused loopback port, and new recovery resources:

   ```sh
   set -euo pipefail
   umask 077
   RESTORE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
   RESTORE_DIR="/run/hirearchy/restore-$RESTORE_ID"
   read -r -p 'Encrypted backup archive path: ' ARCHIVE
   test -f "$ARCHIVE" && test -f "$ARCHIVE.sha256"
   BACKUP_PASSPHRASE_FILE=/etc/hirearchy/backup-passphrase
   test ! -e "$RESTORE_DIR"
   install -d -o root -g root -m 0700 "$RESTORE_DIR"
   (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256")
   gpg --batch --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
     --decrypt "$ARCHIVE" \
     | tar -xz --no-same-owner --no-same-permissions -C "$RESTORE_DIR"
   BACKUP_DIR="$RESTORE_DIR/$(basename "$ARCHIVE" .tar.gpg)"
   (cd "$BACKUP_DIR" && sha256sum -c checksums.sha256)
   RESTORE_POSTGRES_ENV="$RESTORE_DIR/postgres.env"
   RESTORE_PG_CONTAINER="hirearchy-restore-postgres-$RESTORE_ID"
   RESTORE_VOLUME="hirearchy-restore-postgres-data-$RESTORE_ID"
   read -r -p 'Unused recovery PostgreSQL loopback port: ' RECOVERY_PG_PORT
   case "$RECOVERY_PG_PORT" in
     ''|*[!0-9]*) printf 'Port must be a number.\n' >&2; exit 1 ;;
   esac
   if ! node --input-type=module - "$RECOVERY_PG_PORT" <<'NODE'
   import { createServer } from "node:net";
   const port = Number(process.argv[2]);
   if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) process.exit(2);
   const server = createServer();
   server.once("error", () => process.exit(1));
   server.listen(port, "127.0.0.1", () => server.close(() => process.exit(0)));
   NODE
   then
     printf 'Recovery port is invalid or already in use; select an unused loopback port.\n' >&2
     exit 1
   fi
   POSTGRES_IMAGE="$(awk '{print $1}' "$BACKUP_DIR/postgres-image.txt")"
   node --env-file="$BACKUP_DIR/staging.env" --input-type=module -e '
   if (!process.env.POSTGRES_PASSWORD) process.exit(1);
   process.stdout.write("POSTGRES_PASSWORD=" + process.env.POSTGRES_PASSWORD + "\n");
   ' > "$RESTORE_POSTGRES_ENV"
   chmod 0600 "$RESTORE_POSTGRES_ENV"
   docker volume create "$RESTORE_VOLUME"
   docker run -d --name "$RESTORE_PG_CONTAINER" --network host \
     --env-file "$RESTORE_POSTGRES_ENV" \
     --mount "type=volume,src=$RESTORE_VOLUME,dst=/var/lib/postgresql/data" \
     "$POSTGRES_IMAGE" postgres -c listen_addresses=127.0.0.1 \
     -c port="$RECOVERY_PG_PORT" -c password_encryption=scram-sha-256
   for ((attempt = 1; attempt <= 30; attempt++)); do
     if docker exec "$RESTORE_PG_CONTAINER" pg_isready -q \
       -h 127.0.0.1 -p "$RECOVERY_PG_PORT" -U postgres -d postgres; then
       break
     fi
     if [ "$attempt" -eq 30 ]; then
       printf 'Restored PostgreSQL did not become ready within 30 seconds.\n' >&2
       docker logs "$RESTORE_PG_CONTAINER" >&2
       exit 1
     fi
     sleep 1
   done
   awk '
     /^CREATE ROLE postgres;$/ { removed++; next }
     { print }
     END { if (removed != 1) exit 1 }
   ' "$BACKUP_DIR/postgres-globals.sql" > "$RESTORE_DIR/postgres-globals.strict.sql"
   docker exec -i "$RESTORE_PG_CONTAINER" sh -c \
     "export PGPASSWORD=\"\$POSTGRES_PASSWORD\"; exec psql -h 127.0.0.1 -p $RECOVERY_PG_PORT -U postgres -d postgres -v ON_ERROR_STOP=1" \
     < "$RESTORE_DIR/postgres-globals.strict.sql"
   docker exec -i "$RESTORE_PG_CONTAINER" sh -c \
     "export PGPASSWORD=\"\$POSTGRES_PASSWORD\"; exec pg_restore --clean --if-exists --exit-on-error -h 127.0.0.1 -p $RECOVERY_PG_PORT -U postgres -d postgres" \
     < "$BACKUP_DIR/postgres.dump"
   docker exec "$RESTORE_PG_CONTAINER" sh -c \
     "export PGPASSWORD=\"\$POSTGRES_PASSWORD\"; exec psql -h 127.0.0.1 -p $RECOVERY_PG_PORT -U postgres -d postgres -A -t -F '|' -c 'SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls FROM pg_roles ORDER BY rolname'" \
     > "$RESTORE_DIR/role-attributes.restored.txt"
   cmp "$BACKUP_DIR/role-attributes.txt" "$RESTORE_DIR/role-attributes.restored.txt"
   ```

   Keep the source database and snapshot untouched. Only after the strict role/dump restore succeeds, start GoTrue and web in a separate recovery Compose project with the remaining secrets from the snapshot; never pass those secrets to the bare PostgreSQL container.

4. Restore the early-access JSON and Caddy data/config to the recovery project. Keep the same GoTrue JWT secret, Ed25519 signing key/public-key row, and candidate-token encryption key/database binding as the snapshot. Before starting the recovered web service or Caddy, copy the separately retained deletion receipts into a mode-0700 operator directory and replay each receipt against the restored intake volume:

   ```sh
   RECOVERY_OPERATOR_DIR=/run/hirearchy/recovery-operator
   install -d -o root -g root -m 0700 "$RECOVERY_OPERATOR_DIR"
   # Copy only approved receipts from protected custody; do not copy them into the backup archive.
   find "$RECOVERY_OPERATOR_DIR" -maxdepth 1 -type f -name 'delete-*.json' -print
   for RECEIPT in "$RECOVERY_OPERATOR_DIR"/delete-*.json; do
     test -f "$RECEIPT" || continue
     docker compose --env-file "$RECOVERY_ENV_FILE" --project-name "$RECOVERY_PROJECT_NAME" \
       -f "$RECOVERY_COMPOSE_FILE" run --rm --no-deps -T --user 0:0 \
       --volume "$RECOVERY_OPERATOR_DIR:/run/hirearchy/operator:ro" \
       -e EARLY_ACCESS_STORAGE_PATH=/app/data/early-access-requests.json \
       --entrypoint node "$RECOVERY_INTAKE_SERVICE" \
       --experimental-strip-types scripts/manage-early-access-requests.mjs \
       replay --receipt "/run/hirearchy/operator/$(basename "$RECEIPT")" --apply
   done
   ```

   Review only the count-only replay result. Reconcile account revocations or key revocations newer than the snapshot before any traffic is routed. If receipts are missing, fail closed and keep Caddy stopped until the privacy owner resolves the affected-copy inventory.

5. Start the prior application image with the matching restored database snapshot and protected config. Verify liveness, internal readiness, GoTrue health, then sign in as the assigned synthetic reviewer and read the R23 session summary plus the R27 review-packet API. The restored packet must remain FINALIZED at version 2 with the expected snapshot digest before any traffic is routed.
6. Record the snapshot ID, source and prior image IDs, restore result, capability flags, and time-to-restore. Keep the original service and volumes intact until the recovery owner accepts the result.

After the recovery owner accepts the drill, remove only the temporary plaintext restore directory under `/run/hirearchy`; retain the encrypted archive and its checksum under the approved retention policy. Never remove the source database or its original volumes as part of restore cleanup.

Rollback means moving traffic to a prior compatible application image and its matching database snapshot. Do not run arbitrary schema downgrades or point old code at a newer live database without a specifically accepted compatibility result. Keep a protected prior image/archive and matching database, globals, intake, Caddy, and key/config backup before each migration. The local rollback used the matching restored snapshot, recreated only web with the retained a4d32b7 image, then rolled forward to c97c243; both versions were healthy and returned the same FINALIZED packet digest. External-host rollback remains untested.

## 6. Monitoring, incident handling, and key changes

- `scripts/check-staging-readiness.mjs` accepts readiness only when HTTP is 200, the migration matches the target, and all five known markers are true. It bounds the response to 16 KiB, times out after five seconds, and emits only an allowlisted status/marker record. `scripts/run-staging-readiness-check.sh` reads only `APP_PORT` from the root-only environment file, appends mode-0600 JSONL, and exits nonzero for not-ready/unavailable. From the release checkout, run it with `STAGING_ENV_FILE=/etc/hirearchy/staging.env STAGING_READINESS_LOG=/var/log/hirearchy/staging-readiness.jsonl`; the file is a local alert record, not an external notification channel.
- Example `/etc/cron.d/hirearchy-readiness` entry (replace the checkout path); its required `root` user field records each failure in local syslog without including response bodies or secrets. This is a local scheduler template; no remote alert destination or delivery is configured or tested:

  ```cron
  * * * * * root STAGING_ENV_FILE=/etc/hirearchy/staging.env STAGING_READINESS_LOG=/var/log/hirearchy/staging-readiness.jsonl /opt/hirearchy/release/scripts/run-staging-readiness-check.sh >/dev/null || logger -p daemon.warning -t hirearchy-readiness 'Readiness probe failed; inspect the protected JSONL record and service health'
  ```

- Check `docker compose ... ps` and service health after every start/upgrade. Monitor `GET /api/health` for liveness. On Stage B, query `/api/staging/readiness` only through its loopback app port; Caddy intentionally returns `404` for that route. A stopped database returned readiness 503 while liveness stayed healthy, then recovered without restarting web. Monitor disk space, memory, Docker volume growth, Caddy certificate renewal, and backup freshness. No hosted alert destination or monitor owner is configured.
- **Example thresholds only; calibrate against measured host behavior and approve with the named operator before activation:** alert after three consecutive one-minute readiness failures; investigate sustained disk use above 80% or memory above 85%; flag a backup older than the approved backup interval. These values are starting examples, not enforced policy. The local rehearsal verifies one PostgreSQL outage and recovery, not notification delivery or sustained threshold behavior.
- **Resource worksheet:** the `real-docker` run prints a `PACKAGE_RESOURCE_SAMPLE` JSON record in [PR #19](https://github.com/mohamedsaba/hirearchy/pull/19). It contains host CPU/memory/Docker disk, configured per-container limits, an approximately one-second Docker stats sample, duration, the small synthetic workload, and observed project CPU/memory peak. The workload covers fresh preview-to-alpha startup, one synthetic intake, probes, a PostgreSQL outage, and recovery; it has no concurrency or sustained load. Record the final sample and runner image in the PR evidence before using it for planning. It does not establish production capacity, latency, disk-growth rate, or fit for a proposed host.
- Keep Caddy, web, GoTrue, and PostgreSQL logs private. Use `docker compose ... logs --since 15m caddy web web-preview gotrue postgres` for diagnosis; never attach raw logs, exports, environment files, or browser traces to public tickets. Caddy’s native log filter removes the entire request object, including path, query, Referer, and headers; synthetic canaries were absent from both preview and alpha proxy-error logs while 502 context remained. The app logs static error class/code fields, not raw early-access storage or PostgreSQL errors. Backups and GoTrue logs can still contain sensitive information.
- Public intake is capped at 32 KiB and five accepted attempts per 15 minutes in one shared per-process bucket. It does not identify visitors by forwarded IP and stores neither IP nor user-agent; the shared limit can temporarily affect every visitor. These controls do not replace an owner, alert destination, or approved retention policy.
- For suspected exposure, restrict Caddy/network access first, preserve the affected service and encrypted backups, and notify the named incident owner. Do not delete volumes or regenerate secrets during triage. Restore only into an isolated project until the recovery procedure is accepted.
- **Secret custody:** the root-owned environment file is mode 0600 outside the checkout; restrict read access to the named custodian and deployment operator. Generate first-use values only with `scripts/generate-staging-secrets.mjs`; it refuses to overwrite configured secrets and prints no values. Keep database/Auth/signing/candidate-token values out of shell history, CI variables, logs, tickets, and exports. Encrypted snapshots contain the environment file and key material; hold the GPG passphrase separately, and keep off-host transfer credentials and pinned known-hosts files separately at mode 0600.
- **Rotation and disaster recovery:** the generator is for first-time setup only. Proof-key rotation requires adding a new key ID/public key in PostgreSQL, deploying the matching private key, verifying issuance/validation, then revoking the old key. Database role passwords and the GoTrue JWT secret require a reviewed, coordinated service/database procedure. The candidate-token key is database-bound and cannot be replaced independently. Retain the previous secret/config snapshot needed by each encrypted backup; restore matching database, application key versions, and Caddy material together. Do not rotate during incident containment or independently of a restore plan. No hosted rotation rehearsal is accepted; record key IDs and dates, never key values.

## 7. Activation gates

### Founder activation checklist

This preparation task does not authorize hosting, purchases, public activation, real prospect data, or outreach. Keep the service local and synthetic until the founder makes a separate explicit decision. For any later Stage A request, record all of the following before changing bind addresses or routing traffic:

- [ ] Founder approves the specific activation, host and any spend; name the billing owner and operating owner.
- [ ] Privacy/legal reviewer approves the published notice, terms, numeric retention/deletion policy, backup expiry, support contact, and incident contact.
- [ ] Name credential, backup, monitoring, support, and restore custodians; approve key rotation and tested restore access.
- [ ] Approve DNS, TLS ownership, firewall/SSH source ranges, and a separately controlled encrypted backup destination; rehearse retrieval, checksum, decryption, restore, receipt replay, readiness, and rollback there.
- [ ] Review the PR #19 exact-head checks and actual resource sample; size to the chosen host with additional representative load evidence.
- [ ] Confirm public route allow/deny behavior and that public signup, email, live AI, and candidate execution remain disabled.

Before any Stage B access, separately approve the fixed team/VPN CIDRs, named accounts, operator ownership, and the recovery/rollback proof using the selected private host. Until the founder and privacy/legal reviewer explicitly authorize real requests, test intake only with synthetic data.

Before Stage B team access: keep Stage A’s project/volume identity, verify preflight and migration/key binding, use only fixed team/VPN CIDRs, verify the restricted alpha Caddy routes and internal readiness, provision only approved confirmed users through the operator CLI, and validate the full recovery and rollback procedures on an isolated copy. Keep candidate data synthetic until privacy/legal approval. The authenticated staging app does not enable self-service signup, email, AI, code execution, or external-candidate access.

Do not report Stage A/B as hosted-ready or Stage C as available until B’s operational validation and the founder approvals are recorded in [release readiness](../../docs/release-readiness.md).
