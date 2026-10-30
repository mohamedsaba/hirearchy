// Explicit disposable R2.7 lane. Never reads a configured database or Auth URL.
import assert from 'node:assert/strict';
import { installR27EvidenceFixture } from '../database/postgres/r27/adapter.mjs';
import { runR27PostgresEvidenceChecks } from '../tests/r27/postgres-evidence-check.mjs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { initializeCandidateTokenStorage } from '../database/postgres/r23/adapter.mjs';
import { applyMigrations } from '../database/postgres/migrate.mjs';
import { runR25PostgresIssuanceSecurityChecks } from '../tests/r25/postgres-issuance-security-check.mjs';
import { runR26PostgresCandidateChecks } from '../tests/r26/postgres-candidate-check.mjs';
import { runR25RequestAndBrowserChecks } from '../tests/r25/request-issuance-check.mjs';

const pgImage =
  'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
const authImage =
  'supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b';
const network = `hirearchy-r27-${randomBytes(8).toString('hex')}`;
const database = `${network}-db`;
const auth = `${network}-auth`;
const password = randomBytes(32).toString('hex');
const runtimePassword = randomBytes(32).toString('hex');
const jwtSecret = randomBytes(48).toString('hex');
const issuer = 'https://auth.hirearchy.test/auth/v1';
const audience = 'authenticated';
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const sql = (query) =>
  docker(
    'exec',
    database,
    'psql',
    '-U',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-Atc',
    query,
  );
const waitFor = async (check) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (await check()) return;
    } catch {
      // Bounded startup polling only.
    }
    await delay(200);
  }
  throw new Error('Disposable R2.6 fixture readiness failed');
};

let admin;
let migrator;
let authOwner;
let stage = 'startup';

