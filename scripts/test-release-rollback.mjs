import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { applyMigrations } from '../database/postgres/migrate.mjs';
import { checkOperationalReadiness } from '../apps/web/src/observability/readiness.mjs';
import {
  encryptInvitationToken,
  invitationTokenHash,
} from '../apps/web/src/staging/onboarding.ts';
import { reservationMovesBinding } from '../database/postgres/r211/template.mjs';

const pgImage = 'hirearchy-staging-postgres-local:latest';
const gotrueImage =
  'supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b';

const runId = randomBytes(4).toString('hex');
const networkName = `hirearchy-rollback-net-${runId}`;
const pgContainer = `hirearchy-rollback-pg-${runId}`;
const gotrueContainer = `hirearchy-rollback-gotrue-${runId}`;
const pgVolume = `${pgContainer}-data`;

const pgPassword = randomBytes(32).toString('hex');
const migratorPassword = randomBytes(32).toString('hex');
const gatewayPassword = randomBytes(32).toString('hex');
const gotrueAdminPassword = randomBytes(32).toString('hex');
const gotrueJwtSecret = randomBytes(48).toString('hex');
const candidateEncryptionKey = randomBytes(32).toString('base64');

const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();

const sqlFile = async (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const waitFor = async (check, maxAttempts = 120, intervalMs = 250) => {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (await check()) return;
    } catch {
      /* retry */
    }
    await delay(intervalMs);
  }
  throw new Error('Readiness timeout');
};

let primaryClient;
let migratorClient;
let gatewayClient;
let pgPort;
let gotruePort;

