import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { readFileSync, readlinkSync } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readlink,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import {
  createExecutor,
  RECIPE,
  RECIPE_DIGEST,
  snapshotDigest,
} from '../../packages/restricted-executor/index.mjs';
import { createPostgresExecutionStore } from '../../packages/restricted-executor/store.mjs';
import { startPostgresFixture } from './postgres-fixture.mjs';

const sourceRoot = process.cwd();
const previousTmpdir = process.env.TMPDIR;
const fixtureSchema = await readFile(
  new URL('../../packages/restricted-executor/schema.sql', import.meta.url),
  'utf8',
);
const fixture = await startPostgresFixture({ schemaSql: fixtureSchema });
process.env.TMPDIR = fixture.root;
const syntheticSecret = `HIREARCHY_SYNTHETIC_SECRET_${randomBytes(24).toString('hex')}`;
const admissionKey = {
  keyId: 'acceptance-key',
  callerId: 'acceptance-caller',
  secret: `HIREARCHY_SYNTHETIC_ADMISSION_KEY_${randomBytes(32).toString('hex')}`,
};
const admissionKeys = [admissionKey];
const ownedContainers = new Map();
const dockerEnv = Object.freeze({
  LANG: 'C.UTF-8',
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  TMPDIR: fixture.root,
});

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function verifyStream(stream) {
  const bytes = Buffer.from(stream.base64, 'base64');
  assert.equal(bytes.toString('base64'), stream.base64);
  assert.equal(stream.byteCount, bytes.byteLength);
  assert.equal(stream.sha256, digest(bytes));
  assert.equal(stream.truncated, stream.observedByteCount > stream.byteCount);
  return bytes;
}

function files(content = 'def test_smoke():\n    assert 2 + 2 == 4\n') {
  return [{ path: 'test_smoke.py', content }];
}

function signRequest(input, options = {}) {
  const { authorization: previous, ...body } = input;
  const issuedAtMs = options.issuedAtMs ?? Date.now();
  const fields = {
    version: 1,
    callerId: options.callerId ?? previous?.callerId ?? admissionKey.callerId,
    keyId: options.keyId ?? previous?.keyId ?? admissionKey.keyId,
    sessionRef: body.sessionRef,
    operationId: options.operationId ?? previous?.operationId,
    requestId: body.requestId,
    generation: options.generation ?? previous?.generation,
    fence: options.fence ?? previous?.fence,
    scenarioRef: body.scenarioRef,
    scenarioVersion: body.scenarioVersion,
    snapshotDigest: body.snapshotDigest,
    recipeId: body.recipeId,
    recipeVersion: body.recipeVersion,
    recipeDigest: body.recipeDigest,
    timeoutMs: body.timeoutMs,
    resources: {
      memoryBytes: body.resources.memoryBytes,
      cpus: body.resources.cpus,
      pids: body.resources.pids,
    },
    outputBytes: body.outputBytes,
    issuedAtMs,
    expiresAtMs: options.expiresAtMs ?? issuedAtMs + 60_000,
  };
  const tag = createHmac('sha256', admissionKey.secret)
    .update(JSON.stringify(fields), 'utf8')
    .digest('hex');
  return { ...body, authorization: { ...fields, tag } };
}

function request(overrides = {}, admissionOverrides = {}) {
  const {
    authorization: previous,
    operationId: overrideOperationId,
    generation: overrideGeneration,
    fence: overrideFence,
    ...bodyOverrides
  } = overrides;
  const snapshot = bodyOverrides.files ?? files();
  const operationId =
    overrideOperationId ??
    admissionOverrides.operationId ??
    previous?.operationId ??
    `operation-${randomUUID()}`;
  const generation =
    overrideGeneration ??
    admissionOverrides.generation ??
    previous?.generation ??
    1;
  const fence =
    overrideFence ?? admissionOverrides.fence ?? previous?.fence ?? 1;
  const body = {
    requestId: `acceptance-${randomUUID()}`,
    sessionRef: 'acceptance-session',
    scenarioRef: RECIPE.scenarioRef,
    scenarioVersion: RECIPE.scenarioVersion,
    files: snapshot,
    snapshotDigest: bodyOverrides.snapshotDigest ?? snapshotDigest(snapshot),
    recipeId: RECIPE.recipeId,
    recipeVersion: RECIPE.recipeVersion,
    recipeDigest: RECIPE_DIGEST,
    timeoutMs: 10_000,
    resources: { memoryBytes: 134_217_728, cpus: 0.25, pids: 16 },
    outputBytes: 8_192,
    ...bodyOverrides,
  };
  return signRequest(
    { ...body, authorization: previous },
    { ...admissionOverrides, operationId, generation, fence },
  );
}

function executor(pool = fixture.runtimePool) {
  return createExecutor({ pool, admissionKeys });
}

async function expectRejectedBeforeDispatch(pool, input) {
  const dockerCalls = [];
  const restoreSpawn = installSpawnPatch((command, args, options, original) => {
    if (command === '/usr/bin/docker') {
      dockerCalls.push([...args]);
      return original('/usr/bin/false', [], options);
    }
    return original(command, args, options);
  });
  try {
    await expectCode(executor(pool).run(input), 'EXECUTION_STORE_UNAVAILABLE');
  } finally {
    restoreSpawn();
  }
  assert.equal(await readEntry(input.requestId), null);
  assert.equal(await readOperation(input.authorization.operationId), null);
  assert.deepEqual(dockerCalls, []);
}

function cleanupEvidence(attempt, overrides = {}) {
  const prepared = attempt.stage === 'prepared';
  return {
    verified: true,
    containerRemoved: true,
    containerId: attempt.containerId,
    containerStatus: prepared ? 'absent' : 'removed',
    lateCreatePossible: false,
    stagingDirectoryRemoved: true,
    dockerClientConfigRemoved: true,
    ...overrides,
  };
}

async function expectCode(promise, expectedCode) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${expectedCode}`);
  assert.equal(caught.code, expectedCode);
  assert.equal(caught.message.includes(admissionKey.secret), false);
  assert.equal(caught.message.includes(fixture.runtimeConfig.password), false);
  return caught;
}

function ownerIdentity() {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const afterCommand = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  return {
    pid: process.pid,
    startTicks: afterCommand[19],
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    pidNamespace: readlinkSync('/proc/self/ns/pid'),
  };
}

async function ownerIsAlive(owner) {
  const current = ownerIdentity();
  if (
    owner?.bootId !== current.bootId ||
    owner?.pidNamespace !== current.pidNamespace
  )
    return null;
  try {
    const stat = readFileSync(`/proc/${owner.pid}/stat`, 'utf8');
    const afterCommand = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return afterCommand[19] === owner.startTicks;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return false;
    return null;
  }
}

function storeIntent(overrides = {}) {
  const requestBody = request(overrides);
  const intent = {
    requestId: requestBody.requestId,
    sessionRef: requestBody.sessionRef,
    scenarioRef: requestBody.scenarioRef,
    scenarioVersion: requestBody.scenarioVersion,
    snapshotDigest: requestBody.snapshotDigest,
    recipeId: requestBody.recipeId,
    recipeVersion: requestBody.recipeVersion,
    recipeDigest: requestBody.recipeDigest,
    timeoutMs: requestBody.timeoutMs,
    resources: requestBody.resources,
    outputBytes: requestBody.outputBytes,
    operationId: requestBody.authorization.operationId,
    generation: requestBody.authorization.generation,
    fence: requestBody.authorization.fence,
    callerId: requestBody.authorization.callerId,
    keyId: requestBody.authorization.keyId,
    admissionVersion: requestBody.authorization.version,
  };
  const intentDigest = digest(JSON.stringify(intent));
  const attemptId = randomUUID().replaceAll('-', '');
  const attempt = {
    attemptId,
    containerName: `hirearchy-executor-codex-${attemptId}`,
    requestLabel: digest(`${intent.requestId}\0${intentDigest}\0${attemptId}`),
    operationLabel: digest(intent.operationId),
    attemptLabel: attemptId,
    stage: 'prepared',
    createAmbiguous: false,
    containerId: null,
  };
  return { intent, intentDigest, attempt };
}

async function reserveStore(store, values, owner = ownerIdentity()) {
  const result = await store.reserve({
    ...values,
    owner,
    ownerIsAlive,
  });
  assert.ok(result.handle);
  return result;
}

async function readEntry(requestId) {
  const { rows } = await fixture.adminPool.query(
    `SELECT request_id, operation_id, generation, fence, state, owner,
            owner_token, attempt, cleanup, receipt, intent_digest
       FROM restricted_executor.requests WHERE request_id = $1`,
    [requestId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    requestId: row.request_id,
    operationId: row.operation_id,
    generation: Number(row.generation),
    fence: Number(row.fence),
    state: row.state,
    owner: row.owner,
    ownerToken: row.owner_token,
    attempt: row.attempt,
    cleanup: row.cleanup,
    receipt: row.receipt,
    intentDigest: row.intent_digest,
  };
}

async function readOperation(operationId) {
  const { rows } = await fixture.adminPool.query(
    'SELECT operation_id FROM restricted_executor.operations WHERE operation_id = $1',
    [operationId],
  );
  return rows[0] ?? null;
}

function quoteFixtureIdentifier(value) {
  assert.match(value, /^[a-z][a-z0-9_]{0,62}$/);
  return `"${value}"`;
}

async function createEquivalentRuntimeRole() {
  const name = `rex_gate_a_${randomUUID().replaceAll('-', '')}`;
  const password = randomBytes(32).toString('base64url');
  const role = quoteFixtureIdentifier(name);
  await fixture.adminPool.query(
    `CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 12`,
  );
  await fixture.adminPool.query(
    `GRANT CONNECT ON DATABASE ${quoteFixtureIdentifier(fixture.database)} TO ${role}`,
  );
  await fixture.adminPool.query(
    `GRANT USAGE ON SCHEMA restricted_executor TO ${role}`,
  );
  await fixture.adminPool.query(
    `GRANT SELECT ON restricted_executor.schema_meta, restricted_executor.request_events, restricted_executor.request_owners TO ${role}`,
  );
  await fixture.adminPool.query(
    `GRANT SELECT, INSERT, UPDATE ON restricted_executor.operations, restricted_executor.requests TO ${role}`,
  );
  const pool = fixture.createRuntimePool(
    `rex-gate-a-${randomUUID().slice(0, 12)}`,
    { user: name, password, max: 1 },
  );
  return { name, password, pool };
}

async function rolePrivilegeSnapshot(roleName) {
  const { rows } = await fixture.adminPool.query(
    `SELECT role.rolcanlogin, role.rolinherit, role.rolsuper, role.rolcreatedb,
            role.rolcreaterole, role.rolreplication, role.rolbypassrls,
            pg_catalog.has_database_privilege($1, current_database(), 'CREATE') AS database_create,
            pg_catalog.has_schema_privilege($1, 'restricted_executor', 'USAGE') AS executor_schema_usage,
            pg_catalog.has_schema_privilege($1, 'restricted_executor', 'CREATE') AS executor_schema_create,
            pg_catalog.has_table_privilege($1, 'restricted_executor.schema_meta', 'SELECT') AS metadata_select,
            pg_catalog.has_table_privilege($1, 'restricted_executor.schema_meta', 'UPDATE') AS metadata_update,
            pg_catalog.has_table_privilege($1, 'restricted_executor.request_events', 'SELECT') AS events_select,
            pg_catalog.has_table_privilege($1, 'restricted_executor.request_owners', 'SELECT') AS owners_select,
            pg_catalog.has_table_privilege($1, 'restricted_executor.requests', 'SELECT') AS requests_select,
            pg_catalog.has_table_privilege($1, 'restricted_executor.requests', 'INSERT') AS requests_insert,
            pg_catalog.has_table_privilege($1, 'restricted_executor.requests', 'UPDATE') AS requests_update,
            pg_catalog.has_table_privilege($1, 'restricted_executor.requests', 'DELETE') AS requests_delete,
            pg_catalog.has_table_privilege($1, 'restricted_executor.operations', 'SELECT') AS operations_select,
            pg_catalog.has_table_privilege($1, 'restricted_executor.operations', 'INSERT') AS operations_insert,
            pg_catalog.has_table_privilege($1, 'restricted_executor.operations', 'UPDATE') AS operations_update,
            pg_catalog.has_table_privilege($1, 'restricted_executor.operations', 'DELETE') AS operations_delete
       FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = $1`,
    [roleName],
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

function executorLabels(attempt) {
  return {
    'com.hirearchy.restricted-executor.request': attempt.requestLabel,
    'com.hirearchy.restricted-executor.operation': attempt.operationLabel,
    'com.hirearchy.restricted-executor.attempt': attempt.attemptLabel,
  };
}

function registerContainer(id, labels) {
  assert.match(id, /^[a-f0-9]{64}$/);
  if (!ownedContainers.has(id)) ownedContainers.set(id, labels);
}

async function cleanupOwnedContainers() {
  const { rows } = await fixture.adminPool.query(
    `SELECT attempt FROM restricted_executor.requests
      WHERE attempt->>'containerId' ~ '^[a-f0-9]{64}$'`,
  );
  for (const { attempt } of rows)
    if (!ownedContainers.has(attempt.containerId))
      registerContainer(attempt.containerId, executorLabels(attempt));
  for (const [id, labels] of ownedContainers) {
    if (await executorContainerExists(id))
      removeOwnedExecutorContainer(id, labels);
  }
}

after(async () => {
  let cleanupFailed = false;
  try {
    await cleanupOwnedContainers();
  } catch {
    cleanupFailed = true;
  }
  process.env.TMPDIR = previousTmpdir;
  try {
    await fixture.close();
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed)
    throw new Error('Restricted executor acceptance cleanup failed.');
});

function docker(args, options = {}) {
  const result = childProcess.spawnSync(
    '/usr/bin/docker',
    [
      '--config',
      fixture.dockerConfig,
      '--host',
      'unix:///var/run/docker.sock',
      ...args,
    ],
    {
      encoding: 'utf8',
      env: dockerEnv,
      maxBuffer: options.maxBuffer ?? 256 * 1024,
      timeout: options.timeoutMs ?? 30_000,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Owned Docker command failed during ${options.phase ?? 'inspection'}.`,
    );
  return result.stdout.trim();
}

