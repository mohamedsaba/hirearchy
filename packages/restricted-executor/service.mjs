import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { TextDecoder } from 'node:util';
import { Pool } from 'pg';
import { createInternalDispatcher } from './internal-dispatch.mjs';

const VERSION = 'executor-dispatch-v1';
const MAX_BODY = 13 * 1024 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const MAX_ACTIVE = 4;
const CODES = new Set([
  'UNAUTHORIZED',
  'INVALID_REQUEST',
  'INVALID_SNAPSHOT',
  'SNAPSHOT_DIGEST_MISMATCH',
  'UNSUPPORTED_RECIPE',
  'IDEMPOTENCY_CONFLICT',
  'STALE_FENCE',
  'EXECUTION_IN_PROGRESS',
  'EXECUTION_UNKNOWN',
  'EXECUTION_STORE_UNAVAILABLE',
  'CLEANUP_FAILED',
]);

function exact(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

async function readConfig(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o077 ||
      stat.size > 65536
    )
      throw new Error();
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}

function validateConfig(config) {
  if (
    !exact(config, [
      'host',
      'port',
      'database',
      'admissionKeys',
      'dispatchKeys',
    ]) ||
    config.host !== '127.0.0.1' ||
    !Number.isInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535 ||
    !exact(config.database, ['host', 'port', 'database', 'user', 'password']) ||
    config.database.host !== '127.0.0.1' ||
    !Number.isInteger(config.database.port) ||
    config.database.port < 1 ||
    config.database.port > 65535 ||
    typeof config.database.database !== 'string' ||
    !config.database.database ||
    config.database.user !== 'restricted_executor_runtime' ||
    typeof config.database.password !== 'string' ||
    !config.database.password
  )
    throw new Error();
}

function respond(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) > MAX_RESPONSE) {
    return respond(response, 500, {
      version: VERSION,
      ok: false,
      code: 'RESPONSE_TOO_LARGE',
    });
  }
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json),
    connection: 'close',
  });
  response.end(json);
}

async function readBody(request) {
  const bytes = await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let exceeded = false;
    request.on('data', (chunk) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        exceeded = true;
        reject(new Error('BODY_TOO_LARGE'));
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      if (!exceeded) resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('INVALID_REQUEST')));
  });
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('INVALID_REQUEST');
  }
}

async function main() {
  if (process.argv.length !== 3) throw new Error();
  const config = await readConfig(process.argv[2]);
  validateConfig(config);
  const pool = new Pool({
    ...config.database,
    max: MAX_ACTIVE + 1,
    connectionTimeoutMillis: 5000,
  });
  pool.on('error', () => {
    process.stderr.write('Execution store connection was lost.\n');
  });
  const dispatcher = createInternalDispatcher({
    pool,
    admissionKeys: config.admissionKeys,
    dispatchKeys: config.dispatchKeys,
  });
  let active = 0;
  let stopping = false;
  const server = createServer(
    { connectionsCheckingInterval: 1000 },
    async (request, response) => {
      if (stopping || active >= MAX_ACTIVE) {
        respond(response, 503, {
          version: VERSION,
          ok: false,
          code: 'SERVICE_BUSY',
        });
        request.resume();
        return;
      }
      if (
        request.method !== 'POST' ||
        request.url !== '/v1/dispatch' ||
        request.headers['content-type'] !== 'application/json'
      ) {
        respond(response, 400, {
          version: VERSION,
          ok: false,
          code: 'INVALID_REQUEST',
        });
        request.resume();
        return;
      }
      active += 1;
      try {
        const input = await readBody(request);
        const result = await dispatcher.handle(input);
        respond(response, 200, { version: VERSION, ok: true, result });
      } catch (error) {
        const code =
          error?.message === 'BODY_TOO_LARGE'
            ? 'BODY_TOO_LARGE'
            : error?.message === 'INVALID_REQUEST'
              ? 'INVALID_REQUEST'
              : CODES.has(error?.code)
                ? error.code
                : 'INTERNAL_ERROR';
        respond(response, code === 'BODY_TOO_LARGE' ? 413 : 400, {
          version: VERSION,
          ok: false,
          code,
        });
      } finally {
        active -= 1;
      }
    },
  );
  server.headersTimeout = 5000;
  server.requestTimeout = 15000;
  server.maxConnections = 16;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  process.stdout.write(
    `${JSON.stringify({ version: VERSION, host: '127.0.0.1', port: server.address().port })}\n`,
  );
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 120000);
    deadline.unref();
    server.close(async () => {
      await pool.end();
      clearTimeout(deadline);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(() => {
  process.stderr.write('Executor service failed to start.\n');
  process.exitCode = 1;
});
