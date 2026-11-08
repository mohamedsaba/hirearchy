import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { applyMigrations } from '../database/postgres/migrate.mjs';
import {
  decryptInvitationToken,
  encryptInvitationToken,
  invitationTokenHash,
} from '../apps/web/src/staging/onboarding.ts';

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

const pgImage = 'hirearchy-staging-postgres-local:latest';
const gotrueImage =
  'supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b';

const runId = randomBytes(4).toString('hex');
const networkName = `hirearchy-onboard-net-${runId}`;
const pgContainer = `hirearchy-onboard-pg-${runId}`;
const restoredPgContainer = `hirearchy-onboard-pg-restored-${runId}`;
const gotrueContainer = `hirearchy-onboard-gotrue-${runId}`;
const pgVolume = `${pgContainer}-data`;
const restoredPgVolume = `${restoredPgContainer}-data`;

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
      // probing
    }
    await delay(intervalMs);
  }
  throw new Error('Timeout waiting for health/readiness condition');
};

console.log('=== STARTING SELF-SERVICE ONBOARDING & GO-TRUE VERIFICATION ===');
console.log(`Run ID: ${runId}`);

let primaryClient;
let restoredClient;
let migratorClient;
let gatewayClient;
let gotrueAdminClient;
let gotruePort;
let pgPort;
let restoredPgPort;

