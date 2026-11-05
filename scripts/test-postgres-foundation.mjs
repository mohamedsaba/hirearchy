import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Pool } from 'pg';
import { applyMigrations } from '../database/postgres/migrate.mjs';
import { checkInternalRoleBootstrap } from '../tests/postgres/internal-role-bootstrap.mjs';
import {
  checkFixtureRlsAndGucResidual,
  checkLegacySensitiveDirectReads,
  checkLegacyCompatibility,
  checkRuntimePrincipalIdentityDenied,
  checkRlsDeniesWithoutPolicy,
  checkRuntimeRolesAndDefaultDeny,
  checkTrustedTransactionPool,
} from '../tests/postgres/foundation-check.mjs';
import {
  createFoundationFixtures,
  seedFoundationFixtures,
} from '../tests/postgres/foundation-fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'database/postgres/migrations');
const POSTGRES_IMAGE =
  'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
const CORE_TABLES = [
  'organizations',
  'application_principals',
  'organization_memberships',
  'assessment_sessions',
];
const RUNTIME_ROLES = [
  'hirearchy_migrator',
  'app_evaluator',
  'app_candidate_gateway',
  'app_control_worker',
];
let activeFixture;
let signalHandled = false;

function randomPassword() {
  return randomBytes(30).toString('base64url');
}

function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = quiet
      ? ''
      : String(result.stderr || result.error?.message || '').trim();
    throw new Error(
      `${command} ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`,
    );
  }
  return String(result.stdout ?? '').trim();
}

function tryRun(command, args) {
  try {
    return run(command, args, { quiet: true });
  } catch {
    return null;
  }
}

function dockerFixture(adminPassword) {
  if (!tryRun('docker', ['info', '--format', '{{.ServerVersion}}']))
    return null;
  if (
    !tryRun('docker', [
      'image',
      'inspect',
      POSTGRES_IMAGE,
      '--format',
      '{{.Id}}',
    ])
  )
    return null;

  const name = `hirearchy-r22-pg-${process.pid}-${randomBytes(4).toString('hex')}`;
  run('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    `POSTGRES_PASSWORD=${adminPassword}`,
    POSTGRES_IMAGE,
  ]);
  try {
    const portOutput = run('docker', ['port', name, '5432/tcp']);
    const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(portOutput);
    if (!portMatch)
      throw new Error(
        'Disposable PostgreSQL container did not bind to loopback',
      );
    return {
      kind: 'docker',
      host: '127.0.0.1',
      port: Number(portMatch[1]),
      async cleanup() {
        try {
          run('docker', ['stop', '--time', '5', name], { quiet: true });
        } catch {
          // The container is created with --rm and may already have exited.
        }
      },
    };
  } catch (error) {
    try {
      run('docker', ['stop', '--time', '5', name], { quiet: true });
    } catch {
      // The container is created with --rm and may already have exited.
    }
    throw error;
  }
}

for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    if (signalHandled) return;
    signalHandled = true;
    void activeFixture?.cleanup().finally(() => process.exit(exitCode));
  });
}

process.once('unhandledRejection', (reason) => {
  if (signalHandled) return;
  signalHandled = true;
  void activeFixture?.cleanup().finally(() => {
    process.stderr.write(`Unhandled rejection: ${reason?.stack || reason}\n`);
    process.exit(1);
  });
});

async function startPostgres(adminPassword) {
  const docker = dockerFixture(adminPassword);
  if (docker) return docker;
  throw new Error(
    `PostgreSQL fixture unavailable: start Docker with ${POSTGRES_IMAGE} available locally`,
  );
}

async function connectWithRetry(config) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const client = new Client({ ...config, connectionTimeoutMillis: 1000 });
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error('Timed out waiting for the disposable PostgreSQL fixture');
}

function connectionConfig(fixture, database, user, password) {
  return {
    host: fixture.host,
    port: fixture.port,
    database,
    user,
    password,
    application_name: 'hirearchy-r2-foundation-test',
    connectionTimeoutMillis: 3000,
  };
}

async function setRolePassword(admin, role, password) {
  await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
}

async function installMigratorFixtureAccess(admin) {
  for (const table of CORE_TABLES) {
    await admin.query(
      `CREATE POLICY r2_test_migrator_access ON hirearchy.${table} FOR ALL TO hirearchy_migrator USING (true) WITH CHECK (true)`,
    );
  }
}

