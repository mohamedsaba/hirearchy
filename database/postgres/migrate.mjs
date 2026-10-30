import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATOR = 'hirearchy_migrator';
const DEFAULT_MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

function migrationVersion(fileName) {
  const match = /^(\d{4})_[a-z0-9_-]+\.sql$/.exec(fileName);
  if (!match) throw new Error(`Invalid migration filename: ${fileName}`);
  return match[1];
}

async function readMigrations(migrationsDir) {
  const directory =
    migrationsDir instanceof URL ? fileURLToPath(migrationsDir) : migrationsDir;
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const migrations = [];

  for (const name of names) {
    const version = migrationVersion(name);
    const bytes = await readFile(path.join(directory, name));
    const sql = bytes.toString('utf8');
    if (!sql.trim() || sql.includes('\u0000'))
      throw new Error(`Invalid migration content: ${name}`);
    migrations.push({
      version,
      name,
      sql,
      checksum: createHash('sha256').update(bytes).digest('hex'),
    });
  }

  if (
    !migrations.length ||
    migrations.some(
      (migration, index) =>
        migration.version !== String(index + 1).padStart(4, '0'),
    )
  ) {
    throw new Error(
      'Migration versions must start at 0001 and remain contiguous',
    );
  }
  return migrations;
}

async function rollback(client, originalError) {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      'PostgreSQL migration rollback failed',
    );
  }
}

async function verifyMigrationConnection(client) {
  const { rows } = await client.query(`
    SELECT current_user::text AS role_name,
           session_user::text AS login_name,
           r.rolcanlogin,
           r.rolsuper,
           r.rolbypassrls,
           r.rolcreatedb,
           r.rolcreaterole,
           r.rolreplication,
           r.rolinherit,
           pg_catalog.pg_get_userbyid(n.nspowner) AS schema_owner,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_auth_members AS m
             WHERE m.roleid = r.oid OR m.member = r.oid
           ) AS has_role_membership
    FROM pg_catalog.pg_roles AS r
    LEFT JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'hirearchy'
    WHERE r.rolname = current_user
  `);
  const role = rows[0];

  if (
    !role ||
    role.role_name !== MIGRATOR ||
    role.login_name !== MIGRATOR ||
    role.schema_owner !== MIGRATOR ||
    !role.rolcanlogin ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.rolinherit ||
    role.has_role_membership
  ) {
    throw new Error(
      'PostgreSQL migrations require the restricted hirearchy_migrator identity and schema ownership',
    );
  }
}

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS hirearchy.schema_migrations (
      version text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      applied_by name NOT NULL DEFAULT current_user
    )
  `);
  const { rows } = await client.query(`
    SELECT pg_catalog.pg_get_userbyid(c.relowner) AS owner,
           NOT EXISTS (
             SELECT 1
             FROM pg_catalog.aclexplode(
               COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))
             ) AS privilege
             WHERE privilege.grantee = 0
           ) AS public_denied
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'hirearchy' AND c.relname = 'schema_migrations' AND c.relkind = 'r'
  `);
  if (
    rows.length !== 1 ||
    rows[0].owner !== MIGRATOR ||
    !rows[0].public_denied
  ) {
    throw new Error(
      'Migration ledger ownership or PUBLIC privileges are unsafe',
    );
  }
}

async function verifyPublicPrivileges(client) {
  const { rows } = await client.query(`
    SELECT
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_namespace AS n,
             LATERAL pg_catalog.aclexplode(
               COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))
             ) AS privilege
        WHERE n.nspname = 'hirearchy' AND privilege.grantee = 0
      ) AS schema_public_denied,
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_default_acl AS d
        JOIN pg_catalog.pg_roles AS r ON r.oid = d.defaclrole
        CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) AS privilege
        WHERE r.rolname = 'hirearchy_migrator'
          AND d.defaclnamespace IN (
            0,
            (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'hirearchy')
          )
          AND privilege.grantee = 0
      ) AS defaults_public_denied
  `);
  if (!rows[0]?.schema_public_denied || !rows[0]?.defaults_public_denied) {
    throw new Error(
      'PUBLIC has schema or default privileges in the PostgreSQL application schema',
    );
  }
}

export async function applyMigrations(
  client,
  { migrationsDir = DEFAULT_MIGRATIONS_DIR } = {},
) {
  await verifyMigrationConnection(client);
  const migrations = await readMigrations(migrationsDir);
  await client.query('BEGIN');
  try {
    await client.query(
      'SET LOCAL search_path = pg_catalog, hirearchy, pg_temp',
    );
    await client.query(
      'SELECT pg_catalog.pg_advisory_xact_lock(1346851650, 1)',
    );
    await ensureLedger(client);
    await verifyPublicPrivileges(client);

    const { rows: appliedRows } = await client.query(`
      SELECT version, checksum, applied_by
      FROM hirearchy.schema_migrations
      ORDER BY version
    `);
    const applied = new Map(appliedRows.map((row) => [row.version, row]));
    const migrationByVersion = new Map(
      migrations.map((migration) => [migration.version, migration]),
    );

    for (const row of appliedRows) {
      const migration = migrationByVersion.get(row.version);
      if (!migration)
        throw new Error(
          `Applied migration ${row.version} is missing from this release`,
        );
      if (row.checksum !== migration.checksum || row.applied_by !== MIGRATOR) {
        throw new Error(
          `Applied migration ${row.version} checksum or identity does not match`,
        );
      }
    }

    let pending = false;
    const appliedVersions = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        if (pending)
          throw new Error(
            `Migration ${migration.version} is applied after a missing earlier version`,
          );
        appliedVersions.push(migration.version);
        continue;
      }
      pending = true;
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO hirearchy.schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum],
      );
      appliedVersions.push(migration.version);
    }

    await verifyPublicPrivileges(client);
    await client.query('COMMIT');
    return { appliedVersions };
  } catch (error) {
    await rollback(client, error);
    throw error instanceof AggregateError
      ? error
      : new Error('PostgreSQL migration transaction failed', { cause: error });
  }
}
