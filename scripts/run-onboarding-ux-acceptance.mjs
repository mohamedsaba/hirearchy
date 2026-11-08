// Self-Service Onboarding Visual, Responsive & Browser UX Acceptance Runner
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { runOnboardingUxAcceptanceWalkthrough } from '../tests/browser/onboarding-ux-acceptance.mjs';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
  mkdirSync,
  openSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { initializeCandidateTokenStorage } from '../database/postgres/r23/adapter.mjs';
import { applyMigrations } from '../database/postgres/migrate.mjs';

const pgImage = 'hirearchy-staging-postgres-local:latest';
const authImage =
  'supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b';
const network = `hirearchy-onboard-${randomBytes(8).toString('hex')}`;
const database = `${network}-db`;
const auth = `${network}-auth`;
const password = randomBytes(32).toString('hex');
const runtimePassword = randomBytes(32).toString('hex');
const executorRuntimePassword = randomBytes(32).toString('hex');
const jwtSecret = randomBytes(48).toString('hex');
const issuer = 'https://auth.hirearchy.test/auth/v1';
const audience = 'authenticated';

const docker = (...args) => {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (err.stderr) console.error('Docker stderr:', err.stderr);
    throw err;
  }
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

const waitFor = async (predicate, timeoutMs = 45000, intervalMs = 250) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {}
    await delay(intervalMs);
  }
  throw new Error('Condition timed out');
};

let admin;
let migrator;
let authOwner;
let executorServiceProcess;
let executorConfigPath;
let stage = 'docker network';