async function removeMigratorFixtureAccess(admin) {
  for (const table of CORE_TABLES) {
    await admin.query(
      `DROP POLICY IF EXISTS r2_test_migrator_access ON hirearchy.${table}`,
    );
  }
}

async function expectImmutableUpdate(migrator, label, sql, params) {
  await migrator.query('BEGIN');
  let error;
  try {
    await migrator.query(sql, params);
  } catch (caught) {
    error = caught;
  } finally {
    await migrator.query('ROLLBACK');
  }
  assert.ok(error, `${label} must reject identity mutation`);
  assert.equal(
    error.code,
    '23514',
    `${label} must fail through the immutable-column trigger`,
  );
  assert.match(error.message, /immutable/i);
}

async function checkCoreConstraints(migrator, ids) {
  await assert.rejects(
    migrator.query(
      `INSERT INTO hirearchy.assessment_sessions (id, organization_id, issuer_principal_id)
       VALUES ('r2-cross-tenant-invalid', $1, $2)`,
      [ids.organizationA, ids.principalB],
    ),
    (error) => error.code === '23503',
  );

  await expectImmutableUpdate(
    migrator,
    'organization id',
    'UPDATE hirearchy.organizations SET id = $1 WHERE id = $2',
    [randomUUID(), ids.organizationC],
  );
  await expectImmutableUpdate(
    migrator,
    'membership organization ownership',
    'UPDATE hirearchy.organization_memberships SET organization_id = $1 WHERE organization_id = $2 AND principal_id = $3',
    [ids.organizationC, ids.organizationA, ids.principalShared],
  );
  await expectImmutableUpdate(
    migrator,
    'session issuer ownership',
    'UPDATE hirearchy.assessment_sessions SET issuer_principal_id = $1 WHERE id = $2',
    [ids.principalShared, ids.sessionA],
  );
  await expectImmutableUpdate(
    migrator,
    'session organization ownership',
    'UPDATE hirearchy.assessment_sessions SET organization_id = $1 WHERE id = $2',
    [ids.organizationC, ids.sessionA],
  );
  await expectImmutableUpdate(
    migrator,
    'session id',
    'UPDATE hirearchy.assessment_sessions SET id = $1 WHERE id = $2',
    ['r2-foundation-session-A-renamed', ids.sessionA],
  );

  const initialPrincipal = await migrator.query(
    'SELECT id, auth_user_id FROM hirearchy.application_principals WHERE id = $1',
    [ids.principalUnused],
  );
  assert.deepEqual(initialPrincipal.rows, [
    { id: ids.principalUnused, auth_user_id: ids.subjectUnused },
  ]);
  await migrator.query(
    'UPDATE hirearchy.application_principals SET auth_user_id = $1 WHERE id = $2',
    [ids.subjectUnused, ids.principalUnused],
  );
  await expectImmutableUpdate(
    migrator,
    'principal identity binding A to B',
    'UPDATE hirearchy.application_principals SET auth_user_id = $1 WHERE id = $2',
    [ids.subjectB, ids.principalUnused],
  );

  const membershipsBefore = await migrator.query(
    `SELECT organization_id, principal_id, role, status, joined_at, revoked_at, version
       FROM hirearchy.organization_memberships
      WHERE principal_id = $1
      ORDER BY organization_id`,
    [ids.principalUnused],
  );
  assert.ok(membershipsBefore.rows.length > 0);
  const detached = await migrator.query(
    `UPDATE hirearchy.application_principals
        SET auth_user_id = NULL
      WHERE id = $1
      RETURNING id, auth_user_id`,
    [ids.principalUnused],
  );
  assert.deepEqual(detached.rows, [
    { id: ids.principalUnused, auth_user_id: null },
  ]);
  const membershipsAfter = await migrator.query(
    `SELECT organization_id, principal_id, role, status, joined_at, revoked_at, version
       FROM hirearchy.organization_memberships
      WHERE principal_id = $1
      ORDER BY organization_id`,
    [ids.principalUnused],
  );
  assert.deepEqual(
    membershipsAfter.rows,
    membershipsBefore.rows,
    'tombstoning a principal must preserve its historical memberships',
  );
  await expectImmutableUpdate(
    migrator,
    'tombstoned principal rebinding',
    'UPDATE hirearchy.application_principals SET auth_user_id = $1 WHERE id = $2',
    [ids.subjectB, ids.principalUnused],
  );
  await expectImmutableUpdate(
    migrator,
    'tombstoned principal cannot reuse original subject',
    'UPDATE hirearchy.application_principals SET auth_user_id = $1 WHERE id = $2',
    [ids.subjectUnused, ids.principalUnused],
  );
  await expectImmutableUpdate(
    migrator,
    'tombstoned principal id',
    'UPDATE hirearchy.application_principals SET id = $1 WHERE id = $2',
    [randomUUID(), ids.principalUnused],
  );
  await assert.rejects(
    migrator.query(
      'INSERT INTO hirearchy.application_principals (id, auth_user_id) VALUES ($1, NULL)',
      [ids.principalUnused],
    ),
    (error) => error.code === '23505',
    'the original principal id must remain occupied after tombstoning',
  );
  await assert.rejects(
    migrator.query(
      'INSERT INTO hirearchy.application_principals (id, auth_user_id) VALUES ($1, $2)',
      [randomUUID(), ids.subjectB],
    ),
    (error) => error.code === '23505',
    'an existing Auth subject must not be reused by another principal',
  );
  const session = await migrator.query(
    'SELECT id, organization_id, issuer_principal_id FROM hirearchy.assessment_sessions WHERE id = $1',
    [ids.sessionTombstone],
  );
  assert.deepEqual(session.rows, [
    {
      id: ids.sessionTombstone,
      organization_id: ids.organizationC,
      issuer_principal_id: ids.principalUnused,
    },
  ]);
}

