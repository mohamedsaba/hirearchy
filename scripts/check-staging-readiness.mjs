import { fileURLToPath } from 'node:url';

const MAX_RESPONSE_BYTES = 16 * 1024;
const MARKERS = [
  'candidateLifecycle',
  'onboarding',
  'candidateTokenStorage',
  'authoringR211',
  'executionR214',
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readBoundedJson(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    return null;
  }
}

function readinessFields(value) {
  if (
    !isObject(value) ||
    !['ready', 'not_ready'].includes(value.status) ||
    !isObject(value.database) ||
    !/^\d{4}$/.test(value.database.targetMigrationVersion ?? '') ||
    (value.database.migrationVersion !== null &&
      !/^\d{4}$/.test(value.database.migrationVersion ?? '')) ||
    !isObject(value.database.markers) ||
    MARKERS.some((name) => typeof value.database.markers[name] !== 'boolean')
  ) {
    return null;
  }
  return {
    status: value.status,
    migrationVersion: value.database.migrationVersion,
    targetMigrationVersion: value.database.targetMigrationVersion,
    markers: Object.fromEntries(
      MARKERS.map((name) => [name, value.database.markers[name]]),
    ),
  };
}

export async function probeStagingReadiness({
  appPort = process.env.APP_PORT,
  fetchImpl = fetch,
  timeoutMs = 5000,
} = {}) {
  const port = Number(appPort);
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;
  let httpStatus = null;
  let fields = null;

  if (validPort) {
    try {
      const response = await fetchImpl(
        new URL('/api/staging/readiness', 'http://127.0.0.1:' + port),
        { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) },
      );
      httpStatus = response.status;
      fields = readinessFields(await readBoundedJson(response));
    } catch {
      // Connection details and response bodies stay out of the operator record.
    }
  }

  const state =
    httpStatus === 200 &&
    fields?.status === 'ready' &&
    fields.migrationVersion === fields.targetMigrationVersion &&
    Object.values(fields.markers).every(Boolean)
      ? 'ready'
      : httpStatus === 503 && fields?.status === 'not_ready'
        ? 'not_ready'
        : 'unavailable';

  return {
    event: 'hirearchy.staging_readiness',
    observedAt: new Date().toISOString(),
    state,
    httpStatus,
    migrationVersion: fields?.migrationVersion ?? null,
    targetMigrationVersion: fields?.targetMigrationVersion ?? null,
    markers: fields?.markers ?? null,
    action:
      state === 'ready'
        ? 'No action required; continue the approved local checks.'
        : state === 'not_ready'
          ? 'Keep traffic closed; check PostgreSQL health, migration markers, and proof-key setup, then recheck.'
          : 'Keep traffic closed; check the loopback app listener and private service diagnostics.',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await probeStagingReadiness();
  process.stdout.write(JSON.stringify(report) + '\n');
  if (report.state !== 'ready') process.exitCode = 1;
}
