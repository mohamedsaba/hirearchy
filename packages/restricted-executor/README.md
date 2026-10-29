# Restricted synthetic executor

This local development component runs the fixed `reservation-moves` `v3` recipe. It has no candidate or production route.

## PostgreSQL setup

The executor requires PostgreSQL as its authoritative durable store. It does not read, create, or fall back to filesystem journals. `createExecutor` accepts exactly `{ pool, admissionKeys }`; `journalDirectory` and `stateRoot` are rejected. `provisionExecutorStateRoot()` remains only as a disabled compatibility export and always fails with `SECURE_STORAGE_UNAVAILABLE`.

Apply the schema manually as an offline database administrator. Runtime startup never creates or migrates schema objects.

Use a dedicated `restricted_executor` database, separate from the Hirearchy application database. Create these roles and the database once, using a privileged provisioning connection:

```sql
CREATE ROLE restricted_executor_owner
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE restricted_executor_runtime
  LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE restricted_executor OWNER restricted_executor_owner;
REVOKE ALL ON DATABASE restricted_executor FROM PUBLIC;
GRANT CONNECT ON DATABASE restricted_executor TO restricted_executor_runtime;
REVOKE CREATE ON DATABASE restricted_executor FROM restricted_executor_runtime;
```

Set the runtime role password with the organization's secret provisioner or an interactive `psql` `\password` command. Do not put a database password in command-line arguments. The schema owner must not be a member of the runtime role, and the runtime role must have no role memberships.

After creating the database, connect to `restricted_executor` as a privileged administrator and remove any default `CREATE` grant on the public schema. PostgreSQL versions before 15 grant it to `PUBLIC` by default:

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

Apply [schema.sql](./schema.sql) as a privileged DDL operator who can `SET ROLE restricted_executor_owner` and create a schema in the dedicated database. Keep the admin password in the configured credential store or a protected `PGPASSFILE`; pass only non-secret connection fields on the command line:

```sh
PGPASSFILE=/run/secrets/restricted-executor-admin.pgpass psql --host=127.0.0.1 --port=5432 --username=restricted_executor_admin --dbname=restricted_executor --set=ON_ERROR_STOP=1 --file=packages/restricted-executor/schema.sql
```

The script creates only the `restricted_executor` namespace and its five tables, guards, and indexes. Runtime receives schema `USAGE`; `SELECT` on metadata, request events, and ownership-token history; and `SELECT`, `INSERT`, and `UPDATE` on requests and operations. It receives no schema `CREATE`, table `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, database `CREATE` or `TEMPORARY`, DDL, role administration, superuser, or `BYPASSRLS` authority. Public-schema `USAGE` is allowed for PostgreSQL's normal setup, but `CREATE` is not. Runtime has no `USAGE` on other user schemas and no access to other user tables, views, or sequences; system catalogs and `information_schema` remain available normally. Readiness checks effective table and column grants, owners, role flags, `NOINHERIT`, memberships, schema version, disabled row security, and the exact enabled trigger/function identities and stored source/definition fingerprint.

Supply a real `pg.Pool` configured with the dedicated runtime user and an explicit nonempty password:

```js
import { Pool } from 'pg';
import { createExecutor } from './index.mjs';