async function checkMigrationLedger(admin, migrator, migrateAgain) {
  const filenames = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const expected = filenames.map((filename) => ({
    version: filename.slice(0, 4),
    checksum: createHash('sha256')
      .update(readFileSync(join(MIGRATIONS_DIR, filename)))
      .digest('hex'),
  }));
  const { rows } = await migrator.query(
    'SELECT version, checksum, applied_by FROM hirearchy.schema_migrations ORDER BY version',
  );
  assert.deepEqual(
    rows.map(({ version, checksum }) => ({ version, checksum })),
    expected,
    'ledger checksums must match the exact migration bytes',
  );
  assert.ok(rows.every((row) => row.applied_by === 'hirearchy_migrator'));

  await migrator.query(
    `INSERT INTO hirearchy.schema_migrations (version, checksum)
     VALUES ('9999', $1)`,
    ['0'.repeat(64)],
  );
  await assert.rejects(
    migrateAgain(),
    (error) =>
      error.message === 'PostgreSQL migration transaction failed' &&
      /missing from this release/.test(error.cause?.message ?? ''),
  );
  await migrator.query(
    "DELETE FROM hirearchy.schema_migrations WHERE version = '9999'",
  );

  const original = rows[0].checksum;
  const wrong = original === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
  await migrator.query(
    'UPDATE hirearchy.schema_migrations SET checksum = $1 WHERE version = $2',
    [wrong, rows[0].version],
  );
  await assert.rejects(
    migrateAgain(),
    (error) =>
      error.message === 'PostgreSQL migration transaction failed' &&
      /checksum or identity does not match/.test(error.cause?.message ?? ''),
  );
  await migrator.query(
    'UPDATE hirearchy.schema_migrations SET checksum = $1 WHERE version = $2',
    [original, rows[0].version],
  );
  await migrateAgain();

  const temporaryDir = mkdtempSync(join(tmpdir(), 'hirearchy-r2-migrations-'));
  try {
    for (const filename of filenames) {
      writeFileSync(
        join(temporaryDir, filename),
        readFileSync(join(MIGRATIONS_DIR, filename)),
      );
    }
    const nextVersion = String(filenames.length + 1).padStart(4, '0');
    writeFileSync(
      join(temporaryDir, `${nextVersion}_rollback_probe.sql`),
      `CREATE TABLE hirearchy.r2_migration_rollback_probe (id integer PRIMARY KEY);\nSELECT 1 / 0;\n`,
    );
    await assert.rejects(
      applyMigrations(migrator, { migrationsDir: temporaryDir }),
      (error) =>
        error.message === 'PostgreSQL migration transaction failed' &&
        /division by zero/.test(error.cause?.message ?? ''),
    );
    const { rows: rollbackState } = await admin.query(
      `SELECT pg_catalog.to_regclass('hirearchy.r2_migration_rollback_probe') AS relation,
              EXISTS (SELECT 1 FROM hirearchy.schema_migrations WHERE version = $1) AS ledger_row`,
      [nextVersion],
    );
    assert.deepEqual(rollbackState[0], { relation: null, ledger_row: false });
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }

  const { rows: sentinel } = await admin.query(
    'SELECT value FROM public.r2_compatibility_sentinel WHERE id = 1',
  );
  assert.deepEqual(sentinel, [{ value: 'preserve-existing-public-schema' }]);
}

