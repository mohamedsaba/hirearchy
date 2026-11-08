import assert from 'node:assert/strict';
import {
  assertCandidateTokenStorage,
  initializeCandidateTokenStorage,
  loadCandidateTokenEncryptionKey,
  readCandidateTokenStorageMeta,
} from '../../database/postgres/r23/adapter.mjs';

export async function checkReadinessBoundary({
  admin,
  gateway,
  appUrl,
  postgresContainer,
  candidateTokenEncryptionKey,
  secrets,
  appLog,
  docker,
  waitFor,
  onCheckpoint = () => {},
}) {
  const checkpoint = (label) => onCheckpoint(`readiness / ${label}`);
  checkpoint('candidate-token storage binding');
  const key = candidateTokenEncryptionKey
    ? Buffer.from(candidateTokenEncryptionKey, 'base64')
    : loadCandidateTokenEncryptionKey();
  const existingMeta = await readCandidateTokenStorageMeta(admin);
  if (existingMeta) {
    await assertCandidateTokenStorage(admin, { key });
  } else {
    await initializeCandidateTokenStorage(admin, { key });
  }

  checkpoint('least-privilege role and gateway API');
  const { rows: grants } = await admin.query(`
    SELECT readiness.rolcanlogin,
           readiness.rolsuper,
           readiness.rolbypassrls,
           readiness.rolcreatedb,
           readiness.rolcreaterole,
           readiness.rolreplication,
           readiness.rolinherit,
           pg_catalog.has_schema_privilege('staging_readiness_owner','hirearchy','USAGE') AS schema_usage,
           pg_catalog.has_schema_privilege('staging_readiness_owner','hirearchy','CREATE') AS schema_create,
           pg_catalog.has_column_privilege('staging_readiness_owner','hirearchy.schema_migrations','version','SELECT') AS migration_version_select,
           pg_catalog.has_column_privilege('staging_readiness_owner','hirearchy.schema_migrations','checksum','SELECT') AS migration_checksum_select,
           pg_catalog.has_column_privilege('staging_readiness_owner','hirearchy.candidate_token_storage_meta','version','SELECT') AS token_version_select,
           pg_catalog.has_column_privilege('staging_readiness_owner','hirearchy.candidate_token_storage_meta','database_id','SELECT') AS token_database_id_select,
           pg_catalog.has_table_privilege('staging_readiness_owner','hirearchy.organization_memberships','SELECT') AS tenant_select,
           pg_catalog.has_function_privilege('r23_gateway','staging.readiness_probe()','EXECUTE') AS gateway_probe_execute,
           pg_catalog.has_function_privilege('anon','staging.readiness_probe()','EXECUTE') AS anonymous_probe_execute,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_auth_members
              WHERE roleid = readiness.oid OR member = readiness.oid
           ) AS has_memberships
      FROM pg_catalog.pg_roles AS readiness
     WHERE readiness.rolname = 'staging_readiness_owner'
  `);
  assert.deepEqual(grants, [
    {
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolinherit: false,
      schema_usage: true,
      schema_create: false,
      migration_version_select: true,
      migration_checksum_select: false,
      token_version_select: true,
      token_database_id_select: false,
      tenant_select: false,
      gateway_probe_execute: true,
      anonymous_probe_execute: false,
      has_memberships: false,
    },
  ]);

  const { rows } = await gateway.query(
    'SELECT staging.readiness_probe() AS readiness',
  );
  assert.deepEqual(rows[0].readiness, {
    migrationVersion: '0017',
    markers: {
      candidateLifecycle: true,
      onboarding: true,
      candidateTokenStorage: true,
      authoringR211: true,
      executionR214: true,
    },
  });

  for (const query of [
    'SELECT version FROM hirearchy.schema_migrations',
    'SELECT version FROM hirearchy.candidate_token_storage_meta',
    'SELECT marker_key FROM hirearchy.durable_candidate_installation',
    'SELECT id FROM hirearchy.organization_memberships',
    'UPDATE hirearchy.durable_onboarding_installation SET marker_version = 1',
  ]) {
    await assert.rejects(gateway.query(query), { code: '42501' });
  }

  checkpoint('missing installation metadata returns 503');
  const readinessUrl = `${appUrl}/api/staging/readiness`;
  const healthy = await fetch(readinessUrl);
  assert.equal(healthy.status, 200, 'installed readiness is healthy');
  const { rows: metadataRows } = await admin.query(
    'SELECT slot, version, database_id, key_check FROM hirearchy.candidate_token_storage_meta WHERE slot = 1',
  );
  assert.equal(metadataRows.length, 1, 'candidate-token storage marker exists');
  const marker = metadataRows[0];
  try {
    await admin.query(
      'DELETE FROM hirearchy.candidate_token_storage_meta WHERE slot = 1',
    );
    const missingMarker = await fetch(readinessUrl);
    assert.equal(
      missingMarker.status,
      503,
      'readiness fails closed when candidate-token storage marker is absent',
    );
    const missingReport = await missingMarker.json();
    assert.equal(missingReport.database.connected, true);
    assert.equal(missingReport.database.markers.candidateTokenStorage, false);
  } finally {
    await admin.query(
      `INSERT INTO hirearchy.candidate_token_storage_meta
         (slot, version, database_id, key_check)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slot) DO NOTHING`,
      [marker.slot, marker.version, marker.database_id, marker.key_check],
    );
  }
  const restored = await fetch(readinessUrl);
  assert.equal(restored.status, 200, 'readiness recovers after marker restore');

  checkpoint('database outage returns 503 and logs stay redacted');
  docker('stop', postgresContainer);
  try {
    const unavailable = await fetch(readinessUrl);
    assert.equal(unavailable.status, 503, 'database outage returns 503');
  } finally {
    docker('start', postgresContainer);
  }
  await waitFor(async () => (await fetch(readinessUrl)).status === 200);
  for (const secret of secrets) {
    assert.equal(
      appLog().includes(secret),
      false,
      'application logs redact secrets',
    );
  }
}
