# executor-dispatch-v1

Development-only, single-host protocol. The service accepts authenticated synthetic assertions; this is not end-user authorization, production isolation, or P9 approval. PostgreSQL is the only authoritative execution store. The application must obtain an independently signed admission from its trusted admission authority; admission and database secrets are never returned by the service or supplied to the sandbox. The application adapter is outside this implementation.

## Transport and lifecycle

Start `node packages/restricted-executor/service.mjs /absolute/path/to/config.json`. Configuration is a regular file owned by the service UID with no group/other permission bits, at most 65,536 bytes, and the final component cannot be a symlink. Its exact fields are `host`, `port`, `database`, `admissionKeys`, `dispatchKeys`. `host` must be `127.0.0.1`; `port` is 0–65535 (0 requests an ephemeral port). `database` has exactly `host`, `port`, `database`, `user`, `password`; host must be `127.0.0.1`, port 1–65535 and user `restricted_executor_runtime`. `admissionKeys` and `dispatchKeys` are arrays of `{ callerId, keyId, secret }` described below. Use a dedicated database and the offline setup in [README.md](README.md). The service writes one listener-readiness JSON line `{ "version": "executor-dispatch-v1", "host": "127.0.0.1", "port": <number> }` to stdout. Listener readiness does not prove database availability. Startup errors are generic. Port 0 permits test clients to discover the chosen port.

Send `POST /v1/dispatch` with `Content-Type: application/json`, UTF-8 JSON, and at most 13 MiB of body. No other method, path, or content type is accepted. Responses are JSON with `Cache-Control: no-store` and at most 2 MiB. The server permits four active requests and at most 16 connections, with 5-second header and 15-second request receive limits. SIGTERM/SIGINT stops accepting requests, waits for active requests and closes the database pool; after 120 seconds the process exits. A disconnect or process death does not prove execution stopped: query the authorized operation and reconcile uncertainty. Public bind addresses are rejected. This file mode and same-UID process boundary do not prove OS credential isolation; a distinct unprivileged service identity was not demonstrated.

## Request and authentication

Every request is exactly `{ "action": <action>, "authorization": <dispatch envelope>, "request": <payload> }`. Actions are `run`, `lookup`, and `reconcile`. The latter two require `request: null`; `run` carries the complete object below. The dispatch envelope is exactly:

```text
{ version: 1, callerId, keyId, sessionRef, requestId, issuedAtMs, expiresAtMs, payloadDigest, tag }
```

Identifiers are 1–128 UTF-8 bytes and match `[A-Za-z0-9][A-Za-z0-9._:-]*`. Each configured key ID uniquely maps to a caller; each secret is a 32–1024-byte UTF-8 string. `issuedAtMs` and `expiresAtMs` are safe integer Unix milliseconds. Issue time must not be in the future, expiry must be in the future and later than issue time, and the interval is at most 300,000 ms. Digests and tags are lowercase 64-character hexadecimal strings.

Compute `payloadDigest` as SHA-256 over UTF-8 `JSON.stringify(request)` **after parsing** the JSON request. In particular, object property order and JavaScript JSON number/string serialization matter; the client must reproduce those bytes. For lookup and reconcile this is the SHA-256 of UTF-8 `null`. The dispatch `tag` is HMAC-SHA-256 using the dispatch key over UTF-8 `JSON.stringify` of a new object with precisely this property order:

```text
version, action, callerId, keyId, sessionRef, requestId, issuedAtMs, expiresAtMs, payloadDigest
```

The service verifies the tag in constant time, checks expiry, takes a bounded detached JSON snapshot, then verifies its payload digest. The serialized run payload is limited to 12 MiB plus 64 KiB; its JSON tree is limited to 1,024 nodes, depth 8, 32 fields per object, 128 elements per array, 512 Ki UTF-16 code units per string, and 2,500,000 total UTF-8 string bytes. Unknown keys, forged fields, and missing or foreign owned requests return `UNAUTHORIZED`. Caller and session values are assertions by that caller's synthetic key, not independent proof of a user's authorization. The same caller and session must own lookup/reconciliation and match the admission on run.

## Run and admission

The `run` request has exactly these properties:

```text
requestId, sessionRef, scenarioRef, scenarioVersion, files, snapshotDigest,
recipeId, recipeVersion, recipeDigest, timeoutMs, resources, outputBytes, authorization
```

`files` is an array of 1–128 `{ path, content }` UTF-8 text records. Each path is relative, slash-separated, unique, has no empty, `.` or `..` segments, control characters or backslashes, and is at most 256 UTF-8 bytes; a file cannot be an ancestor of another file. Each content is at most 512 KiB and all contents together at most 2 MiB. Lone UTF-16 surrogates are rejected. For every file compute `[path, lowercase SHA-256 hex of UTF-8 content]`; sort pairs by JavaScript string comparison of path, serialize that pair array with `JSON.stringify`, and SHA-256 its UTF-8 bytes. The lowercase result is `snapshotDigest`. The service recomputes it before execution.

Only `scenarioRef: "reservation-moves"`, `scenarioVersion: "v3"`, `recipeId: "reservation-moves.pytest"`, `recipeVersion: "3"`, and `recipeDigest: "1b4e9bcb678e8e83e4cbf8850e593dcd9cd300eb6f3334a53802bbb3001a373a"` are accepted. The recipe pins image `assess-python@sha256:892c8fa7563e6054fb17fa6a729be7dcbeb87f9268da5533f06bde4a8e8d1b3d` and runs `python3 -B -m pytest -q -p no:cacheprovider`. There is no caller-controlled command, image, mount or environment. A pytest result describes tests in the submitted snapshot, not a hiring verdict.

