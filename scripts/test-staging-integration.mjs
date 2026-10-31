// Owned disposable resources; real Auth and persistent application recovery.
import assert from 'node:assert/strict';
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { applyMigrations } from '../database/postgres/migrate.mjs';
import { provisionStaging } from './provision-staging.mjs';
import { checkPrivateReview } from '../tests/staging/private-review.mjs';
import { captureRelease } from '../tests/staging/release.mjs';
import {
  checkInstallerBoundary,
  checkProofBoundary,
} from '../tests/staging/security.mjs';
const name = `hirearchy-r215-${randomBytes(6).toString('hex')}`;
const image = 'hirearchy-staging-postgres-local';
const authImage =
  'supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b';
const password = randomBytes(32).toString('hex');
const jwtSecret = randomBytes(48).toString('hex');
const issuer = 'https://auth.hirearchy.test/auth/v1';
const keys = generateKeyPairSync('ed25519');
const artifact = new URL(`../.data/${name}/`, import.meta.url);
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
const sqlFile = async (file) =>
  readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const resources = [];
const volumes = [];
let networkCreated = false;
const clients = [];
let app;
let appLog = '';
let stage = 'setup';
const waitFor = async (check) => {
  for (let i = 0; i < 150; i++) {
    try {
      if (await check()) return;
    } catch {
      /* Startup only. */
    }
    await delay(200);
  }
  throw new Error('Readiness deadline exceeded');
};
async function db(container) {
  docker(
    'run',
    '-d',
    '--name',
    container,
    '--label',
    `hirearchy.r215.owner=${name}`,
    '--network',
    name,
    '--network-alias',
    container,
    '-p',
    '127.0.0.1::5432',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-v',
    `${container}-data:/var/lib/postgresql/data`,
    image,
  );
  resources.push(container);
  volumes.push(`${container}-data`);
  await waitFor(() =>
    docker('exec', container, 'pg_isready', '-U', 'postgres').includes(
      'accepting connections',
    ),
  );
  const port = Number(/:(\d+)$/.exec(docker('port', container, '5432/tcp'))[1]);
  const connect = async (user = 'postgres') => {
    const client = new Client({
      host: '127.0.0.1',
      port,
      user,
      password,
      database: 'postgres',
    });
    await client.connect();
    clients.push(client);
    return client;
  };
  return { container, port, connect, admin: await connect() };
}
async function bootstrap(target) {
  for (const file of [
    'bootstrap-roles.sql',
    'bootstrap-internal-roles.sql',
    'staging/bootstrap-verifier.sql',
  ])
    await target.admin.query(await sqlFile(`database/postgres/${file}`));
  await target.admin.query(
    `ALTER ROLE hirearchy_migrator PASSWORD '${password}'; ALTER ROLE r23_gateway PASSWORD '${password}'`,
  );
}
async function migrate(target) {
  const client = await target.connect('hirearchy_migrator');
  await applyMigrations(client);
  await client.end();
}
async function authRoles(target, schema = true) {
  await target.admin.query(
    `CREATE ROLE supabase_auth_admin LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN`,
  );
  if (schema)
    await target.admin.query(
      'CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin',
    );
  await target.admin.query(
    'ALTER ROLE supabase_auth_admin SET search_path=auth',
  );
}
async function auth(target, suffix) {
  const container = `${name}-auth-${suffix}`;
  docker(
    'run',
    '-d',
    '--name',
    container,
    '--label',
    `hirearchy.r215.owner=${name}`,
    '--network',
    name,
    '-p',
    '127.0.0.1::9999',
    ...Object.entries({
      GOTRUE_API_HOST: '0.0.0.0',
      PORT: '9999',
      API_EXTERNAL_URL: issuer,
      GOTRUE_SITE_URL: 'https://hirearchy.example.test',
      GOTRUE_DB_DRIVER: 'postgres',
      GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:${password}@${target.container}:5432/postgres?sslmode=disable`,
      GOTRUE_DB_NAMESPACE: 'auth',
      GOTRUE_JWT_SECRET: jwtSecret,
      GOTRUE_JWT_ISSUER: issuer,
      GOTRUE_JWT_EXP: '3600',
      GOTRUE_JWT_AUD: 'authenticated',
      GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
      GOTRUE_DISABLE_SIGNUP: 'true',
      GOTRUE_MAILER_AUTOCONFIRM: 'true',
      GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
    }).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    authImage,
  );
  resources.push(container);
  const port = Number(/:(\d+)$/.exec(docker('port', container, '9999/tcp'))[1]);
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${url}/health`)).ok);
  return url;
}
async function startApp(
  target,
  authUrl,
  proofKey,
  applicationDirectory = 'apps/web',
) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  appLog = '';
  app = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      'start',
      applicationDirectory,
      '-H',
      '127.0.0.1',
      '-p',
      String(port),
    ],
    {
      cwd: new URL('../', import.meta.url),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HIREARCHY_RUNTIME_PROFILE: 'staging-authenticated',
        STAGING_AUTH_URL: authUrl,
        STAGING_AUTH_ISSUER: issuer,
        STAGING_AUTH_AUDIENCE: 'authenticated',
        STAGING_DATABASE_URL: `postgres://r23_gateway:${password}@127.0.0.1:${target.port}/postgres`,
        STAGING_PROOF_PRIVATE_KEY:
          proofKey ??
          keys.privateKey
            .export({ format: 'der', type: 'pkcs8' })
            .toString('base64'),
        STAGING_PROOF_ISSUER: 'hirearchy-staging',
        STAGING_PROOF_AUDIENCE: 'hirearchy-postgres',
        STAGING_PROOF_KEY_ID: 'rehearsal-1',
      },
    },
  );
  app.stdout.on('data', (data) => {
    appLog += data;
  });
  app.stderr.on('data', (data) => {
    appLog += data;
  });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${url}/api/health`)).ok);
  return url;
}
async function stopApp() {
  if (app && app.exitCode === null) {
    app.kill('SIGTERM');
    await once(app, 'exit');
  }
  app = undefined;
}
function adminJwt() {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      role: 'service_role',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url')}`;
}
const login = async (authUrl, email, userPassword) => {
  const response = await fetch(`${authUrl}/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: userPassword }),
  });
  assert.equal(response.status, 200, 'Real GoTrue login');
  return (await response.json()).access_token;
};
const call = async (url, token, op, args, expected = 200) => {
  const response = await fetch(`${url}/api/staging/v1`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ op, args }),
  });
  assert.equal(response.status, expected, `${op} HTTP status`);
  return response.json();
};
async function restore(dump, suffix) {
  const target = await db(`${name}-${suffix}`);
  await bootstrap(target);
  await authRoles(target, false);
  await target.admin.query(
    'DROP SCHEMA hirearchy CASCADE; DROP EXTENSION plpython3u',
  );
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      target.container,
      'pg_restore',
      '-U',
      'postgres',
      '--exit-on-error',
      '-d',
      'postgres',
    ],
    {
      input: dump,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  await migrate(target);
  return target;
}
try {
  await mkdir(artifact, { recursive: true, mode: 0o700 });
  docker('image', 'inspect', image);
  docker('image', 'inspect', authImage);
  docker('network', 'create', name);
  networkCreated = true;
  const unpackRelease = await captureRelease(artifact);
  stage = 'fresh database';
  const source = await db(`${name}-source`);
  await bootstrap(source);
  await migrate(source);
  await authRoles(source);
  const authUrl = await auth(source, 'source');
  stage = 'installer rejects disposable fixture schema';
  await checkInstallerBoundary(
    source.admin,
    await sqlFile('database/postgres/staging/install-api.sql'),
  );
  await source.admin.query(
    "INSERT INTO hirearchy.staging_verification_keys(key_id,issuer,audience,public_key,valid_from,valid_until) VALUES($1,$2,$3,$4,now()-interval '1 minute',now()+interval '1 day')",
    [
      'rehearsal-1',
      'hirearchy-staging',
      'hirearchy-postgres',
      keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
    ],
  );
  const organizationId = randomUUID();
  const userPassword = randomBytes(20).toString('hex');
  const input = {
    organizationId,
    users: [
      {
        email: 'recruiter@staging.test',
        password: userPassword,
        role: 'recruiter',
      },
      {
        email: 'reviewer@staging.test',
        password: userPassword,
        role: 'reviewer',
      },
      {
        email: 'other-reviewer@staging.test',
        password: userPassword,
        role: 'reviewer',
      },
    ],
  };
  stage = 'real durable provisioning';
  const provisioned = await provisionStaging(
    source.admin,
    authUrl,
    adminJwt(),
    input,
  );
  assert.deepEqual(
    await provisionStaging(source.admin, authUrl, adminJwt(), input),
    provisioned,
  );
  const recruiter = await login(authUrl, input.users[0].email, userPassword);
  const reviewer = await login(authUrl, input.users[1].email, userPassword);
  const otherReviewer = await login(
    authUrl,
    input.users[2].email,
    userPassword,
  );
  stage = 'persistent API installation';
  await source.admin.query(
    await sqlFile('database/postgres/staging/install-api.sql'),
  );
  stage = 'database proof security';
  const gateway = await source.connect('r23_gateway');
  await checkProofBoundary(
    gateway,
    source.admin,
    keys.privateKey,
    recruiter,
    organizationId,
  );
  let appUrl = await startApp(source, authUrl);
  stage = 'verified application sessions';
  await call(appUrl, recruiter, 'session.open', { organizationId });
  await call(appUrl, reviewer, 'session.open', { organizationId });
  const journey = await import('../tests/staging/journey.mjs');
  stage = 'durable assessment journey';
  const state = await journey.createJourney({
    call,
    appUrl,
    recruiter,
    reviewer,
    organizationId,
    provisioned,
  });
  stage = 'application restart';
  await stopApp();
  appUrl = await startApp(source, authUrl);
  await journey.readJourney({
    call,
    appUrl,
    recruiter,
    reviewer,
    organizationId,
    state,
  });
  stage = 'backup snapshot';
  await stopApp();
  const dump = execFileSync(
    'docker',
    ['exec', source.container, 'pg_dump', '-U', 'postgres', '-Fc', 'postgres'],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  await writeFile(new URL('database.dump', artifact), dump, { mode: 0o600 });
  await writeFile(
    new URL('snapshot-manifest.json', artifact),
    JSON.stringify(
      {
        databaseSha256: createHash('sha256').update(dump).digest('hex'),
        sourceDirty: Boolean(
          execFileSync('git', ['status', '--porcelain'], {
            encoding: 'utf8',
          }).trim(),
        ),
        gitHead: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        image: docker('image', 'inspect', image, '--format', '{{.Id}}'),
        release: JSON.parse(
          await readFile(new URL('release-manifest.json', artifact), 'utf8'),
        ),
      },
      null,
      2,
    ),
  );
  await writeFile(
    new URL('private-recovery.json', artifact),
    JSON.stringify({
      jwtSecret,
      password,
      privateKey: keys.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
    }),
    { mode: 0o600 },
  );
  const snapshot = await readFile(new URL('database.dump', artifact));
  assert.deepEqual(
    snapshot,
    dump,
    'Saved backup bytes match the captured database',
  );
  stage = 'separate instance restore';
  const restored = await restore(snapshot, 'restored');
  const restoredAuth = await auth(restored, 'restored');
  appUrl = await startApp(restored, restoredAuth);
  await journey.readJourney({
    call,
    appUrl,
    recruiter,
    reviewer,
    organizationId,
    state,
  });
  stage = 'revocation';
  await journey.revokeJourney({
    call,
    appUrl,
    recruiter,
    reviewer,
    organizationId,
    state,
    admin: restored.admin,
    provisioned,
  });
  stage = 'failed release configuration';
  await stopApp();
  appUrl = await startApp(restored, restoredAuth, 'AA==');
  await call(appUrl, recruiter, 'session.open', { organizationId }, 503);
  stage = 'failed production artifact';
  await stopApp();
  await unpackRelease('broken-release', true);
  const restoredRelease = await unpackRelease('restored-release');
  stage = 'matching snapshot recovery';
  const rollback = await restore(snapshot, 'rollback');
  const rollbackAuth = await auth(rollback, 'rollback');
  appUrl = await startApp(rollback, rollbackAuth, undefined, restoredRelease);
  await journey.readJourney({
    call,
    appUrl,
    recruiter,
    reviewer,
    organizationId,
    state,
  });
  stage = 'private reviewer isolation regression';
  await checkPrivateReview({
    call,
    appUrl,
    recruiter,
    reviewer,
    otherReviewer,
    organizationId,
    state,
    admin: rollback.admin,
    provisioned,
  });
  await writeFile(
    new URL('result.json', artifact),
    JSON.stringify(
      {
        passed: true,
        image: docker('image', 'inspect', image, '--format', '{{.Id}}'),
        limitation:
          'Failed signing-key configuration and corrupt production artifact rolled back to retained release archive and matching snapshot; arbitrary schema downgrade is not supported.',
      },
      null,
      2,
    ),
  );
  console.log(
    `Persistent staging journey/restart/restore passed. Private recovery artifacts: ${artifact.pathname}`,
  );
} catch (error) {
  await writeFile(
    new URL('failure.txt', artifact),
    `${stage}\n${error.stack}\n${appLog}\n${resources.map((container) => `\n${container}\n${docker('logs', container)}`).join('')}`,
    { mode: 0o600 },
  );
  console.error(
    `Staging integration failed at ${stage}; private diagnostics: ${artifact.pathname}`,
  );
  process.exitCode = 1;
} finally {
  await stopApp();
  for (const client of clients) await client.end().catch(() => undefined);
  const cleanup = (kind, resource, ...args) => {
    try {
      docker(kind, ...args, resource);
    } catch {
      console.error(`Owned staging resource requires cleanup: ${resource}`);
      process.exitCode = 1;
    }
  };
  for (const container of resources.reverse()) cleanup('rm', container, '-f');
  for (const volume of volumes) cleanup('volume', volume, 'rm');
  if (networkCreated) cleanup('network', name, 'rm');
}
