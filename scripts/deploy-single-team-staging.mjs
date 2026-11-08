import assert from 'node:assert/strict';
import { Client } from 'pg';
import { runPreflightChecks } from '../deploy/staging/preflight.mjs';
import { applyMigrations } from '../database/postgres/migrate.mjs';
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
const migratorUrl =
  process.env.STAGING_MIGRATOR_DATABASE_URL || process.env.STAGING_DATABASE_URL;

assert(migratorUrl, 'Database migrator connection URL is required');
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

// 3. Operational Readiness Probe
console.log('\n--- Step 3: Operational Readiness Probe & Capability Audit ---');
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

operationalLogger.info('staging.deployment.verified', {
  status: readiness.status,
  migration: readiness.database.migrationVersion,
});

console.log('\n✓ Single-team staging deployment successfully verified.');