const pool = new Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'restricted_executor',
  user: 'restricted_executor_runtime',
  password: process.env.RESTRICTED_EXECUTOR_PG_PASSWORD,
  max: 2,
});
const executor = createExecutor({ pool, admissionKeys });
```

The executor makes a live readiness query before reservation and reconciliation, then repeats the full readiness check on the exact checked-out session that holds the advisory locks. Both PostgreSQL `session_user` and `current_user` on that actual session must be exactly `restricted_executor_runtime`; a configured pool username alone does not establish the serving identity, and runtime readiness does not use `SET ROLE` to mask it. Every write transaction sets `synchronous_commit` locally to `on` and checks both it and `fsync` before and after its writes. It rejects a missing/uninitialized schema, a different session role, effective destructive/DDL privileges (including unexpected schema, relation, column, or sequence access), altered/disabled guards, disabled PostgreSQL durability settings, or a pool without an explicit password string. PostgreSQL does not expose the authentication method used for an established session, so readiness cannot prove that server `pg_hba.conf` did not accept `trust`; the controlled fixture uses password authentication and tests that boundary. Database and admission credentials stay in the executor process and are never added to Docker argv or the candidate container environment.

`store.mjs` is a privileged internal adapter, not an authentication boundary. It does not authenticate executor requests or verify HMAC admission envelopes; code that can construct it with the runtime pool credentials has write authority over this store. Use `createExecutor` as the supported boundary so request admission is validated before persistence.

## Durable execution and recovery

The request row stores the complete validated execution intent, its canonical digest, request identity, operation generation and fence, owner process identity and unique owner token, attempt ID and ownership labels, state, cleanup evidence, and immutable completed receipt. The operation row stores the current head. A trigger-written append-only event table records state/time, owner-token, and attempt-stage/container changes; it does not duplicate receipt output or admission keys.

The same request ID and intent replay the original completed receipt, including after later generations. Reusing a request ID with changed intent returns `IDEMPOTENCY_CONFLICT`. A new generation must retain the operation’s original caller and session, increase both generation and fence, and is admitted only after the previous generation completed. An active, reconciling, or unknown operation blocks every later generation. Database constraints and triggers prevent identity changes, generation/fence rollback, invalid state transitions, attempt-label replacement, request/operation head mismatch, and any update to a completed receipt.

Admission takes sorted request and operation PostgreSQL session advisory locks and holds them on one checked-out connection from reservation through container cleanup and final persistence. Each transaction verifies the owner token and current state. A database error after reservation never returns success or causes a retry; the persisted incomplete row continues to block dispatch. There is no expiry or TTL takeover.

The stored owner identity is `{ pid, startTicks, bootId, pidNamespace }` plus a fresh random owner token. Reconciliation refuses to race a live same-host process. It may claim an inactive owner only when the same boot ID and PID namespace are present and `/proc` proves the PID/start-tick identity is gone. Unknown or foreign-host liveness fails closed. Advisory locks coordinate requests across PostgreSQL clients and hosts, but process liveness is local: this executor is supported as a single-host runner. If a runner loses its database session while still alive, or another host cannot establish its liveness, the operation stays blocked until the runner exits or separately authorized operational recovery occurs. Reconciliation only removes a verified resource and leaves the execution `unknown`; it never dispatches a workload or creates a completed receipt.

`reconcile(requestId)` inspects only resources carrying the persisted request, operation, and attempt labels (or the recorded immutable container ID), verifies all labels again, then removes by ID. An ambiguous container create remains `unknown` indefinitely: bounded absence checks cannot rule out a late daemon create. A later reconciliation may find and remove a late container while keeping the execution unknown.

## Legacy filesystem journal import

No legacy journal is discovered or imported automatically, and the executor does not accept a legacy path. The filesystem journal was disabled because a same-UID writer could replace directories or change marked records.

There is no import command in this package. Any future importer must be a separately authorized offline operation with this input contract:

- `archiveBytes` containing the complete immutable legacy journal, `expectedArchiveSha256`, and a manifest listing every relative file path, byte length, and SHA-256. Verify the archive hash and every file hash before parsing; reject missing, extra, duplicate, or path-traversal entries.
- A provenance statement binding the source root ID, archive hash, capture time, and record count, signed by an approved offline provenance key; and a separate signed operator authorization binding that same archive hash to the target database and an explicit recovery ticket.
- Full validation of every record: canonical file name to operation ID, request uniqueness, intent digest recomputation, increasing generation/fence, attempt-label consistency, and receipt identity. Preserve complete receipt JSON byte-for-byte only when its request ID, operation ID, generation, and fence match the validated source record. Convert every active, reconciling, or unknown source record to durable `unknown`; never infer completion or permit rerun.
- A single no-overwrite transaction. Any existing request ID, operation generation, or fence conflict aborts the entire import; no `ON CONFLICT UPDATE`, merge, or silent deduplication is allowed. Preserve the original archive, signed provenance, and signed operator authorization as operator-controlled evidence.

Both signatures must use Ed25519 over UTF-8 JSON with fixed property order. The provenance signer covers `{ version: 1, purpose: 'restricted-executor-legacy-capture', sourceRootId, archiveSha256, capturedAt, recordCount }`. The operator signer covers `{ version: 1, purpose: 'restricted-executor-legacy-import', archiveSha256, targetDatabaseIdentity, operatorId, authorizationRef }`. Verify each signature against a separately provisioned offline public-key allowlist; neither signature key belongs in the runtime pool or admission configuration.

The importer must use an offline maintenance authority; the executor runtime role has no import or deletion privileges. Until that separately authorized importer exists, preserve legacy files outside this package and treat them as unadopted evidence.

## Test-lane admission

Configure synthetic keys as `{ keyId, callerId, secret }` entries. Secrets are UTF-8 strings of at least 32 bytes and remain in executor process memory. Each key ID is bound to its configured caller ID. The request's `authorization` field is an exact version 1 envelope:

```js
{
  version: 1,
  callerId, keyId, sessionRef, operationId, requestId, generation, fence,
  scenarioRef, scenarioVersion, snapshotDigest, recipeId, recipeVersion,
  recipeDigest, timeoutMs, resources: { memoryBytes, cpus, pids }, outputBytes,
  issuedAtMs, expiresAtMs, tag
}
```

`requestId` and `sessionRef` also appear at the top level and must match. The envelope binds every request intent field, including the scenario, snapshot, fixed recipe digest, resource limits and output budget. Times are Unix epoch milliseconds; the envelope must be current and live for no more than five minutes. `tag` is lowercase hex HMAC-SHA-256 with the configured key.

The signed bytes are UTF-8 JSON made from a new object in this exact property order, excluding `tag`:

```text
version, callerId, keyId, sessionRef, operationId, requestId, generation,
fence, scenarioRef, scenarioVersion, snapshotDigest, recipeId, recipeVersion,
recipeDigest, timeoutMs, resources:{memoryBytes,cpus,pids}, outputBytes,
issuedAtMs, expiresAtMs
```

The executor rebuilds that object after validation and compares the MAC with `timingSafeEqual`. Missing keys, wrong caller IDs, modified or expired envelopes return `UNAUTHORIZED`. These synthetic local keys do not define the future service-authentication architecture.

## Internal dispatch envelope

`internal-dispatch.mjs` provides a separate in-process boundary for the three test-lane actions. It accepts no network listener or candidate route:

```js
import { createInternalDispatcher } from './internal-dispatch.mjs';

