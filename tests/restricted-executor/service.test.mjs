import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, readFile, symlink, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test, after } from 'node:test';
import {
  RECIPE,
  RECIPE_DIGEST,
  snapshotDigest,
} from '../../packages/restricted-executor/index.mjs';
import { startPostgresFixture } from './postgres-fixture.mjs';

const schemaSql = await readFile(
  new URL('../../packages/restricted-executor/schema.sql', import.meta.url),
  'utf8',
);
const fixture = await startPostgresFixture({ schemaSql });
const admissionKey = {
  callerId: 'service-caller',
  keyId: 'admission',
  secret: randomBytes(32).toString('hex'),
};
const foreignAdmissionKey = {
  callerId: 'foreign-caller',
  keyId: 'foreign-admission',
  secret: randomBytes(32).toString('hex'),
};
const dispatchKey = {
  callerId: 'service-caller',
  keyId: 'dispatch',
  secret: randomBytes(32).toString('hex'),
};
const foreignKey = {
  callerId: 'foreign-caller',
  keyId: 'foreign',
  secret: randomBytes(32).toString('hex'),
};
const configPath = join(fixture.root, 'service.json');
const faultPath = join(fixture.root, 'fault');
let child;
let port;
let stderr = '';

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}
function sign(key, fields) {
  return createHmac('sha256', key.secret)
    .update(JSON.stringify(fields))
    .digest('hex');
}
function request(files, overrides = {}) {
  const body = {
    requestId: `request-${randomUUID()}`,
    sessionRef: 'service-session',
    scenarioRef: RECIPE.scenarioRef,
    scenarioVersion: RECIPE.scenarioVersion,
    files,
    snapshotDigest: snapshotDigest(files),
    recipeId: RECIPE.recipeId,
    recipeVersion: RECIPE.recipeVersion,
    recipeDigest: RECIPE_DIGEST,
    timeoutMs: 20000,
    resources: { memoryBytes: 134217728, cpus: 0.25, pids: 16 },
    outputBytes: 8192,
    ...overrides,
  };
  const issuedAtMs = Date.now();
  const auth = {
    version: 1,
    callerId: admissionKey.callerId,
    keyId: admissionKey.keyId,
    sessionRef: body.sessionRef,
    operationId: `operation-${randomUUID()}`,
    requestId: body.requestId,
    generation: 1,
    fence: 1,
    scenarioRef: body.scenarioRef,
    scenarioVersion: body.scenarioVersion,
    snapshotDigest: body.snapshotDigest,
    recipeId: body.recipeId,
    recipeVersion: body.recipeVersion,
    recipeDigest: body.recipeDigest,
    timeoutMs: body.timeoutMs,
    resources: body.resources,
    outputBytes: body.outputBytes,
    issuedAtMs,
    expiresAtMs: issuedAtMs + 60000,
  };
  return { ...body, authorization: { ...auth, tag: sign(admissionKey, auth) } };
}
function dispatch(
  action,
  value,
  {
    key = dispatchKey,
    requestId = value?.requestId,
    sessionRef = value?.sessionRef ?? 'service-session',
  } = {},
) {
  const issuedAtMs = Date.now();
  const fields = {
    version: 1,
    action,
    callerId: key.callerId,
    keyId: key.keyId,
    sessionRef,
    requestId,
    issuedAtMs,
    expiresAtMs: issuedAtMs + 60000,
    payloadDigest: hash(JSON.stringify(value)),
  };
  const authorization = { ...fields };
  delete authorization.action;
  return {
    action,
    authorization: { ...authorization, tag: sign(key, fields) },
    request: value,
  };
}
async function call(body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(result.version, 'executor-dispatch-v1');
  return result;
}
async function start(host = '127.0.0.1', useFault = false) {
  const {
    host: dbHost,
    port: dbPort,
    database,
    user,
    password,
  } = fixture.runtimeConfig;
  await writeFile(
    configPath,
    JSON.stringify({
      host,
      port: 0,
      database: { host: dbHost, port: dbPort, database, user, password },
      admissionKeys: [admissionKey, foreignAdmissionKey],
      dispatchKeys: [dispatchKey, foreignKey],
    }),
    { mode: 0o600 },
  );
  const service = new URL(
    '../../packages/restricted-executor/service.mjs',
    import.meta.url,
  ).pathname;
  const fault = new URL('./service-fault-inject.mjs', import.meta.url).pathname;
  child = spawn(
    process.execPath,
    [...(useFault ? ['--import', fault] : []), service, configPath],
    {
      env: { ...process.env, REX_FAULT_MARKER: faultPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  if (host !== '127.0.0.1') {
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    child = null;
    return;
  }
  const [chunk] = await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(() => {
      throw new Error('service exited before readiness');
    }),
  ]);
  const ready = JSON.parse(chunk.toString());
  assert.equal(ready.host, '127.0.0.1');
  port = ready.port;
}
async function stop(signal = 'SIGTERM') {
  if (!child) return;
  const old = child;
  child = null;
  if (old.exitCode !== null || old.signalCode !== null) return;
  old.kill(signal);
  await once(old, 'exit');
}
after(async () => {
  await stop();
  await fixture.close();
});

const scenario = new URL(
  '../../docs/scenarios/examples/reservation-moves/',
  import.meta.url,
);
const snapshot = await Promise.all(
  [
    'src/state.py',
    'src/service.py',
    'src/sender.py',
    'tests/test_moves.py',
  ].map(async (path) => ({
    path,
    content: await readFile(new URL(path, scenario), 'utf8'),
  })),
);

test('loopback service performs a real recipe, authenticates ownership, and preserves replay and intent', async () => {
  await start('0.0.0.0');
  await start();
  const run = request(snapshot);
  const input = dispatch('run', run);
  const outcomes = await Promise.all([call(input), call(input)]);
  const completed = outcomes.find((x) => x.ok);
  assert.ok(completed);
  assert.ok(outcomes.every((x) => x.ok || x.code === 'EXECUTION_IN_PROGRESS'));
  const receipt = completed.result;
  assert.equal(receipt.snapshotDigest, run.snapshotDigest);
  assert.equal(receipt.recipeDigest, RECIPE_DIGEST);
  for (const stream of [receipt.stdout, receipt.stderr]) {
    const bytes = Buffer.from(stream.base64, 'base64');
    assert.equal(bytes.length, stream.byteCount);
    assert.equal(hash(bytes), stream.sha256);
  }
  assert.deepEqual((await call(input)).result, receipt);
  assert.deepEqual(
    (await call(dispatch('lookup', null, { requestId: run.requestId }))).result,
    { state: 'complete', receipt },
  );
  const query = await fixture.adminPool.query(
    'SELECT count(*)::int AS count FROM restricted_executor.requests WHERE request_id = $1',
    [run.requestId],
  );
  assert.equal(query.rows[0].count, 1);
  const attempts = await fixture.adminPool.query(
    "SELECT count(*)::int AS count FROM restricted_executor.request_events WHERE request_id = $1 AND event_kind = 'attempt_updated' AND stage = 'creating'",
    [run.requestId],
  );
  assert.equal(attempts.rows[0].count, 1);
  const receiptJson = JSON.stringify(receipt);
  for (const secret of [
    admissionKey.secret,
    foreignAdmissionKey.secret,
    dispatchKey.secret,
    foreignKey.secret,
    fixture.runtimeConfig.password,
  ]) {
    assert.equal(receiptJson.includes(secret), false);
  }
  process.stdout.write(`# synthetic service receipt: ${receiptJson}\n`);
  assert.equal(
    (
      await call(
        dispatch('lookup', null, { key: foreignKey, requestId: run.requestId }),
      )
    ).code,
    'UNAUTHORIZED',
  );
  assert.equal(
    (
      await call(
        dispatch('reconcile', null, {
          sessionRef: 'other-session',
          requestId: run.requestId,
        }),
      )
    ).code,
    'UNAUTHORIZED',
  );
  for (const [key, signer, sessionRef] of [
    [foreignKey, foreignAdmissionKey, run.sessionRef],
    [dispatchKey, admissionKey, 'other-session'],
  ]) {
    const next = request(snapshot, { sessionRef });
    next.authorization.callerId = signer.callerId;
    next.authorization.keyId = signer.keyId;
    next.authorization.operationId = run.authorization.operationId;
    next.authorization.generation = 2;
    next.authorization.fence = 2;
    const signed = { ...next.authorization };
    delete signed.tag;
    next.authorization.tag = sign(signer, signed);
    assert.equal(
      (await call(dispatch('run', next, { key }))).code,
      'UNAUTHORIZED',
    );
  }
  const operationCount = await fixture.adminPool.query(
    'SELECT count(*)::int AS count FROM restricted_executor.requests WHERE operation_id = $1',
    [run.authorization.operationId],
  );
  assert.equal(operationCount.rows[0].count, 1);
  const tampered = structuredClone(input);
  tampered.request.files[0].content += '\n# tamper';
  assert.equal((await call(tampered)).code, 'UNAUTHORIZED');
  const changed = structuredClone(run);
  changed.timeoutMs += 1000;
  changed.authorization.timeoutMs += 1000;
  const auth = { ...changed.authorization };
  delete auth.tag;
  changed.authorization.tag = sign(admissionKey, auth);
  assert.equal(
    (await call(dispatch('run', changed))).code,
    'IDEMPOTENCY_CONFLICT',
  );
  const unsupported = request(snapshot, { recipeVersion: '4' });
  assert.equal(
    (await call(dispatch('run', unsupported))).code,
    'UNSUPPORTED_RECIPE',
  );
  assert.equal(
    (await call(dispatch('run', run, { key: foreignKey }))).code,
    'UNAUTHORIZED',
  );
  assert.equal(
    stderr.includes(admissionKey.secret) ||
      stderr.includes(dispatchKey.secret) ||
      stderr.includes(fixture.runtimeConfig.password),
    false,
  );
});

test('forgery, expiry and malformed requests fail; sandbox does not receive service secrets', async () => {
  const data = request([
    {
      path: 'test_environment.py',
      content:
        'import json, os\ndef test_env(capsys):\n    with capsys.disabled():\n        print(json.dumps(dict(os.environ)))\n',
    },
  ]);
  const input = dispatch('run', data);
  const forged = structuredClone(input);
  forged.authorization.tag = '0'.repeat(64);
  assert.equal((await call(forged)).code, 'UNAUTHORIZED');
  const expired = structuredClone(input);
  expired.authorization.issuedAtMs = Date.now() - 120000;
  expired.authorization.expiresAtMs = Date.now() - 60000;
  const rest = { ...expired.authorization };
  delete rest.tag;
  const { version, ...tail } = rest;
  expired.authorization.tag = sign(dispatchKey, {
    version,
    action: 'run',
    ...tail,
  });
  assert.equal((await call(expired)).code, 'UNAUTHORIZED');
  const action = structuredClone(input);
  action.action = 'lookup';
  action.request = null;
  assert.equal((await call(action)).code, 'UNAUTHORIZED');
  const result = await call(input);
  assert.equal(result.ok, true);
  const output = Buffer.from(result.result.stdout.base64, 'base64').toString();
  assert.ok(output.includes('PYTEST_DISABLE_PLUGIN_AUTOLOAD'));
  for (const secret of [
    admissionKey.secret,
    dispatchKey.secret,
    foreignKey.secret,
    foreignAdmissionKey.secret,
    fixture.runtimeConfig.password,
  ])
    assert.equal(output.includes(secret), false);
  assert.equal(result.result.status, 'completed');
});

test('cleanup failure remains UNKNOWN after authorized reconciliation and never redispatches', async () => {
  await stop();
  await writeFile(faultPath, 'enabled');
  await start('127.0.0.1', true);
  const data = request([
    { path: 'test_smoke.py', content: 'def test_smoke():\n    assert True\n' },
  ]);
  const input = dispatch('run', data);
  try {
    assert.equal((await call(input)).code, 'CLEANUP_FAILED');
    assert.deepEqual(
      (await call(dispatch('lookup', null, { requestId: data.requestId })))
        .result,
      { state: 'unknown', receipt: null },
    );
    const denied = await call(
      dispatch('reconcile', null, {
        key: foreignKey,
        requestId: data.requestId,
      }),
    );
    assert.equal(denied.code, 'UNAUTHORIZED');
    await unlink(faultPath);
    const reconciled = await call(
      dispatch('reconcile', null, { requestId: data.requestId }),
    );
    assert.equal(reconciled.result.state, 'unknown');
    assert.equal(reconciled.result.cleanup.verified, true);
    assert.equal(reconciled.result.cleanup.containerRemoved, true);
    assert.equal((await call(input)).code, 'EXECUTION_UNKNOWN');
  } finally {
    await unlink(faultPath).catch(() => {});
    await call(
      dispatch('reconcile', null, { requestId: data.requestId }),
    ).catch(() => {});
  }
});

test('database outage fails closed', async () => {
  fixture.stopServer();
  try {
    const data = request([
      {
        path: 'test_smoke.py',
        content: 'def test_smoke():\n    assert True\n',
      },
    ]);
    assert.equal(
      (await call(dispatch('run', data))).code,
      'EXECUTION_STORE_UNAVAILABLE',
    );
  } finally {
    await stop();
    await fixture.startServer();
    await start();
  }
});

test('crashed service reconciles only the owned container and keeps the operation UNKNOWN', async () => {
  const data = request(
    [
      {
        path: 'test_sleep.py',
        content: 'import time\ndef test_sleep():\n    time.sleep(15)\n',
      },
    ],
    { timeoutMs: 30000 },
  );
  const input = dispatch('run', data);
  const pending = call(input).catch(() => null);
  let running = false;
  try {
    for (let i = 0; i < 100; i += 1) {
      const found = await fixture.adminPool.query(
        "SELECT attempt->>'stage' AS stage FROM restricted_executor.requests WHERE request_id = $1",
        [data.requestId],
      );
      if (found.rows[0]?.stage === 'running') {
        running = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(running, true);
    await stop('SIGKILL');
    await pending;
    await start();
    const reconciled = await call(
      dispatch('reconcile', null, { requestId: data.requestId }),
    );
    assert.equal(reconciled.result.state, 'unknown');
    assert.equal(reconciled.result.cleanup.verified, true);
    assert.equal((await call(input)).code, 'EXECUTION_UNKNOWN');
  } finally {
    if (!child) await start();
    if (running)
      await call(
        dispatch('reconcile', null, { requestId: data.requestId }),
      ).catch(() => {});
  }
});

test('HTTP request size and representation are bounded', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/v1/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: ' '.repeat(13 * 1024 * 1024 + 1),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'BODY_TOO_LARGE');
  const wrong = await fetch(`http://127.0.0.1:${port}/v1/dispatch`, {
    method: 'GET',
  });
  assert.equal((await wrong.json()).code, 'INVALID_REQUEST');
});

test('service refuses readable or symlinked credential files', async () => {
  await stop();
  const executable = new URL(
    '../../packages/restricted-executor/service.mjs',
    import.meta.url,
  ).pathname;
  async function rejected(path) {
    const process = spawn(globalThis.process.execPath, [executable, path], {
      stdio: 'ignore',
    });
    const [code] = await once(process, 'exit');
    assert.equal(code, 1);
  }
  await chmod(configPath, 0o644);
  try {
    await rejected(configPath);
  } finally {
    await chmod(configPath, 0o600);
  }
  const link = join(fixture.root, 'service-link.json');
  await symlink(configPath, link);
  try {
    await rejected(link);
  } finally {
    await unlink(link);
  }
});
