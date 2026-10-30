// Disposable Auth protocol proof; no application routes or configured credentials.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { applyMigrations } from '../database/postgres/migrate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suffix = randomBytes(6).toString('hex');
const network = `hirearchy-r22-auth-${suffix}`;
const database = `${network}-db`;
const auth = `${network}-server`;
const password = randomBytes(24).toString('hex');
const jwtSecret = randomBytes(48).toString('hex');
const migratorPassword = randomBytes(24).toString('hex');
const image =
  'supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b';
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
let server;
let postgresAdmin;
let migrator;
let authAdmin;
let fixtureClient;
let base;
const call = async (path, body, token) => {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
};
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
try {
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
    'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777',
  );
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      docker('exec', database, 'psql', '-U', 'postgres', '-Atc', 'SELECT 1');
      ready = true;
      break;
    } catch {
      await delay(250);
    }
  }
  assert(ready, 'disposable PostgreSQL readiness');
  sql(`CREATE ROLE supabase_auth_admin LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
    ALTER ROLE supabase_auth_admin SET search_path = auth;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;`);
  const postgresMapping = /^127\.0\.0\.1:(\d+)$/.exec(
    docker('port', database, '5432/tcp'),
  );
  assert(postgresMapping, 'disposable PostgreSQL loopback port');
  const postgresPort = Number(postgresMapping[1]);
  postgresAdmin = new Client({
    host: '127.0.0.1',
    port: postgresPort,
    database: 'postgres',
    user: 'postgres',
    password,
    connectionTimeoutMillis: 3000,
  });
  await postgresAdmin.connect();
  await postgresAdmin.query(
    readFileSync(join(ROOT, 'database/postgres/bootstrap-roles.sql'), 'utf8'),
  );
  await postgresAdmin.query(
    `ALTER ROLE hirearchy_migrator PASSWORD '${migratorPassword}'`,
  );
  migrator = new Client({
    host: '127.0.0.1',
    port: postgresPort,
    database: 'postgres',
    user: 'hirearchy_migrator',
    password: migratorPassword,
    connectionTimeoutMillis: 3000,
  });
  await migrator.connect();
  const foundation = await applyMigrations(migrator);
  assert(
    foundation.appliedVersions.includes('0001'),
    'actual foundation migration applied to Auth fixture database',
  );
  await migrator.end();
  migrator = undefined;
  await postgresAdmin.end();
  postgresAdmin = undefined;
  docker(
    'run',
    '-d',
    '--name',
    auth,
    '--network',
    network,
    '-p',
    '127.0.0.1::9999',
    '-e',
    'GOTRUE_API_HOST=0.0.0.0',
    '-e',
    'PORT=9999',
    '-e',
    'API_EXTERNAL_URL=http://127.0.0.1:9999',
    '-e',
    'GOTRUE_SITE_URL=http://localhost:3000',
    '-e',
    'GOTRUE_DB_DRIVER=postgres',
    '-e',
    `GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${password}@db:5432/postgres?sslmode=disable`,
    '-e',
    'GOTRUE_DB_NAMESPACE=auth',
    '-e',
    `GOTRUE_JWT_SECRET=${jwtSecret}`,
    '-e',
    'GOTRUE_JWT_EXP=3600',
    '-e',
    'GOTRUE_JWT_AUD=authenticated',
    '-e',
    'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated',
    '-e',
    'GOTRUE_DISABLE_SIGNUP=false',
    '-e',
    'GOTRUE_MAILER_AUTOCONFIRM=true',
    '-e',
    'GOTRUE_EXTERNAL_EMAIL_ENABLED=true',
    image,
  );
  const mapping = docker('port', auth, '9999/tcp');
  base = `http://${mapping}`;
  ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if (
        (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }))
          .ok
      ) {
        ready = true;
        break;
      }
    } catch {
      /* startup only */
    }
    await delay(250);
  }
  assert(ready, 'disposable Auth readiness');
  const credentials = { email: `synthetic-${suffix}@example.test`, password };
  const signup = await call('/signup', credentials);
  assert.equal(signup.status, 200, 'synthetic signup');
  const login = await call('/token?grant_type=password', credentials);
  assert.equal(login.status, 200, 'password login');
  const first = login.body;
  assert(first.access_token && first.refresh_token && first.user.id);
  const claims = JSON.parse(
    Buffer.from(first.access_token.split('.')[1], 'base64url'),
  );
  assert.equal(claims.sub, first.user.id);
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert(
    uuid.test(claims.sub) && uuid.test(claims.session_id),
    'Auth-issued UUID claims',
  );
  assert.equal(
    (await call('/user', undefined, first.access_token)).status,
    200,
  );
  assert.equal(
    sql(
      `SELECT count(*) FROM auth.sessions WHERE id='${claims.session_id}' AND user_id='${claims.sub}'`,
    ),
    '1',
  );

  // This is an isolated transport fixture, not the production Auth adapter or a browser test.
  let refreshToken = first.refresh_token;
  let accessToken = first.access_token;
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.origin, 'https://hirearchy.example.test');
      assert.equal(request.headers.cookie, 'fixture_csrf=bound');
      assert.equal(request.headers['x-csrf-token'], 'bound');
      const refreshed = await call('/token?grant_type=refresh_token', {
        refresh_token: refreshToken,
      });
      assert.equal(refreshed.status, 200);
      accessToken = refreshed.body.access_token;
      refreshToken = refreshed.body.refresh_token;
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader(
        'Set-Cookie',
        `fixture_auth=${refreshToken}; Secure; HttpOnly; SameSite=Lax; Path=/`,
      );
      response.end(JSON.stringify({ authenticated: true }));
    } catch {
      response.statusCode = 403;
      response.setHeader('Cache-Control', 'private, no-store');
      response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const gateway = `http://127.0.0.1:${server.address().port}`;
  const denied = await fetch(gateway, { method: 'POST' });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('set-cookie'), null);
  const refreshed = await fetch(gateway, {
    method: 'POST',
    headers: {
      Origin: 'https://hirearchy.example.test',
      Cookie: 'fixture_csrf=bound',
      'X-CSRF-Token': 'bound',
    },
  });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.headers.get('cache-control'), 'private, no-store');
  const cookie = refreshed.headers.get('set-cookie');
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/'])
    assert(cookie.includes(flag));
  assert(!cookie.includes('Domain='), 'host-only cookie');
  assert.deepEqual(await refreshed.json(), { authenticated: true });
  assert.notEqual(refreshToken, first.refresh_token, 'refresh rotation');
  assert.equal((await call('/user', undefined, accessToken)).status, 200);
  const logout = await call('/logout?scope=local', {}, accessToken);
  assert.equal(logout.status, 204);
  assert.equal(
    sql(`SELECT count(*) FROM auth.sessions WHERE id='${claims.session_id}'`),
    '0',
  );
  assert.equal(
    (await call('/user', undefined, accessToken)).status,
    403,
    'revoked session fails Auth server validation',
  );
  assert.equal(
    (await call('/user', undefined, first.access_token)).status,
    403,
    'original login JWT also denied after signout',
  );
  const fixturePassword = randomBytes(24).toString('hex');
  const principalId = randomUUID();
  const organizationId = randomUUID();
  sql(
    `CREATE ROLE r22_auth_probe LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${fixturePassword}'`,
  );
  authAdmin = new Client({
    host: '127.0.0.1',
    port: postgresPort,
    database: 'postgres',
    user: 'supabase_auth_admin',
    password,
    connectionTimeoutMillis: 3000,
  });
  await authAdmin.connect();
  const authAdminIdentity = await authAdmin.query(
    `SELECT current_user AS role_name, rolsuper
       FROM pg_catalog.pg_roles
      WHERE rolname = current_user`,
  );
  assert.deepEqual(authAdminIdentity.rows, [
    { role_name: 'supabase_auth_admin', rolsuper: false },
  ]);
  await authAdmin.query('GRANT USAGE ON SCHEMA auth TO hirearchy_migrator');
  await authAdmin.query(
    'GRANT REFERENCES (id) ON auth.users TO hirearchy_migrator',
  );
  migrator = new Client({
    host: '127.0.0.1',
    port: postgresPort,
    database: 'postgres',
    user: 'hirearchy_migrator',
    password: migratorPassword,
    connectionTimeoutMillis: 3000,
  });
  await migrator.connect();
  await migrator.query(`
    ALTER TABLE hirearchy.application_principals
      ADD CONSTRAINT r22_auth_users_fk
      FOREIGN KEY (auth_user_id) REFERENCES auth.users (id) ON DELETE SET NULL
  `);
  await migrator.query('GRANT USAGE ON SCHEMA hirearchy TO r22_auth_probe');
  await migrator.query(
    'GRANT SELECT, INSERT ON hirearchy.organizations TO r22_auth_probe',
  );
  await migrator.query(
    'GRANT SELECT, INSERT ON hirearchy.application_principals TO r22_auth_probe',
  );
  await migrator.query(
    'GRANT SELECT, INSERT ON hirearchy.organization_memberships TO r22_auth_probe',
  );
  for (const table of [
    'organizations',
    'application_principals',
    'organization_memberships',
  ]) {
    await migrator.query(`
      CREATE POLICY r22_auth_probe_access ON hirearchy.${table}
      FOR ALL TO r22_auth_probe USING (true) WITH CHECK (true)
    `);
  }
  await migrator.end();
  migrator = undefined;
  fixtureClient = new Client({
    host: '127.0.0.1',
    port: postgresPort,
    database: 'postgres',
    user: 'r22_auth_probe',
    password: fixturePassword,
    connectionTimeoutMillis: 3000,
  });
  await fixtureClient.connect();
  await fixtureClient.query(
    'INSERT INTO hirearchy.organizations (id) VALUES ($1)',
    [organizationId],
  );
  await fixtureClient.query(
    'INSERT INTO hirearchy.application_principals (id, auth_user_id) VALUES ($1, $2)',
    [principalId, claims.sub],
  );
  await fixtureClient.query(
    `INSERT INTO hirearchy.organization_memberships
       (organization_id, principal_id, role, status, joined_at, revoked_at, version)
     VALUES ($1, $2, 'recruiter', 'active', pg_catalog.clock_timestamp(), NULL, 1)`,
    [organizationId, principalId],
  );
  assert.equal(
    sql(
      `SELECT has_table_privilege('r22_auth_probe','auth.sessions','SELECT')`,
    ),
    'f',
  );
  assert.equal(
    sql(
      `SELECT has_table_privilege('supabase_auth_admin','hirearchy.application_principals','UPDATE')`,
    ),
    'f',
    'Auth role receives no application-table update grant',
  );
  const deleted = await authAdmin.query(
    'DELETE FROM auth.users WHERE id = $1',
    [claims.sub],
  );
  assert.equal(deleted.rowCount, 1, 'delete actual Auth user as Auth owner');
  const tombstone = await fixtureClient.query(
    'SELECT id, auth_user_id FROM hirearchy.application_principals WHERE id = $1',
    [principalId],
  );
  assert.deepEqual(tombstone.rows, [{ id: principalId, auth_user_id: null }]);
  const membership = await fixtureClient.query(
    `SELECT organization_id, principal_id
       FROM hirearchy.organization_memberships
      WHERE organization_id = $1 AND principal_id = $2`,
    [organizationId, principalId],
  );
  assert.deepEqual(membership.rows, [
    { organization_id: organizationId, principal_id: principalId },
  ]);
  await assert.rejects(
    fixtureClient.query(
      'INSERT INTO hirearchy.application_principals (id, auth_user_id) VALUES ($1, $2)',
      [randomUUID(), claims.sub],
    ),
    (error) => error.code === '23503',
    'a deleted Auth subject cannot be reused',
  );
  const signupAgain = await call('/signup', credentials);
  assert.equal(
    signupAgain.status,
    200,
    'same-email signup after Auth deletion',
  );
  const replacement = await call('/token?grant_type=password', credentials);
  assert.equal(replacement.status, 200, 'same-email login after Auth deletion');
  assert.notEqual(
    replacement.body.user.id,
    claims.sub,
    'a recreated email receives a new Auth subject',
  );
  const replacementPrincipal = await fixtureClient.query(
    'SELECT id FROM hirearchy.application_principals WHERE auth_user_id = $1',
    [replacement.body.user.id],
  );
  assert.deepEqual(
    replacementPrincipal.rows,
    [],
    'new same-email Auth subject receives no prior principal or memberships',
  );
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        authImage: image,
        checks: [
          'Auth-managed users/sessions schema',
          'actual foundation bootstrap and migration in the Auth database',
          'subject/session binding',
          'Auth-server getUser equivalent',
          'refresh rotation through server transport fixture',
          'cookie attributes and no-store',
          'Origin/CSRF negative',
          'local signout removes session and rejects old JWT',
          'non-superuser Auth owner grants FK prerequisites to hirearchy_migrator',
          'fixture-only role and policies write the actual foundation tables',
          'auth.users deletion triggers the foundation principal tombstone',
          'historical membership survives Auth deletion',
          'deleted Auth subject cannot be reused',
          'same-email recreation receives no prior principal or membership',
          'fixture role has no auth.sessions SELECT',
          'Auth owner has no application-table UPDATE grant',
        ],
        limitations: [
          'self-hosted Auth on vanilla PostgreSQL, not hosted Supabase grants',
          'transport fixture is not browser cookie enforcement, PKCE, concurrent refresh, MFA or production integration',
          'managed auth.sessions helper privileges and external pool remain unverified',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  // Never print Docker errors: command arguments can contain disposable credentials.
  console.error(
    `Supabase Auth proof failed (${error instanceof assert.AssertionError ? 'assertion' : 'infrastructure/protocol'}); no token diagnostics emitted.`,
  );

  process.exitCode = 1;
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await Promise.all(
    [fixtureClient, migrator, authAdmin, postgresAdmin]
      .filter(Boolean)
      .map((client) => client.end().catch(() => undefined)),
  );
  for (const name of [auth, database]) {
    try {
      docker('rm', '-f', name);
    } catch {
      /* only owned disposable names */
    }
  }
  try {
    docker('network', 'rm', network);
  } catch {
    /* no unrelated cleanup */
  }
}
