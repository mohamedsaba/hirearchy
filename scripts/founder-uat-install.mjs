import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { applyMigrations } from '../database/postgres/migrate.mjs';
import {
  assertCandidateTokenStorage,
  initializeCandidateTokenStorage,
  loadCandidateTokenEncryptionKey,
  readCandidateTokenStorageMeta,
} from '../database/postgres/r23/adapter.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM_TABLES = new Set([
  'auth.instances',
  'auth.schema_migrations',
  'hirearchy.candidate_token_storage_meta',
  'hirearchy.durable_candidate_installation',
  'hirearchy.durable_onboarding_installation',
  'hirearchy.schema_migrations',
  'hirearchy.staging_verification_keys',
]);

function required(name, env = process.env) {
  const value = env[name];
  assert(value && value.length <= 16384, `${name} is required`);
  return value;
}

function localPostgresUrl(
  name,
  expectedUser,
  expectedPort,
  expectedPassword,
  env,
) {
  const value = required(name, env);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a local PostgreSQL URL`);
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    isIP(url.hostname) !== 4 ||
    !url.hostname.startsWith('127.') ||
    url.port !== expectedPort ||
    url.username !== expectedUser ||
    !url.password ||
    url.pathname !== '/postgres' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must use the ${expectedUser} role on local 127.0.0.1 PostgreSQL port ${expectedPort}, database postgres, without URL options`,
    );
  }
  if (url.password !== expectedPassword) {
    throw new Error(`${name} password must match protected runtime state`);
  }
  return value;
}

function localHttpOrigin(name, expectedPort, env) {
  const value = required(name, env);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a local HTTP origin`);
  }
  assert(
    url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port === expectedPort &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.origin === value,
    `${name} must be exactly http://127.0.0.1:${expectedPort}`,
  );
  return url;
}

