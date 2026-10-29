import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { after, test } from 'node:test';
import { createInternalDispatcher } from '../../packages/restricted-executor/internal-dispatch.mjs';
import {
  RECIPE,
  RECIPE_DIGEST,
  snapshotDigest,
} from '../../packages/restricted-executor/index.mjs';
import { startPostgresFixture } from './postgres-fixture.mjs';

const previousTmpdir = process.env.TMPDIR;
const schemaSql = await readFile(
  new URL('../../packages/restricted-executor/schema.sql', import.meta.url),
  'utf8',
);
const fixture = await startPostgresFixture({ schemaSql });
process.env.TMPDIR = fixture.root;

const admissionKey = {
  keyId: 'dispatch-admission-key',
  callerId: 'dispatch-caller',
  secret: `HIREARCHY_SYNTHETIC_ADMISSION_KEY_${randomBytes(32).toString('hex')}`,
};
const dispatchKey = {
  keyId: 'dispatch-internal-key',
  callerId: 'dispatch-caller',
  secret: `HIREARCHY_SYNTHETIC_DISPATCH_KEY_${randomBytes(32).toString('hex')}`,
};
const foreignDispatchKey = {
  keyId: 'dispatch-foreign-key',
  callerId: 'foreign-caller',
  secret: `HIREARCHY_SYNTHETIC_FOREIGN_KEY_${randomBytes(32).toString('hex')}`,
};
const admissionKeys = [admissionKey];
const dispatchKeys = [dispatchKey, foreignDispatchKey];
function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function files(content = 'def test_smoke():\n    assert 2 + 2 == 4\n') {
  return [{ path: 'test_smoke.py', content }];
}