async function createFixtureRlsProbe(admin, password, organizationContext) {
  await admin.query(
    `CREATE ROLE r2_fixture_rls_probe LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD '${password}'`,
  );
  await admin.query('GRANT USAGE ON SCHEMA hirearchy TO r2_fixture_rls_probe');
  await admin.query(
    'GRANT SELECT, INSERT ON hirearchy.assessment_sessions TO r2_fixture_rls_probe',
  );
  await admin.query(
    'GRANT SELECT ON hirearchy.organizations, hirearchy.organization_memberships TO r2_fixture_rls_probe',
  );
  return new Pool({
    ...organizationContext,
    user: 'r2_fixture_rls_probe',
    password,
    max: 1,
  });
}

async function checkUpgradeFromLegacyGrants({
  admin,
  fixture,
  adminPassword,
  passwords,
  bootstrapSql,
  internalBootstrapSql,
}) {
  const database = `r2_upgrade_${randomBytes(6).toString('hex')}`;
  const prefixDir = mkdtempSync(join(tmpdir(), 'hirearchy-r2-upgrade-prefix-'));
  let upgradeAdmin;
  let upgradeMigrator;
  const upgradePools = [];
  const upgradeRuntimePools = {};
  await admin.query(`CREATE DATABASE ${database}`);
  try {
    const upgradeConfig = (user, password) =>
      connectionConfig(fixture, database, user, password);
    upgradeAdmin = await connectWithRetry(
      upgradeConfig('postgres', adminPassword),
    );
    await upgradeAdmin.query(bootstrapSql);
    await upgradeAdmin.query(internalBootstrapSql);

    const legacyMigrations = readdirSync(MIGRATIONS_DIR)
      .filter((filename) => filename.endsWith('.sql') && filename < '0013_')
      .sort();
    assert.ok(
      legacyMigrations.some((filename) => filename.startsWith('0012_')),
    );
    assert.ok(
      legacyMigrations.every((filename) => !filename.startsWith('0013_')),
    );
    for (const filename of legacyMigrations) {
      writeFileSync(
        join(prefixDir, filename),
        readFileSync(join(MIGRATIONS_DIR, filename)),
      );
    }

    upgradeMigrator = await connectWithRetry(
      upgradeConfig('hirearchy_migrator', passwords.hirearchy_migrator),
    );
    const legacyResult = await applyMigrations(upgradeMigrator, {
      migrationsDir: prefixDir,
    });
    assert.ok(legacyResult.appliedVersions.includes('0012'));
    assert.ok(!legacyResult.appliedVersions.includes('0013'));

    const fixtureData = createFoundationFixtures();
    await installMigratorFixtureAccess(upgradeAdmin);
    try {
      await seedFoundationFixtures(upgradeMigrator, fixtureData.ids);
    } finally {
      await removeMigratorFixtureAccess(upgradeAdmin);
    }
    await upgradeAdmin.query(
      `INSERT INTO hirearchy.reviewer_assignments
         (id, organization_id, session_id, reviewer_principal_id, assigned_by_principal_id)
       VALUES ('r2-upgrade-reviewer-assignment', $1, $2, $3, $4)`,
      [
        fixtureData.ids.organizationA,
        fixtureData.ids.sessionA,
        fixtureData.ids.principalShared,
        fixtureData.ids.principalA,
      ],
    );
    await upgradeAdmin.query(
      `UPDATE hirearchy.assessment_sessions
          SET status = 'SUBMITTED',
              activated_at = created_at + INTERVAL '1 second',
              submitted_at = created_at + INTERVAL '2 seconds',
              closure_reason = 'candidate_submission'
        WHERE id = $1`,
      [fixtureData.ids.sessionA],
    );
    await upgradeAdmin.query(
      `INSERT INTO hirearchy.candidate_ai_interactions
         (organization_id, session_id, interaction_id, request_id, sequence_start,
          sequence_completed, candidate_prompt, assistant_response, status, completed_at)
       VALUES ($1, $2, 'r2-upgrade-ai-evidence', 'r2-upgrade-ai-request', 1, 2,
               'synthetic prompt', 'synthetic response', 'COMPLETED', pg_catalog.clock_timestamp())`,
      [fixtureData.ids.organizationA, fixtureData.ids.sessionA],
    );
    await upgradeAdmin.query(
      `INSERT INTO hirearchy.candidate_execution_operations
         (organization_id, session_id, operation_id, request_id, sequence_start,
          sequence_completed, workspace_digest, workspace_version, recipe_id,
          recipe_version, recipe_digest, fence, status, exit_code, completed_at)
       VALUES ($1, $2, 'r2-upgrade-execution-evidence', 'r2-upgrade-execution-request',
               1, 2, repeat('a', 64), 1, 'r2-upgrade-fixture', '1.0.0',
               repeat('b', 64), 1, 'COMPLETED', 0, pg_catalog.clock_timestamp())`,
      [fixtureData.ids.organizationA, fixtureData.ids.sessionA],
    );

    for (const role of [
      'app_evaluator',
      'app_candidate_gateway',
      'app_control_worker',
    ]) {
      const pool = new Pool({
        ...upgradeConfig(role, passwords[role]),
        max: 1,
      });
      upgradePools.push(pool);
      upgradeRuntimePools[role] = pool;
    }
    await checkLegacySensitiveDirectReads({
      admin: upgradeAdmin,
      pools: upgradeRuntimePools,
      ids: fixtureData.ids,
    });

    const hardenedResult = await applyMigrations(upgradeMigrator);
    assert.ok(hardenedResult.appliedVersions.includes('0013'));
    const preservedAi = await upgradeAdmin.query(
      `SELECT interaction_id FROM hirearchy.candidate_ai_interactions
        WHERE session_id = $1`,
      [fixtureData.ids.sessionA],
    );
    const preservedExecution = await upgradeAdmin.query(
      `SELECT operation_id FROM hirearchy.candidate_execution_operations
        WHERE session_id = $1`,
      [fixtureData.ids.sessionA],
    );
    assert.deepEqual(preservedAi.rows, [
      { interaction_id: 'r2-upgrade-ai-evidence' },
    ]);
    assert.deepEqual(preservedExecution.rows, [
      { operation_id: 'r2-upgrade-execution-evidence' },
    ]);
    await checkRuntimeRolesAndDefaultDeny({
      admin: upgradeAdmin,
      pools: upgradeRuntimePools,
      ids: fixtureData.ids,
    });
  } finally {
    await Promise.all(
      upgradePools.map((pool) => pool.end().catch(() => undefined)),
    );
    await Promise.all(
      [upgradeMigrator, upgradeAdmin]
        .filter(Boolean)
        .map((client) => client.end().catch(() => undefined)),
    );
    rmSync(prefixDir, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  }
}

async function installFixtureRlsPolicies(admin) {
  await admin.query(`
    CREATE POLICY r2_fixture_tenant_org_read ON hirearchy.organizations
    FOR SELECT TO r2_fixture_rls_probe
    USING (id::text = current_setting('hirearchy.organization_id', true))
  `);
  await admin.query(`
    CREATE POLICY r2_fixture_tenant_membership_read ON hirearchy.organization_memberships
    FOR SELECT TO r2_fixture_rls_probe
    USING (organization_id::text = current_setting('hirearchy.organization_id', true))
  `);
  await admin.query(`
    CREATE POLICY r2_fixture_tenant_read ON hirearchy.assessment_sessions
    FOR SELECT TO r2_fixture_rls_probe
    USING (organization_id::text = current_setting('hirearchy.organization_id', true))
  `);
  await admin.query(`
    CREATE POLICY r2_fixture_tenant_insert ON hirearchy.assessment_sessions
    FOR INSERT TO r2_fixture_rls_probe
    WITH CHECK (organization_id::text = current_setting('hirearchy.organization_id', true))
  `);
}

async function removeFixtureRlsPolicies(admin) {
  await admin.query(
    'DROP POLICY IF EXISTS r2_fixture_tenant_org_read ON hirearchy.organizations',
  );
  await admin.query(
    'DROP POLICY IF EXISTS r2_fixture_tenant_membership_read ON hirearchy.organization_memberships',
  );
  await admin.query(
    'DROP POLICY IF EXISTS r2_fixture_tenant_read ON hirearchy.assessment_sessions',
  );
  await admin.query(
    'DROP POLICY IF EXISTS r2_fixture_tenant_insert ON hirearchy.assessment_sessions',
  );
  await admin.query(
    'REVOKE SELECT, INSERT ON hirearchy.assessment_sessions FROM r2_fixture_rls_probe',
  );
  await admin.query(
    'REVOKE SELECT ON hirearchy.organizations, hirearchy.organization_memberships FROM r2_fixture_rls_probe',
  );
  await admin.query(
    'REVOKE USAGE ON SCHEMA hirearchy FROM r2_fixture_rls_probe',
  );
  await admin.query('DROP ROLE IF EXISTS r2_fixture_rls_probe');
}

async function runCheck(name, check) {
  try {
    await check();
  } catch (error) {
    throw new Error(`${name}: ${error.message}`, { cause: error });
  }
  process.stdout.write(`PASS ${name}\n`);
}

async function main() {
  const adminPassword = randomPassword();
  let fixture;
  const pools = [];
  let admin;
  let migratorA;
  let migratorB;
  let fixtureProbe;
  try {
    fixture = await startPostgres(adminPassword);
    activeFixture = fixture;
    const adminConfig = connectionConfig(
      fixture,
      'postgres',
      'postgres',
      adminPassword,
    );
    admin = await connectWithRetry(adminConfig);

    const bootstrapSql = readFileSync(
      join(ROOT, 'database/postgres/bootstrap-roles.sql'),
      'utf8',
    );
    await admin.query(bootstrapSql);
    await admin.query(bootstrapSql);
    const internalBootstrapSql = readFileSync(
      join(ROOT, 'database/postgres/bootstrap-internal-roles.sql'),
      'utf8',
    );
    await runCheck(
      'internal roles bootstrap is atomic, repeatable, and rejects unsafe roles',
      () => checkInternalRoleBootstrap(admin, internalBootstrapSql),
    );
    await admin.query(internalBootstrapSql);
    await admin.query(
      `CREATE TABLE public.r2_compatibility_sentinel (id integer PRIMARY KEY, value text NOT NULL)`,
    );
    await admin.query(
      "INSERT INTO public.r2_compatibility_sentinel VALUES (1, 'preserve-existing-public-schema')",
    );

    const passwords = Object.fromEntries(
      RUNTIME_ROLES.map((role) => [role, randomPassword()]),
    );
    for (const role of RUNTIME_ROLES)
      await setRolePassword(admin, role, passwords[role]);

    const server = await admin.query(
      "SELECT current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num",
    );
    process.stdout.write(
      `Fixture: ${fixture.kind} PostgreSQL ${server.rows[0].server_version} (server_version_num ${server.rows[0].server_version_num}; deployment support target unspecified)\n`,
    );

    const migratorConfig = connectionConfig(
      fixture,
      'postgres',
      'hirearchy_migrator',
      passwords.hirearchy_migrator,
    );
    migratorA = await connectWithRetry(migratorConfig);
    migratorB = await connectWithRetry(migratorConfig);
    await runCheck(
      'concurrent migration apply, repeatability, exact-byte checksum, and compatibility sentinel',
      async () => {
        const concurrentResults = await Promise.all([
          applyMigrations(migratorA),
          applyMigrations(migratorB),
        ]);
        assert.ok(
          concurrentResults.every((result) =>
            result.appliedVersions.includes('0001'),
          ),
        );
        await checkMigrationLedger(admin, migratorA, () =>
          applyMigrations(migratorA),
        );
        const repeated = await applyMigrations(migratorA);
        assert.ok(repeated.appliedVersions.includes('0001'));
        await checkLegacyCompatibility(admin);
      },
    );

    await runCheck(
      'staging proof state remains inaccessible to runtime roles',
      async () => {
        const { rows } = await admin.query(`
        SELECT role_name, relation_name,
               pg_catalog.has_table_privilege(role_name, relation_name, 'SELECT,INSERT,UPDATE,DELETE') AS access
        FROM pg_catalog.unnest(ARRAY['app_evaluator', 'app_candidate_gateway', 'app_control_worker']) AS role_name
        CROSS JOIN pg_catalog.unnest(ARRAY['hirearchy.staging_verification_keys', 'hirearchy.staging_proof_nonces', 'hirearchy.staging_sessions']) AS relation_name
      `);
        assert.equal(rows.length, 9);
        for (const row of rows)
          assert.equal(
            row.access,
            false,
            `${row.role_name}: ${row.relation_name}`,
          );
      },
    );

    await runCheck(
      '0013 upgrade denies forged evaluator contexts and worker reads without deleting evidence',
      () =>
        checkUpgradeFromLegacyGrants({
          admin,
          fixture,
          adminPassword,
          passwords,
          bootstrapSql,
          internalBootstrapSql,
        }),
    );

    const fixtureData = createFoundationFixtures();
    await installMigratorFixtureAccess(admin);
    try {
      await seedFoundationFixtures(migratorA, fixtureData.ids);
      await runCheck(
        'composite tenant foreign keys and immutable ownership guards',
        () => checkCoreConstraints(migratorA, fixtureData.ids),
      );
    } finally {
      await removeMigratorFixtureAccess(admin);
    }

    const roleConfigs = Object.fromEntries(
      ['app_evaluator', 'app_candidate_gateway', 'app_control_worker'].map(
        (role) => [
          role,
          connectionConfig(fixture, 'postgres', role, passwords[role]),
        ],
      ),
    );
    const runtimePools = Object.fromEntries(
      Object.entries(roleConfigs).map(([role, config]) => {
        const pool = new Pool({ ...config, max: 1 });
        pools.push(pool);
        return [role, pool];
      }),
    );
    await runCheck(
      'actual runtime LOGIN role attributes and default-deny grants',
      () =>
        checkRuntimeRolesAndDefaultDeny({
          admin,
          pools: runtimePools,
          ids: fixtureData.ids,
        }),
    );
    await runCheck(
      'ordinary runtime roles cannot clear or replace principal subjects',
      () =>
        checkRuntimePrincipalIdentityDenied({
          pools: runtimePools,
          ids: fixtureData.ids,
        }),
    );

    fixtureProbe = await createFixtureRlsProbe(
      admin,
      randomPassword(),
      connectionConfig(fixture, 'postgres', 'postgres', adminPassword),
    );
    pools.push(fixtureProbe);
    await runCheck(
      'RLS default deny with a fixture-only table grant and no policy',
      () => checkRlsDeniesWithoutPolicy(fixtureProbe),
    );
    await installFixtureRlsPolicies(admin);
    await runCheck(
      'fixture-only RLS row filtering, missing/malformed context, and forgeable-GUC residual',
      () =>
        checkFixtureRlsAndGucResidual({
          fixturePool: fixtureProbe,
          ids: fixtureData.ids,
        }),
    );
    await runCheck(
      'max-one transaction context isolation, validation, rollback, timeout, and active backend cancellation',
      () =>
        checkTrustedTransactionPool({
          admin,
          evaluatorPool: runtimePools.app_evaluator,
          candidatePool: runtimePools.app_candidate_gateway,
          contextA: fixtureData.contextA,
          contextB: fixtureData.contextB,
        }),
    );
    await fixtureProbe.end();
    pools.splice(pools.indexOf(fixtureProbe), 1);
    await removeFixtureRlsPolicies(admin);
    fixtureProbe = undefined;

    process.stdout.write(
      'R2.2 foundation fixture checks passed. All rows were synthetic; no configured database URL was read.\n',
    );
  } finally {
    await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
    await Promise.all(
      [migratorA, migratorB, admin]
        .filter(Boolean)
        .map((client) => client.end().catch(() => undefined)),
    );
    await fixture?.cleanup();
    activeFixture = undefined;
  }
}

main().catch((error) => {
  const code = error.cause?.code ?? error.code;
  process.stderr.write(
    `R2.2 foundation fixture failed${code ? ` (${code})` : ''}: ${error.message}\n`,
  );
  process.exitCode = 1;
});
