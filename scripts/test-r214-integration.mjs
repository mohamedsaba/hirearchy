// Explicit disposable R2.14 lane. Never reads a configured database or Auth URL.
import assert from 'node:assert/strict';
import { installR27EvidenceFixture } from '../database/postgres/r27/adapter.mjs';
import { installR28RevisionFixture } from '../database/postgres/r28/adapter.mjs';
import { installR29ObservationFixture } from '../database/postgres/r29/adapter.mjs';
import { installR210ReviewPacketFixture } from '../database/postgres/r210/adapter.mjs';
import { installR211AuthoringFixture } from '../database/postgres/r211/adapter.mjs';
import { installR212AiFixture } from '../database/postgres/r212/adapter.mjs';
import { installR213ExecutionFixture } from '../database/postgres/r213/adapter.mjs';
import { installR214ExecutionFixture } from '../database/postgres/r214/adapter.mjs';
import { runR27PostgresEvidenceChecks } from '../tests/r27/postgres-evidence-check.mjs';
import { runR28PostgresRevisionChecks } from '../tests/r28/postgres-revision-check.mjs';
import { runR29PostgresObservationChecks } from '../tests/r29/postgres-observation-check.mjs';
import { runR210PostgresReviewPacketChecks } from '../tests/r210/postgres-review-packet-check.mjs';
import { runR211PostgresBuilderChecks } from '../tests/r211/postgres-builder-check.mjs';
import { runR212PostgresAiSecurityChecks } from '../tests/r212/postgres-ai-security-check.mjs';
import { runR213PostgresExecutionSecurityChecks } from '../tests/r213/postgres-execution-security-check.mjs';
import { runR214PostgresBridgeSecurityChecks } from '../tests/r214/postgres-bridge-security-check.mjs';
import { runR214BrowserBridgeJourneyChecks } from '../tests/r214/browser-bridge-journey-check.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
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
import { runR26PostgresCandidateChecks } from '../tests/r26/postgres-candidate-check.mjs';
import { runR25RequestAndBrowserChecks } from '../tests/r25/request-issuance-check.mjs';
import {
  computeCanonicalSnapshotDigest,
  signAdmissionEnvelope,
  signDispatchEnvelope,
  R214_RESTRICTED_RECIPE_DIGEST,
  R214_RESTRICTED_RECIPE_ID,
  R214_RESTRICTED_RECIPE_VERSION,
  R214_RESTRICTED_SCENARIO_REF,
  R214_RESTRICTED_SCENARIO_VERSION,
  R214_PROTOCOL_VERSION,
} from '../database/postgres/r214/adapter.mjs';

const pgImage =
  'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
const authImage =
  'supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b';
const network = `hirearchy-r214-${randomBytes(8).toString('hex')}`;
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
  throw new Error('Disposable R2.14 fixture readiness failed');
};