try {
  docker('network', 'create', network);
  stage = 'PostgreSQL container';
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
  for (const file of [
    '../database/postgres/bootstrap-roles.sql',
    '../database/postgres/bootstrap-internal-roles.sql',
    '../database/postgres/staging/bootstrap-verifier.sql',
  ]) {
    await admin.query(readFileSync(new URL(file, import.meta.url), 'utf8'));
  }
  sql(`ALTER ROLE hirearchy_migrator PASSWORD '${password}';
    ALTER ROLE app_evaluator PASSWORD '${runtimePassword}';
    ALTER ROLE app_candidate_gateway PASSWORD '${runtimePassword}';
    ALTER ROLE app_control_worker PASSWORD '${runtimePassword}';
    ALTER ROLE r23_gateway LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE supabase_auth_admin LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
    ALTER ROLE supabase_auth_admin SET search_path = auth;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE ROLE restricted_executor_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
    CREATE ROLE restricted_executor_runtime LOGIN NOINHERIT PASSWORD '${executorRuntimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION CONNECTION LIMIT 12;`);

  sql('CREATE DATABASE rex_service;');
  sql(`REVOKE ALL ON DATABASE rex_service FROM PUBLIC;
    GRANT CONNECT ON DATABASE rex_service TO restricted_executor_runtime;
    GRANT CREATE ON DATABASE rex_service TO restricted_executor_owner;`);

  migrator = new Client({
    ...connection,
    user: 'hirearchy_migrator',
    password,
  });
  await migrator.connect();
  stage = 'foundation migrations (0001 through 0017)';
  await applyMigrations(migrator);
  await migrator.end();
  migrator = undefined;

  const executorAdmin = new Client({
    ...connection,
    database: 'rex_service',
    user: 'postgres',
    password,
  });
  await executorAdmin.connect();
  const executorSchemaSql = readFileSync(
    new URL('../packages/restricted-executor/schema.sql', import.meta.url),
    'utf8',
  );
  await executorAdmin.query(executorSchemaSql);
  await executorAdmin.query(
    'REVOKE CREATE ON DATABASE rex_service FROM restricted_executor_owner;',
  );
  await executorAdmin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC;');
  await executorAdmin.end();

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
  const authPortMatch = /^127\.0\.0\.1:(\d+)$/.exec(
    docker('port', auth, '9999/tcp'),
  );
  assert(authPortMatch, 'loopback-only Auth');
  const authUrl = `http://127.0.0.1:${authPortMatch[1]}`;
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

  const candidateTokenKey = randomBytes(32).toString('base64');
  await admin.query('DELETE FROM hirearchy.candidate_token_storage_meta');
  await initializeCandidateTokenStorage(admin, {
    key: Buffer.from(candidateTokenKey, 'base64'),
  });

  stage = 'Install Staging API schema';
  const installApiSql = readFileSync(
    new URL('../database/postgres/staging/install-api.sql', import.meta.url),
    'utf8',
  );
  await admin.query(installApiSql);

  const stagingKeys = generateKeyPairSync('ed25519');
  const stagingProofPrivateKey = stagingKeys.privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .toString('base64');
  await admin.query(
    "INSERT INTO hirearchy.staging_verification_keys(key_id,issuer,audience,public_key,valid_from,valid_until) VALUES($1,$2,$3,$4,now()-interval '1 minute',now()+interval '1 day')",
    [
      'rehearsal-1',
      'hirearchy-staging',
      'hirearchy-postgres',
      stagingKeys.publicKey
        .export({ format: 'der', type: 'spki' })
        .subarray(-32),
    ],
  );

  const admissionKey = {
    callerId: 'hirearchy-bridge-caller',
    keyId: 'bridge-admission-key-1',
    secret: randomBytes(32).toString('hex'),
  };
  const dispatchKey = {
    callerId: 'hirearchy-bridge-caller',
    keyId: 'bridge-dispatch-key-1',
    secret: randomBytes(32).toString('hex'),
  };

  const executorConfig = {
    host: '127.0.0.1',
    port: 0,
    database: {
      host: '127.0.0.1',
      port: connection.port,
      database: 'rex_service',
      user: 'restricted_executor_runtime',
      password: executorRuntimePassword,
    },
    admissionKeys: [admissionKey],
    dispatchKeys: [dispatchKey],
  };

  executorConfigPath = join(
    tmpdir(),
    `rex-config-${randomBytes(8).toString('hex')}.json`,
  );
  writeFileSync(executorConfigPath, JSON.stringify(executorConfig), {
    mode: 0o600,
  });
  chmodSync(executorConfigPath, 0o600);

  const serviceScript = fileURLToPath(
    new URL('../packages/restricted-executor/service.mjs', import.meta.url),
  );
  executorServiceProcess = spawn(
    process.execPath,
    [serviceScript, executorConfigPath],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );

  let servicePort = null;
  const portPromise = new Promise((resolve, reject) => {
    executorServiceProcess.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.version === 'executor-dispatch-v1' && parsed.port) {
            resolve(parsed.port);
            return;
          }
        } catch {}
      }
    });
    executorServiceProcess.on('error', reject);
    executorServiceProcess.on('exit', (code) => {
      if (!servicePort)
        reject(new Error(`Service process exited with code ${code}`));
    });
  });

  servicePort = await Promise.race([
    portPromise,
    delay(10_000).then(() => {
      throw new Error('Timed out waiting for executor service readiness');
    }),
  ]);

  const executorServiceUrl = `http://127.0.0.1:${servicePort}/v1/dispatch`;
  console.log(`[Runner] Restricted Executor ready on ${executorServiceUrl}`);

  stage = 'Self-Service Onboarding Visual Acceptance Walkthrough';
  const evidenceDir = join(
    tmpdir(),
    `hirearchy-onboard-evidence-${randomBytes(6).toString('hex')}`,
  );
  mkdirSync(evidenceDir, { recursive: true });

  let auditReportResult = null;

  const key = join(evidenceDir, 'key.pem');
  const cert = join(evidenceDir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );

  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const nextPort = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const origin = `https://127.0.0.1:${nextPort}`;

  const devLock = fileURLToPath(
    new URL('../apps/web/.next/dev/lock', import.meta.url),
  );
  try {
    rmSync(devLock, { force: true });
  } catch {}

  const nextLog = openSync(join(evidenceDir, 'next.log'), 'a', 0o600);
  const nextProcess = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      'dev',
      'apps/web',
      '-H',
      '127.0.0.1',
      '-p',
      String(nextPort),
      '--experimental-https',
      '--experimental-https-key',
      key,
      '--experimental-https-cert',
      cert,
    ],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        NEXT_TELEMETRY_DISABLED: '1',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        HIREARCHY_RUNTIME_PROFILE: 'staging-authenticated',
        HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED: 'true',
        STAGING_AUTH_URL: authUrl,
        STAGING_AUTH_ISSUER: issuer,
        STAGING_AUTH_AUDIENCE: audience,
        STAGING_DATABASE_URL: `postgres://r23_gateway:${runtimePassword}@127.0.0.1:${connection.port}/postgres`,
        STAGING_CANDIDATE_DATABASE_URL: `postgres://app_candidate_gateway:${runtimePassword}@127.0.0.1:${connection.port}/postgres`,
        HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY: candidateTokenKey,
        STAGING_PROOF_PRIVATE_KEY: stagingProofPrivateKey,
        STAGING_PROOF_ISSUER: 'hirearchy-staging',
        STAGING_PROOF_AUDIENCE: 'hirearchy-postgres',
        STAGING_PROOF_KEY_ID: 'rehearsal-1',
        STAGING_PUBLIC_ORIGIN: origin,
        HIREARCHY_R26_DISPOSABLE: '1',
        HIREARCHY_R27_DISPOSABLE: '1',
        NEXT_PUBLIC_HIREARCHY_R27_DISPOSABLE: '1',
        HIREARCHY_R28_DISPOSABLE: '1',
        HIREARCHY_R29_DISPOSABLE: '1',
        HIREARCHY_R210_DISPOSABLE: '1',
        HIREARCHY_R211_DISPOSABLE: '1',
        HIREARCHY_R212_DISPOSABLE: '1',
        NEXT_PUBLIC_HIREARCHY_R212_DISPOSABLE: '1',
        HIREARCHY_R213_DISPOSABLE: '1',
        NEXT_PUBLIC_HIREARCHY_R213_DISPOSABLE: '1',
        HIREARCHY_R214_DISPOSABLE: '1',
        NEXT_PUBLIC_HIREARCHY_R214_DISPOSABLE: '1',
        HIREARCHY_EXECUTION_BACKEND: 'restricted-executor',
        HIREARCHY_RESTRICTED_EXECUTOR_URL: executorServiceUrl,
        HIREARCHY_ADMISSION_KEY: JSON.stringify(admissionKey),
        HIREARCHY_DISPATCH_KEY: JSON.stringify(dispatchKey),
        R26_DATABASE_URL: `postgres://app_candidate_gateway:${runtimePassword}@127.0.0.1:${connection.port}/postgres`,
      },
      stdio: ['ignore', nextLog, nextLog],
    },
  );

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  let nextReady = false;
  for (let i = 0; i < 80; i++) {
    if (nextProcess.exitCode !== null) {
      throw new Error(
        `Next.js process exited with code ${nextProcess.exitCode}`,
      );
    }
    try {
      const res = await fetch(`${origin}/r23/login`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.status === 200) {
        nextReady = true;
        break;
      }
    } catch {}
    await delay(250);
  }
  if (!nextReady) {
    throw new Error('Next.js dev server failed to become ready');
  }

  try {
    auditReportResult = await runOnboardingUxAcceptanceWalkthrough({
      origin,
      admin,
      authUrl,
      users,
      candidateTokenKey,
      jwtSecret,
    });
  } finally {
    nextProcess.kill('SIGTERM');
    try {
      rmSync(devLock, { force: true });
    } catch {}
  }

  console.log('\n======================================================');
  console.log('--- SELF-SERVICE ONBOARDING UX ACCEPTANCE AUDIT REPORT ---');
  console.log('======================================================');
  console.log(`Screenshots Captured: ${auditReportResult?.steps?.length ?? 0}`);
  console.log(
    `Horizontal Overflows: ${auditReportResult?.overflows?.length ?? 0}`,
  );
  console.log(
    `Axe Violations: ${auditReportResult?.axeViolations?.length ?? 0}`,
  );
  console.log(`Page Errors: ${auditReportResult?.pageErrors?.length ?? 0}`);
  console.log(
    `Console Errors: ${auditReportResult?.consoleErrors?.length ?? 0}`,
  );

  if (auditReportResult?.overflows?.length > 0) {
    console.log('\n--- OVERFLOW FINDINGS ---');
    for (const ov of auditReportResult.overflows) {
      console.log(
        `  - ${ov.step} [${ov.viewport}]: docWidth=${ov.docWidth}px > clientWidth=${ov.clientWidth}px`,
      );
    }
  }

  if (auditReportResult?.axeViolations?.length > 0) {
    console.log('\n--- ACCESSIBILITY FINDINGS ---');
    for (const item of auditReportResult.axeViolations) {
      console.log(`  - ${item.step}:`);
      for (const v of item.violations) {
        console.log(
          `      * [${v.impact}] ${v.id}: ${v.description} (${v.nodes} nodes)`,
        );
      }
    }
  }

  assert.equal(
    auditReportResult?.overflows?.length ?? 0,
    0,
    'Zero horizontal overflows required across all viewports',
  );
  assert.equal(
    auditReportResult?.axeViolations?.length ?? 0,
    0,
    'Zero accessibility violations required across all viewports',
  );
  assert.equal(
    auditReportResult?.pageErrors?.length ?? 0,
    0,
    'Zero page errors required',
  );
  assert.equal(
    auditReportResult?.consoleErrors?.length ?? 0,
    0,
    'Zero console errors required',
  );

  console.log(
    '\nPASS: All Self-Service Onboarding UX steps verified end-to-end!',
  );
} catch (error) {
  console.error(`Runner failed during ${stage}:`, error.message);
  if (error.stack) console.error(error.stack);
  process.exitCode = 1;
} finally {
  if (executorServiceProcess) {
    try {
      executorServiceProcess.kill('SIGTERM');
    } catch {}
  }
  if (executorConfigPath) {
    try {
      unlinkSync(executorConfigPath);
    } catch {}
  }
  if (admin) {
    try {
      await admin.end();
    } catch {}
  }
  if (migrator) {
    try {
      await migrator.end();
    } catch {}
  }
  if (authOwner) {
    try {
      await authOwner.end();
    } catch {}
  }
  try {
    docker('stop', auth, database);
  } catch {}
  try {
    docker('rm', '-f', auth, database);
  } catch {}
  try {
    docker('network', 'rm', network);
  } catch {}
}