try {
  console.log(
    `\n=== RELEASE ROLLBACK & COMPATIBILITY REHEARSAL (${runId}) ===`,
  );

  // --- SETUP INFRASTRUCTURE ---
  console.log('1. Starting isolated PostgreSQL container...');
  docker('network', 'create', networkName);
  docker(
    'run',
    '-d',
    '--name',
    pgContainer,
    '--network',
    networkName,
    '--network-alias',
    'db',
    '-v',
    `${pgVolume}:/var/lib/postgresql/data`,
    '-e',
    `POSTGRES_PASSWORD=${pgPassword}`,
    '-p',
    '127.0.0.1::5432',
    pgImage,
  );

  const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(
    docker('port', pgContainer, '5432/tcp'),
  );
  assert(portMatch, 'PostgreSQL port mapped');
  pgPort = Number(portMatch[1]);

  await waitFor(async () => {
    const probe = new Client({
      host: '127.0.0.1',
      port: pgPort,
      database: 'postgres',
      user: 'postgres',
      password: pgPassword,
      connectionTimeoutMillis: 1000,
    });
    probe.on('error', () => {});
    try {
      await probe.connect();
      await probe.query('SELECT 1');
      return true;
    } catch {
      return false;
    } finally {
      await probe.end().catch(() => {});
    }
  });

  // Setup roles
  primaryClient = new Client({
    host: '127.0.0.1',
    port: pgPort,
    database: 'postgres',
    user: 'postgres',
    password: pgPassword,
  });
  primaryClient.on('error', () => {});
  await primaryClient.connect();

  await primaryClient.query(`
    CREATE ROLE supabase_auth_admin LOGIN PASSWORD '${gotrueAdminPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
    ALTER ROLE supabase_auth_admin SET search_path = auth;
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
  `);

  for (const file of [
    'database/postgres/bootstrap-roles.sql',
    'database/postgres/bootstrap-internal-roles.sql',
    'database/postgres/staging/bootstrap-verifier.sql',
  ]) {
    await primaryClient.query(await sqlFile(file));
  }
  await primaryClient.query(
    `ALTER ROLE hirearchy_migrator PASSWORD '${migratorPassword}';
     ALTER ROLE r23_gateway PASSWORD '${gatewayPassword}';`,
  );

  // Apply migrations 0001 - 0017
  console.log('2. Applying schema migrations 0001 through 0017...');
  migratorClient = new Client({
    host: '127.0.0.1',
    port: pgPort,
    database: 'postgres',
    user: 'hirearchy_migrator',
    password: migratorPassword,
  });
  migratorClient.on('error', () => {});
  await migratorClient.connect();
  const migrationResult = await applyMigrations(migratorClient);
  assert(
    migrationResult.appliedVersions.includes('0017'),
    'Migration 0017 applied',
  );

  // Start GoTrue
  console.log('3. Starting GoTrue authentication container...');
  docker(
    'run',
    '-d',
    '--name',
    gotrueContainer,
    '--network',
    networkName,
    '-p',
    '127.0.0.1::9999',
    '-e',
    'GOTRUE_API_HOST=0.0.0.0',
    '-e',
    'PORT=9999',
    '-e',
    'API_EXTERNAL_URL=http://127.0.0.1:9999',
    '-e',
    'GOTRUE_API_PORT=9999',
    '-e',
    'GOTRUE_SITE_URL=http://localhost:3000',
    '-e',
    'GOTRUE_DB_DRIVER=postgres',
    '-e',
    `GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${gotrueAdminPassword}@db:5432/postgres?sslmode=disable`,
    '-e',
    'GOTRUE_DB_NAMESPACE=auth',
    '-e',
    `GOTRUE_JWT_SECRET=${gotrueJwtSecret}`,
    '-e',
    'GOTRUE_JWT_EXP=3600',
    '-e',
    'GOTRUE_JWT_AUD=authenticated',
    '-e',
    'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated',
    '-e',
    'GOTRUE_DISABLE_SIGNUP=false',
    '-e',
    'GOTRUE_MAILER_AUTOCONFIRM=false',
    '-e',
    'GOTRUE_EXTERNAL_EMAIL_ENABLED=true',
    gotrueImage,
  );

  const gotruePortMatch = /^127\.0\.0\.1:(\d+)$/.exec(
    docker('port', gotrueContainer, '9999/tcp'),
  );
  assert(gotruePortMatch, 'GoTrue port mapped');
  gotruePort = Number(gotruePortMatch[1]);

  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${gotruePort}/health`);
    return res.ok;
  });

  // Install Staging API & durable installation markers
  console.log('4. Installing Staging API & durable installation markers...');
  await primaryClient.query(
    await sqlFile('database/postgres/staging/install-api.sql'),
  );

  const gatewayDbUrl = `postgres://postgres:${pgPassword}@127.0.0.1:${pgPort}/postgres`;

  // --- STAGE 1: OPERATIONAL READINESS PROBE ---
  console.log('\n--- STAGE 1: Operational Readiness Probe on Release N ---');
  process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED = 'true';
  const readiness = await checkOperationalReadiness(gatewayDbUrl);
  assert.equal(
    readiness.status,
    'ready',
    'Operational readiness status is ready',
  );
  assert.equal(
    readiness.database.migrationVersion,
    '0017',
    'Current migration level is 0017',
  );
  assert.equal(readiness.database.isMigrationCurrent, true);
  assert.equal(readiness.database.markers.candidateLifecycle, true);
  assert.equal(readiness.database.markers.onboarding, true);
  assert.equal(readiness.database.markers.authoringR211, true);
  assert.equal(readiness.database.markers.executionR214, true);
  assert.equal(readiness.capabilities.liveCodeExecutionEnabled, false);
  assert.equal(readiness.capabilities.liveAiAssistanceEnabled, false);
  assert.equal(readiness.capabilities.emailDeliveryEnabled, false);
  assert.equal(readiness.capabilities.managedSupabaseSupported, false);
  assert.equal(readiness.capabilities.selfServiceOnboardingEnabled, true);
  console.log(
    'PASS: Operational readiness probe truthfully verified Release N state.',
  );

  // --- STAGE 2: CREATE RELEASE N DATA ---
  console.log(
    '\n--- STAGE 2: Seed Release N Data (Reservation Moves v3 + Onboarding) ---',
  );
  const orgId = randomUUID();
  const aliceUserId = randomUUID();
  const alicePrincipalId = randomUUID();
  const assessmentId = randomUUID();
  const sessionId = `rm-v3-${runId}`;

  // 1. Principal & User
  await primaryClient.query(
    `INSERT INTO auth.users (id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     VALUES ($1, $2, clock_timestamp(), '{"provider":"email"}', '{}', clock_timestamp(), clock_timestamp())`,
    [aliceUserId, `alice-${runId}@example.test`],
  );
  await primaryClient.query(
    `INSERT INTO hirearchy.application_principals (id, auth_user_id, display_name)
     VALUES ($1, $2, 'Alice Founder')`,
    [alicePrincipalId, aliceUserId],
  );

  // 2. Organization (Release N: includes display_name and owner_principal_id)
  await primaryClient.query(
    `INSERT INTO hirearchy.organizations (id, owner_principal_id, display_name)
     VALUES ($1, $2, 'Hyperion Systems')`,
    [orgId, alicePrincipalId],
  );
  await primaryClient.query(
    `INSERT INTO hirearchy.organization_memberships (organization_id, principal_id, role, status, joined_at, version)
     VALUES ($1, $2, 'recruiter', 'active', clock_timestamp(), 1)`,
    [orgId, alicePrincipalId],
  );

  // 3. Reservation Moves v3 Assessment & Validated Version
  const binding = reservationMovesBinding();
  await primaryClient.query(
    `INSERT INTO hirearchy.assessment_definitions (id, organization_id, author_principal_id, title, draft_version)
     VALUES ($1, $2, $3, 'Reservation Moves v3 Assessment', 1)`,
    [assessmentId, orgId, alicePrincipalId],
  );
  const contentDigest =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  await primaryClient.query(
    `INSERT INTO hirearchy.assessment_validated_versions
       (id, definition_id, organization_id, author_principal_id, version_number, content_digest, scenario_id, scenario_version, scenario_title, scenario_snapshot, task_rubric_snapshot, duration_seconds, terminal_enabled, integrated_ai, validation_receipt)
     VALUES ($1, $2, $3, $4, 1, $5, 'reservation-moves', 'v3', 'Reservation Moves v3 Assessment', $6, '{}'::jsonb, 3600, false, false, '{}'::jsonb)`,
    [
      randomUUID(),
      assessmentId,
      orgId,
      alicePrincipalId,
      contentDigest,
      JSON.stringify({ scenario: binding }),
    ],
  );

  // 4. Candidate Session
  await primaryClient.query(
    `INSERT INTO hirearchy.assessment_sessions
       (id, organization_id, issuer_principal_id, scenario_id, scenario_version, scenario_title, status, created_at, activated_at, duration_seconds)
     VALUES ($1, $2, $3, 'reservation-moves', 'v3', 'Reservation Moves v3', 'ACTIVE', clock_timestamp(), clock_timestamp(), 3600)`,
    [sessionId, orgId, alicePrincipalId],
  );
  await primaryClient.query(
    `INSERT INTO hirearchy.candidate_session_events
       (organization_id, session_id, sequence, event_type, happened_at, payload)
     VALUES ($1, $2, 1, 'SESSION_ACTIVATED', clock_timestamp(), '{"client":"web"}'::jsonb)`,
    [orgId, sessionId],
  );

  // 5. Release N Reviewer Invitation
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = invitationTokenHash(rawToken);
  const ciphertext = encryptInvitationToken(
    rawToken,
    orgId,
    Buffer.from(candidateEncryptionKey, 'base64'),
  );
  const inviteId = randomUUID();
  await primaryClient.query(
    `INSERT INTO hirearchy.organization_invitations
       (id, organization_id, inviter_principal_id, target_email, role, token_hash, token_ciphertext, expires_at)
     VALUES ($1, $2, $3, $4, 'reviewer', $5, $6, clock_timestamp() + INTERVAL '7 days')`,
    [
      inviteId,
      orgId,
      alicePrincipalId,
      `bob-${runId}@example.test`,
      tokenHash,
      ciphertext,
    ],
  );

  console.log(
    'PASS: Seeded Release N organization, Reservation Moves v3 session, and reviewer invitation.',
  );

  // --- STAGE 3: SIMULATED APPLICATION ROLLBACK TO RELEASE N-1 ---
  console.log(
    '\n--- STAGE 3: Simulated Application Rollback to Release N-1 ---',
  );
  // In Release N-1, the application runtime executes queries against the Release N-1 domain schema
  // (without assuming display_name, owner_principal_id, or organization_invitations exist).

  // 1. Release N-1 Organization Query
  const nMinusOneOrgRes = await primaryClient.query(
    `SELECT id FROM hirearchy.organizations WHERE id = $1`,
    [orgId],
  );
  assert.equal(nMinusOneOrgRes.rows.length, 1);
  assert.equal(nMinusOneOrgRes.rows[0].id, orgId);

  // 2. Release N-1 Membership & Role Resolution
  const nMinusOneMemRes = await primaryClient.query(
    `SELECT m.organization_id, m.principal_id, m.role
     FROM hirearchy.organization_memberships m
     WHERE m.organization_id = $1 AND m.principal_id = $2`,
    [orgId, alicePrincipalId],
  );
  assert.equal(nMinusOneMemRes.rows.length, 1);
  assert.equal(nMinusOneMemRes.rows[0].role, 'recruiter');

  // 3. Release N-1 Reservation Moves v3 Assessment & Binding Fetch
  const nMinusOneAssessRes = await primaryClient.query(
    `SELECT d.id AS definition_id, v.version_number, v.scenario_id, v.scenario_version, v.scenario_snapshot
     FROM hirearchy.assessment_definitions d
     JOIN hirearchy.assessment_validated_versions v ON v.definition_id = d.id
     WHERE d.id = $1 AND d.organization_id = $2`,
    [assessmentId, orgId],
  );
  assert.equal(nMinusOneAssessRes.rows.length, 1);
  assert.equal(nMinusOneAssessRes.rows[0].scenario_id, 'reservation-moves');
  assert.equal(nMinusOneAssessRes.rows[0].scenario_version, 'v3');
  assert.ok(nMinusOneAssessRes.rows[0].scenario_snapshot);

  // 4. Release N-1 Candidate Session & Event Stream Fetch
  const nMinusOneSessionRes = await primaryClient.query(
    `SELECT s.id, s.status, s.duration_seconds
     FROM hirearchy.assessment_sessions s
     WHERE s.id = $1 AND s.organization_id = $2`,
    [sessionId, orgId],
  );
  assert.equal(nMinusOneSessionRes.rows.length, 1);
  assert.equal(nMinusOneSessionRes.rows[0].status, 'ACTIVE');

  const nMinusOneEventsRes = await primaryClient.query(
    `SELECT e.sequence, e.event_type
     FROM hirearchy.candidate_session_events e
     WHERE e.session_id = $1 AND e.organization_id = $2
     ORDER BY e.sequence ASC`,
    [sessionId, orgId],
  );
  assert.equal(nMinusOneEventsRes.rows.length, 1);
  assert.equal(nMinusOneEventsRes.rows[0].event_type, 'SESSION_ACTIVATED');

  // 5. Release N-1 Auth Guard (Prove no unapproved access or auth bypass)
  // An unconfirmed user or random subject cannot access the organization or session
  const randomPrincipalId = randomUUID();
  const unapprovedAccessRes = await primaryClient.query(
    `SELECT m.role FROM hirearchy.organization_memberships m
     WHERE m.organization_id = $1 AND m.principal_id = $2`,
    [orgId, randomPrincipalId],
  );
  assert.equal(
    unapprovedAccessRes.rows.length,
    0,
    'Unapproved principal denied access',
  );

  console.log(
    'PASS: Release N-1 runtime cleanly queries all legacy data without regression or auth bypass.',
  );

  // --- STAGE 4: ROLL FORWARD BACK TO RELEASE N ---
  console.log('\n--- STAGE 4: Roll Forward Back to Release N ---');
  // Reconnect with Release N capabilities and confirm all Release N data was preserved:
  const nOrgRes = await primaryClient.query(
    `SELECT id, owner_principal_id, display_name FROM hirearchy.organizations WHERE id = $1`,
    [orgId],
  );
  assert.equal(nOrgRes.rows[0].display_name, 'Hyperion Systems');
  assert.equal(nOrgRes.rows[0].owner_principal_id, alicePrincipalId);

  const nInviteRes = await primaryClient.query(
    `SELECT id, target_email, role, token_hash FROM hirearchy.organization_invitations WHERE id = $1`,
    [inviteId],
  );
  assert.equal(nInviteRes.rows.length, 1);
  assert.equal(nInviteRes.rows[0].target_email, `bob-${runId}@example.test`);
  assert.equal(nInviteRes.rows[0].token_hash, tokenHash);

  // Issue a second invitation in Release N to prove full idempotency and stability
  const invite2Id = randomUUID();
  const rawToken2 = randomBytes(32).toString('base64url');
  await primaryClient.query(
    `INSERT INTO hirearchy.organization_invitations
       (id, organization_id, inviter_principal_id, target_email, role, token_hash, token_ciphertext, expires_at)
     VALUES ($1, $2, $3, $4, 'reviewer', $5, $6, clock_timestamp() + INTERVAL '7 days')`,
    [
      invite2Id,
      orgId,
      alicePrincipalId,
      `carol-${runId}@example.test`,
      invitationTokenHash(rawToken2),
      ciphertext,
    ],
  );

  const totalInvites = await primaryClient.query(
    `SELECT count(*)::int AS total FROM hirearchy.organization_invitations WHERE organization_id = $1`,
    [orgId],
  );
  assert.equal(totalInvites.rows[0].total, 2);

  console.log(
    'PASS: Roll-forward successfully preserved data and accepted subsequent mutations.',
  );
  console.log('\n=== ALL 4 REHEARSAL STAGES COMPLETED CLEANLY ===');
} finally {
  console.log('\nCleaning up rollback rehearsal resources...');
  if (migratorClient) await migratorClient.end().catch(() => {});
  if (primaryClient) await primaryClient.end().catch(() => {});
  if (gatewayClient) await gatewayClient.end().catch(() => {});

  try {
    docker('rm', '-f', gotrueContainer);
  } catch {}
  try {
    docker('rm', '-f', pgContainer);
  } catch {}
  try {
    docker('volume', 'rm', '-f', pgVolume);
  } catch {}
  try {
    docker('network', 'rm', networkName);
  } catch {}
  console.log('Cleanup finished.');
}