let admin;
let migrator;
let authOwner;
let executorServiceProcess;
let executorConfigPath;
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

  // Initialize dedicated restricted executor schema
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

  stage = 'R2.6 actual-role candidate security/finality checks';
  await runR26PostgresCandidateChecks({
    admin,
    connection,
    runtimePassword,
    candidateTokenKey,
  });

  stage = 'R2.7 fixture schema install';
  await installR27EvidenceFixture(admin);
  stage =
    'R2.7 PostgreSQL evidence collection and multi-tenant security checks';
  await runR27PostgresEvidenceChecks({
    admin,
    connection,
    runtimePassword,
    candidateTokenKey,
  });

  stage = 'R2.8 fixture schema install';
  await installR28RevisionFixture(admin);
  stage =
    'R2.8 PostgreSQL candidate revision stream and timeline security checks';
  await runR28PostgresRevisionChecks({
    admin,
    connection,
    runtimePassword,
    candidateTokenKey,
  });

  stage = 'R2.9 fixture schema install';
  await installR29ObservationFixture(admin);
  stage =
    'R2.9 PostgreSQL evaluator observations and immutable verdict-free checks';
  await runR29PostgresObservationChecks({
    admin,
    connection,
    runtimePassword,
    candidateTokenKey,
  });

  stage = 'R2.10 fixture schema install';
  await installR210ReviewPacketFixture(admin);
  stage = 'R2.10 PostgreSQL human review packet lifecycle and evidence checks';
  await runR210PostgresReviewPacketChecks({
    admin,
    connection,
    runtimePassword,
    candidateTokenKey,
  });

  stage = 'R2.11 fixture schema install';
  await installR211AuthoringFixture(admin);
  stage =
    'R2.11 PostgreSQL assessment authoring, draft concurrency, and tenant isolation checks';
  await runR211PostgresBuilderChecks({
    admin,
    connection,
    runtimePassword,
    candidateTokenKey,
  });

  stage = 'R2.12 fixture schema install';
  await installR212AiFixture(admin);
  stage = 'R2.12 PostgreSQL candidate AI security and budget checks';
  await runR212PostgresAiSecurityChecks({
    admin,
    connection,
    runtimePassword,
    candidateTokenKey,
  });

  stage = 'R2.13 fixture schema install';
  await installR213ExecutionFixture(admin);
  stage =
    'R2.13 PostgreSQL execution requests, durable operations, and evidence security checks';
  await runR213PostgresExecutionSecurityChecks({
    admin,
    connection,
    runtimePassword,
    candidateTokenKey,
  });

  stage = 'R2.14 fixture schema install';
  await installR214ExecutionFixture(admin);
  stage = 'R2.14 execution bridge PostgreSQL security checks';
  await runR214PostgresBridgeSecurityChecks({
    admin,
    connection,
    runtimePassword,
    candidateTokenKey,
  });
  console.log('PASS R2.14 10/10 PostgreSQL execution bridge security checks');

  // =========================================================================
  // End-to-End Real Restricted Executor Rehearsal
  // =========================================================================
  stage = 'Start Codex Restricted Executor Service';
  console.log(
    '--- Starting Codex Restricted Executor Service for Disposable Rehearsal ---',
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
    port: 0, // Ephemeral port
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
      throw new Error('Timed out waiting for executor service readiness line');
    }),
  ]);

  const executorServiceUrl = `http://127.0.0.1:${servicePort}/v1/dispatch`;
  console.log(
    `Codex Restricted Executor Service ready on ${executorServiceUrl}`,
  );

  stage = 'Execute Real Restricted Executor Integration Rehearsal';
  {
    const files = [
      {
        path: 'solution.py',
        content: 'def solve():\n    return "solved"\n',
      },
      {
        path: 'test_smoke.py',
        content:
          'from solution import solve\ndef test_solve():\n    assert solve() == "solved"\n',
      },
    ];
    const snapshotDigest = computeCanonicalSnapshotDigest(files);
    const intent = {
      organizationId: randomUUID(),
      sessionId: `sess_rehearsal_${randomBytes(6).toString('hex')}`,
      operationId: `op_rehearsal_${randomBytes(6).toString('hex')}`,
      requestId: `req_rehearsal_${randomBytes(6).toString('hex')}`,
      assessmentVersion: 'v3',
      persistedWorkspaceVersion: '1',
      canonicalWorkspaceSnapshotDigest: snapshotDigest,
      approvedRecipeId: R214_RESTRICTED_RECIPE_ID,
      approvedRecipeVersion: R214_RESTRICTED_RECIPE_VERSION,
      approvedRecipeDigest: R214_RESTRICTED_RECIPE_DIGEST,
      admittedAt: new Date().toISOString(),
      sessionDeadline: new Date(Date.now() + 600_000).toISOString(),
      budgets: {
        timeoutMs: 15_000,
        maxStdoutBytes: 64_000,
        maxStderrBytes: 64_000,
        maxExecutionCount: 10,
      },
      generation: 1,
      fence: 1,
      protocolVersion: R214_PROTOCOL_VERSION,
    };

    const signedAdmission = signAdmissionEnvelope({
      callerId: admissionKey.callerId,
      keyId: admissionKey.keyId,
      secret: admissionKey.secret,
      sessionRef: intent.sessionId,
      operationId: intent.operationId,
      requestId: intent.requestId,
      generation: intent.generation,
      fence: intent.fence,
      scenarioRef: R214_RESTRICTED_SCENARIO_REF,
      scenarioVersion: R214_RESTRICTED_SCENARIO_VERSION,
      snapshotDigest,
      recipeId: R214_RESTRICTED_RECIPE_ID,
      recipeVersion: R214_RESTRICTED_RECIPE_VERSION,
      recipeDigest: R214_RESTRICTED_RECIPE_DIGEST,
      timeoutMs: intent.budgets.timeoutMs,
      resources: {
        memoryBytes: 134_217_728,
        cpus: 0.25,
        pids: 16,
      },
      outputBytes: 65_536,
    });

    const runPayload = {
      requestId: intent.requestId,
      sessionRef: intent.sessionId,
      scenarioRef: R214_RESTRICTED_SCENARIO_REF,
      scenarioVersion: R214_RESTRICTED_SCENARIO_VERSION,
      files,
      snapshotDigest,
      recipeId: R214_RESTRICTED_RECIPE_ID,
      recipeVersion: R214_RESTRICTED_RECIPE_VERSION,
      recipeDigest: R214_RESTRICTED_RECIPE_DIGEST,
      timeoutMs: intent.budgets.timeoutMs,
      resources: {
        memoryBytes: 134_217_728,
        cpus: 0.25,
        pids: 16,
      },
      outputBytes: 65_536,
      authorization: signedAdmission,
    };

    const dispatchAuth = signDispatchEnvelope({
      action: 'run',
      callerId: dispatchKey.callerId,
      keyId: dispatchKey.keyId,
      secret: dispatchKey.secret,
      sessionRef: intent.sessionId,
      requestId: intent.requestId,
      requestPayload: runPayload,
    });

    console.log('Dispatching real Docker execution (assess-python pytest)...');
    const response = await fetch(executorServiceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'run',
        authorization: dispatchAuth,
        request: runPayload,
      }),
    });

    const resText = await response.text();
    console.log(
      `Executor response: status=${response.status}, body=${resText}`,
    );
    assert.equal(response.status, 200, resText);
    const data = JSON.parse(resText);
    assert.equal(data.ok, true);
    assert.ok(data.result);
    const receipt = data.result;

    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.exitCode, 0);
    assert.ok(receipt.stdout?.base64);
    const stdout = Buffer.from(receipt.stdout.base64, 'base64').toString(
      'utf8',
    );
    assert.match(stdout, /1 passed/i);
    assert.equal(receipt.cleanup?.verified, true);
    console.log(
      `Real Restricted Execution SUCCESS: pytest output captured (${receipt.stdout.byteCount} bytes), exit code 0, cleanup verified`,
    );
  }

  // =========================================================================
  // Browser & Next.js End-to-End Journey
  // =========================================================================
  stage = 'browser & application journey';
  const evidenceDir = join(
    tmpdir(),
    `hirearchy-r214-evidence-${randomBytes(6).toString('hex')}`,
  );
  mkdirSync(evidenceDir, { recursive: true });

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
    candidateChecks: runR214BrowserBridgeJourneyChecks,
    evidenceDir,
  });

  console.log(
    'PASS R2.14 real execution application bridge: PostgreSQL security checks, real Docker execution, and browser journey',
  );
} catch (error) {
  console.error(
    `R2.14 failed during ${stage} (${error instanceof assert.AssertionError ? 'assertion' : 'fixture/protocol'})`,
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
  if (executorServiceProcess) {
    try {
      executorServiceProcess.kill('SIGKILL');
    } catch {}
  }
  if (executorConfigPath) {
    try {
      unlinkSync(executorConfigPath);
    } catch {}
  }
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
    console.error('R2.14 owned test-resource cleanup failed');
    process.exitCode = 1;
  }
}
