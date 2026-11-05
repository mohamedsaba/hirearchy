import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  generateKeyPairSync,
  randomUUID,
  randomBytes,
  createHmac,
} from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const dataDir = join(rootDir, '.data', 'local-staging');

const networkName = 'hirearchy-local-staging-net';
const pgContainer = 'hirearchy-local-staging-pg';
const authContainer = 'hirearchy-local-staging-auth';
const pgPort = 5433;
const authPort = 9998;
const appPort = 3005;
const postgresPassword = 'staging-local-password-123';
const candidatePassword = randomBytes(32).toString('hex');
const jwtSecret = 'staging-local-jwt-secret-at-least-32-chars-long!';
const image = 'hirearchy-staging-postgres-local:latest';
const authImage = 'supabase/gotrue:v2.197.0';

const docker = (...args) =>
  execFileSync('docker', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();

let networkCreated = false;
const createdContainers = [];
let appPid;

process.on('exit', (code) => {
  if (
    code === 0 ||
    (!networkCreated && createdContainers.length === 0 && !appPid)
  ) {
    return;
  }
  const retained = [
    ...createdContainers.map((name) => 'container ' + name),
    ...(networkCreated ? ['network ' + networkName] : []),
    ...(appPid ? ['loopback app process ' + appPid] : []),
  ];
  console.error(
    'Startup failed; resources created by this run are retained: ' +
      retained.join(', '),
  );
});

function resourceNames(output) {
  return new Set(
    output
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      reject(
        new Error(
          'Refusing to start local staging: 127.0.0.1:' +
            port +
            ' is unavailable (' +
            (error.code ?? error.message) +
            ').',
        ),
      );
    });
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

async function preflightResources() {
  const containers = resourceNames(
    docker('ps', '--all', '--format', '{{.Names}}'),
  );
  const networks = resourceNames(
    docker('network', 'ls', '--format', '{{.Name}}'),
  );
  const conflicts = [
    ...[authContainer, pgContainer]
      .filter((name) => containers.has(name))
      .map((name) => 'container ' + name),
    ...(networks.has(networkName) ? ['network ' + networkName] : []),
  ];
  if (conflicts.length > 0) {
    throw new Error(
      'Refusing to overwrite existing local staging resources: ' +
        conflicts.join(', ') +
        '. Stop or remove only resources you own, then retry.',
    );
  }

  for (const port of [pgPort, authPort, appPort]) {
    await assertPortAvailable(port);
  }
}

async function waitFor(check, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await check()) return;
    } catch {
      /* wait */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Readiness check timed out after ${timeoutMs}ms`);
}

async function sqlFile(relativePath) {
  return readFile(join(rootDir, relativePath), 'utf8');
}

await preflightResources();
const { Client } = await import('pg');
const { applyMigrations } = await import('../database/postgres/migrate.mjs');
const { provisionStaging } = await import('./provision-staging.mjs');
await mkdir(dataDir, { recursive: true, mode: 0o700 });

console.log('Creating Docker network...');
docker('network', 'create', networkName);
networkCreated = true;

console.log(
  `Starting PostgreSQL container (${pgContainer}) on port ${pgPort}...`,
);
docker(
  'run',
  '-d',
  '--name',
  pgContainer,
  '--network',
  networkName,
  '--network-alias',
  pgContainer,
  '-p',
  `127.0.0.1:${pgPort}:5432`,
  '-e',
  `POSTGRES_PASSWORD=${postgresPassword}`,
  image,
);
createdContainers.push(pgContainer);

await waitFor(() =>
  docker('exec', pgContainer, 'pg_isready', '-U', 'postgres').includes(
    'accepting connections',
  ),
);

await waitFor(async () => {
  const probe = new Client({
    host: '127.0.0.1',
    port: pgPort,
    user: 'postgres',
    password: postgresPassword,
    database: 'postgres',
    connectionTimeoutMillis: 1000,
  });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    return true;
  } finally {
    await probe.end().catch(() => {});
  }
});

const adminClient = new Client({
  host: '127.0.0.1',
  port: pgPort,
  user: 'postgres',
  password: postgresPassword,
  database: 'postgres',
});
await adminClient.connect();

console.log('Bootstrapping internal PostgreSQL roles and verifier...');
for (const file of [
  'database/postgres/bootstrap-roles.sql',
  'database/postgres/bootstrap-internal-roles.sql',
  'database/postgres/staging/bootstrap-verifier.sql',
]) {
  await adminClient.query(await sqlFile(file));
}

await adminClient.query(
  `ALTER ROLE hirearchy_migrator PASSWORD '${postgresPassword}'; ALTER ROLE r23_gateway PASSWORD '${postgresPassword}'; ALTER ROLE app_candidate_gateway PASSWORD '${candidatePassword}'`,
);

console.log('Applying database migrations...');
const migratorClient = new Client({
  host: '127.0.0.1',
  port: pgPort,
  user: 'hirearchy_migrator',
  password: postgresPassword,
  database: 'postgres',
});
await migratorClient.connect();
await applyMigrations(migratorClient);
await migratorClient.end();

console.log('Creating auth roles...');
await adminClient.query(
  `CREATE ROLE supabase_auth_admin LOGIN PASSWORD '${postgresPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN`,
);
await adminClient.query('CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin');
await adminClient.query('ALTER ROLE supabase_auth_admin SET search_path=auth');