const dispatcher = createInternalDispatcher({
  pool,
  admissionKeys,
  dispatchKeys,
});
const result = await dispatcher.handle({ action, authorization, request });
```

`dispatchKeys` is an array of `{ callerId, keyId, secret }` entries. Each identifier follows the executor's bounded ASCII identifier format; `keyId` is unique, and each UTF-8 secret is 32 to 1,024 bytes. The authorization object has exactly these fields:

```text
{ version: 1, callerId, keyId, sessionRef, requestId, issuedAtMs, expiresAtMs, payloadDigest, tag }
```

`action` is `run`, `lookup`, or `reconcile`. `request` is the complete existing executor request for `run`, and exactly `null` for the other actions. `payloadDigest` is lowercase SHA-256 hex over UTF-8 `JSON.stringify(request)`. The dispatcher first verifies the HMAC envelope, then makes a bounded detached JSON snapshot and checks that snapshot's digest before continuing. The HMAC-SHA-256 input is UTF-8 JSON made from a new object in this exact property order:

```text
version, action, callerId, keyId, sessionRef, requestId, issuedAtMs,
expiresAtMs, payloadDigest
```

`tag` is lowercase hex and is compared with `timingSafeEqual`. `issuedAtMs` cannot be in the future, `expiresAtMs` must be live, and the interval cannot exceed five minutes. The `run` action also requires the existing admission envelope and binds its `callerId`, `requestId`, and `sessionRef` to the dispatch envelope before calling `executor.run`.

For `lookup` and `reconcile`, the dispatcher reads the stored request through a checked-out PostgreSQL session that passes the full runtime readiness checks. It requires both stored intent `callerId` and `sessionRef` to match. Missing and foreign requests share the same `UNAUTHORIZED` response. `lookup` returns `{ state, receipt }`, exposing the receipt only in `complete`; other states, including `active` and `unknown`, remain visible to their authenticated owner. `reconcile` then delegates to the existing conservative executor reconciliation path; it does not run a workload.

These keys and signed caller/session values are synthetic caller assertions. They do not establish end-user or session authorization, do not provide key custody or attestation for production P9, and do not change the executor's single-host development-only support boundary. No production policy or service-authentication decision is implied.

## Separate-process development service

`service.mjs` exposes the same dispatcher over authenticated loopback HTTP. The complete [executor-dispatch-v1 contract](./executor-dispatch-v1.md) specifies startup, wire fields, limits, receipts, retries, and conservative reconciliation. Run its synthetic integration checks with `node --test --test-concurrency=1 tests/restricted-executor/service.test.mjs` using disposable PostgreSQL and Docker resources. This is a development-only, single-host process; distinct-identity credential separation and production isolation remain unverified.

GitHub Actions separately runs the PostgreSQL-only admission checks and the full Docker suites. The full lane requires the pinned `assess-python` image to be available to the runner; it is currently only available locally, so that lane fails until a reviewed, accessible copy of the exact image is provided. The local real-Docker checks are an interim development check, not evidence that GitHub's Docker lane passed.

## Fixed execution boundary

The reviewed image is the locally available
`assess-python@sha256:892c8fa7563e6054fb17fa6a729be7dcbeb87f9268da5533f06bde4a8e8d1b3d`.
Recipe `reservation-moves.pytest`, version `3`, runs
`python3 -B -m pytest -q -p no:cacheprovider`; its digest remains
`1b4e9bcb678e8e83e4cbf8850e593dcd9cd300eb6f3334a53802bbb3001a373a`.
Snapshot files are bounded JSON streamed over stdin to a fixed loader. The
container runs as UID/GID `65534:65534` with no network, a read-only root,
dropped capabilities, `no-new-privileges`, bounded noexec/nosuid/nodev tmpfs
mounts, CPU/memory/PID/time limits, and capped output. Docker isolation checks
fail closed. A zero pytest exit only reports the supplied snapshot's tests; it
is not independent validation or a candidate verdict.

Receipts contain factual command output and capture-byte hashes. For completed
workloads, the executor attempts to read host cgroup v2 `memory.events` before
and after execution. It verifies the owned container ID and labels, a stable
container PID and process start time, the same cgroup path tied to that
container ID, and a unique cgroup v2 mount before pairing the counters. A
successful pair is recorded as
`{ source, baseline, post, delta }` in `resourceAttribution.oomEventCounter`.
Only a positive `oom_kill` delta is classified as
`cgroup_oom_kill_observed`; this records an event in the container cgroup and
does not claim that it caused the recipe process's exit. Missing, unreadable,
changed, or unverified samples remain `null`. In that case exit 137 remains
`resource_related_unconfirmed`. Timed-out workloads do not receive a post
sample because execution may still be running at that point.
