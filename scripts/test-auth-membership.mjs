// Explicit disposable R2.2b lane. Never reads a configured database or Auth URL.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Pool } from 'pg';
import { applyMigrations } from '../database/postgres/migrate.mjs';
import { createAuthVerifier } from '../tests/r22b/auth.mjs';
import { runAuthChecks } from '../tests/r22b/auth-check.mjs';
import { runMembershipChecks } from '../tests/r22b/membership-check.mjs';
import {
  createMembershipLane,
  MembershipLaneError,
} from '../tests/r22b/membership.mjs';

const pgImage =
  'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
const authImage =
  'supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b';
const network = `hirearchy-r22b-${randomBytes(8).toString('hex')}`;
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
      // Only bounded startup polling; command/token diagnostics stay private.
    }
    await delay(200);
  }
  throw new Error('Disposable fixture readiness failed');
};
let admin;
let migrator;
let authOwner;
let pool;
let stage = 'startup';
try {
  // Images must already exist locally; this lane never provisions a hosted project.
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
  stage = 'foundation migrations';
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
  stage = 'test-only Auth foreign key';
  authOwner = new Client({
    ...connection,
    user: 'supabase_auth_admin',
    password,
  });
  await authOwner.connect();
  await authOwner.query('GRANT USAGE ON SCHEMA auth TO hirearchy_migrator');
  await authOwner.query(
    'GRANT REFERENCES (id) ON auth.users TO hirearchy_migrator',
  );
  migrator = new Client({
    ...connection,
    user: 'hirearchy_migrator',
    password,
  });
  await migrator.connect();
  await migrator.query(`ALTER TABLE hirearchy.application_principals
    ADD CONSTRAINT r22b_auth_users_fk FOREIGN KEY (auth_user_id)
    REFERENCES auth.users(id) ON DELETE SET NULL`);
  await migrator.end();
  migrator = undefined;
  const users = Object.fromEntries(
    ['a', 'b', 'ab', 'revoked', 'signup'].map((name) => [
      name,
      { email: `${name}-${network}@example.test`, password },
    ]),
  );
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
  stage = 'Auth negative, session and transport checks';
  const authChecks = await runAuthChecks({
    authUrl,
    issuer,
    audience,
    jwtSecret,
    users,
  });
  console.log(
    `Auth signed subject/session diagnostic: ${authChecks.subjectSessionDiagnostic}`,
  );
  console.log('PASS real Auth identity, session and server transport checks');
  stage = 'membership fixture install';
  await admin.query(
    readFileSync(new URL('../tests/r22b/fixture.sql', import.meta.url), 'utf8'),
  );
  pool = new Pool({
    ...connection,
    user: 'app_evaluator',
    password: runtimePassword,
    max: 1,
  });
  const tokens = {};
  for (const [name, user] of Object.entries(users)) {
    tokens[name] = (
      await authCall('/token?grant_type=password', user)
    ).access_token;
  }
  stage = 'membership security checks';
  const membershipChecks = await runMembershipChecks({
    admin,
    pool,
    verify: createAuthVerifier({ authUrl, issuer, audience }),
    tokens,
  });
  console.log('PASS real Auth → principal → membership A/B authorization lane');
  stage = 'integrated Auth session revocation';
  const lane = createMembershipLane({
    pool,
    verify: createAuthVerifier({ authUrl, issuer, audience }),
  });
  const originalMembershipB = await lane.read(
    tokens.b,
    membershipChecks.organizationB,
  );
  const originalIdentityB = await createAuthVerifier({
    authUrl,
    issuer,
    audience,
  })(tokens.b);
  const signedOut = await fetch(`${authUrl}/logout?scope=local`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.b}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(signedOut.status, 204);
  await assert.rejects(
    () => lane.read(tokens.b, membershipChecks.organizationB),
    (error) =>
      error instanceof MembershipLaneError &&
      error.message === 'Authentication required',
  );
  console.log('PASS real Auth signout denies subsequent membership admission');
  stage = 'integrated account deletion and same-email identity separation';
  const deleted = await authOwner.query(
    'DELETE FROM auth.users WHERE id = $1',
    [originalIdentityB.subjectId],
  );
  assert.equal(deleted.rowCount, 1);
  const historical = await admin.query(
    `SELECT principal.id, principal.auth_user_id,
    membership.organization_id FROM hirearchy.application_principals AS principal
    JOIN hirearchy.organization_memberships AS membership ON membership.principal_id = principal.id
    WHERE principal.id = $1 AND membership.organization_id = $2`,
    [originalMembershipB.principalId, membershipChecks.organizationB],
  );
  assert.deepEqual(historical.rows, [
    {
      id: originalMembershipB.principalId,
      auth_user_id: null,
      organization_id: membershipChecks.organizationB,
    },
  ]);
  await authCall('/signup', users.b);
  const replacement = await authCall('/token?grant_type=password', users.b);
  const replacementPrincipal = await lane.bind(replacement.access_token);
  assert.notEqual(replacementPrincipal, originalMembershipB.principalId);
  await assert.rejects(
    () => lane.read(replacement.access_token, membershipChecks.organizationB),
    (error) =>
      error instanceof MembershipLaneError &&
      error.message === 'Membership operation denied',
  );
  console.log(
    'PASS actual Auth deletion retains historical principal; same-email account inherits no membership',
  );
  console.log(
    'R2.2b disposable checks passed; production routes and SQLite unchanged.',
  );
} catch (error) {
  // Docker arguments and assertion values may contain synthetic secrets: never print them.
  console.error(
    `R2.2b failed during ${stage} (${error instanceof assert.AssertionError ? 'assertion' : 'fixture/protocol'}).`,
  );
  if (typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code))
    console.error(`Failure code: ${error.code}`);
  process.exitCode = 1;
} finally {
  await pool?.end();
  await migrator?.end().catch(() => undefined);
  await authOwner?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  for (const name of [auth, database]) {
    try {
      docker('rm', '-f', name);
    } catch {
      /* only resources owned by this run */
    }
  }
  try {
    docker('network', 'rm', network);
  } catch {
    /* startup may not have created it */
  }
}
