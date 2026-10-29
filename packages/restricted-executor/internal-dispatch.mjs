import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createExecutor, ExecutorError } from './index.mjs';
import { createPostgresExecutionStore } from './store.mjs';

const AUTHORIZATION_FIELDS = [
  'version',
  'callerId',
  'keyId',
  'sessionRef',
  'requestId',
  'issuedAtMs',
  'expiresAtMs',
  'payloadDigest',
  'tag',
];
const MAX_TTL_MS = 5 * 60 * 1000;
// JSON can encode each byte of a valid 2 MiB snapshot as six ASCII bytes.
const MAX_PAYLOAD_BYTES = 12 * 1024 * 1024 + 64 * 1024;
const MAX_JSON_NODES = 1024;
const MAX_JSON_DEPTH = 8;
const MAX_OBJECT_FIELDS = 32;
const MAX_ARRAY_ITEMS = 128;
const MAX_STRING_CODE_UNITS = 512 * 1024;
const MAX_TOTAL_STRING_BYTES = 2_500_000;

function unauthorized() {
  return new ExecutorError(
    'UNAUTHORIZED',
    'Internal dispatch authentication failed.',
  );
}

function invalidConfig() {
  return new ExecutorError('INVALID_CONFIG', 'dispatchKeys are invalid.');
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function requireExactKeys(value, keys) {
  if (!isPlainObject(value)) throw unauthorized();
  const actual = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    actual.push(key);
    if (actual.length > keys.length) throw unauthorized();
  }
  actual.sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw unauthorized();
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      throw unauthorized();
  }
}

function requireIdentifier(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw unauthorized();
  }
  return value;
}

function validateDispatchKeys(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw invalidConfig();
  }
  const keys = new Map();
  for (const entry of value) {
    try {
      if (!isPlainObject(entry) || Object.getOwnPropertySymbols(entry).length)
        throw new Error();
      const fields = Object.keys(entry).sort();
      if (fields.join(',') !== 'callerId,keyId,secret') throw new Error();
      for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, field);
        if (!descriptor?.enumerable || !('value' in descriptor))
          throw new Error();
      }
      const callerId = entry.callerId;
      const keyId = entry.keyId;
      if (
        typeof callerId !== 'string' ||
        callerId.length < 1 ||
        Buffer.byteLength(callerId, 'utf8') > 128 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(callerId) ||
        typeof keyId !== 'string' ||
        keyId.length < 1 ||
        Buffer.byteLength(keyId, 'utf8') > 128 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(keyId) ||
        typeof entry.secret !== 'string' ||
        Buffer.byteLength(entry.secret, 'utf8') < 32 ||
        Buffer.byteLength(entry.secret, 'utf8') > 1024 ||
        keys.has(keyId)
      ) {
        throw new Error();
      }
      keys.set(keyId, { callerId, secret: Buffer.from(entry.secret, 'utf8') });
    } catch {
      throw invalidConfig();
    }
  }
  return keys;
}