`timeoutMs` is 1,000–60,000; `outputBytes` is 0–262,144 shared across stdout/stderr; `resources` is exactly `{ memoryBytes, cpus, pids }`, with 134,217,728–536,870,912 bytes, 0.25–1 CPU in 0.25 increments, and 16–64 PIDs. The container has no network, read-only root, unprivileged UID/GID, dropped capabilities and no-new-privileges. `/tmp`, `/workspace`, and `/dev/shm` are each limited to 16 MiB, with noexec, nosuid and nodev protections. Memory swap is limited to the same value as memory. These controls are not a hostile-code production boundary.

The inner `authorization` is independently HMAC-signed using an admission key. Its exact fields, and the exact property order of the signed object excluding `tag`, are:

```text
version, callerId, keyId, sessionRef, operationId, requestId, generation, fence,
scenarioRef, scenarioVersion, snapshotDigest, recipeId, recipeVersion,
recipeDigest, timeoutMs, resources:{memoryBytes,cpus,pids}, outputBytes,
issuedAtMs, expiresAtMs, tag
```

All intent fields must equal the outer request, and caller, session and request ID must equal the dispatch envelope. The inner `version` is 1; identity, secret, timestamp and HMAC rules match the dispatch rules, with its separately configured admission key. `operationId` is an identifier; `generation` and `fence` are positive safe integers. The tag excludes itself from the signed object. No admission key is carried in the request.

## Results, retries and reconciliation

A successful response is `{ "version": "executor-dispatch-v1", "ok": true, "result": ... }`. `run` returns the immutable receipt; `lookup` returns `{ state, receipt }`, with `receipt` null unless `state` is `complete`. States are `active`, `reconciling`, `unknown`, and `complete`. Authorized reconciliation of a completed operation returns `{ requestId, operationId, generation, fence, state: "complete", receipt }`. For an incomplete operation it returns `{ requestId, operationId, generation, fence, state: "unknown", observedAt, attemptId, container: { status, containerId? }, cleanup: { attempted, verified, containerRemoved, lateCreatePossible }, reason }`. Container status is `absent`, `removed`, `present`, `unverified`, or `unavailable`; reason is `ambiguous_create_may_complete_late` or `execution_outcome_remains_unknown`.

A receipt contains `receiptId`, `requestId`, `operationId`, `generation`, `fence`, `admission: { callerId, keyId, verified }`, `sessionRef`, `scenarioRef`, `scenarioVersion`, `snapshotDigest`, `recipeId`, `recipeVersion`, `recipeDigest`, `resultMeaning`, `status`, `startedAt`, `endedAt`, `exitCode`, `timedOut`, `resourceAttribution`, `stdout`, `stderr`, `isolation`, `failure`, and `cleanup`. `status` is `completed` or `failed`; `resultMeaning` is `observed_command_result_only` or `command_not_started`. Failure is null or `{ classification, code? }`, with classifications `cleanup_failed`, `unsupported_isolation`, `setup_failed`, `timeout`, or `workload_nonzero_exit`. Output streams contain `{ base64, byteCount, observedByteCount, truncated, sha256 }`; hashes cover decoded captured bytes, not omitted output. `resourceAttribution` contains `classification` (`cgroup_oom_kill_observed`, `resource_related_unconfirmed`, `not_observed`) and `oomEventCounter`, which is null or `{ source, baseline, post, delta }`. `isolation` records `image`, `containerId`, `network`, `rootFilesystemReadOnly`, `workspace`, `user`, `memoryBytes`, `memorySwapBytes`, `cpus`, `pids`, `capabilities`, `noNewPrivileges`, and `seccomp`. `cleanup` records `verified`, `containerRemoved`, `lateCreatePossible`, `stagingDirectoryRemoved`, and `dockerClientConfigRemoved`.

The same request ID and same intent replay its completed receipt; refreshed valid signatures may be used. Changed intent for an existing request returns `IDEMPOTENCY_CONFLICT`. An operation's next request must retain the original caller and session, increase both generation and fence, and the preceding generation must be complete. A different caller or session receives `UNAUTHORIZED`. An active/reconciling/unknown operation blocks a later generation. Duplicate concurrent calls may return `EXECUTION_IN_PROGRESS`. UNKNOWN is never automatically redispatched, even after verified cleanup. Reconciliation is bounded inspection and exact owned-container cleanup, not a rerun or proof of command outcome; an ambiguous Docker create can remain unknown because a late create is possible. No TTL takeover exists.

Errors are `{ "version": "executor-dispatch-v1", "ok": false, "code": <code> }`; no raw exception, key or credential is returned. `BODY_TOO_LARGE` uses HTTP 413, `SERVICE_BUSY` HTTP 503, `RESPONSE_TOO_LARGE` HTTP 500, and the following use HTTP 400: `UNAUTHORIZED`, `INVALID_REQUEST`, `INVALID_SNAPSHOT`, `SNAPSHOT_DIGEST_MISMATCH`, `UNSUPPORTED_RECIPE`, `IDEMPOTENCY_CONFLICT`, `STALE_FENCE`, `EXECUTION_IN_PROGRESS`, `EXECUTION_UNKNOWN`, `EXECUTION_STORE_UNAVAILABLE`, `CLEANUP_FAILED`, `INTERNAL_ERROR`. A lost response, store failure, internal error, cleanup failure or process death is not evidence that a command did not run; use the same request identity for an authorized lookup and conservative reconciliation. Do not automatically generate a fresh request to bypass uncertainty.