function inspectExecutorContainer(id, expectedLabels) {
  assert.match(id, /^[a-f0-9]{64}$/);
  const output = docker(
    [
      'container',
      'inspect',
      '--format',
      '{{.Id}}|{{json .Config.Labels}}|{{json .HostConfig}}|{{json .Mounts}}|{{json .Config.Env}}|{{.Config.User}}|{{json .State}}',
      id,
    ],
    { phase: 'container ownership inspection' },
  );
  const [
    observedId,
    labelsJson,
    hostConfigJson,
    mountsJson,
    envJson,
    user,
    stateJson,
  ] = output.split('|');
  if (observedId !== id)
    throw new Error('Executor container identity changed.');
  let labels;
  let hostConfig;
  let mounts;
  let environment;
  let state;
  try {
    labels = JSON.parse(labelsJson);
    hostConfig = JSON.parse(hostConfigJson);
    mounts = JSON.parse(mountsJson);
    environment = JSON.parse(envJson);
    state = JSON.parse(stateJson);
  } catch {
    throw new Error('Executor container inspection is invalid.');
  }
  if (
    !labels ||
    Object.keys(labels).length !== Object.keys(expectedLabels).length ||
    Object.entries(expectedLabels).some(([key, value]) => labels[key] !== value)
  ) {
    throw new Error('Executor container ownership mismatch.');
  }
  return { id, labels, hostConfig, mounts, environment, user, state };
}

async function executorContainerExists(id) {
  assert.match(id, /^[a-f0-9]{64}$/);
  const output = docker(
    [
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      `id=${id}`,
      '--format',
      '{{.ID}}',
    ],
    { phase: 'exact container presence inspection' },
  );
  return output.split('\n').includes(id);
}

function removeOwnedExecutorContainer(id, expectedLabels) {
  inspectExecutorContainer(id, expectedLabels);
  docker(['container', 'rm', '--force', id], { phase: 'owned cleanup' });
  if (executorContainerExistsSync(id))
    throw new Error('Executor container remains after cleanup.');
}

function executorContainerExistsSync(id) {
  assert.match(id, /^[a-f0-9]{64}$/);
  const output = docker(
    [
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      `id=${id}`,
      '--format',
      '{{.ID}}',
    ],
    { phase: 'exact cleanup verification' },
  );
  return output.split('\n').includes(id);
}

function listOwnedExecutorContainers(attempt) {
  const args = ['container', 'ls', '--all', '--no-trunc'];
  for (const [key, value] of Object.entries(executorLabels(attempt))) {
    args.push('--filter', `label=${key}=${value}`);
  }
  args.push('--format', '{{.ID}}');
  const output = docker(args, { phase: 'owned container listing' });
  return output ? output.split('\n') : [];
}

const storeModuleUrl = new URL(
  '../../packages/restricted-executor/store.mjs',
  import.meta.url,
).href;
const executorModuleUrl = new URL(
  '../../packages/restricted-executor/index.mjs',
  import.meta.url,
).href;

const storeChildSource = [
  "import fs from 'node:fs';",
  "import { readFileSync, readlinkSync } from 'node:fs';",
  "import { Pool } from 'pg';",
  `import { createPostgresExecutionStore } from ${JSON.stringify(storeModuleUrl)};`,
  'let inputText = "";',
  'await new Promise((resolve, reject) => {',
  '  const onData = (chunk) => {',
  '    inputText += chunk.toString();',
  '    const newline = inputText.indexOf("\\n");',
  '    if (newline >= 0) { process.stdin.off("data", onData); resolve(); }',
  '  };',
  '  process.stdin.on("data", onData);',
  '  process.stdin.once("error", reject);',
  '});',
  'const input = JSON.parse(inputText.slice(0, inputText.indexOf("\\n")));',
  'const stat = readFileSync("/proc/self/stat", "utf8");',
  'const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\\s+/);',
  'const owner = { pid: process.pid, startTicks: afterCommand[19], bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), pidNamespace: readlinkSync("/proc/self/ns/pid") };',
  'const pool = new Pool(input.database);',
  'let asynchronousDatabaseError;',
  'pool.on("error", (error) => { asynchronousDatabaseError = typeof error?.code === "string" ? error.code : "UNKNOWN"; });',
  'const store = createPostgresExecutionStore({ pool });',
  'const isAlive = async (candidate) => {',
  '  if (candidate.bootId !== owner.bootId || candidate.pidNamespace !== owner.pidNamespace) return null;',
  '  try { const value = readFileSync(`/proc/${candidate.pid}/stat`, "utf8"); const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\\s+/); return fields[19] === candidate.startTicks; }',
  '  catch (error) { return error?.code === "ENOENT" || error?.code === "ESRCH" ? false : null; }',
  '};',
  'let handle;',
  'try {',
  '  const result = await store.reserve({ ...input.values, owner, ownerIsAlive: isAlive });',
  '  handle = result.handle;',
  '  if (input.action === "reserve-exit") { fs.writeFileSync(input.markerPath, JSON.stringify(owner)); process.exit(0); }',
  '  if (input.action === "reserve-hold") { fs.writeFileSync(input.markerPath, JSON.stringify(owner)); await new Promise((resolve) => process.stdin.once("data", resolve)); await store.release(handle); handle = null; }',
  '  process.stdout.write(JSON.stringify(result.receipt ? { receipt: result.receipt } : { state: result.entry.state }));',
  '} catch (error) { process.stdout.write(JSON.stringify({ code: error?.code ?? "ERROR" })); process.exitCode = 1; }',
  'finally { if (handle) await store.release(handle).catch(() => {}); await pool.end().catch(() => {}); }',
  'if (asynchronousDatabaseError) { process.stderr.write(`PostgreSQL pool error ${asynchronousDatabaseError}\\n`); process.exitCode = 1; }',
].join('\n');

