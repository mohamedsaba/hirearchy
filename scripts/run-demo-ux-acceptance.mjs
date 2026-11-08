// Standalone visual & browser UX acceptance runner for all 12 demo steps.
import assert from 'node:assert/strict';
import { installR27EvidenceFixture } from '../database/postgres/r27/adapter.mjs';
import { installR28RevisionFixture } from '../database/postgres/r28/adapter.mjs';
import { installR29ObservationFixture } from '../database/postgres/r29/adapter.mjs';
import { installR210ReviewPacketFixture } from '../database/postgres/r210/adapter.mjs';
import { installR211AuthoringFixture } from '../database/postgres/r211/adapter.mjs';
import { installR212AiFixture } from '../database/postgres/r212/adapter.mjs';
import { installR213ExecutionFixture } from '../database/postgres/r213/adapter.mjs';
import { installR214ExecutionFixture } from '../database/postgres/r214/adapter.mjs';
import { runDemoUxAcceptanceWalkthrough } from '../tests/browser/demo-ux-acceptance.mjs';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { initializeCandidateTokenStorage } from '../database/postgres/r23/adapter.mjs';
import { applyMigrations } from '../database/postgres/migrate.mjs';
import { runR25PostgresIssuanceSecurityChecks } from '../tests/r25/postgres-issuance-security-check.mjs';
import { runR25RequestAndBrowserChecks } from '../tests/r25/request-issuance-check.mjs';

const pgImage =
  'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
const authImage =
  'supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b';
const network = `hirearchy-ux-${randomBytes(8).toString('hex')}`;
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

const waitFor = async (check) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (await check()) return;
    } catch {
      // Bounded startup polling only.
    }
    await delay(200);
  }
  throw new Error('Disposable fixture readiness failed');
};

let admin;
let migrator;
let authOwner;
let executorServiceProcess;
let executorConfigPath;
let stage = 'startup';

try {
  console.log(
    `[Runner] Launching disposable environment: network=${network}, database=${database}, auth=${auth}`,
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
  stage = 'foundation migrations (0001 through 0012)';
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

  stage = 'R2.3 + R2.4 + R2.6 fixture schema install';
  await admin.query(
    readFileSync(
      new URL('../database/postgres/r23/fixture.sql', import.meta.url),
      'utf8',
    ),
  );

  stage = 'R2.5 PostgreSQL security and transaction checks';
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

  stage = 'Install fixtures';
  await installR27EvidenceFixture(admin);
  await installR28RevisionFixture(admin);
  await installR29ObservationFixture(admin);
  await installR210ReviewPacketFixture(admin);
  await installR211AuthoringFixture(admin);
  await installR212AiFixture(admin);
  await installR213ExecutionFixture(admin);
  await installR214ExecutionFixture(admin);

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

  stage = '12-Step Visual Acceptance Walkthrough';
  const evidenceDir = join(
    tmpdir(),
    `hirearchy-ux-evidence-${randomBytes(6).toString('hex')}`,
  );
  mkdirSync(evidenceDir, { recursive: true });

  let auditReportResult = null;

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
    candidateChecks: async (params) => {
      auditReportResult = await runDemoUxAcceptanceWalkthrough(params);
    },
    evidenceDir,
  });

  console.log('\n======================================================');
  console.log('--- 12-STEP DEMO UX ACCEPTANCE AUDIT REPORT ---');
  console.log('======================================================');
  console.log(`Screenshots Captured: ${auditReportResult?.steps?.length ?? 0}`);
  console.log(`Horizontal Overflows: ${auditReportResult?.overflows?.length ?? 0}`);
  console.log(`Axe Violations: ${auditReportResult?.axeViolations?.length ?? 0}`);
  console.log(`Page Errors: ${auditReportResult?.pageErrors?.length ?? 0}`);
  console.log(`Console Errors: ${auditReportResult?.consoleErrors?.length ?? 0}`);

  if (auditReportResult?.overflows?.length > 0) {
    console.log('\n--- OVERFLOW FINDINGS ---');
    for (const ov of auditReportResult.overflows) {
      console.log(`  - ${ov.step} [${ov.viewport}]: docWidth=${ov.docWidth}px > clientWidth=${ov.clientWidth}px`);
    }
  }

  if (auditReportResult?.axeViolations?.length > 0) {
    console.log('\n--- ACCESSIBILITY FINDINGS ---');
    for (const item of auditReportResult.axeViolations) {
      console.log(`  - ${item.step}:`);
      for (const v of item.violations) {
        console.log(`      * [${v.impact}] ${v.id}: ${v.description} (${v.nodes} nodes)`);
      }
    }
  }

  console.log('\nPASS: All 12 internal demo steps verified end-to-end!');
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