export function validateFounderUatDatabaseConfiguration(env = process.env) {
  assert.equal(
    required('HIREARCHY_RUNTIME_PROFILE', env),
    'founder-uat',
    'Founder UAT installation requires the founder-uat profile',
  );
  const pgPort = required('PG_PORT', env);
  assert.match(pgPort, /^\d{1,5}$/);
  assert(Number(pgPort) >= 1 && Number(pgPort) <= 65535);
  const adminUrl = localPostgresUrl(
    'STAGING_ADMIN_DATABASE_URL',
    'postgres',
    pgPort,
    required('POSTGRES_PASSWORD', env),
    env,
  );
  const migratorUrl = localPostgresUrl(
    'STAGING_MIGRATOR_DATABASE_URL',
    'hirearchy_migrator',
    pgPort,
    required('MIGRATOR_DATABASE_PASSWORD', env),
    env,
  );
  localPostgresUrl(
    'STAGING_DATABASE_URL',
    'r23_gateway',
    pgPort,
    required('R23_GATEWAY_PASSWORD', env),
    env,
  );
  localPostgresUrl(
    'STAGING_CANDIDATE_DATABASE_URL',
    'app_candidate_gateway',
    pgPort,
    required('CANDIDATE_GATEWAY_PASSWORD', env),
    env,
  );
  const appOrigin = localHttpOrigin(
    'FOUNDER_UAT_APP_ORIGIN',
    required('APP_PORT', env),
    env,
  );
  const authOrigin = localHttpOrigin(
    'STAGING_AUTH_URL',
    required('GOTRUE_API_PORT', env),
    env,
  );
  localHttpOrigin(
    'FOUNDER_UAT_MAILPIT_API_URL',
    required('MAILPIT_API_PORT', env),
    env,
  );
  assert.equal(required('STAGING_PUBLIC_ORIGIN', env), appOrigin.origin);
  assert.equal(required('STAGING_AUTH_ISSUER', env), authOrigin.origin);
  assert.equal(required('STAGING_AUTH_AUDIENCE', env), 'authenticated');
  assert.equal(required('STAGING_PROOF_AUDIENCE', env), 'hirearchy-postgres');
  assert.match(required('STAGING_PROOF_KEY_ID', env), UUID);
  return { adminUrl, migratorUrl };
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function countRows(client, schema, table) {
  const { rows } = await client.query(
    `SELECT count(*)::text AS count FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
  );
  return BigInt(rows[0].count);
}

async function readFounderUatDatabaseCounts(client) {
  const { rows: tableRows } = await client.query(
    `SELECT namespace.nspname AS schema_name, relation.relname AS table_name
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY($1::pg_catalog.name[])
        AND relation.relkind IN ('r', 'p')
      ORDER BY namespace.nspname, relation.relname`,
    [['auth', 'hirearchy', 'staging']],
  );

  const counts = new Map();
  for (const { schema_name: schema, table_name: table } of tableRows) {
    const qualified = `${schema}.${table}`;
    if (SYSTEM_TABLES.has(qualified)) continue;
    counts.set(qualified, await countRows(client, schema, table));
  }

  const sum = (names) =>
    names.reduce((total, name) => total + (counts.get(name) ?? 0n), 0n);
  const output = {
    authUsers: counts.get('auth.users') ?? 0n,
    authSessions: counts.get('auth.sessions') ?? 0n,
    applicationPrincipals: counts.get('hirearchy.application_principals') ?? 0n,
    organizations: counts.get('hirearchy.organizations') ?? 0n,
    organizationMemberships:
      counts.get('hirearchy.organization_memberships') ?? 0n,
    assessments: sum([
      'hirearchy.assessment_definitions',
      'hirearchy.assessment_drafts',
      'hirearchy.assessment_validated_versions',
      'hirearchy.assessment_issuances',
    ]),
    candidateSessions: sum([
      'hirearchy.assessment_sessions',
      'hirearchy.candidate_workspace_files',
      'hirearchy.candidate_file_revisions',
      'hirearchy.candidate_session_events',
      'hirearchy.candidate_session_operations',
      'hirearchy.candidate_session_submissions',
      'hirearchy.candidate_execution_operations',
      'hirearchy.candidate_ai_interactions',
      'hirearchy.candidate_invitation_requests',
      'hirearchy.candidate_data_consents',
      'hirearchy.candidate_token_envelopes',
    ]),
    observations: sum([
      'hirearchy.evaluator_observations',
      'hirearchy.evaluator_observation_history',
    ]),
    reviews: sum([
      'hirearchy.evaluator_review_packets',
      'hirearchy.evaluator_review_packet_history',
      'hirearchy.reviewer_assignments',
    ]),
    invitations: sum([
      'hirearchy.organization_invitations',
      'hirearchy.onboarding_request_receipts',
    ]),
    otherProductRows: [...counts.entries()]
      .filter(
        ([name]) =>
          ![
            'auth.users',
            'auth.sessions',
            'hirearchy.application_principals',
            'hirearchy.organizations',
            'hirearchy.organization_memberships',
            'hirearchy.assessment_definitions',
            'hirearchy.assessment_drafts',
            'hirearchy.assessment_validated_versions',
            'hirearchy.assessment_issuances',
            'hirearchy.assessment_sessions',
            'hirearchy.candidate_workspace_files',
            'hirearchy.candidate_file_revisions',
            'hirearchy.candidate_session_events',
            'hirearchy.candidate_session_operations',
            'hirearchy.candidate_session_submissions',
            'hirearchy.candidate_execution_operations',
            'hirearchy.candidate_ai_interactions',
            'hirearchy.candidate_invitation_requests',
            'hirearchy.candidate_data_consents',
            'hirearchy.candidate_token_envelopes',
            'hirearchy.evaluator_observations',
            'hirearchy.evaluator_observation_history',
            'hirearchy.evaluator_review_packets',
            'hirearchy.evaluator_review_packet_history',
            'hirearchy.reviewer_assignments',
            'hirearchy.organization_invitations',
            'hirearchy.onboarding_request_receipts',
          ].includes(name),
      )
      .reduce((total, [, value]) => total + value, 0n),
  };

  const total = Object.values(output).reduce((sum, count) => sum + count, 0n);
  return {
    ...Object.fromEntries(
      Object.entries(output).map(([name, count]) => [name, Number(count)]),
    ),
    productRows: Number(total),
  };
}

async function verifyAndRegisterProofKey(client) {
  const encoded = required('STAGING_PROOF_PRIVATE_KEY');
  const encodedBytes = Buffer.from(encoded, 'base64');
  assert.equal(encodedBytes.toString('base64'), encoded);
  const privateKey = createPrivateKey({
    key: encodedBytes,
    format: 'der',
    type: 'pkcs8',
  });
  assert.equal(privateKey.asymmetricKeyType, 'ed25519');
  const publicKey = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32);
  const keyId = required('STAGING_PROOF_KEY_ID');
  const issuer = required('STAGING_PROOF_ISSUER');
  const audience = required('STAGING_PROOF_AUDIENCE');
  assert.match(keyId, /^[A-Za-z0-9._-]{1,80}$/);

  const existing = await client.query(
    `SELECT issuer, audience, public_key, revoked_at,
            valid_from <= pg_catalog.clock_timestamp()
              AND valid_until > pg_catalog.clock_timestamp() AS active
       FROM hirearchy.staging_verification_keys
      WHERE key_id = $1`,
    [keyId],
  );
  if (existing.rowCount === 0) {
    await client.query(
      `INSERT INTO hirearchy.staging_verification_keys
         (key_id, issuer, audience, public_key, valid_from, valid_until)
       VALUES ($1, $2, $3, $4,
               pg_catalog.clock_timestamp() - INTERVAL '1 minute',
               pg_catalog.clock_timestamp() + INTERVAL '365 days')`,
      [keyId, issuer, audience, publicKey],
    );
    console.log('Registered the local Founder UAT proof verification key.');
    return;
  }

  assert.equal(existing.rowCount, 1, 'Proof key ID must be unique');
  const row = existing.rows[0];
  assert(
    row.issuer === issuer &&
      row.audience === audience &&
      Buffer.from(row.public_key).equals(publicKey) &&
      row.revoked_at === null &&
      row.active === true,
    'The stored Founder UAT proof key is revoked, expired, or differs from protected runtime state',
  );
  console.log('Verified the existing local Founder UAT proof key.');
}

async function main() {
  const expectedEmpty = process.env.FOUNDER_UAT_REQUIRE_EMPTY === '1';
  const { adminUrl, migratorUrl } = validateFounderUatDatabaseConfiguration();

  const migrator = new Client({ connectionString: migratorUrl });
  await migrator.connect();
  try {
    const result = await applyMigrations(migrator);
    assert(
      result.appliedVersions.includes('0017'),
      'Founder UAT requires migration 0017',
    );
    console.log(
      `Migrations verified through ${result.appliedVersions.at(-1)} (${result.appliedVersions.length} total).`,
    );
  } finally {
    await migrator.end().catch(() => {});
  }

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const candidateTokenKey = loadCandidateTokenEncryptionKey();
    const existingStorage = await readCandidateTokenStorageMeta(admin);
    let databaseId;
    if (existingStorage) {
      await assertCandidateTokenStorage(admin, { key: candidateTokenKey });
      databaseId = existingStorage.database_id;
      console.log('Verified the existing candidate-token key binding.');
    } else {
      const initialized = await initializeCandidateTokenStorage(admin, {
        key: candidateTokenKey,
      });
      databaseId = initialized.databaseId;
      console.log('Initialized the candidate-token key binding.');
    }

    const installer = await readFile(
      new URL('../database/postgres/staging/install-api.sql', import.meta.url),
      'utf8',
    );
    await admin.query(installer);
    await verifyAndRegisterProofKey(admin);

    const counts = await readFounderUatDatabaseCounts(admin);
    assert.match(databaseId, /^[A-Za-z0-9_-]{22}$/);
    console.log(`FOUNDER_UAT_DATABASE_ID=${databaseId}`);
    console.log(`Founder UAT database row counts: ${JSON.stringify(counts)}`);
    if (expectedEmpty) {
      assert.equal(
        counts.productRows,
        0,
        'First initialization found product activity; refusing to expose this database',
      );
      assert.equal(
        counts.authUsers,
        0,
        'First initialization found Auth users',
      );
      console.log(
        'First-initialization empty database assertion passed after migrations, API installation, and key registration.',
      );
    } else {
      console.log(
        'Existing Founder UAT records were preserved; empty-state checks are first-initialization only.',
      );
    }
  } finally {
    await admin.end().catch(() => {});
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? `Founder UAT database installation failed: ${error.message}`
        : 'Founder UAT database installation failed.',
    );
    process.exitCode = 1;
  });
}