console.log(
  `Starting GoTrue container (${authContainer}) on port ${authPort}...`,
);
const authExternalUrl = `http://127.0.0.1:${authPort}`;
docker(
  'run',
  '-d',
  '--name',
  authContainer,
  '--network',
  networkName,
  '-p',
  `127.0.0.1:${authPort}:9999`,
  ...Object.entries({
    GOTRUE_API_HOST: '0.0.0.0',
    PORT: '9999',
    API_EXTERNAL_URL: authExternalUrl,
    GOTRUE_SITE_URL: `http://127.0.0.1:${appPort}`,
    GOTRUE_DB_DRIVER: 'postgres',
    GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:${postgresPassword}@${pgContainer}:5432/postgres?sslmode=disable`,
    GOTRUE_DB_NAMESPACE: 'auth',
    GOTRUE_JWT_SECRET: jwtSecret,
    GOTRUE_JWT_ISSUER: authExternalUrl,
    GOTRUE_JWT_EXP: '3600',
    GOTRUE_JWT_AUD: 'authenticated',
    GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
    GOTRUE_DISABLE_SIGNUP: 'true',
    GOTRUE_MAILER_AUTOCONFIRM: 'true',
    GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
  }).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
  authImage,
);
createdContainers.push(authContainer);

await waitFor(async () => {
  const res = await fetch(`${authExternalUrl}/health`);
  return res.ok;
});

console.log('Installing staging API and proof verification engine...');
await adminClient.query(
  await sqlFile('database/postgres/staging/install-api.sql'),
);

console.log('Generating Ed25519 signing keypair for operation proof...');
const keys = generateKeyPairSync('ed25519');
const proofKeyId = 'local-staging-key-1';
const proofIssuer = 'hirearchy-staging';
const proofAudience = 'hirearchy-postgres';

await adminClient.query(
  "INSERT INTO hirearchy.staging_verification_keys(key_id,issuer,audience,public_key,valid_from,valid_until) VALUES($1,$2,$3,$4,now()-interval '1 minute',now()+interval '30 days')",
  [
    proofKeyId,
    proofIssuer,
    proofAudience,
    keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ],
);

function adminJwt() {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      role: 'service_role',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 86400,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', jwtSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const organizationId = '00000000-0000-4000-8000-000000000001';
const testPassword = 'StagingPassword123!';

const provisioningInput = {
  organizationId,
  users: [
    {
      email: 'recruiter@staging.test',
      password: testPassword,
      role: 'recruiter',
    },
    {
      email: 'reviewer@staging.test',
      password: testPassword,
      role: 'reviewer',
    },
    {
      email: 'other-reviewer@staging.test',
      password: testPassword,
      role: 'reviewer',
    },
  ],
};

console.log('Provisioning test organization and named accounts...');
const provisioned = await provisionStaging(
  adminClient,
  authExternalUrl,
  adminJwt(),
  provisioningInput,
);

console.log('Provisioned users:', provisioned.users);

// Seed a sample submitted session with private review data for testing evaluator experience
console.log('Starting Next.js production app on port 3005...');
const appEnv = {
  ...process.env,
  PORT: String(appPort),
  HIREARCHY_RUNTIME_PROFILE: 'staging-authenticated',
  STAGING_AUTH_URL: authExternalUrl,
  STAGING_AUTH_ISSUER: authExternalUrl,
  STAGING_AUTH_AUDIENCE: 'authenticated',
  STAGING_DATABASE_URL: `postgres://r23_gateway:${postgresPassword}@127.0.0.1:${pgPort}/postgres`,
  STAGING_CANDIDATE_DATABASE_URL: `postgres://app_candidate_gateway:${candidatePassword}@127.0.0.1:${pgPort}/postgres`,
  STAGING_PROOF_PRIVATE_KEY: keys.privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .toString('base64'),
  STAGING_PROOF_ISSUER: proofIssuer,
  STAGING_PROOF_AUDIENCE: proofAudience,
  STAGING_PROOF_KEY_ID: proofKeyId,
  STAGING_PUBLIC_ORIGIN: `http://127.0.0.1:${appPort}`,
};

const appProcess = spawn(
  process.execPath,
  [
    'node_modules/next/dist/bin/next',
    'start',
    'apps/web',
    '-H',
    '127.0.0.1',
    '-p',
    String(appPort),
  ],
  {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: appEnv,
    detached: true,
  },
);
appPid = appProcess.pid;

let appLog = '';
appProcess.stdout.on('data', (d) => {
  appLog += d;
});
appProcess.stderr.on('data', (d) => {
  appLog += d;
});

await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:${appPort}/api/health`);
  return res.ok;
});
console.log(
  `Next.js server is healthy and responding on http://127.0.0.1:${appPort}`,
);

const login = async (email, password) => {
  const res = await fetch(`${authExternalUrl}/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `GoTrue login for ${email}`);
  return (await res.json()).access_token;
};

const call = async (token, op, args, expected = 200) => {
  const res = await fetch(`http://127.0.0.1:${appPort}/api/staging/v1`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ op, args }),
  });
  assert.equal(res.status, expected, `${op} status ${res.status}`);
  return res.json();
};