function signAdmission(input, options = {}) {
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

function runRequest(overrides = {}, admissionOverrides = {}) {
  const {
    authorization: previous,
    operationId: overrideOperationId,
    generation: overrideGeneration,
    fence: overrideFence,
    ...bodyOverrides
  } = overrides;
  const snapshot = bodyOverrides.files ?? files();
  const body = {
    requestId: `dispatch-${randomUUID()}`,
    sessionRef: 'dispatch-session',
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
  return signAdmission(
    { ...body, authorization: previous },
    {
      ...admissionOverrides,
      operationId:
        overrideOperationId ??
        admissionOverrides.operationId ??
        previous?.operationId ??
        `operation-${randomUUID()}`,
      generation:
        overrideGeneration ??
        admissionOverrides.generation ??
        previous?.generation ??
        1,
      fence: overrideFence ?? admissionOverrides.fence ?? previous?.fence ?? 1,
    },
  );
}

function signDispatch(action, request, options = {}) {
  const key = options.key ?? dispatchKey;
  const issuedAtMs = options.issuedAtMs ?? Date.now();
  const expiresAtMs = options.expiresAtMs ?? issuedAtMs + 60_000;
  const payloadDigest = digest(JSON.stringify(request));
  const fields = {
    version: 1,
    action,
    callerId: options.callerId ?? key.callerId,
    keyId: options.keyId ?? key.keyId,
    sessionRef: options.sessionRef ?? 'dispatch-session',
    requestId: options.requestId,
    issuedAtMs,
    expiresAtMs,
    payloadDigest,
  };
  const tag = createHmac('sha256', options.secret ?? key.secret)
    .update(JSON.stringify(fields), 'utf8')
    .digest('hex');
  const authorization = { ...fields };
  delete authorization.action;
  return { ...authorization, tag };
}

function dispatchInput(action, request, options = {}) {
  return {
    action,
    request,
    authorization: signDispatch(action, request, options),
  };
}

function dispatcher(pool, keys = dispatchKeys) {
  return createInternalDispatcher({ pool, admissionKeys, dispatchKeys: keys });
}

async function expectCode(promise, code) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${code}`);
  assert.equal(caught.code, code);
  assert.equal(caught.message.includes(admissionKey.secret), false);
  assert.equal(caught.message.includes(dispatchKey.secret), false);
  assert.equal(caught.message.includes(fixture.runtimeConfig.password), false);
  return caught;
}

function installSpawnPatch(patch) {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) =>
    patch(command, args, options, originalSpawn);
  syncBuiltinESMExports();
  return () => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  };
}

after(async () => {
  process.env.TMPDIR = previousTmpdir;
  await fixture.close();
});

test('authenticated run returns one factual receipt, replays, and enforces operation fences', async () => {
  const service = dispatcher(fixture.runtimePool);
  const creates = [];
  const restoreSpawn = installSpawnPatch((command, args, options, original) => {
    if (
      command === '/usr/bin/docker' &&
      args.includes('container') &&
      args.includes('create')
    ) {
      creates.push([...args]);
    }
    return original(command, args, options);
  });

  try {
    const first = runRequest();
    const authorization = signDispatch('run', first, {
      requestId: first.requestId,
      sessionRef: first.sessionRef,
    });
    const requestInput = { action: 'run', authorization, request: first };
    const pending = [
      service.handle(requestInput),
      service.handle(requestInput),
    ];
    const originalContent = first.files[0].content;
    first.files[0].content += '# changed after dispatch\n';
    const outcomes = await Promise.allSettled(pending);
    first.files[0].content = originalContent;
    const completed = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    assert.ok(completed.length >= 1);
    const receipt = completed[0].value;
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled')
        assert.deepEqual(outcome.value, receipt);
      else assert.equal(outcome.reason.code, 'EXECUTION_IN_PROGRESS');
    }
    assert.equal(receipt.requestId, first.requestId);
    assert.equal(receipt.operationId, first.authorization.operationId);
    assert.equal(receipt.snapshotDigest, first.snapshotDigest);
    assert.equal(receipt.generation, 1);
    assert.equal(receipt.fence, 1);
    assert.equal(receipt.status, 'completed');

    assert.deepEqual(await service.handle(requestInput), receipt);
    assert.equal(creates.length, 1);
    assert.deepEqual(
      await service.handle({
        action: 'lookup',
        request: null,
        authorization: signDispatch('lookup', null, {
          requestId: first.requestId,
          sessionRef: first.sessionRef,
        }),
      }),
      { state: 'complete', receipt },
    );

    const next = runRequest(
      { operationId: first.authorization.operationId },
      { generation: 2, fence: 2 },
    );
    const nextReceipt = await service.handle({
      action: 'run',
      request: next,
      authorization: signDispatch('run', next, {
        requestId: next.requestId,
        sessionRef: next.sessionRef,
      }),
    });
    assert.equal(nextReceipt.generation, 2);
    assert.equal(nextReceipt.fence, 2);

    const stale = runRequest(
      { operationId: first.authorization.operationId },
      { generation: 1, fence: 1 },
    );
    await expectCode(
      service.handle({
        action: 'run',
        request: stale,
        authorization: signDispatch('run', stale, {
          requestId: stale.requestId,
          sessionRef: stale.sessionRef,
        }),
      }),
      'STALE_FENCE',
    );
    assert.equal(creates.length, 2);
  } finally {
    restoreSpawn();
  }
});

test('malformed, wrong-key, tampered, and expired envelopes stop before PostgreSQL or Docker', async () => {
  const pool = fixture.createRuntimePool(
    `rex-auth-${randomUUID().slice(0, 12)}`,
  );
  let connects = 0;
  const connect = pool.connect.bind(pool);
  pool.connect = (...args) => {
    connects += 1;
    return connect(...args);
  };
  const service = dispatcher(pool);
  const dockerCalls = [];
  const restoreSpawn = installSpawnPatch((command, args, options, original) => {
    if (command === '/usr/bin/docker') dockerCalls.push([...args]);
    return original(command, args, options);
  });

  try {
    const request = runRequest();
    const valid = dispatchInput('run', request, {
      requestId: request.requestId,
      sessionRef: request.sessionRef,
    });
    const expired = dispatchInput('run', request, {
      requestId: request.requestId,
      sessionRef: request.sessionRef,
      issuedAtMs: Date.now() - 120_000,
      expiresAtMs: Date.now() - 60_000,
    });
    const alteredPayload = structuredClone(request);
    alteredPayload.files[0].content += '# altered\n';
    const alteredAction = {
      action: 'reconcile',
      request: null,
      authorization: signDispatch('lookup', null, {
        requestId: request.requestId,
        sessionRef: request.sessionRef,
      }),
    };
    const malformed = {
      ...valid,
      authorization: { ...valid.authorization, unsupported: true },
    };
    const wrongKey = {
      ...valid,
      authorization: signDispatch('run', request, {
        requestId: request.requestId,
        sessionRef: request.sessionRef,
        secret: `HIREARCHY_SYNTHETIC_WRONG_KEY_${randomBytes(32).toString('hex')}`,
      }),
    };
    const excessiveKey = structuredClone(request);
    excessiveKey.files[0]['x'.repeat(512 * 1024 + 1)] = true;
    const invalidAdmission = structuredClone(request);
    invalidAdmission.authorization.tag = '0'.repeat(64);

    for (const input of [
      malformed,
      wrongKey,
      { ...valid, request: alteredPayload },
      alteredAction,
      expired,
      dispatchInput('run', excessiveKey, {
        requestId: request.requestId,
        sessionRef: request.sessionRef,
      }),
      dispatchInput('run', invalidAdmission, {
        requestId: request.requestId,
        sessionRef: request.sessionRef,
      }),
      dispatchInput('run', request, {
        key: foreignDispatchKey,
        requestId: request.requestId,
        sessionRef: request.sessionRef,
      }),
    ]) {
      await expectCode(service.handle(input), 'UNAUTHORIZED');
      assert.equal(connects, 0);
      assert.deepEqual(dockerCalls, []);
    }
  } finally {
    restoreSpawn();
    await pool.end();
  }
});

test('foreign and missing request identities return the same authorization failure without reconciliation', async () => {
  const service = dispatcher(fixture.runtimePool);
  const input = runRequest();
  const receipt = await service.handle({
    action: 'run',
    request: input,
    authorization: signDispatch('run', input, {
      requestId: input.requestId,
      sessionRef: input.sessionRef,
    }),
  });
  assert.equal(receipt.status, 'completed');

  const lookup = (options) => ({
    action: 'lookup',
    request: null,
    authorization: signDispatch('lookup', null, {
      requestId: input.requestId,
      sessionRef: input.sessionRef,
      ...options,
    }),
  });
  const reconcile = (options) => ({
    action: 'reconcile',
    request: null,
    authorization: signDispatch('reconcile', null, {
      requestId: input.requestId,
      sessionRef: input.sessionRef,
      ...options,
    }),
  });
  const wrongCaller = {
    key: foreignDispatchKey,
    callerId: foreignDispatchKey.callerId,
  };
  const wrongSession = { sessionRef: 'foreign-session' };
  const missing = { requestId: `missing-${randomUUID()}` };
  const failures = await Promise.all([
    service.handle(lookup(wrongCaller)).then(
      () => null,
      (error) => error,
    ),
    service.handle(lookup(wrongSession)).then(
      () => null,
      (error) => error,
    ),
    service.handle(lookup(missing)).then(
      () => null,
      (error) => error,
    ),
    service.handle(reconcile(wrongCaller)).then(
      () => null,
      (error) => error,
    ),
    service.handle(reconcile(wrongSession)).then(
      () => null,
      (error) => error,
    ),
    service.handle(reconcile(missing)).then(
      () => null,
      (error) => error,
    ),
  ]);
  for (const error of failures) {
    assert.ok(error);
    assert.equal(error?.code, 'UNAUTHORIZED');
    assert.equal(error.message, failures[0].message);
  }
  assert.deepEqual(
    await service.handle({
      action: 'lookup',
      request: null,
      authorization: signDispatch('lookup', null, {
        requestId: input.requestId,
        sessionRef: input.sessionRef,
      }),
    }),
    { state: 'complete', receipt },
  );
});

test('valid maximum snapshots remain accepted when JSON escaping expands them', async () => {
  const request = runRequest({
    files: Array.from({ length: 4 }, (_, index) => ({
      path: `file-${index}.py`,
      content: '\0'.repeat(512 * 1024),
    })),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(request)) > 4 * 1024 * 1024);
  await expectCode(
    dispatcher(fixture.adminPool).handle({
      action: 'run',
      request,
      authorization: signDispatch('run', request, {
        requestId: request.requestId,
        sessionRef: request.sessionRef,
      }),
    }),
    'EXECUTION_STORE_UNAVAILABLE',
  );
});

test('wrong PostgreSQL role and database outage fail closed without a receipt', async () => {
  const request = runRequest();
  const roleFailure = await expectCode(
    dispatcher(fixture.adminPool).handle({
      action: 'run',
      request,
      authorization: signDispatch('run', request, {
        requestId: request.requestId,
        sessionRef: request.sessionRef,
      }),
    }),
    'EXECUTION_STORE_UNAVAILABLE',
  );
  assert.equal(roleFailure.message.includes('postgres'), false);

  const outageRequest = runRequest();
  let serverStopped = false;
  try {
    fixture.stopServer();
    serverStopped = true;
    await expectCode(
      dispatcher(fixture.runtimePool).handle({
        action: 'run',
        request: outageRequest,
        authorization: signDispatch('run', outageRequest, {
          requestId: outageRequest.requestId,
          sessionRef: outageRequest.sessionRef,
        }),
      }),
      'EXECUTION_STORE_UNAVAILABLE',
    );
  } finally {
    if (serverStopped) await fixture.startServer();
  }
  assert.equal(
    await dispatcher(fixture.runtimePool)
      .handle({
        action: 'lookup',
        request: null,
        authorization: signDispatch('lookup', null, {
          requestId: outageRequest.requestId,
          sessionRef: outageRequest.sessionRef,
        }),
      })
      .then(
        () => false,
        (error) => error.code === 'UNAUTHORIZED',
      ),
    true,
  );
});

test('UNKNOWN remains non-replayable after exact cleanup reconciliation', async () => {
  const service = dispatcher(fixture.runtimePool);
  const request = runRequest();
  const signedRun = {
    action: 'run',
    request,
    authorization: signDispatch('run', request, {
      requestId: request.requestId,
      sessionRef: request.sessionRef,
    }),
  };
  const creates = [];
  const restoreSpawn = installSpawnPatch((command, args, options, original) => {
    if (
      command === '/usr/bin/docker' &&
      args.includes('container') &&
      args.includes('create')
    ) {
      creates.push([...args]);
    }
    if (
      command === '/usr/bin/docker' &&
      args.includes('container') &&
      args.includes('rm')
    ) {
      return original('/usr/bin/false', [], options);
    }
    return original(command, args, options);
  });
  let needsRecovery = false;
  try {
    needsRecovery = true;
    await expectCode(service.handle(signedRun), 'CLEANUP_FAILED');
  } finally {
    restoreSpawn();
  }

  const authFor = (action) =>
    signDispatch(action, null, {
      requestId: request.requestId,
      sessionRef: request.sessionRef,
    });
  try {
    const before = await service.handle({
      action: 'lookup',
      request: null,
      authorization: authFor('lookup'),
    });
    assert.equal(before.state, 'unknown');
    assert.equal(before.receipt, null);

    const reconciled = await service.handle({
      action: 'reconcile',
      request: null,
      authorization: authFor('reconcile'),
    });
    assert.equal(reconciled.state, 'unknown');
    assert.equal(reconciled.cleanup.verified, true);
    assert.equal(reconciled.cleanup.containerRemoved, true);
    assert.equal(Object.hasOwn(reconciled, 'receipt'), false);
    needsRecovery = false;

    await expectCode(service.handle(signedRun), 'EXECUTION_UNKNOWN');
    assert.equal(creates.length, 1);
    assert.deepEqual(
      await service.handle({
        action: 'lookup',
        request: null,
        authorization: authFor('lookup'),
      }),
      { state: 'unknown', receipt: null },
    );
  } finally {
    if (needsRecovery) {
      await service.handle({
        action: 'reconcile',
        request: null,
        authorization: authFor('reconcile'),
      });
    }
  }
});