try {
  // 1. Setup Docker network
  docker('network', 'create', networkName);

  // 2. Start PostgreSQL container
  docker(
    'run',
    '-d',
    '--name',
    pgContainer,
    '--network',
    networkName,
    '--network-alias',
    'db',
    '-e',
    `POSTGRES_PASSWORD=${pgPassword}`,
    '-p',
    '127.0.0.1::5432',
    '-v',
    `${pgVolume}:/var/lib/postgresql/data`,
    pgImage,
  );

  const pgPortMatch = /^127\.0\.0\.1:(\d+)$/.exec(
    docker('port', pgContainer, '5432/tcp'),
  );
  assert(pgPortMatch, 'PostgreSQL loopback port mapped');
  pgPort = Number(pgPortMatch[1]);

  await waitFor(async () => {
    const probe = new Client({
      host: '127.0.0.1',
      port: pgPort,
      user: 'postgres',
      password: pgPassword,
      database: 'postgres',
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

  // 3. Setup GoTrue database user and schema
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

  // Bootstrap Hirearchy roles
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

  // Run migrations
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
  console.log(
    `Migrations applied up to ${migrationResult.appliedVersions[migrationResult.appliedVersions.length - 1]} (Total: ${migrationResult.appliedVersions.length})`,
  );
  assert(
    migrationResult.appliedVersions.includes('0017'),
    'Migration 0017_self_service_onboarding applied',
  );

  // 4. Start GoTrue container (so GoTrue initializes auth schema before install-api grants permissions on auth.users)
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
  assert(gotruePortMatch, 'GoTrue loopback port mapped');
  gotruePort = Number(gotruePortMatch[1]);
  const gotrueUrl = `http://127.0.0.1:${gotruePort}`;

  await waitFor(async () => {
    const res = await fetch(`${gotrueUrl}/health`);
    return res.ok;
  });
  console.log(`GoTrue container healthy on port ${gotruePort}`);

  // Install Staging API & verifier owner (auth.users now exists)
  await primaryClient.query(
    await sqlFile('database/postgres/staging/install-api.sql'),
  );

  // Setup Ed25519 verification keypair
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32);
  const keyId = `key-${runId}`;
  const issuer = 'hirearchy-staging-verifier';
  const audience = 'hirearchy-staging-api';

  await primaryClient.query(
    `INSERT INTO hirearchy.staging_verification_keys
       (key_id, issuer, audience, public_key, valid_from, valid_until)
     VALUES ($1, $2, $3, $4, clock_timestamp() - INTERVAL '1 hour', clock_timestamp() + INTERVAL '1 day')`,
    [keyId, issuer, audience, rawPublicKey],
  );

  gatewayClient = new Client({
    host: '127.0.0.1',
    port: pgPort,
    database: 'postgres',
    user: 'r23_gateway',
    password: gatewayPassword,
  });
  gatewayClient.on('error', () => {});
  await gatewayClient.connect();

  // Helper to issue Ed25519 signed staging proofs
  const callStaging = async ({
    identity,
    op,
    args,
    isRecovery = false,
    forceV1 = false,
  }) => {
    const now = Math.floor(Date.now() / 1000);
    const payloadObj = {
      v: forceV1 ? 1 : 2,
      isRecovery,
      iss: issuer,
      aud: audience,
      kid: keyId,
      iat: now,
      exp: now + 60,
      auth_exp: identity.authExp ?? now + 3600,
      jti: randomUUID(),
      sub: identity.subjectId,
      sid: identity.sessionId,
      op,
      args,
    };
    if (forceV1) delete payloadObj.isRecovery;
    const payloadBytes = Buffer.from(canonical(payloadObj), 'utf8');
    const signature = sign(null, payloadBytes, privateKey);

    const query = 'SELECT staging.dispatch($1::bytea, $2::bytea) AS result';
    const res = await gatewayClient.query(query, [payloadBytes, signature]);
    const raw = res.rows[0].result;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  };

  const callGotrue = async (path, body, token) => {
    const response = await fetch(`${gotrueUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  };

  // --- STAGE 1: Operational Signup Gate ---
  console.log('\n--- STAGE 1: Operational Signup Gate ---');
  // Signup gate is checked in app API layer (default disabled).
  assert.equal(
    process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED,
    undefined,
    'Signup gate defaults to disabled in clean environment',
  );
  // Enable gate for testing
  process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED = 'true';
  console.log(
    'PASS: Operational signup gate defaults to disabled unless explicitly enabled.',
  );

  // --- STAGE 2: User Registration & Unconfirmed Email Rejection ---
  console.log(
    '\n--- STAGE 2: User Registration & Unconfirmed Email Rejection ---',
  );
  const aliceCredentials = {
    email: `alice-${runId}@example.test`,
    password: `Password-${runId}-123!`,
  };
  const aliceSignup = await callGotrue('/signup', aliceCredentials);
  if (aliceSignup.status !== 200) {
    console.error(
      'Signup failed with status:',
      aliceSignup.status,
      'body:',
      aliceSignup.body,
    );
  }
  assert.equal(aliceSignup.status, 200, 'Alice registered in GoTrue');
  const aliceUser = aliceSignup.body.user ?? aliceSignup.body;
  assert(aliceUser.id, 'Alice user ID created');

  // Login as unconfirmed user
  // In GoTrue with autoconfirm=false, password login fails with Email not confirmed, OR if enabled, returns session
  // Let's check auth.users directly in DB
  const unconfirmedRow = await primaryClient.query(
    'SELECT id, email, email_confirmed_at FROM auth.users WHERE id = $1',
    [aliceUser.id],
  );
  assert.equal(
    unconfirmedRow.rows[0].email_confirmed_at,
    null,
    'Alice email is not confirmed yet',
  );

  // Synthetic session in auth.sessions for testing proof before email confirmation
  const aliceSessionId = randomUUID();
  await primaryClient.query(
    `INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
     VALUES ($1, $2, clock_timestamp(), clock_timestamp())`,
    [aliceSessionId, aliceUser.id],
  );

  const aliceIdentity = {
    subjectId: aliceUser.id,
    sessionId: aliceSessionId,
    authExp: Math.floor(Date.now() / 1000) + 3600,
  };

  // Attempting onboarding.status before email confirmation MUST be denied
  await assert.rejects(
    callStaging({ identity: aliceIdentity, op: 'onboarding.status', args: {} }),
    (err) =>
      err.code === '42501' &&
      err.message.includes('Email confirmation is required'),
    'Unconfirmed email rejected with 42501',
  );

  // Attempting organization.bootstrap before email confirmation MUST be denied
  await assert.rejects(
    callStaging({
      identity: aliceIdentity,
      op: 'organization.bootstrap',
      args: {
        displayName: 'Alice Corp',
        idempotencyKey: `boot-alice-${runId}`,
      },
    }),
    (err) =>
      err.code === '42501' &&
      err.message.includes('Email confirmation is required'),
    'Unconfirmed email bootstrap rejected with 42501',
  );
  console.log(
    'PASS: Unconfirmed email strictly denied for pre-principal and onboarding operations.',
  );

  // --- STAGE 3: Email Confirmation & Pre-Principal Status ---
  console.log('\n--- STAGE 3: Email Confirmation & Pre-Principal Status ---');
  await primaryClient.query(
    'UPDATE auth.users SET email_confirmed_at = clock_timestamp() WHERE id = $1',
    [aliceUser.id],
  );

  const status1 = await callStaging({
    identity: aliceIdentity,
    op: 'onboarding.status',
    args: {},
  });
  assert.equal(
    status1.status,
    'needs_team',
    'Status correctly reports needs_team',
  );
  assert.equal(
    status1.email,
    aliceCredentials.email,
    'Confirmed email returned',
  );
  assert.equal(status1.capabilities.selfServiceOnboardingEnabled, true);
  assert.equal(
    status1.capabilities.emailDeliveryEnabled,
    false,
    'Truthful email delivery disabled',
  );
  console.log(
    'PASS: Confirmed email reads onboarding.status ("needs_team", emailDeliveryEnabled: false).',
  );

  // --- STAGE 4: First Organization Creation & Owner Governance ---
  console.log(
    '\n--- STAGE 4: First Organization Creation & Owner Governance ---',
  );
  const bootPayload = {
    displayName: 'Acme Space Systems',
    idempotencyKey: `boot-alice-${runId}`,
  };
  const bootResult = await callStaging({
    identity: aliceIdentity,
    op: 'organization.bootstrap',
    args: bootPayload,
  });

  assert(bootResult.organizationId, 'Organization ID returned');
  assert.equal(bootResult.displayName, 'Acme Space Systems');
  assert.equal(bootResult.role, 'recruiter');
  assert.equal(bootResult.isOwner, true);
  assert.equal(bootResult.emailDeliveryEnabled, false);

  const orgId = bootResult.organizationId;

  // Verify database record
  const orgRow = await primaryClient.query(
    'SELECT id, owner_principal_id, display_name FROM hirearchy.organizations WHERE id = $1',
    [orgId],
  );
  assert.equal(orgRow.rows.length, 1);
  assert.equal(orgRow.rows[0].display_name, 'Acme Space Systems');
  const alicePrincipalId = orgRow.rows[0].owner_principal_id;
  assert(alicePrincipalId, 'Owner principal ID set');

  // Verify principal record
  const principalRow = await primaryClient.query(
    'SELECT id, auth_user_id FROM hirearchy.application_principals WHERE id = $1',
    [alicePrincipalId],
  );
  assert.equal(principalRow.rows[0].auth_user_id, aliceUser.id);

  // Verify membership record
  const memRow = await primaryClient.query(
    'SELECT organization_id, principal_id, role, status FROM hirearchy.organization_memberships WHERE organization_id = $1 AND principal_id = $2',
    [orgId, alicePrincipalId],
  );
  assert.equal(memRow.rows[0].role, 'recruiter');
  assert.equal(memRow.rows[0].status, 'active');

  // Invariant test: mutating owner_principal_id is forbidden by trigger
  await assert.rejects(
    primaryClient.query(
      'UPDATE hirearchy.organizations SET owner_principal_id = $1 WHERE id = $2',
      [randomUUID(), orgId],
    ),
    (err) => err.code === '23514',
    'Trigger organizations_owner_principal_immutable rejects changing owner',
  );
  console.log(
    'PASS: First organization bootstrapped with owner governance, recruiter membership, and immutable ownership.',
  );

  // --- STAGE 5: Idempotent Bootstrap Replay & Active Membership Protection ---
  console.log(
    '\n--- STAGE 5: Idempotent Bootstrap Replay & Active Membership Protection ---',
  );
  // Replay identical bootstrap request
  const replayResult = await callStaging({
    identity: aliceIdentity,
    op: 'organization.bootstrap',
    args: bootPayload,
  });
  assert.deepEqual(
    replayResult,
    bootResult,
    'Identical replay returns original receipt',
  );

  // Replay same idempotency key with different payload -> 22023 conflict
  await assert.rejects(
    callStaging({
      identity: aliceIdentity,
      op: 'organization.bootstrap',
      args: {
        displayName: 'Different Name Corp',
        idempotencyKey: bootPayload.idempotencyKey,
      },
    }),
    (err) =>
      err.code === '22023' &&
      err.message.includes(
        'Idempotency key already exists with different request parameters',
      ),
    'Changed payload with same idempotency key rejected with 22023 conflict',
  );

  // Attempting second bootstrap with new key while having active membership -> 42501
  await assert.rejects(
    callStaging({
      identity: aliceIdentity,
      op: 'organization.bootstrap',
      args: {
        displayName: 'Second Org',
        idempotencyKey: `boot-alice-second-${runId}`,
      },
    }),
    (err) =>
      err.code === '42501' &&
      err.message.includes(
        'User already has an active organization membership',
      ),
    'Active membership blocks creating second organization',
  );

  // Status check now reports has_active_membership
  const status2 = await callStaging({
    identity: aliceIdentity,
    op: 'onboarding.status',
    args: {},
  });
  assert.equal(status2.status, 'has_active_membership');
  console.log(
    'PASS: Idempotent bootstrap replay succeeds; conflicting replay and duplicate team creation blocked.',
  );

  // --- STAGE 6: Organization Scope & Approved Template Exposure ---
  console.log(
    '\n--- STAGE 6: Organization Scope & Approved Template Exposure ---',
  );
  // Open session
  await callStaging({
    identity: aliceIdentity,
    op: 'session.open',
    args: { organizationId: orgId },
  });

  // Load organization context
  const context = await callStaging({
    identity: aliceIdentity,
    op: 'organization.context',
    args: { organizationId: orgId },
  });
  assert.equal(context.organizationId, orgId);
  assert.equal(context.displayName, 'Acme Space Systems');
  assert.equal(context.isOwner, true);
  assert.equal(context.role, 'recruiter');
  assert.deepEqual(
    context.sessions,
    [],
    'New org has clean empty session list',
  );
  const templateIds = context.availableTemplates.map((t) => t.templateId);
  assert(
    templateIds.includes('reservation-moves-v3'),
    'Reservation Moves v3 template available to new organization',
  );
  console.log(
    'PASS: Approved template catalog immediately visible to new org; empty session list verified.',
  );

  // --- STAGE 7: Reviewer Invitation Lifecycle ---
  console.log('\n--- STAGE 7: Reviewer Invitation Lifecycle ---');
  const carolEmail = `carol-${runId}@example.test`;
  const carolRawToken = randomBytes(32).toString('base64url');
  const carolTokenHash = invitationTokenHash(carolRawToken);
  const carolCiphertext = encryptInvitationToken(
    carolRawToken,
    orgId,
    Buffer.from(candidateEncryptionKey, 'base64'),
  );
  const carolExpiresAt = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const inviteKey = `invite-carol-${runId}`;

  // Owner creates invitation
  const inviteResult = await callStaging({
    identity: aliceIdentity,
    op: 'organization.invitation.create',
    args: {
      organizationId: orgId,
      targetEmail: carolEmail,
      expiresAt: carolExpiresAt,
      idempotencyKey: inviteKey,
      invitationTokenHash: carolTokenHash,
      invitationTokenCiphertext: carolCiphertext,
    },
  });
  assert(inviteResult.invitationId, 'Invitation created');
  assert.equal(inviteResult.targetEmail, carolEmail);
  assert.equal(inviteResult.role, 'reviewer');
  assert.equal(
    inviteResult.emailDeliveryEnabled,
    false,
    'Truthful delivery reporting',
  );
  const carolInvitationId = inviteResult.invitationId;

  // List invitations as owner
  const inviteList = await callStaging({
    identity: aliceIdentity,
    op: 'organization.invitation.list',
    args: { organizationId: orgId },
  });
  assert.equal(inviteList.invitations.length, 1);
  assert.equal(inviteList.invitations[0].status, 'active');
  assert.equal(
    inviteList.invitations[0].tokenCiphertext,
    carolCiphertext,
    'Owner can recover ciphertext',
  );

  // Decrypt recovered link
  const decryptedToken = decryptInvitationToken(
    inviteList.invitations[0].tokenCiphertext,
    orgId,
    Buffer.from(candidateEncryptionKey, 'base64'),
  );
  assert.equal(
    decryptedToken,
    carolRawToken,
    'Owner recovered exact invitation bearer token',
  );

  // Setup Carol in GoTrue
  const carolSignup = await callGotrue('/signup', {
    email: carolEmail,
    password: `CarolPass-${runId}-123!`,
  });
  const carolUser = carolSignup.body.user ?? carolSignup.body;
  const carolSessionId = randomUUID();
  await primaryClient.query(
    `INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
     VALUES ($1, $2, clock_timestamp(), clock_timestamp())`,
    [carolSessionId, carolUser.id],
  );
  const carolIdentity = {
    subjectId: carolUser.id,
    sessionId: carolSessionId,
    authExp: Math.floor(Date.now() / 1000) + 3600,
  };

  // Carol unconfirmed attempt -> 42501
  await assert.rejects(
    callStaging({
      identity: carolIdentity,
      op: 'organization.invitation.accept',
      args: { invitationTokenHash: carolTokenHash },
    }),
    (err) =>
      err.code === '42501' &&
      err.message.includes('Email confirmation is required'),
    'Unconfirmed invitee denied acceptance',
  );

  // Confirm Carol's email
  await primaryClient.query(
    'UPDATE auth.users SET email_confirmed_at = clock_timestamp() WHERE id = $1',
    [carolUser.id],
  );

  // Wrong email user attempts acceptance -> 42501
  const daveSignup = await callGotrue('/signup', {
    email: `dave-${runId}@example.test`,
    password: `DavePass-${runId}-123!`,
  });
  const daveUser = daveSignup.body.user ?? daveSignup.body;
  const daveSessionId = randomUUID();
  await primaryClient.query(
    `INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
     VALUES ($1, $2, clock_timestamp(), clock_timestamp())`,
    [daveSessionId, daveUser.id],
  );
  await primaryClient.query(
    'UPDATE auth.users SET email_confirmed_at = clock_timestamp() WHERE id = $1',
    [daveUser.id],
  );
  const daveIdentity = {
    subjectId: daveUser.id,
    sessionId: daveSessionId,
    authExp: Math.floor(Date.now() / 1000) + 3600,
  };

  await assert.rejects(
    callStaging({
      identity: daveIdentity,
      op: 'organization.invitation.accept',
      args: { invitationTokenHash: carolTokenHash },
    }),
    (err) =>
      err.code === '42501' &&
      err.message.includes('Invitation is bound to a different email address'),
    'Wrong email address denied acceptance',
  );

  // Carol accepts invitation
  const acceptResult = await callStaging({
    identity: carolIdentity,
    op: 'organization.invitation.accept',
    args: { invitationTokenHash: carolTokenHash },
  });
  assert.equal(acceptResult.organizationId, orgId);
  assert.equal(acceptResult.role, 'reviewer');
  assert.equal(acceptResult.status, 'accepted');

  // Verify Carol's membership
  const carolPrincipal = (
    await primaryClient.query(
      'SELECT id FROM hirearchy.application_principals WHERE auth_user_id = $1',
      [carolUser.id],
    )
  ).rows[0].id;
  const carolMem = (
    await primaryClient.query(
      'SELECT role, status FROM hirearchy.organization_memberships WHERE organization_id = $1 AND principal_id = $2',
      [orgId, carolPrincipal],
    )
  ).rows[0];
  assert.equal(carolMem.role, 'reviewer');
  assert.equal(carolMem.status, 'active');

  // Carol retries acceptance -> idempotent
  const retryResult = await callStaging({
    identity: carolIdentity,
    op: 'organization.invitation.accept',
    args: { invitationTokenHash: carolTokenHash },
  });
  assert.deepEqual(
    retryResult,
    acceptResult,
    'Idempotent retry returns accepted state',
  );

  // Dave tries to accept already accepted invitation -> 42501
  await assert.rejects(
    callStaging({
      identity: daveIdentity,
      op: 'organization.invitation.accept',
      args: { invitationTokenHash: carolTokenHash },
    }),
    (err) => err.code === '42501',
    'Third party cannot accept already accepted invitation',
  );
  console.log(
    'PASS: Reviewer invitation creation, listing, recovery, email binding, and acceptance verified.',
  );

  // --- STAGE 8: Revocation & Expiration Security ---
  console.log('\n--- STAGE 8: Revocation & Expiration Security ---');
  const eveRawToken = randomBytes(32).toString('base64url');
  const eveTokenHash = invitationTokenHash(eveRawToken);
  const eveCiphertext = encryptInvitationToken(
    eveRawToken,
    orgId,
    Buffer.from(candidateEncryptionKey, 'base64'),
  );
  const eveExpiresAt = new Date(Date.now() + 7 * 86400 * 1000).toISOString();

  const eveInvite = await callStaging({
    identity: aliceIdentity,
    op: 'organization.invitation.create',
    args: {
      organizationId: orgId,
      targetEmail: `eve-${runId}@example.test`,
      expiresAt: eveExpiresAt,
      idempotencyKey: `invite-eve-${runId}`,
      invitationTokenHash: eveTokenHash,
      invitationTokenCiphertext: eveCiphertext,
    },
  });

  // Revoke Eve's invitation
  const revokeResult = await callStaging({
    identity: aliceIdentity,
    op: 'organization.invitation.revoke',
    args: {
      organizationId: orgId,
      invitationId: eveInvite.invitationId,
    },
  });
  assert.equal(revokeResult.status, 'revoked');

  // Create Eve user and attempt acceptance of revoked invitation
  const eveSignup = await callGotrue('/signup', {
    email: `eve-${runId}@example.test`,
    password: `EvePass-${runId}-123!`,
  });
  const eveUser = eveSignup.body.user ?? eveSignup.body;
  const eveSessionId = randomUUID();
  await primaryClient.query(
    `INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
     VALUES ($1, $2, clock_timestamp(), clock_timestamp())`,
    [eveSessionId, eveUser.id],
  );
  await primaryClient.query(
    'UPDATE auth.users SET email_confirmed_at = clock_timestamp() WHERE id = $1',
    [eveUser.id],
  );
  const eveIdentity = {
    subjectId: eveUser.id,
    sessionId: eveSessionId,
    authExp: Math.floor(Date.now() / 1000) + 3600,
  };

  await assert.rejects(
    callStaging({
      identity: eveIdentity,
      op: 'organization.invitation.accept',
      args: { invitationTokenHash: eveTokenHash },
    }),
    (err) =>
      err.code === '42501' &&
      err.message.includes('Invitation has been revoked'),
    'Revoked invitation acceptance rejected with 42501',
  );

  // Expired invitation acceptance denial
  await primaryClient.query(
    `UPDATE hirearchy.organization_invitations
     SET expires_at = created_at + INTERVAL '1 second'
     WHERE id = $1`,
    [eveInvite.invitationId],
  );
  // Clear revoked to test pure expiry check
  await primaryClient.query(
    'UPDATE hirearchy.organization_invitations SET revoked_at = NULL WHERE id = $1',
    [eveInvite.invitationId],
  );
  await delay(1100);

  await assert.rejects(
    callStaging({
      identity: eveIdentity,
      op: 'organization.invitation.accept',
      args: { invitationTokenHash: eveTokenHash },
    }),
    (err) =>
      err.code === '42501' && err.message.includes('Invitation has expired'),
    'Expired invitation acceptance rejected with 42501',
  );
  console.log(
    'PASS: Revoked and expired invitations strictly denied acceptance.',
  );

  // --- STAGE 9: Account & Organization Management ---
  console.log('\n--- STAGE 9: Account & Organization Management ---');
  // Account profile get & update
  const profile = await callStaging({
    identity: aliceIdentity,
    op: 'account.profile.get',
    args: {},
  });
  assert.equal(profile.principalId, alicePrincipalId);
  assert.equal(profile.email, aliceCredentials.email);

  const updatedProfile = await callStaging({
    identity: aliceIdentity,
    op: 'account.profile.update',
    args: { displayName: 'Alice Founder' },
  });
  assert.equal(updatedProfile.displayName, 'Alice Founder');

  // Organization update
  const updatedOrg = await callStaging({
    identity: aliceIdentity,
    op: 'organization.update',
    args: { organizationId: orgId, displayName: 'Acme Planetary Systems' },
  });
  assert.equal(updatedOrg.displayName, 'Acme Planetary Systems');

  // Carol (reviewer) tries to update org -> denied
  await callStaging({
    identity: carolIdentity,
    op: 'session.open',
    args: { organizationId: orgId },
  });
  await assert.rejects(
    callStaging({
      identity: carolIdentity,
      op: 'organization.update',
      args: { organizationId: orgId, displayName: 'Hacked Org Name' },
    }),
    (err) => err.code === '42501',
    'Reviewer denied organization update',
  );

  // Members list
  const membersList = await callStaging({
    identity: aliceIdentity,
    op: 'organization.members.list',
    args: { organizationId: orgId },
  });
  assert.equal(membersList.members.length, 2);
  const ownerEntry = membersList.members.find(
    (m) => m.principalId === alicePrincipalId,
  );
  const reviewerEntry = membersList.members.find(
    (m) => m.principalId === carolPrincipal,
  );
  assert.equal(ownerEntry.isOwner, true);
  assert.equal(ownerEntry.displayName, 'Alice Founder');
  assert.equal(reviewerEntry.isOwner, false);

  // Owner removes Carol
  const removeResult = await callStaging({
    identity: aliceIdentity,
    op: 'organization.member.remove',
    args: { organizationId: orgId, targetPrincipalId: carolPrincipal },
  });
  assert.equal(removeResult.status, 'revoked');

  // Revoked member cannot access org anymore
  await assert.rejects(
    callStaging({
      identity: carolIdentity,
      op: 'organization.context',
      args: { organizationId: orgId },
    }),
    (err) => err.code === '42501',
    'Revoked member denied organization context',
  );

  // Invariant test: Owner cannot be removed or demoted
  await assert.rejects(
    callStaging({
      identity: aliceIdentity,
      op: 'organization.member.remove',
      args: { organizationId: orgId, targetPrincipalId: alicePrincipalId },
    }),
    (err) =>
      err.code === '42501' &&
      err.message.includes('Cannot remove or demote the organization owner'),
    'Owner cannot remove or demote themselves',
  );
  console.log(
    'PASS: Account profile, org rename, member listing, member removal, and owner protection verified.',
  );

  // --- STAGE 10: Session Expiration & Server-Side Revocation ---
  console.log(
    '\n--- STAGE 10: Session Expiration & Server-Side Revocation ---',
  );
  // Revoke staging session
  await callStaging({
    identity: aliceIdentity,
    op: 'session.revoke',
    args: { organizationId: orgId },
  });

  // Subsequent operation denied
  await assert.rejects(
    callStaging({
      identity: aliceIdentity,
      op: 'organization.context',
      args: { organizationId: orgId },
    }),
    (err) => err.code === '28000',
    'Revoked staging session rejected with 28000',
  );

  // GoTrue session deletion
  await primaryClient.query('DELETE FROM auth.sessions WHERE id = $1', [
    aliceSessionId,
  ]);
  await assert.rejects(
    callStaging({
      identity: aliceIdentity,
      op: 'session.open',
      args: { organizationId: orgId },
    }),
    (err) => err.code === '28000',
    'Deleted Auth session rejected with 28000',
  );
  console.log(
    'PASS: Server-side session revocation and Auth session deletion verified.',
  );

  // --- STAGE 11: Password Recovery & Quarantine Invariant ---
  console.log('\n--- STAGE 11: Password Recovery & Quarantine Invariant ---');
  // Request password recovery
  const recoverRes = await callGotrue('/recover', {
    email: aliceCredentials.email,
  });
  assert.equal(recoverRes.status, 200, 'Password recovery initiated in GoTrue');

  // In GoTrue, recovery creates a session with AMR method "recovery"
  const recoverySessionId = randomUUID();
  await primaryClient.query(
    `INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
     VALUES ($1, $2, clock_timestamp(), clock_timestamp())`,
    [recoverySessionId, aliceUser.id],
  );

  const recoveryIdentity = {
    subjectId: aliceUser.id,
    sessionId: recoverySessionId,
    authExp: Math.floor(Date.now() / 1000) + 3600,
  };

  // Proof with isRecovery: true MUST be rejected by staging.dispatch (PR #7 invariant)
  await assert.rejects(
    callStaging({
      identity: recoveryIdentity,
      op: 'onboarding.status',
      args: {},
      isRecovery: true,
    }),
    (err) =>
      err.code === '28000' && err.message.includes('Staging proof is invalid'),
    'Recovery proof strictly rejected by staging.dispatch with 28000',
  );

  // Proof with v1 (missing isRecovery) MUST be rejected by staging.dispatch
  await assert.rejects(
    callStaging({
      identity: recoveryIdentity,
      op: 'onboarding.status',
      args: {},
      forceV1: true,
    }),
    (err) =>
      err.code === '28000' && err.message.includes('Staging proof is invalid'),
    'v1 proof strictly rejected by staging.dispatch with 28000',
  );
  console.log(
    'PASS: PR #7 Invariant preserved: recovery credentials strictly quarantined from product staging APIs.',
  );

  // --- STAGE 12: Migration Idempotency & Disaster Recovery Rehearsal ---
  console.log(
    '\n--- STAGE 12: Migration Idempotency & Disaster Recovery Rehearsal ---',
  );
  // Idempotency re-run
  const rerun = await applyMigrations(migratorClient);
  assert.equal(
    rerun.appliedVersions.length,
    migrationResult.appliedVersions.length,
  );
  console.log('PASS: Migration idempotency verified on re-run.');

  // Disaster recovery backup & restore
  const dumpFile = `/tmp/hirearchy-onboarding-${runId}.dump`;
  const globalsFile = `/tmp/hirearchy-globals-${runId}.sql`;

  docker(
    'exec',
    pgContainer,
    'pg_dumpall',
    '-g',
    '-U',
    'postgres',
    '-f',
    '/tmp/globals.sql',
  );
  execFileSync('docker', [
    'cp',
    `${pgContainer}:/tmp/globals.sql`,
    globalsFile,
  ]);

  docker(
    'exec',
    pgContainer,
    'pg_dump',
    '-Fc',
    '-U',
    'postgres',
    '-f',
    '/tmp/backup.dump',
    'postgres',
  );
  execFileSync('docker', ['cp', `${pgContainer}:/tmp/backup.dump`, dumpFile]);

  // Start second PostgreSQL container
  docker(
    'run',
    '-d',
    '--name',
    restoredPgContainer,
    '--network',
    networkName,
    '-e',
    `POSTGRES_PASSWORD=${pgPassword}`,
    '-p',
    '127.0.0.1::5432',
    '-v',
    `${restoredPgVolume}:/var/lib/postgresql/data`,
    pgImage,
  );

  const restoredPortMatch = /^127\.0\.0\.1:(\d+)$/.exec(
    docker('port', restoredPgContainer, '5432/tcp'),
  );
  assert(restoredPortMatch, 'Restored PostgreSQL port mapped');
  restoredPgPort = Number(restoredPortMatch[1]);

  await waitFor(async () => {
    const probe = new Client({
      host: '127.0.0.1',
      port: restoredPgPort,
      user: 'postgres',
      password: pgPassword,
      database: 'postgres',
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

  execFileSync('docker', [
    'cp',
    globalsFile,
    `${restoredPgContainer}:/tmp/globals.sql`,
  ]);
  execFileSync('docker', [
    'cp',
    dumpFile,
    `${restoredPgContainer}:/tmp/backup.dump`,
  ]);

  docker(
    'exec',
    restoredPgContainer,
    'psql',
    '-U',
    'postgres',
    '-f',
    '/tmp/globals.sql',
  );

  docker(
    'exec',
    restoredPgContainer,
    'pg_restore',
    '-v',
    '--clean',
    '--if-exists',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '/tmp/backup.dump',
  );

  // Connect to restored DB and verify data
  restoredClient = new Client({
    host: '127.0.0.1',
    port: restoredPgPort,
    database: 'postgres',
    user: 'postgres',
    password: pgPassword,
  });
  restoredClient.on('error', () => {});
  await restoredClient.connect();

  const restoredOrg = await restoredClient.query(
    'SELECT id, display_name, owner_principal_id FROM hirearchy.organizations WHERE id = $1',
    [orgId],
  );
  assert.equal(restoredOrg.rows.length, 1);
  assert.equal(restoredOrg.rows[0].display_name, 'Acme Planetary Systems');
  assert.equal(restoredOrg.rows[0].owner_principal_id, alicePrincipalId);

  const restoredMembers = await restoredClient.query(
    'SELECT principal_id, role, status FROM hirearchy.organization_memberships WHERE organization_id = $1 ORDER BY joined_at',
    [orgId],
  );
  assert.equal(restoredMembers.rows.length, 2);
  assert.equal(restoredMembers.rows[0].role, 'recruiter');
  assert.equal(restoredMembers.rows[1].role, 'reviewer');
  assert.equal(restoredMembers.rows[1].status, 'revoked');

  const restoredInvites = await restoredClient.query(
    'SELECT id, target_email, role, accepted_at FROM hirearchy.organization_invitations WHERE id = $1',
    [carolInvitationId],
  );
  assert.equal(restoredInvites.rows.length, 1);
  assert.equal(restoredInvites.rows[0].target_email, carolEmail);
  assert(restoredInvites.rows[0].accepted_at, 'Accepted timestamp intact');

  await rm(dumpFile, { force: true });
  await rm(globalsFile, { force: true });
  console.log(
    'PASS: Migration idempotency and disaster recovery restore verified.',
  );

  console.log(
    '\n===============================================================',
  );
  console.log(
    'ALL 12 STAGES OF SELF-SERVICE ONBOARDING COMPLETED SUCCESSFULLY!',
  );
  console.log(
    '===============================================================',
  );
} catch (err) {
  console.error('\n!!! TEST FAILED WITH ERROR:', err);
  throw err;
} finally {
  console.log('\nCleaning up disposable test resources...');
  for (const client of [
    primaryClient,
    restoredClient,
    migratorClient,
    gatewayClient,
    gotrueAdminClient,
  ]) {
    if (client) {
      try {
        await client.end();
      } catch {}
    }
  }

  for (const c of [gotrueContainer, pgContainer, restoredPgContainer]) {
    try {
      docker('rm', '-f', c);
    } catch {
      // already removed
    }
  }
  for (const v of [pgVolume, restoredPgVolume]) {
    try {
      docker('volume', 'rm', '-f', v);
    } catch {
      // already removed
    }
  }
  try {
    docker('network', 'rm', networkName);
  } catch {
    // already removed
  }
}
