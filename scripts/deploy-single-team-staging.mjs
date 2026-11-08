import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { runPreflightChecks } from '../deploy/staging/preflight.mjs';
import { applyMigrations } from '../database/postgres/migrate.mjs';
import {
  assertCandidateTokenStorage,
  initializeCandidateTokenStorage,
  loadCandidateTokenEncryptionKey,
  readCandidateTokenStorageMeta,
} from '../database/postgres/r23/adapter.mjs';
import { checkOperationalReadiness } from '../apps/web/src/observability/readiness.mjs';
import { operationalLogger } from '../apps/web/src/observability/logger.mjs';

console.log(
  '=== Hirearchy Single-Team Staging Deployment & Verification ===\n',
);

// 1. Run Preflight Checks
console.log('--- Step 1: Preflight Environment & Key Checks ---');
const preflight = runPreflightChecks();
let preflightPassed = true;
for (const check of preflight) {
  const sym = check.passed ? '✓' : '✗';
  console.log(
    `${sym} ${check.name}: ${check.message || (check.passed ? 'OK' : 'FAILED')}`,
  );
  if (!check.passed) preflightPassed = false;
}

if (!preflightPassed) {
  console.error(
    '\nPreflight checks failed. Please resolve environment variables before continuing.',
  );
  process.exit(1);
}

// 2. Database Migration Engine
console.log('\n--- Step 2: Database Migration Check (0001 - 0017) ---');
const migratorUrl = process.env.STAGING_MIGRATOR_DATABASE_URL;

assert(migratorUrl, 'Database migrator connection URL is required');
assert(
  process.env.STAGING_ADMIN_DATABASE_URL,
  'Admin database URL is required',
);
const migratorClient = new Client({ connectionString: migratorUrl });
await migratorClient.connect();

try {
  const migrationRes = await applyMigrations(migratorClient);
  console.log(
    `✓ Schema migrations current up to: ${migrationRes.appliedVersions[migrationRes.appliedVersions.length - 1]} (Total: ${migrationRes.appliedVersions.length})`,
  );
  assert(
    migrationRes.appliedVersions.includes('0017'),
    'Migration 0017_self_service_onboarding is required',
  );
} finally {
  await migratorClient.end().catch(() => {});
}

// Install the privileged verifier only after GoTrue has created auth.users.
console.log('\n--- Step 3: Install privileged verifier and signing key ---');
const adminClient = new Client({
  connectionString: process.env.STAGING_ADMIN_DATABASE_URL,
});
await adminClient.connect();
try {
  const candidateTokenKey = loadCandidateTokenEncryptionKey();
  const candidateTokenMeta = await readCandidateTokenStorageMeta(adminClient);
  if (candidateTokenMeta) {
    await assertCandidateTokenStorage(adminClient, { key: candidateTokenKey });
    console.log('Verified the existing candidate-token storage key binding.');
  } else {
    await initializeCandidateTokenStorage(adminClient, {
      key: candidateTokenKey,
    });
    console.log('Initialized the candidate-token storage key binding.');
  }

  const installer = await readFile(
    new URL('../database/postgres/staging/install-api.sql', import.meta.url),
    'utf8',
  );
  await adminClient.query(installer);

  const privateKey = createPrivateKey({
    key: Buffer.from(process.env.STAGING_PROOF_PRIVATE_KEY, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32);
  const keyId = process.env.STAGING_PROOF_KEY_ID;
  const issuer = process.env.STAGING_PROOF_ISSUER;
  const audience = process.env.STAGING_PROOF_AUDIENCE;
  assert(keyId && issuer && audience, 'Staging proof metadata is required');

  const existing = await adminClient.query(
    `SELECT issuer, audience, public_key, revoked_at,
            valid_from <= pg_catalog.clock_timestamp()
              AND valid_until > pg_catalog.clock_timestamp() AS active
       FROM hirearchy.staging_verification_keys
      WHERE key_id = $1`,
    [keyId],
  );
  if (existing.rowCount === 0) {
    await adminClient.query(
      `INSERT INTO hirearchy.staging_verification_keys
         (key_id, issuer, audience, public_key, valid_from, valid_until)
       VALUES ($1, $2, $3, $4,
               pg_catalog.clock_timestamp() - INTERVAL '1 minute',
               pg_catalog.clock_timestamp() + INTERVAL '365 days')`,
      [keyId, issuer, audience, publicKey],
    );
    console.log(`Registered Ed25519 verifier key ID ${keyId}.`);
  } else {
    const row = existing.rows[0];
    assert(
      row.issuer === issuer &&
        row.audience === audience &&
        Buffer.from(row.public_key).equals(publicKey) &&
        row.revoked_at === null &&
        row.active === true,
      'Existing staging verifier key is revoked, expired, or does not match this release configuration; use a new key ID',
    );
    console.log(`Verified existing Ed25519 verifier key ID ${keyId}.`);
  }
} finally {
  await adminClient.end().catch(() => {});
}

// 4. Operational Readiness Probe
console.log('\n--- Step 4: Operational Readiness Probe & Capability Audit ---');
const readiness = await checkOperationalReadiness();
console.log(`Readiness Status: ${readiness.status.toUpperCase()}`);
console.log(`Database Connected: ${readiness.database.connected}`);
console.log(
  `Migration Version: ${readiness.database.migrationVersion} (Target: ${readiness.database.targetMigrationVersion})`,
);
console.log('Durable Markers:', readiness.database.markers);
console.log('Truthful Capabilities:', readiness.capabilities);

assert.equal(
  readiness.status,
  'ready',
  'Operational readiness probe must report ready',
);
assert.equal(
  readiness.capabilities.liveCodeExecutionEnabled,
  false,
  'Untrusted code execution must remain disabled',
);
assert.equal(
  readiness.capabilities.liveAiAssistanceEnabled,
  false,
  'Live AI assistance must remain disabled',
);
assert.equal(
  readiness.capabilities.emailDeliveryEnabled,
  false,
  'Automated email delivery must remain disabled',
);
assert.equal(
  readiness.capabilities.managedSupabaseSupported,
  false,
  'Managed Supabase must not be claimed',
);

const authHealth = await fetch(
  new URL('/health', process.env.STAGING_AUTH_URL),
  {
    signal: AbortSignal.timeout(5000),
  },
);
assert(authHealth.ok, 'GoTrue health check must return HTTP 2xx');

operationalLogger.info('staging.deployment.verified', {
  status: readiness.status,
  migration: readiness.database.migrationVersion,
});

console.log('\n✓ Single-team staging deployment successfully verified.');