function startStoreProcess({ action, markerPath, values }) {
  const child = childProcess.spawn(
    process.execPath,
    ['--input-type=module', '-e', storeChildSource],
    {
      cwd: sourceRoot,
      env: dockerEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const result = new Promise((resolve) => {
    child.once('close', (code, signal) =>
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
  const inputLine =
    JSON.stringify({
      action,
      markerPath,
      values,
      database: {
        ...fixture.runtimeConfig,
        application_name: `rex-child-${randomUUID().slice(0, 12)}`,
        max: 2,
      },
    }) + '\n';
  if (action === 'reserve-hold') child.stdin.write(inputLine);
  else child.stdin.end(inputLine);
  return { child, result };
}

async function waitFor(check, label, timeoutMs = 10_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function legacyDirectorySnapshot(directory, sentinelName) {
  const sentinelPath = join(directory, sentinelName);
  const [directoryInfo, sentinelInfo, entries, bytes] = await Promise.all([
    lstat(directory),
    lstat(sentinelPath),
    readdir(directory),
    readFile(sentinelPath),
  ]);
  assert.equal(directoryInfo.isDirectory(), true);
  assert.equal(sentinelInfo.isFile(), true);
  return {
    directoryMode: directoryInfo.mode & 0o777,
    sentinelMode: sentinelInfo.mode & 0o777,
    entries: entries.sort(),
    sentinelBytes: bytes.byteLength,
    sentinelSha256: digest(bytes),
  };
}

async function expectDenied(sql) {
  const code = await fixture.runtimePool.query(sql).then(
    () => null,
    (error) => error?.code,
  );
  assert.equal(code, '42501');
}

function invokeExecutorChildSource(options = {}) {
  const hooks = [
    "import childProcess from 'node:child_process';",
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { Pool } from 'pg';",
    `import { createExecutor } from ${JSON.stringify(executorModuleUrl)};`,
    'let inputText = "";',
    'for await (const chunk of process.stdin) inputText += chunk;',
    'const input = JSON.parse(inputText);',
    'const pool = new Pool(input.database);',
    'let asynchronousDatabaseError;',
    'pool.on("error", (error) => { asynchronousDatabaseError = typeof error?.code === "string" ? error.code : "UNKNOWN"; });',
    'const originalSpawn = childProcess.spawn;',
    'if (input.createCountPath || input.crashMarkerPath) {',
    '  childProcess.spawn = (command, args, spawnOptions) => {',
    '    if (args.includes("container") && args.includes("create")) {',
    '      if (input.createCountPath) fs.appendFileSync(input.createCountPath, `${process.pid}\\n`);',
    '      const spawned = originalSpawn(command, args, spawnOptions);',
    '      if (input.crashMarkerPath) spawned.once("close", (code, signal) => {',
    '        fs.writeFileSync(input.crashMarkerPath, JSON.stringify({ code, signal }));',
    '        process.kill(process.pid, "SIGSTOP");',
    '      });',
    '      return spawned;',
    '    }',
    '    return originalSpawn(command, args, spawnOptions);',
    '  };',
    '  syncBuiltinESMExports();',
    '}',
    'const executor = createExecutor({ pool, admissionKeys: input.admissionKeys });',
    'try {',
    '  const result = input.action === "reconcile" ? await executor.reconcile(input.request.requestId) : await executor.run(input.request);',
    '  process.stdout.write(JSON.stringify(result));',
    '} catch (error) {',
    '  process.stdout.write(JSON.stringify({ code: error?.code ?? "ERROR" }));',
    '  process.exitCode = 1;',
    '} finally { await pool.end().catch(() => {}); }',
    'if (asynchronousDatabaseError) { process.stderr.write(`PostgreSQL pool error ${asynchronousDatabaseError}\\n`); process.exitCode = 1; }',
  ];
  if (options.sourceLines) hooks.push(...options.sourceLines);
  return hooks.join('\n');
}

function startExecutorProcess(name, input, options = {}) {
  const source = invokeExecutorChildSource(options);
  const child = childProcess.spawn(
    process.execPath,
    ['--input-type=module', '-e', source],
    {
      cwd: sourceRoot,
      detached: options.detached ?? false,
      env: dockerEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const result = new Promise((resolve) => {
    child.once('close', (code, signal) =>
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
  const database = {
    ...fixture.runtimeConfig,
    application_name: `rex-executor-${randomUUID().slice(0, 12)}`,
    max: 4,
  };
  child.stdin.end(
    JSON.stringify({
      database,
      admissionKeys,
      request: input,
      action: options.action,
      createCountPath: options.createCountPath,
      crashMarkerPath: options.crashMarkerPath,
    }),
  );
  assert.equal(
    JSON.stringify(child.spawnargs).includes(database.password),
    false,
  );
  return { child, result, appName: database.application_name };
}

async function createCount(path) {
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean)
      .length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function installSpawnPatch(patch) {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (command, args, spawnOptions) =>
    patch(command, args, spawnOptions, originalSpawn);
  syncBuiltinESMExports();
  return () => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  };
}

function trackCreateOutput(
  originalSpawn,
  command,
  args,
  spawnOptions,
  onCreate,
) {
  const created = originalSpawn(command, args, spawnOptions);
  const stdout = [];
  created.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  created.once('close', (code) => {
    if (code !== 0) return;
    const id = Buffer.concat(stdout).toString('utf8').trim();
    if (/^[a-f0-9]{64}$/.test(id)) onCreate(id);
  });
  return created;
}

function observeExecutorCreate(
  onDockerArgs = () => undefined,
  transformCreateArgs = (args) => args,
) {
  let resolveObservation;
  let rejectObservation;
  let observed = false;
  const observation = new Promise((resolve, reject) => {
    resolveObservation = resolve;
    rejectObservation = reject;
  });
  const restore = installSpawnPatch((command, args, spawnOptions, original) => {
    if (
      command === '/usr/bin/docker' &&
      args.includes('container') &&
      args.includes('create')
    ) {
      const observedArgs = transformCreateArgs([...args]);
      onDockerArgs([...observedArgs]);
      if (observed || !observedArgs)
        return original(command, args, spawnOptions);
      observed = true;
      const labels = labelsFromDockerArgs(observedArgs);
      return trackCreateOutput(
        original,
        command,
        observedArgs,
        spawnOptions,
        (id) => {
          try {
            registerContainer(id, labels);
            resolveObservation(inspectExecutorContainer(id, labels));
          } catch (error) {
            rejectObservation(error);
          }
        },
      );
    }
    if (command === '/usr/bin/docker') onDockerArgs([...args]);
    return original(command, args, spawnOptions);
  });
  return { observation, restore };
}

function labelsFromDockerArgs(args) {
  const labels = {};
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== '--label') continue;
    const assignment = args[index + 1];
    const separator = assignment.indexOf('=');
    if (separator > 0)
      labels[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  return labels;
}

async function waitForFile(path, label) {
  return waitFor(async () => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }, label);
}

test('fixed recipe argument arrays are immutable', () => {
  assert.equal(Object.isFrozen(RECIPE), true);
  assert.equal(Object.isFrozen(RECIPE.argv), true);
  assert.equal(Object.isFrozen(RECIPE.environment), true);
  assert.throws(() => {
    RECIPE.argv[0] = 'sh';
  }, TypeError);
});

test('canonical snapshots are order-independent and reject path escapes and duplicates', () => {
  const input = [
    { path: 'z.py', content: 'z = 1\n' },
    { path: 'a.py', content: 'a = 2\n' },
  ];
  assert.equal(snapshotDigest(input), snapshotDigest([...input].reverse()));
  assert.throws(() => snapshotDigest([{ path: '../escape.py', content: '' }]), {
    code: 'INVALID_SNAPSHOT',
  });
  assert.throws(
    () =>
      snapshotDigest([
        { path: 'a.py', content: '' },
        { path: 'a.py', content: '' },
      ]),
    { code: 'INVALID_SNAPSHOT' },
  );
});

test('PostgreSQL-only simulation: invalid, expired, and tampered admission fails before reservation', async () => {
  const valid = request();
  const tamperedFiles = files('def test_tampered():\n    assert True\n');
  const tamperedSnapshot = {
    ...valid,
    files: tamperedFiles,
    snapshotDigest: snapshotDigest(tamperedFiles),
  };
  const tamperedRecipe = { ...valid, recipeId: 'tampered.recipe' };
  const expired = request(
    {},
    {
      issuedAtMs: Date.now() - 10_000,
      expiresAtMs: Date.now() - 1_000,
    },
  );
  const invalidTag = {
    ...valid,
    authorization: { ...valid.authorization, tag: '0'.repeat(64) },
  };
  const cases = [
    [invalidTag, 'UNAUTHORIZED'],
    [expired, 'UNAUTHORIZED'],
    [request({}, { keyId: 'unknown-key' }), 'UNAUTHORIZED'],
    [tamperedSnapshot, 'UNAUTHORIZED'],
    [tamperedRecipe, 'UNAUTHORIZED'],
    [{ ...valid, files: tamperedFiles }, 'SNAPSHOT_DIGEST_MISMATCH'],
  ];
  const dockerCalls = [];
  const restoreSpawn = installSpawnPatch((command, args, options, original) => {
    if (command === '/usr/bin/docker') dockerCalls.push(args.slice(0, 3));
    return original(command, args, options);
  });
  try {
    for (const [candidate, code] of cases) {
      await expectCode(executor().run(candidate), code);
      assert.equal(await readEntry(candidate.requestId), null);
    }
  } finally {
    restoreSpawn();
  }
  assert.deepEqual(dockerCalls, []);
});

test('PostgreSQL-only simulation: lock-holding session durability is checked independently of readiness', async () => {
  const mixedPool = new Pool({
    ...fixture.runtimeConfig,
    application_name: `rex-mixed-session-${randomUUID().slice(0, 12)}`,
    max: 2,
  });
  mixedPool.on('error', () => {});
  const nativeConnect = mixedPool.connect.bind(mixedPool);
  const readinessClient = await nativeConnect();
  const lockClient = await nativeConnect();
  await readinessClient.query('SET synchronous_commit = on');
  await lockClient.query('SET synchronous_commit = off');
  let lease = 0;
  mixedPool.connect = (...args) => {
    lease += 1;
    if (lease === 1) return Promise.resolve(readinessClient);
    if (lease === 2) return Promise.resolve(lockClient);
    return nativeConnect(...args);
  };
  const input = request();
  const dockerCalls = [];
  const restoreSpawn = installSpawnPatch((command, args, options, original) => {
    if (command === '/usr/bin/docker') dockerCalls.push(args.slice(0, 3));
    return original(command, args, options);
  });
  try {
    assert.equal(
      (
        await readinessClient.query(
          "SELECT current_setting('synchronous_commit') AS value",
        )
      ).rows[0].value,
      'on',
    );
    assert.equal(
      (
        await lockClient.query(
          "SELECT current_setting('synchronous_commit') AS value",
        )
      ).rows[0].value,
      'off',
    );
    await expectCode(
      executor(mixedPool).run(input),
      'EXECUTION_STORE_UNAVAILABLE',
    );
    assert.equal(lease, 2);
    assert.equal(await readEntry(input.requestId), null);
    assert.deepEqual(dockerCalls, []);
  } finally {
    restoreSpawn();
    mixedPool.connect = nativeConnect;
    await mixedPool.end();
  }
});

test('PostgreSQL-only simulation: readiness binds role identity and effective privilege boundaries', async (t) => {
  const runtimeRole = quoteFixtureIdentifier(fixture.appRole);
  const store = createPostgresExecutionStore({ pool: fixture.runtimePool });
  await store.assertReady();
  const correctIdentity = await fixture.runtimePool.query(
    'SELECT current_user, session_user',
  );
  assert.equal(fixture.runtimeConfig.user, fixture.appRole);
  assert.deepEqual(correctIdentity.rows[0], {
    current_user: fixture.appRole,
    session_user: fixture.appRole,
  });
  t.diagnostic(
    `configured runtime user=${fixture.runtimeConfig.user}; serving current_user=${correctIdentity.rows[0].current_user}; session_user=${correctIdentity.rows[0].session_user}`,
  );

  const runtimePrivileges = await rolePrivilegeSnapshot(fixture.appRole);
  assert.equal(runtimePrivileges.rolinherit, false);
  const schemaName = `rex_gate_a_${randomUUID().replaceAll('-', '')}`;
  const schema = quoteFixtureIdentifier(schemaName);
  const table = `${schema}.relation_probe`;
  const sequence = `${schema}.sequence_probe`;
  let schemaCreated = false;
  let equivalentRole;
  let roleSwitchPool;
  try {
    equivalentRole = await createEquivalentRuntimeRole();
    assert.notEqual(equivalentRole.name, fixture.appRole);
    assert.deepEqual(
      await rolePrivilegeSnapshot(equivalentRole.name),
      runtimePrivileges,
    );
    const configuredRole = equivalentRole.pool.options.user;
    const servingIdentity = await equivalentRole.pool.query(
      'SELECT current_user, session_user',
    );
    assert.deepEqual(servingIdentity.rows[0], {
      current_user: equivalentRole.name,
      session_user: equivalentRole.name,
    });
    t.diagnostic(
      `configured alternate user=${configuredRole}; serving current_user=${servingIdentity.rows[0].current_user}; session_user=${servingIdentity.rows[0].session_user}`,
    );
    await expectCode(
      createPostgresExecutionStore({ pool: equivalentRole.pool }).assertReady(),
      'EXECUTION_STORE_UNAVAILABLE',
    );

    await expectRejectedBeforeDispatch(equivalentRole.pool, request());

    await fixture.adminPool.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    await fixture.adminPool.query(`CREATE TABLE ${table} (id integer)`);
    await fixture.adminPool.query(`CREATE SEQUENCE ${sequence}`);

    const rejectGrant = async (grant, revoke, verifyDispatch = false) => {
      await fixture.adminPool.query(grant);
      try {
        await expectCode(store.assertReady(), 'EXECUTION_STORE_UNAVAILABLE');
        if (verifyDispatch)
          await expectRejectedBeforeDispatch(fixture.runtimePool, request());
      } finally {
        await fixture.adminPool.query(revoke);
      }
      await store.assertReady();
    };

    await fixture.adminPool.query(
      `GRANT CREATE ON SCHEMA ${schema} TO ${quoteFixtureIdentifier(equivalentRole.name)}`,
    );
    assert.equal(
      (
        await fixture.adminPool.query(
          "SELECT pg_catalog.has_schema_privilege($1, $2, 'CREATE') AS allowed",
          [equivalentRole.name, schemaName],
        )
      ).rows[0].allowed,
      true,
    );
    await expectCode(
      createPostgresExecutionStore({ pool: equivalentRole.pool }).assertReady(),
      'EXECUTION_STORE_UNAVAILABLE',
    );
    await fixture.adminPool.query(
      `REVOKE CREATE ON SCHEMA ${schema} FROM ${quoteFixtureIdentifier(equivalentRole.name)}`,
    );

    await rejectGrant(
      `GRANT CREATE ON SCHEMA public TO ${runtimeRole}`,
      `REVOKE CREATE ON SCHEMA public FROM ${runtimeRole}`,
    );
    await rejectGrant(
      `GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`,
      `REVOKE USAGE ON SCHEMA ${schema} FROM ${runtimeRole}`,
    );
    await rejectGrant(
      `GRANT CREATE ON SCHEMA ${schema} TO ${runtimeRole}`,
      `REVOKE CREATE ON SCHEMA ${schema} FROM ${runtimeRole}`,
    );
    await rejectGrant(
      `GRANT SELECT ON ${table} TO ${runtimeRole}`,
      `REVOKE SELECT ON ${table} FROM ${runtimeRole}`,
      true,
    );
    await rejectGrant(
      `GRANT USAGE ON SEQUENCE ${sequence} TO ${runtimeRole}`,
      `REVOKE USAGE ON SEQUENCE ${sequence} FROM ${runtimeRole}`,
    );
    for (const privilege of ['INSERT', 'UPDATE', 'REFERENCES']) {
      await rejectGrant(
        `GRANT ${privilege} (singleton) ON restricted_executor.schema_meta TO ${runtimeRole}`,
        `REVOKE ${privilege} (singleton) ON restricted_executor.schema_meta FROM ${runtimeRole}`,
      );
    }
    await rejectGrant(
      `REVOKE SELECT ON restricted_executor.operations FROM ${runtimeRole}`,
      `GRANT SELECT ON restricted_executor.operations TO ${runtimeRole}`,
    );

    await fixture.adminPool.query(
      `GRANT CREATE ON SCHEMA ${schema} TO ${quoteFixtureIdentifier(equivalentRole.name)}`,
    );
    await fixture.adminPool.query(
      `GRANT ${quoteFixtureIdentifier(equivalentRole.name)} TO ${runtimeRole}`,
    );
    assert.equal(
      (
        await fixture.adminPool.query(
          "SELECT pg_catalog.pg_has_role($1, $2, 'MEMBER') AS member, pg_catalog.has_schema_privilege($1, $3, 'CREATE') AS inherited_create",
          [fixture.appRole, equivalentRole.name, schemaName],
        )
      ).rows[0].member,
      true,
    );
    assert.equal(
      (
        await fixture.adminPool.query(
          "SELECT pg_catalog.has_schema_privilege($1, $2, 'CREATE') AS allowed",
          [fixture.appRole, schemaName],
        )
      ).rows[0].allowed,
      false,
    );
    await expectCode(store.assertReady(), 'EXECUTION_STORE_UNAVAILABLE');

    await fixture.adminPool.query(`ALTER ROLE ${runtimeRole} INHERIT`);
    await fixture.adminPool.query(
      `REVOKE ${quoteFixtureIdentifier(equivalentRole.name)} FROM ${runtimeRole}`,
    );
    await fixture.adminPool.query(
      `GRANT ${quoteFixtureIdentifier(equivalentRole.name)} TO ${runtimeRole}`,
    );
    const inherited = await fixture.adminPool.query(
      `SELECT role.rolinherit,
              pg_catalog.has_schema_privilege(role.rolname, $1, 'CREATE') AS inherited_create
         FROM pg_catalog.pg_roles AS role WHERE role.rolname = $2`,
      [schemaName, fixture.appRole],
    );
    assert.deepEqual(inherited.rows[0], {
      rolinherit: true,
      inherited_create: true,
    });
    await expectCode(store.assertReady(), 'EXECUTION_STORE_UNAVAILABLE');
    await fixture.adminPool.query(`ALTER ROLE ${runtimeRole} NOINHERIT`);
    await expectCode(store.assertReady(), 'EXECUTION_STORE_UNAVAILABLE');

    roleSwitchPool = fixture.createRuntimePool(
      `rex-gate-a-${randomUUID().slice(0, 12)}`,
      {
        user: fixture.appRole,
        password: fixture.runtimeConfig.password,
        max: 1,
      },
    );
    await roleSwitchPool.query(
      `SET ROLE ${quoteFixtureIdentifier(equivalentRole.name)}`,
    );
    const switchedIdentity = await roleSwitchPool.query(
      'SELECT current_user, session_user',
    );
    assert.deepEqual(switchedIdentity.rows[0], {
      current_user: equivalentRole.name,
      session_user: fixture.appRole,
    });
    t.diagnostic(
      `configured SET ROLE pool user=${roleSwitchPool.options.user}; serving current_user=${switchedIdentity.rows[0].current_user}; session_user=${switchedIdentity.rows[0].session_user}`,
    );
    await expectCode(
      createPostgresExecutionStore({ pool: roleSwitchPool }).assertReady(),
      'EXECUTION_STORE_UNAVAILABLE',
    );

    await fixture.adminPool.query(
      `REVOKE ${quoteFixtureIdentifier(equivalentRole.name)} FROM ${runtimeRole}`,
    );
    await store.assertReady();
    const schemaOwner = quoteFixtureIdentifier(fixture.schemaOwner);
    await fixture.adminPool.query(`GRANT ${runtimeRole} TO ${schemaOwner}`);
    try {
      const ownerMembership = await fixture.adminPool.query(
        "SELECT pg_catalog.pg_has_role($1, $2, 'MEMBER') AS member",
        [fixture.schemaOwner, fixture.appRole],
      );
      assert.equal(ownerMembership.rows[0].member, true);
      await expectCode(store.assertReady(), 'EXECUTION_STORE_UNAVAILABLE');
    } finally {
      await fixture.adminPool.query(
        `REVOKE ${runtimeRole} FROM ${schemaOwner}`,
      );
    }
    await store.assertReady();
    const values = storeIntent();
    const reserved = await reserveStore(store, values);
    try {
      const receipt = {
        requestId: values.intent.requestId,
        operationId: values.intent.operationId,
        generation: values.intent.generation,
        fence: values.intent.fence,
        status: 'completed',
      };
      await store.complete(reserved.handle, {
        attempt: reserved.entry.attempt,
        cleanup: cleanupEvidence(reserved.entry.attempt),
        receipt,
      });
    } finally {
      await store.release(reserved.handle);
    }
    assert.equal((await readEntry(values.intent.requestId)).state, 'complete');

    await fixture.adminPool.query(
      `GRANT ${runtimeRole} TO ${quoteFixtureIdentifier(equivalentRole.name)}`,
    );
    await equivalentRole.pool.query(`SET ROLE ${runtimeRole}`);
    const reverseSwitchedIdentity = await equivalentRole.pool.query(
      'SELECT current_user, session_user',
    );
    assert.deepEqual(reverseSwitchedIdentity.rows[0], {
      current_user: fixture.appRole,
      session_user: equivalentRole.name,
    });
    t.diagnostic(
      `configured reverse SET ROLE pool user=${equivalentRole.pool.options.user}; serving current_user=${reverseSwitchedIdentity.rows[0].current_user}; session_user=${reverseSwitchedIdentity.rows[0].session_user}`,
    );
    await expectCode(
      createPostgresExecutionStore({ pool: equivalentRole.pool }).assertReady(),
      'EXECUTION_STORE_UNAVAILABLE',
    );
    await expectRejectedBeforeDispatch(equivalentRole.pool, request());
  } finally {
    if (roleSwitchPool) await roleSwitchPool.end();
    await fixture.adminPool.query(`ALTER ROLE ${runtimeRole} NOINHERIT`);
    if (equivalentRole) {
      const equivalentIdentifier = quoteFixtureIdentifier(equivalentRole.name);
      await fixture.adminPool.query(
        `REVOKE ${equivalentIdentifier} FROM ${runtimeRole}`,
      );
      await fixture.adminPool.query(
        `REVOKE ${runtimeRole} FROM ${equivalentIdentifier}`,
      );
      await equivalentRole.pool.end();
    }
    if (schemaCreated)
      await fixture.adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    if (equivalentRole) {
      const equivalentIdentifier = quoteFixtureIdentifier(equivalentRole.name);
      await fixture.adminPool.query(`DROP OWNED BY ${equivalentIdentifier}`);
      await fixture.adminPool.query(`DROP ROLE ${equivalentIdentifier}`);
    }
  }
  await store.assertReady();
});

test('PostgreSQL-only simulation: runtime role and schema deny elevated access', async (t) => {
  await createPostgresExecutionStore({
    pool: fixture.runtimePool,
  }).assertReady();
  assert.equal(fixture.runtimeConfig.user, 'restricted_executor_runtime');
  const identity = await fixture.runtimePool.query(
    `SELECT current_user, session_user,
            (SELECT version FROM restricted_executor.schema_meta WHERE singleton) AS schema_version`,
  );
  t.diagnostic(
    `configured runtime user=${fixture.runtimeConfig.user}; serving current_user=${identity.rows[0].current_user}; session_user=${identity.rows[0].session_user}`,
  );
  assert.deepEqual(identity.rows[0], {
    current_user: 'restricted_executor_runtime',
    session_user: 'restricted_executor_runtime',
    schema_version: 1,
  });
  const roles = await fixture.adminPool.query(
    `SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
            has_database_privilege(rolname, current_database(), 'CREATE') AS database_create,
            has_schema_privilege(rolname, 'restricted_executor', 'CREATE') AS schema_create
       FROM pg_catalog.pg_roles
      WHERE rolname = ANY($1::text[])
      ORDER BY rolname`,
    [['restricted_executor_owner', 'restricted_executor_runtime']],
  );
  assert.deepEqual(roles.rows, [
    {
      rolname: 'restricted_executor_owner',
      rolcanlogin: false,
      rolinherit: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      database_create: false,
      schema_create: true,
    },
    {
      rolname: 'restricted_executor_runtime',
      rolcanlogin: true,
      rolinherit: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      database_create: false,
      schema_create: false,
    },
  ]);
  const permissions = await fixture.adminPool.query(
    `SELECT
       has_table_privilege($1, 'restricted_executor.schema_meta', 'SELECT') AS meta_select,
       has_table_privilege($1, 'restricted_executor.schema_meta', 'UPDATE') AS meta_update,
       has_table_privilege($1, 'restricted_executor.request_events', 'SELECT') AS events_select,
       has_table_privilege($1, 'restricted_executor.request_events', 'INSERT') AS events_insert,
       has_table_privilege($1, 'restricted_executor.request_owners', 'SELECT') AS owners_select,
       has_table_privilege($1, 'restricted_executor.request_owners', 'DELETE') AS owners_delete,
       has_table_privilege($1, 'restricted_executor.requests', 'INSERT') AS requests_insert,
       has_table_privilege($1, 'restricted_executor.requests', 'UPDATE') AS requests_update,
       has_table_privilege($1, 'restricted_executor.requests', 'DELETE') AS requests_delete,
       has_table_privilege($1, 'restricted_executor.operations', 'INSERT') AS operations_insert,
       has_table_privilege($1, 'restricted_executor.operations', 'UPDATE') AS operations_update,
       has_table_privilege($1, 'restricted_executor.operations', 'TRUNCATE') AS operations_truncate`,
    ['restricted_executor_runtime'],
  );
  assert.deepEqual(permissions.rows[0], {
    meta_select: true,
    meta_update: false,
    events_select: true,
    events_insert: false,
    owners_select: true,
    owners_delete: false,
    requests_insert: true,
    requests_update: true,
    requests_delete: false,
    operations_insert: true,
    operations_update: true,
    operations_truncate: false,
  });
  await expectDenied(
    'CREATE TABLE restricted_executor.fixture_forbidden (id integer)',
  );
  await expectDenied(
    `INSERT INTO restricted_executor.request_events
      (request_id, operation_id, generation, fence, event_kind, to_state, attempt_id, stage, create_ambiguous)
      VALUES ('fixture', 'fixture', 1, 1, 'reserved', 'active', '${'0'.repeat(32)}', 'prepared', false)`,
  );
  await expectDenied('DELETE FROM restricted_executor.request_owners');
  await expectDenied('TRUNCATE restricted_executor.requests');
  assert.throws(() => createPostgresExecutionStore({ pool: {} }), {
    code: 'INVALID_CONFIG',
  });
  const noPasswordPool = new Pool({
    ...fixture.runtimeConfig,
    password: '',
  });
  assert.throws(() => createPostgresExecutionStore({ pool: noPasswordPool }), {
    code: 'INVALID_CONFIG',
  });
  await noPasswordPool.end();
  const legacyRoot = join(fixture.root, 'filesystem-journal-must-not-exist');
  assert.throws(
    () =>
      createExecutor({
        pool: fixture.runtimePool,
        admissionKeys,
        stateRoot: legacyRoot,
        journalDirectory: join(legacyRoot, 'journal'),
      }),
    { code: 'INVALID_CONFIG' },
  );
  await assert.rejects(access(legacyRoot), { code: 'ENOENT' });

  const legacy755 = join(fixture.root, 'legacy-state-0755');
  const legacy700 = join(fixture.root, 'legacy-journal-0700');
  const legacySymlink = join(fixture.root, 'legacy-state-symlink');
  const legacySentinel = 'pre-existing-sentinel.bin';
  const sentinelBytes = Buffer.from('fixture-owned legacy sentinel\n');
  for (const [directory, mode] of [
    [legacy755, 0o755],
    [legacy700, 0o700],
  ]) {
    await mkdir(directory, { mode });
    await chmod(directory, mode);
    const sentinelPath = join(directory, legacySentinel);
    await writeFile(sentinelPath, sentinelBytes, { mode: 0o640 });
    await chmod(sentinelPath, 0o640);
  }
  await symlink(legacy700, legacySymlink);
  const legacySymlinkInfoBefore = await lstat(legacySymlink);
  const legacySymlinkTargetBefore = await readlink(legacySymlink);
  assert.equal(legacySymlinkInfoBefore.isSymbolicLink(), true);
  assert.equal(legacySymlinkTargetBefore, legacy700);
  const legacySnapshotsBefore = await Promise.all([
    legacyDirectorySnapshot(legacy755, legacySentinel),
    legacyDirectorySnapshot(legacy700, legacySentinel),
  ]);
  assert.deepEqual(
    legacySnapshotsBefore.map(({ directoryMode }) => directoryMode),
    [0o755, 0o700],
  );
  for (const legacyOptions of [
    { stateRoot: legacy755 },
    { journalDirectory: legacy700 },
    { stateRoot: legacySymlink },
  ]) {
    assert.throws(
      () =>
        createExecutor({
          pool: fixture.runtimePool,
          admissionKeys,
          ...legacyOptions,
        }),
      { code: 'INVALID_CONFIG' },
    );
  }
  assert.throws(() => createExecutor({ admissionKeys }), {
    code: 'INVALID_CONFIG',
  });

  const pathIndependentInput = request();
  const dockerArgv = [];
  const restorePreflightFailure = installSpawnPatch(
    (command, args, options, original) => {
      if (command === '/usr/bin/docker') dockerArgv.push([...args]);
      if (command === '/usr/bin/docker' && args.includes('info')) {
        return original('/usr/bin/false', [], options);
      }
      return original(command, args, options);
    },
  );
  let pathIndependentReceipt;
  try {
    pathIndependentReceipt = await executor(fixture.runtimePool).run(
      pathIndependentInput,
    );
  } finally {
    restorePreflightFailure();
  }
  assert.equal(pathIndependentReceipt.status, 'failed');
  assert.equal(pathIndependentReceipt.failure.classification, 'setup_failed');
  assert.equal(pathIndependentReceipt.cleanup.verified, true);
  const pathIndependentEntry = await readEntry(pathIndependentInput.requestId);
  assert.equal(pathIndependentEntry.state, 'complete');
  assert.deepEqual(pathIndependentEntry.receipt, pathIndependentReceipt);
  assert.equal(
    dockerArgv.filter(
      (args) => args.includes('container') && args.includes('create'),
    ).length,
    0,
  );
  assert.deepEqual(
    await Promise.all([
      legacyDirectorySnapshot(legacy755, legacySentinel),
      legacyDirectorySnapshot(legacy700, legacySentinel),
    ]),
    legacySnapshotsBefore,
  );
  const legacySymlinkInfoAfter = await lstat(legacySymlink);
  assert.equal(legacySymlinkInfoAfter.isSymbolicLink(), true);
  assert.equal(await readlink(legacySymlink), legacySymlinkTargetBefore);
  await rm(legacySymlink, { force: true });
  await rm(legacy755, { recursive: true, force: true });
  await rm(legacy700, { recursive: true, force: true });

  await expectCode(
    executor(fixture.adminPool).run(request()),
    'EXECUTION_STORE_UNAVAILABLE',
  );
});

test('PostgreSQL-only simulation: readiness rejects altered or disabled guards and dangerous grants', async () => {
  const store = createPostgresExecutionStore({ pool: fixture.runtimePool });
  await store.assertReady();

  await fixture.adminPool.query(
    'ALTER TABLE restricted_executor.requests DISABLE TRIGGER requests_guard_write',
  );
  try {
    await expectCode(store.assertReady(), 'EXECUTION_STORE_UNAVAILABLE');
  } finally {
    await fixture.adminPool.query(
      'ALTER TABLE restricted_executor.requests ENABLE TRIGGER requests_guard_write',
    );
  }

  await fixture.adminPool.query(
    'DROP TRIGGER requests_guard_write ON restricted_executor.requests',
  );
  try {
    await expectCode(store.assertReady(), 'EXECUTION_STORE_UNAVAILABLE');
  } finally {
    await fixture.adminPool.query(
      `CREATE TRIGGER requests_guard_write
       BEFORE INSERT OR UPDATE ON restricted_executor.requests
       FOR EACH ROW EXECUTE FUNCTION restricted_executor.guard_request_write()`,
    );
  }

  const functionSource = await fixture.adminPool.query(
    `SELECT pg_catalog.pg_get_functiondef(
       'restricted_executor.guard_request_write()'::regprocedure
     ) AS definition`,
  );
  const originalDefinition = functionSource.rows[0].definition;
  const alteredDefinition = originalDefinition.replace(
    'new execution must start active',
    'acceptance altered guard source',
  );
  assert.notEqual(alteredDefinition, originalDefinition);
  await fixture.adminPool.query(alteredDefinition);
  try {
    await expectCode(store.assertReady(), 'EXECUTION_STORE_UNAVAILABLE');
  } finally {
    await fixture.adminPool.query(originalDefinition);
  }

  for (const [grant, revoke] of [
    [
      'GRANT UPDATE ON restricted_executor.schema_meta TO restricted_executor_runtime',
      'REVOKE UPDATE ON restricted_executor.schema_meta FROM restricted_executor_runtime',
    ],
    [
      'GRANT DELETE ON restricted_executor.request_owners TO restricted_executor_runtime',
      'REVOKE DELETE ON restricted_executor.request_owners FROM restricted_executor_runtime',
    ],
    [
      `GRANT CREATE ON DATABASE "${fixture.database}" TO restricted_executor_runtime`,
      `REVOKE CREATE ON DATABASE "${fixture.database}" FROM restricted_executor_runtime`,
    ],
    [
      'GRANT CREATE ON SCHEMA restricted_executor TO restricted_executor_runtime',
      'REVOKE CREATE ON SCHEMA restricted_executor FROM restricted_executor_runtime',
    ],
  ]) {
    await fixture.adminPool.query(grant);
    try {
      await expectCode(store.assertReady(), 'EXECUTION_STORE_UNAVAILABLE');
    } finally {
      await fixture.adminPool.query(revoke);
    }
    await store.assertReady();
  }
});

test('PostgreSQL-only simulation: prepared to creating to created persists and replays after process restart', async () => {
  const store = createPostgresExecutionStore({ pool: fixture.runtimePool });
  const values = storeIntent();
  const reserved = await reserveStore(store, values);
  let handle = reserved.handle;
  try {
    assert.equal(reserved.entry.state, 'active');
    assert.equal(reserved.entry.attempt.stage, 'prepared');
    const creating = await store.updateAttempt(handle, {
      stage: 'creating',
      createAmbiguous: true,
    });
    assert.equal(creating.attempt.stage, 'creating');
    assert.equal(creating.attempt.createAmbiguous, true);
    const containerId = 'a'.repeat(64);
    const created = await store.updateAttempt(handle, {
      stage: 'created',
      createAmbiguous: false,
      containerId,
    });
    assert.equal(created.attempt.stage, 'created');
    assert.equal(created.attempt.containerId, containerId);
    const receipt = {
      requestId: values.intent.requestId,
      operationId: values.intent.operationId,
      generation: values.intent.generation,
      fence: values.intent.fence,
      status: 'completed',
      resultMeaning: 'observed_command_result_only',
    };
    const completed = await store.complete(handle, {
      attempt: created.attempt,
      cleanup: cleanupEvidence(created.attempt),
      receipt,
    });
    assert.equal(completed.state, 'complete');
    assert.equal(completed.owner, null);
    assert.equal(completed.ownerToken, null);
    assert.deepEqual(completed.receipt, receipt);
    await expectCode(
      store.complete(handle, {
        attempt: created.attempt,
        cleanup: cleanupEvidence(created.attempt),
        receipt,
      }),
      'EXECUTION_UNKNOWN',
    );
  } finally {
    await store.release(handle).catch(() => undefined);
    handle = null;
  }
  const events = await fixture.adminPool.query(
    `SELECT event_kind, from_state, to_state, stage, container_id
       FROM restricted_executor.request_events
      WHERE request_id = $1 ORDER BY event_id`,
    [values.intent.requestId],
  );
  assert.deepEqual(
    events.rows.map(({ stage }) => stage),
    ['prepared', 'creating', 'created', 'created'],
  );
  assert.deepEqual(
    events.rows.map(({ event_kind }) => event_kind),
    ['reserved', 'attempt_updated', 'attempt_updated', 'state_transition'],
  );
  const replay = startStoreProcess({
    action: 'reserve-replay',
    values: { ...values, attempt: storeIntent().attempt },
  });
  assert.equal(
    JSON.stringify(replay.child.spawnargs).includes(
      fixture.runtimeConfig.password,
    ),
    false,
  );
  const replayed = await replay.result;
  assert.equal(replayed.code, 0, replay.stderr);
  assert.deepEqual(
    JSON.parse(replayed.stdout).receipt,
    (await readEntry(values.intent.requestId)).receipt,
  );
});

test('PostgreSQL-only simulation: duplicate admission from another process is fenced by advisory locks', async () => {
  const values = storeIntent();
  const markerPath = join(fixture.root, `duplicate-${randomUUID()}.ready`);
  const child = startStoreProcess({
    action: 'reserve-hold',
    markerPath,
    values,
  });
  try {
    const childOwner = JSON.parse(
      await waitForFile(markerPath, 'child reservation'),
    );
    assert.equal(await ownerIsAlive(childOwner), true);
    assert.equal(
      JSON.stringify(child.child.spawnargs).includes(
        fixture.runtimeConfig.password,
      ),
      false,
    );
    const store = createPostgresExecutionStore({ pool: fixture.runtimePool });
    await expectCode(
      store.reserve({ ...values, owner: ownerIdentity(), ownerIsAlive }),
      'EXECUTION_IN_PROGRESS',
    );
    const entry = await readEntry(values.intent.requestId);
    assert.equal(entry.state, 'active');
    assert.deepEqual(entry.owner, childOwner);
  } finally {
    child.child.stdin.end('release\n');
    const result = await child.result;
    assert.equal(result.code, 0, result.stderr);
  }
});

test('PostgreSQL-only simulation: changed intent conflicts and higher fences require completion', async () => {
  const store = createPostgresExecutionStore({ pool: fixture.runtimePool });
  const first = storeIntent();
  const reserved = await reserveStore(store, first);
  const receipt = {
    requestId: first.intent.requestId,
    operationId: first.intent.operationId,
    generation: 1,
    fence: 1,
    status: 'completed',
  };
  await store.complete(reserved.handle, {
    attempt: reserved.entry.attempt,
    cleanup: cleanupEvidence(reserved.entry.attempt),
    receipt,
  });
  await store.release(reserved.handle);

  const changed = {
    ...first,
    intent: { ...first.intent, evidenceMarker: 'changed' },
    intentDigest: digest(
      JSON.stringify({ ...first.intent, evidenceMarker: 'changed' }),
    ),
  };
  await expectCode(
    store.reserve({
      ...changed,
      owner: ownerIdentity(),
      ownerIsAlive,
      attempt: storeIntent().attempt,
    }),
    'IDEMPOTENCY_CONFLICT',
  );
  for (const [generation, fence] of [
    [1, 1],
    [2, 1],
    [1, 2],
  ]) {
    const stale = storeIntent({
      requestId: `fence-${randomUUID()}`,
      operationId: first.intent.operationId,
      generation,
      fence,
    });
    await expectCode(
      store.reserve({ ...stale, owner: ownerIdentity(), ownerIsAlive }),
      generation === 1 && fence === 1 ? 'IDEMPOTENCY_CONFLICT' : 'STALE_FENCE',
    );
  }
  const next = storeIntent({
    operationId: first.intent.operationId,
    generation: 2,
    fence: 2,
  });
  const nextReservation = await reserveStore(store, next);
  try {
    const nextReceipt = {
      requestId: next.intent.requestId,
      operationId: next.intent.operationId,
      generation: 2,
      fence: 2,
      status: 'completed',
    };
    await store.complete(nextReservation.handle, {
      attempt: nextReservation.entry.attempt,
      cleanup: cleanupEvidence(nextReservation.entry.attempt),
      receipt: nextReceipt,
    });
  } finally {
    await store.release(nextReservation.handle);
  }
  assert.equal((await readEntry(next.intent.requestId)).state, 'complete');
});

test('PostgreSQL-only simulation: a dead owner stays UNKNOWN until reconciliation', async () => {
  const values = storeIntent();
  const markerPath = join(fixture.root, `stale-owner-${randomUUID()}.ready`);
  const child = startStoreProcess({
    action: 'reserve-exit',
    markerPath,
    values,
  });
  await waitForFile(markerPath, 'child reservation');
  const childResult = await child.result;
  assert.equal(childResult.code, 0, childResult.stderr);
  const row = await readEntry(values.intent.requestId);
  assert.equal(row.state, 'active');
  assert.equal(await ownerIsAlive(row.owner), false);

  const store = createPostgresExecutionStore({ pool: fixture.runtimePool });
  await expectCode(
    store.reserve({ ...values, owner: ownerIdentity(), ownerIsAlive }),
    'EXECUTION_UNKNOWN',
  );
  const claim = await store.claimReconciliation({
    requestId: values.intent.requestId,
    owner: ownerIdentity(),
    ownerIsAlive,
  });
  assert.equal(claim.entry.state, 'reconciling');
  try {
    const finalized = await store.finishReconciliation(claim.handle, {
      attempt: claim.entry.attempt,
      cleanup: cleanupEvidence(claim.entry.attempt, {
        verified: true,
        containerRemoved: true,
        containerStatus: 'absent',
        lateCreatePossible: false,
      }),
    });
    assert.equal(finalized.state, 'unknown');
    assert.equal(finalized.receipt, null);
    assert.equal(finalized.cleanup.verified, true);
    assert.equal(finalized.cleanup.lateCreatePossible, false);
  } finally {
    await store.release(claim.handle);
  }
  await expectCode(
    store.reserve({ ...values, owner: ownerIdentity(), ownerIsAlive }),
    'EXECUTION_UNKNOWN',
  );
  const events = await fixture.adminPool.query(
    `SELECT from_state, to_state FROM restricted_executor.request_events
      WHERE request_id = $1 ORDER BY event_id`,
    [values.intent.requestId],
  );
  assert.deepEqual(
    events.rows.map(({ to_state }) => to_state),
    ['active', 'reconciling', 'unknown'],
  );
});

test('PostgreSQL-only simulation: service restart preserves active, UNKNOWN, and complete records', async () => {
  let serverStopped = false;
  let child;
  const createCountPath = join(
    fixture.root,
    `restart-create-${randomUUID()}.log`,
  );
  const activeValues = storeIntent();
  let reconcilePool;
  let completionPool;
  let receiptReplayPool;

  async function stopDatabase() {
    fixture.stopServer();
    serverStopped = true;
  }
  async function startDatabase() {
    await fixture.startServer();
    serverStopped = false;
  }

  try {
    const markerPath = join(
      fixture.root,
      `restart-owner-${randomUUID()}.ready`,
    );
    child = startStoreProcess({
      action: 'reserve-hold',
      markerPath,
      values: activeValues,
    });
    const childOwner = JSON.parse(
      await waitForFile(markerPath, 'active reservation'),
    );
    assert.equal(await ownerIsAlive(childOwner), true);

    await stopDatabase();
    child.child.kill('SIGKILL');
    const killed = await child.result;
    assert.equal(killed.signal, 'SIGKILL');
    await startDatabase();

    const persistedActive = await readEntry(activeValues.intent.requestId);
    assert.equal(persistedActive.state, 'active');
    assert.equal(persistedActive.receipt, null);
    assert.deepEqual(persistedActive.owner, childOwner);
    assert.equal(await ownerIsAlive(persistedActive.owner), false);
    reconcilePool = fixture.createRuntimePool(
      `rex-reconcile-${randomUUID().slice(0, 12)}`,
    );

    const replay = startExecutorProcess(
      'restart-active-replay',
      request(
        {
          requestId: activeValues.intent.requestId,
          sessionRef: activeValues.intent.sessionRef,
          snapshotDigest: activeValues.intent.snapshotDigest,
          recipeId: activeValues.intent.recipeId,
          recipeVersion: activeValues.intent.recipeVersion,
          recipeDigest: activeValues.intent.recipeDigest,
          timeoutMs: activeValues.intent.timeoutMs,
          resources: activeValues.intent.resources,
          outputBytes: activeValues.intent.outputBytes,
        },
        {
          operationId: activeValues.intent.operationId,
          generation: activeValues.intent.generation,
          fence: activeValues.intent.fence,
        },
      ),
      { createCountPath },
    );
    const replayResult = await replay.result;
    assert.equal(replayResult.code, 1, replayResult.stderr);
    assert.equal(JSON.parse(replayResult.stdout).code, 'EXECUTION_UNKNOWN');
    assert.equal(await createCount(createCountPath), 0);

    const reconciled = await executor(reconcilePool).reconcile(
      activeValues.intent.requestId,
    );
    assert.equal(reconciled.state, 'unknown');
    assert.equal(reconciled.cleanup.verified, true);
    assert.equal(reconciled.cleanup.lateCreatePossible, false);
    assert.equal(
      (await readEntry(activeValues.intent.requestId)).receipt,
      null,
    );

    await reconcilePool.end();
    reconcilePool = null;
    await fixture.restartServer();
    const persistedUnknown = await readEntry(activeValues.intent.requestId);
    assert.equal(persistedUnknown.state, 'unknown');
    assert.equal(persistedUnknown.receipt, null);

    const completedValues = storeIntent();
    completionPool = fixture.createRuntimePool(
      `rex-complete-${randomUUID().slice(0, 12)}`,
    );
    const store = createPostgresExecutionStore({ pool: completionPool });
    const reserved = await reserveStore(store, completedValues);
    const receipt = {
      requestId: completedValues.intent.requestId,
      operationId: completedValues.intent.operationId,
      generation: completedValues.intent.generation,
      fence: completedValues.intent.fence,
      status: 'failed',
      resultMeaning: 'command_not_started',
    };
    try {
      await store.complete(reserved.handle, {
        attempt: reserved.entry.attempt,
        cleanup: cleanupEvidence(reserved.entry.attempt),
        receipt,
      });
    } finally {
      await store.release(reserved.handle).catch(() => undefined);
    }

    await completionPool.end();
    completionPool = null;
    await fixture.restartServer();
    const persistedComplete = await readEntry(completedValues.intent.requestId);
    assert.equal(persistedComplete.state, 'complete');
    assert.deepEqual(persistedComplete.receipt, receipt);
    receiptReplayPool = fixture.createRuntimePool(
      `rex-replay-${randomUUID().slice(0, 12)}`,
    );
    const replayStore = createPostgresExecutionStore({
      pool: receiptReplayPool,
    });
    const replayed = await replayStore.reserve({
      ...completedValues,
      owner: ownerIdentity(),
      ownerIsAlive,
    });
    assert.deepEqual(replayed.receipt, receipt);
  } finally {
    if (child?.child.exitCode === null && child?.child.signalCode === null)
      child.child.kill('SIGKILL');
    if (child) await child.result;
    if (serverStopped) await startDatabase();
    await reconcilePool?.end().catch(() => undefined);
    await completionPool?.end().catch(() => undefined);
    await receiptReplayPool?.end().catch(() => undefined);
  }
});

test('PostgreSQL-only simulation: outages before reservation and before receipt fail closed', async () => {
  const beforeReservation = request();
  const reservationPool = fixture.createRuntimePool(
    `rex-before-${randomUUID().slice(0, 12)}`,
  );
  let completePool = fixture.createRuntimePool(
    `rex-receipt-${randomUUID().slice(0, 12)}`,
  );
  let serverStopped = false;
  let handle;
  let receiptValues;

  try {
    fixture.stopServer();
    serverStopped = true;
    await expectCode(
      executor(reservationPool).run(beforeReservation),
      'EXECUTION_STORE_UNAVAILABLE',
    );
    await fixture.startServer();
    serverStopped = false;
    assert.equal(await readEntry(beforeReservation.requestId), null);

    receiptValues = storeIntent();
    const store = createPostgresExecutionStore({ pool: completePool });
    const reserved = await reserveStore(store, receiptValues);
    handle = reserved.handle;
    fixture.stopServer();
    serverStopped = true;
    await expectCode(
      store.complete(handle, {
        attempt: reserved.entry.attempt,
        cleanup: cleanupEvidence(reserved.entry.attempt),
        receipt: {
          requestId: receiptValues.intent.requestId,
          operationId: receiptValues.intent.operationId,
          generation: receiptValues.intent.generation,
          fence: receiptValues.intent.fence,
          status: 'failed',
          resultMeaning: 'command_not_started',
        },
      }),
      'EXECUTION_STORE_UNAVAILABLE',
    );
    await store.release(handle).catch(() => undefined);
    handle = null;
    await fixture.startServer();
    serverStopped = false;

    const persisted = await readEntry(receiptValues.intent.requestId);
    assert.equal(persisted.state, 'active');
    assert.equal(persisted.receipt, null);
    await completePool.end();
    completePool = fixture.createRuntimePool(
      `rex-receipt-retry-${randomUUID().slice(0, 12)}`,
    );
    await expectCode(
      createPostgresExecutionStore({ pool: completePool }).reserve({
        ...receiptValues,
        owner: ownerIdentity(),
        ownerIsAlive,
      }),
      'EXECUTION_IN_PROGRESS',
    );
  } finally {
    if (handle)
      await createPostgresExecutionStore({ pool: completePool })
        .release(handle)
        .catch(() => undefined);
    if (serverStopped) await fixture.startServer();
    await reservationPool.end().catch(() => undefined);
    await completePool.end().catch(() => undefined);
  }
});

test('real Docker execution is bounded, credential-free, and replays after service and process restart', async (t) => {
  const hostMarker = join(fixture.root, `sandbox-host-marker-${randomUUID()}`);
  const createCountPath = join(
    fixture.root,
    `sandbox-create-count-${randomUUID()}`,
  );
  let databasePool = fixture.createRuntimePool(
    `rex-sandbox-${randomUUID().slice(0, 12)}`,
  );
  const input = request({
    files: files(
      [
        'import os',
        'import socket',
        'import subprocess',
        'from pathlib import Path',
        '',
        'def test_secret_not_inherited():',
        '    assert "HIREARCHY_SYNTHETIC_SECRET" not in os.environ',
        `    assert ${JSON.stringify(syntheticSecret)} not in os.environ.values()`,
        '',
        'def test_kernel_limits_are_applied():',
        '    assert Path("/sys/fs/cgroup/memory.max").read_text().strip() == "134217728"',
        '    assert Path("/sys/fs/cgroup/memory.swap.max").read_text().strip() == "0"',
        '    assert Path("/sys/fs/cgroup/pids.max").read_text().strip() == "16"',
        '',
        'def test_network_is_disabled():',
        '    try:',
        '        socket.create_connection(("1.1.1.1", 80), timeout=0.25)',
        '    except OSError:',
        '        return',
        '    raise AssertionError("network unexpectedly connected")',
        '',
        'def test_host_path_is_not_mounted():',
        `    try: Path(${JSON.stringify(hostMarker)}).write_text("owned")`,
        '    except OSError: return',
        '    raise AssertionError("host path unexpectedly writable")',
        '',
        'def test_root_filesystem_is_read_only():',
        '    try: Path("/etc/hirearchy-executor-write-probe").write_text("owned")',
        '    except OSError: return',
        '    raise AssertionError("root filesystem unexpectedly writable")',
        '',
        'def test_pid_limit_blocks_more_processes():',
        '    children = []',
        '    blocked = False',
        '    try:',
        '        for _ in range(16):',
        '            try:',
        '                children.append(subprocess.Popen(["/bin/sleep", "30"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))',
        '            except OSError:',
        '                blocked = True',
        '                break',
        '        assert blocked, "pid limit did not stop bounded process creation"',
        '    finally:',
        '        for child in children:',
        '            child.terminate()',
        '        for child in children:',
        '            child.wait(timeout=1)',
      ].join('\n'),
    ),
    timeoutMs: 20_000,
    outputBytes: 8_192,
  });
  const dockerArgv = [];
  const createObservation = observeExecutorCreate((args) =>
    dockerArgv.push(args),
  );
  process.env.HIREARCHY_SYNTHETIC_SECRET = syntheticSecret;
  try {
    const receipt = await executor(databasePool).run(input);
    const inspected = await createObservation.observation;
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.resultMeaning, 'observed_command_result_only');
    assert.equal(receipt.isolation.network, 'none');
    assert.equal(receipt.isolation.rootFilesystemReadOnly, true);
    assert.equal(receipt.isolation.memoryBytes, input.resources.memoryBytes);
    assert.equal(receipt.isolation.cpus, input.resources.cpus);
    assert.equal(receipt.isolation.pids, input.resources.pids);
    assert.equal(receipt.cleanup.verified, true);
    assert.equal(receipt.cleanup.containerRemoved, true);
    assert.equal(receipt.cleanup.stagingDirectoryRemoved, true);
    assert.equal(inspected.hostConfig.NetworkMode, 'none');
    assert.equal(inspected.hostConfig.ReadonlyRootfs, true);
    assert.equal(inspected.hostConfig.Memory, input.resources.memoryBytes);
    assert.equal(inspected.hostConfig.NanoCpus, 250_000_000);
    assert.equal(inspected.hostConfig.PidsLimit, input.resources.pids);
    assert.deepEqual(inspected.hostConfig.CapDrop, ['ALL']);
    assert.equal(inspected.hostConfig.Privileged, false);
    assert.equal(inspected.user, '65534:65534');
    assert.equal(inspected.hostConfig.Binds?.length ?? 0, 0);
    assert.equal(
      inspected.mounts.some(
        (mount) => mount.Type === 'bind' || mount.Type === 'volume',
      ),
      false,
    );
    assert.ok(
      inspected.hostConfig.SecurityOpt?.includes('no-new-privileges:true'),
    );
    const serializedCredentials = JSON.stringify({
      argv: dockerArgv,
      environment: inspected.environment,
      receipt,
    });
    for (const secret of [
      syntheticSecret,
      admissionKey.secret,
      fixture.runtimeConfig.password,
    ]) {
      assert.equal(serializedCredentials.includes(secret), false);
    }
    assert.equal(
      inspected.environment.some((entry) =>
        /PASSWORD|SECRET|DATABASE_URL/i.test(entry),
      ),
      false,
    );
    assert.equal(receipt.admission.verified, true);
    assert.equal(receipt.cleanup.lateCreatePossible, false);
    verifyStream(receipt.stdout);
    verifyStream(receipt.stderr);
    t.diagnostic(
      `synthetic receipt: ${JSON.stringify({
        requestId: receipt.requestId,
        operationId: receipt.operationId,
        snapshotDigest: receipt.snapshotDigest,
        recipeDigest: receipt.recipeDigest,
        containerId: receipt.isolation.containerId,
        status: receipt.status,
        exitCode: receipt.exitCode,
        resultMeaning: receipt.resultMeaning,
        stdout: {
          byteCount: receipt.stdout.byteCount,
          observedByteCount: receipt.stdout.observedByteCount,
          sha256: receipt.stdout.sha256,
          truncated: receipt.stdout.truncated,
        },
        stderr: {
          byteCount: receipt.stderr.byteCount,
          observedByteCount: receipt.stderr.observedByteCount,
          sha256: receipt.stderr.sha256,
          truncated: receipt.stderr.truncated,
        },
        cleanup: receipt.cleanup,
      })}`,
    );
    assert.equal(
      await executorContainerExists(receipt.isolation.containerId),
      false,
    );
    await assert.rejects(access(hostMarker), { code: 'ENOENT' });
    await assert.rejects(
      access(join(fixture.root, 'restricted-executor-state')),
      { code: 'ENOENT' },
    );
    const persisted = await readEntry(input.requestId);
    assert.equal(persisted.state, 'complete');
    assert.deepEqual(persisted.receipt, receipt);

    await databasePool.end();
    databasePool = null;
    await fixture.restartServer();
    const restartedReplay = startExecutorProcess(
      'sandbox-restart-replay',
      input,
      {
        createCountPath,
      },
    );
    const replayResult = await restartedReplay.result;
    assert.equal(replayResult.code, 0, replayResult.stderr);
    const replayed = JSON.parse(replayResult.stdout);
    assert.deepEqual(replayed, receipt);
    assert.equal(await createCount(createCountPath), 0);
    assert.equal(
      JSON.stringify(restartedReplay.child.spawnargs).includes(
        fixture.runtimeConfig.password,
      ),
      false,
    );
  } finally {
    delete process.env.HIREARCHY_SYNTHETIC_SECRET;
    createObservation.restore();
    await databasePool?.end().catch(() => undefined);
  }
});

test('real Docker execution admits one concurrent request across executor processes', async () => {
  const input = request({
    files: files('def test_concurrent_admission():\n    assert 3 * 7 == 21\n'),
  });
  const createCountPath = join(
    fixture.root,
    `concurrent-create-${randomUUID()}.log`,
  );
  const executions = [
    startExecutorProcess('concurrent-admission-a', input, { createCountPath }),
    startExecutorProcess('concurrent-admission-b', input, { createCountPath }),
  ];
  const results = await Promise.all(executions.map(({ result }) => result));
  const successful = results.filter(({ code }) => code === 0);
  assert.ok(successful.length >= 1);
  for (const result of results.filter(({ code }) => code !== 0)) {
    assert.equal(JSON.parse(result.stdout).code, 'EXECUTION_IN_PROGRESS');
  }
  assert.equal(await createCount(createCountPath), 1);
  const receipt = JSON.parse(successful[0].stdout);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.exitCode, 0);
  assert.deepEqual((await readEntry(input.requestId)).receipt, receipt);
});

test('real Docker nonzero result replays truthfully and rejects a stale fence', async () => {
  const input = request({
    files: files(
      'def test_observed_nonzero():\n    assert False, "synthetic failure"\n',
    ),
  });
  const pool = fixture.createRuntimePool(
    `rex-nonzero-${randomUUID().slice(0, 12)}`,
  );
  const dockerArgv = [];
  const observation = observeExecutorCreate((args) => dockerArgv.push(args));
  try {
    const receipt = await executor(pool).run(input);
    await observation.observation;
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.exitCode, 1);
    assert.equal(receipt.resultMeaning, 'observed_command_result_only');
    assert.equal(receipt.failure.classification, 'workload_nonzero_exit');
    assert.equal(receipt.cleanup.verified, true);
    assert.deepEqual(await executor(pool).run(input), receipt);
    const stale = request(
      {
        requestId: `stale-${randomUUID()}`,
        sessionRef: input.sessionRef,
        files: input.files,
        snapshotDigest: input.snapshotDigest,
        recipeId: input.recipeId,
        recipeVersion: input.recipeVersion,
        recipeDigest: input.recipeDigest,
        timeoutMs: input.timeoutMs,
        resources: input.resources,
        outputBytes: input.outputBytes,
      },
      {
        operationId: input.authorization.operationId,
        generation: input.authorization.generation,
        fence: input.authorization.fence + 1,
      },
    );
    await expectCode(executor(pool).run(stale), 'STALE_FENCE');
    assert.equal(
      dockerArgv.filter(
        (args) => args.includes('container') && args.includes('create'),
      ).length,
      1,
    );
    assert.equal(
      await executorContainerExists(receipt.isolation.containerId),
      false,
    );
  } finally {
    observation.restore();
    await pool.end().catch(() => undefined);
  }
});

test('real Docker timeout produces a durable failed receipt and does not rerun', async () => {
  const input = request({
    files: files('import time\ndef test_timed_work():\n    time.sleep(4)\n'),
    timeoutMs: 1_000,
  });
  const pool = fixture.createRuntimePool(
    `rex-timeout-${randomUUID().slice(0, 12)}`,
  );
  const dockerArgv = [];
  const observation = observeExecutorCreate((args) => dockerArgv.push(args));
  try {
    const receipt = await executor(pool).run(input);
    await observation.observation;
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.timedOut, true);
    assert.equal(receipt.failure.classification, 'timeout');
    assert.equal(receipt.cleanup.verified, true);
    assert.equal(receipt.cleanup.containerRemoved, true);
    assert.deepEqual(await executor(pool).run(input), receipt);
    assert.equal(
      dockerArgv.filter(
        (args) => args.includes('container') && args.includes('create'),
      ).length,
      1,
    );
    assert.equal(
      await executorContainerExists(receipt.isolation.containerId),
      false,
    );
  } finally {
    observation.restore();
    await pool.end().catch(() => undefined);
  }
});

test('real Docker OOM remains bounded and reports only observed resource attribution', async () => {
  const input = request({
    files: files(
      [
        'def test_memory_limit_kills_over_budget_allocation():',
        '    pages = bytearray(256 * 1024 * 1024)',
        '    for offset in range(0, len(pages), 4096):',
        '        pages[offset] = 1',
      ].join('\n'),
    ),
    timeoutMs: 10_000,
  });
  const pool = fixture.createRuntimePool(
    `rex-oom-${randomUUID().slice(0, 12)}`,
  );
  const dockerArgv = [];
  const observation = observeExecutorCreate((args) => dockerArgv.push(args));
  try {
    const receipt = await executor(pool).run(input);
    await observation.observation;
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.exitCode, 137);
    assert.equal(receipt.timedOut, false);
    assert.equal(receipt.failure.classification, 'workload_nonzero_exit');
    assert.equal(receipt.isolation.memoryBytes, input.resources.memoryBytes);
    assert.ok(
      ['cgroup_oom_kill_observed', 'resource_related_unconfirmed'].includes(
        receipt.resourceAttribution.classification,
      ),
    );
    if (
      receipt.resourceAttribution.classification === 'cgroup_oom_kill_observed'
    ) {
      assert.ok(receipt.resourceAttribution.oomEventCounter);
      assert.ok(receipt.resourceAttribution.oomEventCounter.delta.oom_kill > 0);
    }
    assert.equal(receipt.cleanup.verified, true);
    assert.equal(receipt.cleanup.containerRemoved, true);
    assert.deepEqual(await executor(pool).run(input), receipt);
    assert.equal(
      dockerArgv.filter(
        (args) => args.includes('container') && args.includes('create'),
      ).length,
      1,
    );
    assert.equal(
      await executorContainerExists(receipt.isolation.containerId),
      false,
    );
  } finally {
    observation.restore();
    await pool.end().catch(() => undefined);
  }
});

test('real Docker stdout and stderr stay within the shared output byte budget', async () => {
  const input = request({
    files: files(
      [
        'import os',
        'def test_bounded_streams(capsys):',
        '    with capsys.disabled():',
        '        os.write(1, b"stdout-prefix\\n")',
        '        os.write(2, b"stderr-prefix\\n")',
        '        os.write(1, b"A" * 1024)',
        '        os.write(2, b"B" * 8192)',
      ].join('\n'),
    ),
    outputBytes: 2_048,
  });
  const pool = fixture.createRuntimePool(
    `rex-output-${randomUUID().slice(0, 12)}`,
  );
  try {
    const receipt = await executor(pool).run(input);
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.exitCode, 0);
    const stdout = verifyStream(receipt.stdout);
    const stderr = verifyStream(receipt.stderr);
    assert.ok(stdout.byteLength > 0);
    assert.ok(stderr.byteLength > 0);
    assert.ok(stdout.byteLength + stderr.byteLength <= input.outputBytes);
    assert.ok(
      receipt.stdout.observedByteCount + receipt.stderr.observedByteCount >
        input.outputBytes,
    );
    assert.ok(receipt.stdout.truncated || receipt.stderr.truncated);
    assert.equal(receipt.cleanup.verified, true);
    assert.equal(
      await executorContainerExists(receipt.isolation.containerId),
      false,
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
});

test('real Docker work holds admission through a long bounded run', async () => {
  const input = request({
    files: files('import time\ndef test_long_work():\n    time.sleep(7)\n'),
    timeoutMs: 15_000,
  });
  const createCountPath = join(fixture.root, `long-create-${randomUUID()}.log`);
  const first = startExecutorProcess('long-bounded-first', input, {
    createCountPath,
  });
  await waitFor(async () => {
    const entry = await readEntry(input.requestId);
    return entry?.attempt.stage === 'running' ? entry : null;
  }, 'the long bounded run stage');
  const duplicate = startExecutorProcess('long-bounded-duplicate', input, {
    createCountPath,
  });
  const duplicateResult = await duplicate.result;
  assert.equal(duplicateResult.code, 1);
  assert.equal(
    JSON.parse(duplicateResult.stdout).code,
    'EXECUTION_IN_PROGRESS',
  );
  const firstResult = await first.result;
  assert.equal(firstResult.code, 0, firstResult.stderr);
  const receipt = JSON.parse(firstResult.stdout);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.cleanup.verified, true);
  assert.equal(await createCount(createCountPath), 1);
});

test('real Docker startup failure is persisted as a setup failure and replayed', async () => {
  const input = request();
  const pool = fixture.createRuntimePool(
    `rex-startfail-${randomUUID().slice(0, 12)}`,
  );
  const dockerArgv = [];
  const observation = observeExecutorCreate((args) => dockerArgv.push(args));
  let startFailures = 0;
  let restoreFault;
  try {
    restoreFault = installSpawnPatch((command, args, options, original) => {
      if (
        startFailures === 0 &&
        command === '/usr/bin/docker' &&
        args.includes('container') &&
        args.includes('start')
      ) {
        startFailures += 1;
        return original('/usr/bin/false', [], options);
      }
      return original(command, args, options);
    });
    const receipt = await executor(pool).run(input);
    restoreFault();
    restoreFault = null;
    await observation.observation;
    assert.equal(startFailures, 1);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.exitCode, null);
    assert.equal(receipt.resultMeaning, 'command_not_started');
    assert.equal(receipt.failure.classification, 'setup_failed');
    assert.equal(receipt.cleanup.verified, true);
    assert.equal(receipt.cleanup.containerRemoved, true);
    assert.deepEqual(await executor(pool).run(input), receipt);
    assert.equal(
      dockerArgv.filter(
        (args) => args.includes('container') && args.includes('create'),
      ).length,
      1,
    );
    assert.equal(
      await executorContainerExists(receipt.isolation.containerId),
      false,
    );
  } finally {
    restoreFault?.();
    observation.restore();
    await pool.end().catch(() => undefined);
  }
});

test('real Docker client config cleanup failure stays UNKNOWN and never replays as success', async () => {
  const input = request();
  const pool = fixture.createRuntimePool(
    `rex-config-cleanup-${randomUUID().slice(0, 12)}`,
  );
  const dockerArgv = [];
  const observation = observeExecutorCreate((args) => dockerArgv.push(args));
  const originalRm = fs.promises.rm;
  const configPrefix = join(
    fixture.root,
    'hirearchy-executor-codex-docker-config-',
  );
  let createStarted = false;
  let targetedDirectory;
  let created;
  let restoreFault;
  try {
    restoreFault = installSpawnPatch((command, args, options, original) => {
      if (
        command === '/usr/bin/docker' &&
        args.includes('container') &&
        args.includes('create')
      ) {
        createStarted = true;
      }
      return original(command, args, options);
    });
    fs.promises.rm = async (path, options) => {
      if (
        createStarted &&
        !targetedDirectory &&
        typeof path === 'string' &&
        path.startsWith(configPrefix)
      ) {
        targetedDirectory = path;
      }
      if (path === targetedDirectory)
        throw new Error('synthetic Docker client config cleanup failure');
      return originalRm(path, options);
    };
    syncBuiltinESMExports();

    await expectCode(executor(pool).run(input), 'EXECUTION_UNKNOWN');
    created = await observation.observation;
    assert.equal(createStarted, true);
    assert.ok(targetedDirectory);
    assert.ok(targetedDirectory.startsWith(configPrefix));
    await access(targetedDirectory);
    const entry = await readEntry(input.requestId);
    assert.equal(entry.state, 'unknown');
    assert.equal(entry.attempt.stage, 'creating');
    assert.equal(entry.attempt.createAmbiguous, true);
    assert.equal(entry.attempt.containerId, null);
    assert.equal(entry.cleanup.verified, false);
    assert.equal(entry.cleanup.containerRemoved, true);
    assert.equal(entry.cleanup.dockerClientConfigRemoved, false);
    assert.equal(entry.cleanup.lateCreatePossible, true);
    assert.equal(await executorContainerExists(created.id), false);
    await expectCode(executor(pool).run(input), 'EXECUTION_UNKNOWN');
    assert.equal(
      dockerArgv.filter(
        (args) => args.includes('container') && args.includes('create'),
      ).length,
      1,
    );
  } finally {
    restoreFault?.();
    observation.restore();
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
    if (targetedDirectory)
      await originalRm(targetedDirectory, { recursive: true, force: true });
    if (created && (await executorContainerExists(created.id)))
      removeOwnedExecutorContainer(created.id, created.labels);
    await pool.end().catch(() => undefined);
  }
});

test('temporary Docker CLI unavailability during cleanup preserves UNKNOWN until reconciliation', async () => {
  const input = request();
  const pool = fixture.createRuntimePool(
    `rex-cli-outage-${randomUUID().slice(0, 12)}`,
  );
  const dockerArgv = [];
  const observation = observeExecutorCreate((args) => dockerArgv.push(args));
  let cleanupStarted = false;
  let removeAttempted = false;
  let created;
  let restoreFault;
  try {
    restoreFault = installSpawnPatch((command, args, options, original) => {
      if (command !== '/usr/bin/docker')
        return original(command, args, options);
      if (cleanupStarted) return original('/usr/bin/false', [], options);
      if (args.includes('container') && args.includes('rm')) {
        cleanupStarted = true;
        removeAttempted = true;
        return original('/usr/bin/false', [], options);
      }
      return original(command, args, options);
    });

    await expectCode(executor(pool).run(input), 'CLEANUP_FAILED');
    created = await observation.observation;
    assert.equal(cleanupStarted, true);
    assert.equal(removeAttempted, true);
    const entry = await readEntry(input.requestId);
    assert.equal(entry.state, 'unknown');
    assert.equal(entry.cleanup.verified, false);
    assert.equal(entry.cleanup.containerRemoved, false);
    assert.equal(entry.cleanup.dockerClientConfigRemoved, true);
    const present = await inspectExecutorContainer(created.id, created.labels);
    assert.equal(present.id, created.id);
    assert.equal(await executorContainerExists(created.id), true);

    restoreFault();
    restoreFault = null;
    const reconciled = await executor(pool).reconcile(input.requestId);
    assert.equal(reconciled.state, 'unknown');
    assert.equal(reconciled.cleanup.verified, true);
    assert.equal(reconciled.cleanup.containerRemoved, true);
    assert.equal(await executorContainerExists(created.id), false);
    await expectCode(executor(pool).run(input), 'EXECUTION_UNKNOWN');
    assert.equal(
      dockerArgv.filter(
        (args) => args.includes('container') && args.includes('create'),
      ).length,
      1,
    );
  } finally {
    restoreFault?.();
    observation.restore();
    if (created && (await executorContainerExists(created.id)))
      removeOwnedExecutorContainer(created.id, created.labels);
    await pool.end().catch(() => undefined);
  }
});

test('real Docker remove failure persists UNKNOWN until verified reconciliation', async () => {
  const input = request();
  const pool = fixture.createRuntimePool(
    `rex-rmfail-${randomUUID().slice(0, 12)}`,
  );
  const dockerArgv = [];
  const observation = observeExecutorCreate((args) => dockerArgv.push(args));
  let removeAttempts = 0;
  let restoreFault;
  try {
    restoreFault = installSpawnPatch((command, args, options, original) => {
      if (
        command === '/usr/bin/docker' &&
        args.includes('container') &&
        args.includes('rm')
      ) {
        removeAttempts += 1;
        return original('/usr/bin/false', [], options);
      }
      return original(command, args, options);
    });
    await expectCode(executor(pool).run(input), 'CLEANUP_FAILED');
    const created = await observation.observation;
    assert.equal(removeAttempts, 4);
    const unknown = await readEntry(input.requestId);
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.cleanup.verified, false);
    assert.equal(await executorContainerExists(created.id), true);
    assert.deepEqual(
      (await inspectExecutorContainer(created.id, created.labels)).labels,
      created.labels,
    );
    restoreFault();
    restoreFault = null;

    const reconciled = await executor(pool).reconcile(input.requestId);
    assert.equal(reconciled.state, 'unknown');
    assert.equal(reconciled.cleanup.verified, true);
    assert.equal(reconciled.cleanup.containerRemoved, true);
    assert.equal(await executorContainerExists(created.id), false);
    await expectCode(executor(pool).run(input), 'EXECUTION_UNKNOWN');
    assert.equal(
      dockerArgv.filter(
        (args) => args.includes('container') && args.includes('create'),
      ).length,
      1,
    );
  } finally {
    restoreFault?.();
    observation.restore();
    await pool.end().catch(() => undefined);
  }
});

test('real Docker ownership mismatch remains untouched during cleanup and reconciliation', async () => {
  const input = request();
  const pool = fixture.createRuntimePool(
    `rex-owner-mismatch-${randomUUID().slice(0, 12)}`,
  );
  const dockerArgv = [];
  const decoyLabel = digest(randomUUID());
  const observation = observeExecutorCreate(
    (args) => dockerArgv.push(args),
    (args) => {
      const index = args.findIndex((value) =>
        value.startsWith('com.hirearchy.restricted-executor.request='),
      );
      assert.notEqual(index, -1);
      args[index] = `com.hirearchy.restricted-executor.request=${decoyLabel}`;
      return args;
    },
  );
  let created;
  try {
    await expectCode(executor(pool).run(input), 'CLEANUP_FAILED');
    created = await observation.observation;
    assert.equal(
      created.labels['com.hirearchy.restricted-executor.request'],
      decoyLabel,
    );
    assert.equal(await executorContainerExists(created.id), true);
    assert.equal(
      dockerArgv.filter(
        (args) => args.includes('container') && args.includes('rm'),
      ).length,
      0,
    );
    const reconciled = await executor(pool).reconcile(input.requestId);
    assert.equal(reconciled.state, 'unknown');
    assert.equal(reconciled.container.status, 'unverified');
    assert.equal(reconciled.cleanup.verified, false);
    assert.equal(
      dockerArgv.filter(
        (args) => args.includes('container') && args.includes('rm'),
      ).length,
      0,
    );
    assert.equal(
      (await inspectExecutorContainer(created.id, created.labels)).id,
      created.id,
    );
    await expectCode(executor(pool).run(input), 'EXECUTION_UNKNOWN');
  } finally {
    observation.restore();
    if (created && (await executorContainerExists(created.id)))
      removeOwnedExecutorContainer(created.id, created.labels);
    await pool.end().catch(() => undefined);
  }
});

test('a process crash after ambiguous Docker create reconciles only the exact owned container', async () => {
  const input = request();
  const createCountPath = join(
    fixture.root,
    `crash-create-${randomUUID()}.log`,
  );
  const crashMarkerPath = join(
    fixture.root,
    `crash-marker-${randomUUID()}.json`,
  );
  const crashed = startExecutorProcess('crash-after-create', input, {
    crashMarkerPath,
    createCountPath,
    detached: true,
  });
  const reconcilers = [];
  let ownedId;
  let labels;
  try {
    const marker = JSON.parse(
      await waitForFile(crashMarkerPath, 'container create return'),
    );
    assert.equal(marker.code, 0);
    const active = await readEntry(input.requestId);
    assert.equal(active.state, 'active');
    assert.equal(active.attempt.stage, 'creating');
    assert.equal(active.attempt.createAmbiguous, true);
    assert.equal(active.attempt.containerId, null);
    labels = executorLabels(active.attempt);
    const ids = listOwnedExecutorContainers(active.attempt);
    assert.equal(ids.length, 1);
    [ownedId] = ids;
    registerContainer(ownedId, labels);
    const owned = inspectExecutorContainer(ownedId, labels);
    assert.equal(owned.state.Running, false);

    process.kill(-crashed.child.pid, 'SIGKILL');
    const crashedResult = await crashed.result;
    assert.equal(crashedResult.signal, 'SIGKILL');
    assert.equal(await ownerIsAlive(active.owner), false);
    const replayPool = fixture.createRuntimePool(
      `rex-crash-replay-${randomUUID().slice(0, 12)}`,
    );
    try {
      await expectCode(executor(replayPool).run(input), 'EXECUTION_UNKNOWN');
    } finally {
      await replayPool.end();
    }
    assert.equal(await createCount(createCountPath), 1);

    reconcilers.push(
      startExecutorProcess('crash-reconcile-a', input, { action: 'reconcile' }),
      startExecutorProcess('crash-reconcile-b', input, { action: 'reconcile' }),
    );
    const results = await Promise.all(reconcilers.map(({ result }) => result));
    const completed = results.filter(({ code }) => code === 0);
    assert.ok(completed.length >= 1);
    for (const result of results.filter(({ code }) => code !== 0)) {
      assert.equal(JSON.parse(result.stdout).code, 'EXECUTION_IN_PROGRESS');
    }
    for (const result of completed) {
      const reconciliation = JSON.parse(result.stdout);
      assert.equal(reconciliation.state, 'unknown');
      assert.equal(reconciliation.cleanup.lateCreatePossible, true);
    }
    const unknown = await readEntry(input.requestId);
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.receipt, null);
    assert.equal(unknown.cleanup.lateCreatePossible, true);
    assert.equal(await executorContainerExists(ownedId), false);
    const finalPool = fixture.createRuntimePool(
      `rex-crash-final-${randomUUID().slice(0, 12)}`,
    );
    try {
      await expectCode(executor(finalPool).run(input), 'EXECUTION_UNKNOWN');
    } finally {
      await finalPool.end();
    }
    assert.equal(await createCount(createCountPath), 1);
  } finally {
    if (crashed.child.exitCode === null && crashed.child.signalCode === null)
      process.kill(-crashed.child.pid, 'SIGKILL');
    await crashed.result;
    await Promise.all(reconcilers.map(({ result }) => result));
    if (ownedId && labels && (await executorContainerExists(ownedId)))
      removeOwnedExecutorContainer(ownedId, labels);
  }
});

test('a Docker create that arrives late remains UNKNOWN until exact owned cleanup', async () => {
  const input = request();
  const pool = fixture.createRuntimePool(
    `rex-late-create-${randomUUID().slice(0, 12)}`,
  );
  const originalSetTimeout = globalThis.setTimeout;
  let delayedCreate;
  let delayedId;
  let labels;
  let injected = false;
  const restoreTimeout = () => {
    globalThis.setTimeout = originalSetTimeout;
  };
  globalThis.setTimeout = (callback, milliseconds, ...args) =>
    originalSetTimeout(
      callback,
      milliseconds === 10_000 ? 50 : milliseconds,
      ...args,
    );
  const restoreSpawn = installSpawnPatch((command, args, options, original) => {
    if (
      injected ||
      command !== '/usr/bin/docker' ||
      !args.includes('container') ||
      !args.includes('create')
    ) {
      return original(command, args, options);
    }
    injected = true;
    const lateArgs = [...args];
    labels = labelsFromDockerArgs(lateArgs);
    const configIndex = lateArgs.indexOf('--config');
    assert.notEqual(configIndex, -1);
    lateArgs[configIndex + 1] = fixture.dockerConfig;
    delayedCreate = new Promise((resolve, reject) => {
      originalSetTimeout(() => {
        let lateProcess;
        try {
          lateProcess = original(command, lateArgs, {
            ...options,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) {
          reject(error);
          return;
        }
        const stdout = [];
        lateProcess.stdout.on('data', (chunk) =>
          stdout.push(Buffer.from(chunk)),
        );
        lateProcess.once('close', (code, signal) =>
          resolve({
            code,
            signal,
            id: Buffer.concat(stdout).toString('utf8').trim(),
          }),
        );
      }, 2_000);
    });
    return original('/usr/bin/sleep', ['5'], options);
  });

  try {
    await expectCode(executor(pool).run(input), 'EXECUTION_UNKNOWN');
    assert.equal(injected, true);
    const beforeLateCreate = await executor(pool).reconcile(input.requestId);
    assert.equal(beforeLateCreate.state, 'unknown');
    assert.equal(beforeLateCreate.container.status, 'absent');
    assert.equal(beforeLateCreate.cleanup.verified, false);
    assert.equal(beforeLateCreate.cleanup.lateCreatePossible, true);

    const late = await delayedCreate;
    assert.equal(late.code, 0);
    assert.match(late.id, /^[a-f0-9]{64}$/);
    delayedId = late.id;
    registerContainer(delayedId, labels);
    const observed = inspectExecutorContainer(delayedId, labels);
    assert.equal(observed.id, delayedId);

    restoreTimeout();
    const afterLateCreate = await executor(pool).reconcile(input.requestId);
    assert.equal(afterLateCreate.state, 'unknown');
    assert.equal(afterLateCreate.container.status, 'removed');
    assert.equal(afterLateCreate.container.containerId, delayedId);
    assert.equal(afterLateCreate.cleanup.verified, false);
    assert.equal(afterLateCreate.cleanup.containerRemoved, true);
    assert.equal(afterLateCreate.cleanup.lateCreatePossible, true);
    assert.equal(await executorContainerExists(delayedId), false);
    await expectCode(executor(pool).run(input), 'EXECUTION_UNKNOWN');
  } finally {
    restoreTimeout();
    restoreSpawn();
    if (delayedCreate) await delayedCreate;
    if (delayedId && labels && (await executorContainerExists(delayedId)))
      removeOwnedExecutorContainer(delayedId, labels);
    await pool.end().catch(() => undefined);
  }
});

test('database loss during a real running workload leaves UNKNOWN and blocks redispatch', async () => {
  const input = request({
    files: files(
      'import time\ndef test_running_during_database_loss():\n    time.sleep(20)\n',
    ),
    timeoutMs: 30_000,
  });
  const createCountPath = join(
    fixture.root,
    `db-loss-create-${randomUUID()}.log`,
  );
  const child = startExecutorProcess('database-loss-during-run', input, {
    createCountPath,
    detached: true,
  });
  let serverStopped = false;
  let runningEntry;
  let replayPool;
  let reconciliationPool;

  async function startDatabase() {
    await fixture.startServer();
    serverStopped = false;
  }

  try {
    runningEntry = await waitFor(async () => {
      const entry = await readEntry(input.requestId);
      return entry?.attempt.stage === 'running' ? entry : null;
    }, 'real executor running stage');
    assert.equal(runningEntry.state, 'active');
    assert.equal(runningEntry.receipt, null);
    assert.match(runningEntry.attempt.containerId, /^[a-f0-9]{64}$/);
    const labels = executorLabels(runningEntry.attempt);
    registerContainer(runningEntry.attempt.containerId, labels);
    const container = inspectExecutorContainer(
      runningEntry.attempt.containerId,
      labels,
    );
    assert.equal(container.state.Running, true);
    await new Promise((resolve) => setTimeout(resolve, 500));

    fixture.stopServer();
    serverStopped = true;
    process.kill(-child.child.pid, 'SIGKILL');
    const killed = await child.result;
    assert.equal(killed.signal, 'SIGKILL');
    await startDatabase();

    const persisted = await readEntry(input.requestId);
    assert.equal(persisted.state, 'active');
    assert.equal(persisted.attempt.stage, 'running');
    assert.equal(persisted.receipt, null);
    assert.equal(await ownerIsAlive(persisted.owner), false);

    replayPool = fixture.createRuntimePool(
      `rex-db-loss-replay-${randomUUID().slice(0, 12)}`,
    );
    await expectCode(executor(replayPool).run(input), 'EXECUTION_UNKNOWN');
    assert.equal(await createCount(createCountPath), 1);

    reconciliationPool = fixture.createRuntimePool(
      `rex-db-loss-reconcile-${randomUUID().slice(0, 12)}`,
    );
    const reconciled = await executor(reconciliationPool).reconcile(
      input.requestId,
    );
    assert.equal(reconciled.state, 'unknown');
    assert.equal(reconciled.cleanup.verified, true);
    assert.equal(reconciled.cleanup.containerRemoved, true);
    assert.equal(
      await executorContainerExists(runningEntry.attempt.containerId),
      false,
    );
    assert.equal((await readEntry(input.requestId)).receipt, null);
    await expectCode(executor(replayPool).run(input), 'EXECUTION_UNKNOWN');
    assert.equal(await createCount(createCountPath), 1);
  } finally {
    if (child.child.exitCode === null && child.child.signalCode === null) {
      try {
        process.kill(-child.child.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    await child.result;
    if (serverStopped) await startDatabase();
    if (runningEntry?.attempt.containerId) {
      const id = runningEntry.attempt.containerId;
      const labels = executorLabels(runningEntry.attempt);
      if (await executorContainerExists(id))
        removeOwnedExecutorContainer(id, labels);
    }
    await replayPool?.end().catch(() => undefined);
    await reconciliationPool?.end().catch(() => undefined);
  }
});