const recruiterToken = await login(
  provisioningInput.users[0].email,
  testPassword,
);
const reviewerToken = await login(
  provisioningInput.users[1].email,
  testPassword,
);
const otherReviewerToken = await login(
  provisioningInput.users[2].email,
  testPassword,
);

await call(recruiterToken, 'session.open', { organizationId });
await call(reviewerToken, 'session.open', { organizationId });
await call(otherReviewerToken, 'session.open', { organizationId });

const content = {
  title: 'Backend Systems Engineering Assessment',
  brief:
    'Implement high-concurrency event queue and verify idempotency and dead-letter handling.',
  expectedBehavior: [
    'Process queue events in FIFO order.',
    'Route malformed events to DLQ.',
  ],
  acceptanceCriteria: [
    'All events processed with zero data loss.',
    'No memory leaks under load.',
  ],
  primaryFilePath: 'src/service.py',
  starterFiles: [
    {
      path: 'src/service.py',
      content: '# Service implementation\ndef notify():\n    pass\n',
    },
  ],
  durationMinutes: 60,
  terminalEnabled: true,
  integratedAi: false,
  rubric: [
    {
      id: 'correctness',
      label: 'Correctness',
      description: 'Queue preserves idempotency and delivery guarantees.',
      weight: 100,
      applicability: { kind: 'always', rule: 'Applies to all attempts' },
    },
  ],
};

// 1. Create and issue CREATED session
const { assessmentId } = await call(recruiterToken, 'assessment.create', {
  organizationId,
  content,
});
await call(recruiterToken, 'assessment.validate', {
  organizationId,
  assessmentId,
});
const { sessionId: createdSessionId } = await call(
  recruiterToken,
  'assessment.issue',
  {
    organizationId,
    assessmentId,
    reviewerPrincipalId: provisioned.users[1].principalId,
  },
);
console.log(
  `Issued CREATED session: ${createdSessionId} (assigned to ${provisioned.users[1].email})`,
);

// 2. Create and issue second session, then transition to SUBMITTED with private reviewer data
const { assessmentId: assessmentId2 } = await call(
  recruiterToken,
  'assessment.create',
  { organizationId, content },
);
await call(recruiterToken, 'assessment.validate', {
  organizationId,
  assessmentId: assessmentId2,
});
const { sessionId: submittedSessionId } = await call(
  recruiterToken,
  'assessment.issue',
  {
    organizationId,
    assessmentId: assessmentId2,
    reviewerPrincipalId: provisioned.users[1].principalId,
  },
);

// Assign second reviewer as well
await adminClient.query(
  'INSERT INTO hirearchy.reviewer_assignments(id, organization_id, session_id, reviewer_principal_id, assigned_by_principal_id) VALUES($1, $2, $3, $4, $5)',
  [
    randomUUID(),
    organizationId,
    submittedSessionId,
    provisioned.users[2].principalId,
    provisioned.users[0].principalId,
  ],
);

// Insert private packets for both reviewers
await adminClient.query(
  'INSERT INTO hirearchy.evaluator_review_packets(organization_id, session_id, author_principal_id, summary) VALUES($1, $2, $3, $4)',
  [
    organizationId,
    submittedSessionId,
    provisioned.users[1].principalId,
    `private-${provisioned.users[1].principalId}`,
  ],
);
await adminClient.query(
  'INSERT INTO hirearchy.evaluator_review_packets(organization_id, session_id, author_principal_id, summary) VALUES($1, $2, $3, $4)',
  [
    organizationId,
    submittedSessionId,
    provisioned.users[2].principalId,
    `private-${provisioned.users[2].principalId}`,
  ],
);