try {
  console.log(
    JSON.stringify({ fixtureResources: { network, database, auth } }),
  );
  for (const image of [pgImage, authImage]) docker('image', 'inspect', image);
  stage = 'disposable network';
  docker('network', 'create', network);
  docker(
    'run',
    '-d',
    '--name',
    database,
    '--network',
    network,
    '--network-alias',
    'db',
    '-p',
    '127.0.0.1::5432',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '--tmpfs',
    '/var/lib/postgresql/data',
    pgImage,
  );
  stage = 'PostgreSQL readiness';
  await waitFor(() => sql('SELECT 1') === '1');
  const port = /^127\.0\.0\.1:(\d+)$/.exec(
    docker('port', database, '5432/tcp'),
  );
  assert(port, 'loopback-only PostgreSQL');
  const connection = {
    host: '127.0.0.1',
    port: Number(port[1]),
    database: 'postgres',
    connectionTimeoutMillis: 3000,
  };
  stage = 'PostgreSQL TCP readiness';
  await waitFor(async () => {
    const probe = new Client({ ...connection, user: 'postgres', password });
    try {
      await probe.connect();
      await probe.query('SELECT 1');
      return true;
    } finally {
      await probe.end().catch(() => undefined);
    }
  });

  stage = 'foundation bootstrap';
  admin = new Client({ ...connection, user: 'postgres', password });
  await admin.connect();
  await admin.query(
    readFileSync(
      new URL('../database/postgres/bootstrap-roles.sql', import.meta.url),
      'utf8',
    ),
  );
  sql(`ALTER ROLE hirearchy_migrator PASSWORD '${password}';
    ALTER ROLE app_evaluator PASSWORD '${runtimePassword}';
    ALTER ROLE app_candidate_gateway PASSWORD '${runtimePassword}';
    ALTER ROLE app_control_worker PASSWORD '${runtimePassword}';
    CREATE ROLE r23_gateway LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE supabase_auth_admin LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
    ALTER ROLE supabase_auth_admin SET search_path = auth;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;`);
  migrator = new Client({
    ...connection,
    user: 'hirearchy_migrator',
    password,
  });
  await migrator.connect();
  stage = 'foundation migrations (0001 + 0002 + 0003 + 0004)';
  await applyMigrations(migrator);
  await migrator.end();
  migrator = undefined;
  docker(
    'run',
    '-d',
    '--name',
    auth,
    '--network',
    network,
    '-p',
    '127.0.0.1::9999',
    ...Object.entries({
      GOTRUE_API_HOST: '0.0.0.0',
      PORT: '9999',
      API_EXTERNAL_URL: issuer,
      GOTRUE_SITE_URL: 'https://hirearchy.example.test',
      GOTRUE_DB_DRIVER: 'postgres',
      GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:${password}@db:5432/postgres?sslmode=disable`,
      GOTRUE_DB_NAMESPACE: 'auth',
      GOTRUE_JWT_SECRET: jwtSecret,
      GOTRUE_JWT_ISSUER: issuer,
      GOTRUE_JWT_EXP: '3600',
      GOTRUE_JWT_AUD: audience,
      GOTRUE_JWT_DEFAULT_GROUP_NAME: audience,
      GOTRUE_DISABLE_SIGNUP: 'false',
      GOTRUE_MAILER_AUTOCONFIRM: 'true',
      GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
    }).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    authImage,
  );
  stage = 'Auth readiness';
  const authPort = /^127\.0\.0\.1:(\d+)$/.exec(
    docker('port', auth, '9999/tcp'),
  );
  assert(authPort, 'loopback-only Auth');
  const authUrl = `http://127.0.0.1:${authPort[1]}`;
  await waitFor(
    async () =>
      (await fetch(`${authUrl}/health`, { signal: AbortSignal.timeout(1000) }))
        .ok,
  );
  const users = {
    a: { email: `evaluator-a-${network}@acme.example`, password },
    b: { email: `reviewer-b-${network}@beta.example`, password },
    ab: { email: `evaluator-ab-${network}@shared.example`, password },
    revoked: { email: `revoked-a-${network}@acme.example`, password },
    recruiterA2: { email: `recruiter-a2-${network}@acme.example`, password },
    recruiterEmpty: {
      email: `recruiter-empty-${network}@acme.example`,
      password,
    },
    adminA: { email: `admin-a-${network}@acme.example`, password },
    recruiterB: { email: `recruiter-b-${network}@beta.example`, password },
  };
  const authCall = async (path, body) => {
    const response = await fetch(`${authUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    assert(response.ok, 'synthetic Auth operation');
    return response.json();
  };
  stage = 'synthetic signup';
  for (const user of Object.values(users)) await authCall('/signup', user);
  stage = 'R2.3 + R2.4 + R2.6 fixture schema install';
  await admin.query(
    readFileSync(
      new URL('../database/postgres/r23/fixture.sql', import.meta.url),
      'utf8',
    ),
  );

  stage = 'R2.6 PostgreSQL security and transaction checks';
  await runR25PostgresIssuanceSecurityChecks({
    admin,
    connection,
    password,
    runtimePassword,
  });

  const candidateTokenKey = randomBytes(32).toString('base64');
  await admin.query('DELETE FROM hirearchy.candidate_token_storage_meta');
  await initializeCandidateTokenStorage(admin, {
    key: Buffer.from(candidateTokenKey, 'base64'),
  });
  stage = 'R2.6 actual-role candidate security/finality checks';
  await runR26PostgresCandidateChecks({
    admin,
    connection,
    runtimePassword,
    candidateTokenKey,
  });
  stage = 'R2.7 evidence fixture';
  await installR27EvidenceFixture(admin);
  stage = 'R2.7 actual-role evidence authorization';
  await runR27PostgresEvidenceChecks({
    admin,
    connection,
    runtimePassword,
    candidateTokenKey,
  });
  if (process.argv.includes('--database-only')) {
    console.log(
      'PASS R2.7 database-only evidence authorization checks; browser not run',
    );
  } else {
    const { runR27BrowserEvidenceChecks } =
      await import('../tests/r27/browser-evidence-check.mjs');
    stage = 'R2.7 Next.js + PostgreSQL + HTTPS Workbench verification';
    await runR25RequestAndBrowserChecks({
      admin,
      connection,
      password,
      runtimePassword,
      authUrl,
      issuer,
      audience,
      users,
      authCall,
      candidateTokenKey,
      extraEnv: {
        HIREARCHY_R26_DISPOSABLE: '1',
        HIREARCHY_R27_DISPOSABLE: '1',
        R26_DATABASE_URL: `postgres://app_candidate_gateway:${runtimePassword}@127.0.0.1:${connection.port}/postgres`,
      },
      candidateChecks: runR27BrowserEvidenceChecks,
      evidenceDir: process.env.R27_EVIDENCE_DIR,
    });
    console.log(
      'PASS R2.7 actual-role evidence isolation and real Next.js HTTPS candidate-to-Workbench journey',
    );
  }
} catch (error) {
  console.error(
    `R2.7 failed during ${stage} (${error instanceof assert.AssertionError ? 'assertion' : 'fixture/protocol'})`,
  );
  console.error(
    JSON.stringify({
      sqlState: error?.code,
      constraint: error?.constraint,
      table: error?.table,
      position: error?.position,
    }),
  );
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : 'Disposable fixture or protocol operation failed; raw connection details withheld.',
  );
  if (error instanceof Error && error.stack)
    console.error(
      error.stack
        .split('\n')
        .filter((line) => /^\s+at /.test(line))
        .join('\n'),
    );
  process.exitCode = 1;
} finally {
  let cleanupFailed = false;
  for (const client of [migrator, authOwner, admin]) {
    try {
      await client?.end();
    } catch {
      cleanupFailed = true;
    }
  }
  for (const name of [auth, database]) {
    try {
      const names = docker('ps', '-a', '--format', '{{.Names}}').split('\n');
      if (names.includes(name)) docker('rm', '-f', name);
    } catch {
      cleanupFailed = true;
    }
  }
  try {
    const networks = docker('network', 'ls', '--format', '{{.Name}}').split(
      '\n',
    );
    if (networks.includes(network)) docker('network', 'rm', network);
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed) {
    console.error('R2.7 owned test-resource cleanup failed');
    process.exitCode = 1;
  }
}