function assertJsonData(
  value,
  state = { nodes: 0, stringBytes: 0 },
  depth = 0,
  seen = new Set(),
) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH)
    throw unauthorized();
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_CODE_UNITS) throw unauthorized();
    state.stringBytes += Buffer.byteLength(value, 'utf8');
    if (state.stringBytes > MAX_TOTAL_STRING_BYTES) throw unauthorized();
    return;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) throw unauthorized();
  seen.add(value);
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > MAX_ARRAY_ITEMS ||
      Object.hasOwn(value, 'toJSON')
    ) {
      throw unauthorized();
    }
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const index = Number(key);
      if (
        !Number.isSafeInteger(index) ||
        String(index) !== key ||
        index >= value.length
      )
        throw unauthorized();
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor))
        throw unauthorized();
      assertJsonData(descriptor.value, state, depth + 1, seen);
    }
  } else {
    if (!isPlainObject(value) || Object.hasOwn(value, 'toJSON'))
      throw unauthorized();
    const keys = [];
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (key.length > MAX_STRING_CODE_UNITS) throw unauthorized();
      state.stringBytes += Buffer.byteLength(key, 'utf8');
      if (state.stringBytes > MAX_TOTAL_STRING_BYTES) throw unauthorized();
      keys.push(key);
      if (keys.length > MAX_OBJECT_FIELDS) throw unauthorized();
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor))
        throw unauthorized();
      assertJsonData(descriptor.value, state, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function snapshotRunRequest(request) {
  try {
    requireExactKeys(request, [
      'requestId',
      'sessionRef',
      'scenarioRef',
      'scenarioVersion',
      'files',
      'snapshotDigest',
      'recipeId',
      'recipeVersion',
      'recipeDigest',
      'timeoutMs',
      'resources',
      'outputBytes',
      'authorization',
    ]);
    assertJsonData(request);
    const serialized = JSON.stringify(request);
    if (
      typeof serialized !== 'string' ||
      Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES
    ) {
      throw unauthorized();
    }
    const snapshot = JSON.parse(serialized);
    if (!isPlainObject(snapshot)) throw unauthorized();
    const detachedSerialized = JSON.stringify(snapshot);
    if (detachedSerialized !== serialized) throw unauthorized();
    return { snapshot, serialized: detachedSerialized };
  } catch {
    throw unauthorized();
  }
}

function payloadFor(action, request) {
  if (action === 'run') return snapshotRunRequest(request);
  if (request !== null) throw unauthorized();
  return { snapshot: null, serialized: 'null' };
}

function verifyAuthorization(action, authorization, keys) {
  requireExactKeys(authorization, AUTHORIZATION_FIELDS);
  if (authorization.version !== 1) throw unauthorized();
  const callerId = requireIdentifier(authorization.callerId);
  const keyId = requireIdentifier(authorization.keyId);
  const sessionRef = requireIdentifier(authorization.sessionRef);
  const requestId = requireIdentifier(authorization.requestId);
  const { issuedAtMs, expiresAtMs } = authorization;
  const payloadDigest = authorization.payloadDigest;
  const tag = authorization.tag;
  if (
    !Number.isSafeInteger(issuedAtMs) ||
    !Number.isSafeInteger(expiresAtMs) ||
    typeof payloadDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payloadDigest) ||
    typeof tag !== 'string' ||
    !/^[a-f0-9]{64}$/.test(tag)
  ) {
    throw unauthorized();
  }
  const now = Date.now();
  if (
    issuedAtMs > now ||
    expiresAtMs <= now ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > MAX_TTL_MS
  ) {
    throw unauthorized();
  }
  const configured = keys.get(keyId);
  if (!configured || configured.callerId !== callerId) throw unauthorized();
  const signed = {
    version: 1,
    action,
    callerId,
    keyId,
    sessionRef,
    requestId,
    issuedAtMs,
    expiresAtMs,
    payloadDigest,
  };
  const expected = createHmac('sha256', configured.secret)
    .update(JSON.stringify(signed), 'utf8')
    .digest();
  const actual = Buffer.from(tag, 'hex');
  if (!timingSafeEqual(expected, actual)) throw unauthorized();
  return { callerId, sessionRef, requestId, payloadDigest };
}

function requireOwnedRequest(record, callerId, sessionRef) {
  if (
    !record ||
    !isPlainObject(record.intent) ||
    record.intent.callerId !== callerId ||
    record.intent.sessionRef !== sessionRef
  ) {
    throw unauthorized();
  }
}

export function createInternalDispatcher(config) {
  if (
    !isPlainObject(config) ||
    Object.getOwnPropertySymbols(config).length > 0 ||
    Object.keys(config).sort().join(',') !==
      'admissionKeys,dispatchKeys,pool' ||
    ['admissionKeys', 'dispatchKeys', 'pool'].some((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(config, field);
      return !descriptor?.enumerable || !('value' in descriptor);
    })
  ) {
    throw new ExecutorError(
      'INVALID_CONFIG',
      'config must contain only pool, admissionKeys, and dispatchKeys.',
    );
  }
  const dispatchKeys = validateDispatchKeys(config.dispatchKeys);
  const executor = createExecutor({
    pool: config.pool,
    admissionKeys: config.admissionKeys,
  });
  const store = createPostgresExecutionStore({ pool: config.pool });

  async function handle(input) {
    requireExactKeys(input, ['action', 'authorization', 'request']);
    const { action, authorization, request } = input;
    if (!['run', 'lookup', 'reconcile'].includes(action)) throw unauthorized();
    const auth = verifyAuthorization(action, authorization, dispatchKeys);
    const payload = payloadFor(action, request);
    const actualPayloadDigest = createHash('sha256')
      .update(payload.serialized, 'utf8')
      .digest('hex');
    if (auth.payloadDigest !== actualPayloadDigest) throw unauthorized();

    if (action === 'run') {
      const admission = payload.snapshot.authorization;
      if (
        !isPlainObject(admission) ||
        admission.callerId !== auth.callerId ||
        admission.requestId !== auth.requestId ||
        admission.sessionRef !== auth.sessionRef
      ) {
        throw unauthorized();
      }
      return executor.run(payload.snapshot);
    }

    const stored = await store.readRequest(auth.requestId);
    requireOwnedRequest(stored, auth.callerId, auth.sessionRef);
    if (action === 'lookup') {
      return {
        state: stored.state,
        receipt:
          stored.state === 'complete' && stored.receipt !== null
            ? structuredClone(stored.receipt)
            : null,
      };
    }

    try {
      return await executor.reconcile(auth.requestId);
    } catch (error) {
      if (error?.code === 'UNKNOWN_REQUEST') throw unauthorized();
      throw error;
    }
  }

  return Object.freeze({ handle });
}