// Update session to SUBMITTED
await adminClient.query(
  "UPDATE hirearchy.assessment_sessions SET status='SUBMITTED', activated_at=now(), submitted_at=now(), closure_reason='candidate_submission', review_process_status='not_started' WHERE id=$1",
  [submittedSessionId],
);

// Add submitted timeline event
await adminClient.query(
  'INSERT INTO hirearchy.candidate_session_events(organization_id, session_id, sequence, event_type, happened_at, payload) VALUES($1, $2, 1, \'SESSION_SUBMITTED\', now(), \'{"submission":"complete"}\')',
  [organizationId, submittedSessionId],
);

// Insert private observations for both reviewers
await adminClient.query(
  "INSERT INTO hirearchy.evaluator_observations(organization_id, session_id, author_principal_id, evidence_source_type, event_sequence, evidence_digest, body) VALUES($1, $2, $3, 'timeline_event', 1, $4, $5)",
  [
    organizationId,
    submittedSessionId,
    provisioned.users[1].principalId,
    'a'.repeat(64),
    `private-${provisioned.users[1].principalId}`,
  ],
);
await adminClient.query(
  "INSERT INTO hirearchy.evaluator_observations(organization_id, session_id, author_principal_id, evidence_source_type, event_sequence, evidence_digest, body) VALUES($1, $2, $3, 'timeline_event', 1, $4, $5)",
  [
    organizationId,
    submittedSessionId,
    provisioned.users[2].principalId,
    'b'.repeat(64),
    `private-${provisioned.users[2].principalId}`,
  ],
);

await adminClient.query(
  `INSERT INTO hirearchy.evaluator_observation_history
  (observation_id,organization_id,session_id,author_principal_id,version,body,evidence_source_type,event_sequence,file_path,file_version,evidence_digest,visibility,valid_from,valid_until)
  SELECT id,organization_id,session_id,author_principal_id,version,body,evidence_source_type,event_sequence,file_path,file_version,evidence_digest,visibility,created_at,clock_timestamp()
  FROM hirearchy.evaluator_observations WHERE session_id=$1`,
  [submittedSessionId],
);
await adminClient.query(
  `INSERT INTO hirearchy.evaluator_review_packet_history
  (packet_id,organization_id,session_id,author_principal_id,status,version,summary,strengths,concerns,unresolved_questions,referenced_observation_ids,referenced_evidence,finalized_at,final_digest,valid_from,valid_until)
  SELECT id,organization_id,session_id,author_principal_id,status,version,summary,strengths,concerns,unresolved_questions,referenced_observation_ids,referenced_evidence,finalized_at,final_digest,created_at,clock_timestamp()
  FROM hirearchy.evaluator_review_packets WHERE session_id=$1`,
  [submittedSessionId],
);

console.log(`Created and seeded SUBMITTED session: ${submittedSessionId}`);

const statusInfo = {
  appUrl: `http://127.0.0.1:${appPort}`,
  authUrl: authExternalUrl,
  postgresPort: pgPort,
  appPid: appProcess.pid,
  organizationId,
  users: {
    recruiter: {
      email: 'recruiter@staging.test',
      password: testPassword,
      role: 'recruiter',
      principalId: provisioned.users[0].principalId,
    },
    assignedReviewer: {
      email: 'reviewer@staging.test',
      password: testPassword,
      role: 'reviewer',
      principalId: provisioned.users[1].principalId,
    },
    unassignedReviewer: {
      email: 'other-reviewer@staging.test',
      password: testPassword,
      role: 'reviewer',
      principalId: provisioned.users[2].principalId,
    },
  },
  sessions: {
    createdSessionId,
    submittedSessionId,
  },
};

await writeFile(
  join(dataDir, 'status.json'),
  JSON.stringify(statusInfo, null, 2),
  { encoding: 'utf8', mode: 0o600 },
);
await chmod(join(dataDir, 'status.json'), 0o600);
await adminClient.end();

console.log('\n======================================================');
console.log('HIREARCHY R2.15 STAGING ENVIRONMENT RUNNING');
console.log('======================================================');
console.log(`App URL: http://127.0.0.1:${appPort}/r23/login`);
console.log(`Recruiter: ${provisioningInput.users[0].email} / ${testPassword}`);
console.log(
  `Assigned Evaluator: ${provisioningInput.users[1].email} / ${testPassword}`,
);
console.log(
  `Unassigned Evaluator: ${provisioningInput.users[2].email} / ${testPassword}`,
);
console.log(`Organization ID: ${organizationId}`);
console.log(`Created Session: ${createdSessionId}`);
console.log(`Submitted Session: ${submittedSessionId}`);
console.log('======================================================\n');
process.exit(0);
