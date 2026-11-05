import assert from 'node:assert/strict';
import { withTrustedEvaluatorTransaction } from '../../database/postgres/transaction.mjs';

const TABLES = [
  'organizations',
  'application_principals',
  'organization_memberships',
  'assessment_sessions',
];
const SENSITIVE_TABLES = [
  'candidate_ai_interactions',
  'candidate_execution_operations',
];

const GUC_COLUMNS = `
  NULLIF(current_setting('hirearchy.actor_principal_id', true), '') AS principal_id,
  NULLIF(current_setting('hirearchy.auth_subject_id', true), '') AS subject_id,
  NULLIF(current_setting('hirearchy.auth_session_id', true), '') AS auth_session_id,
  NULLIF(current_setting('hirearchy.auth_assurance', true), '') AS assurance,
  NULLIF(current_setting('hirearchy.organization_id', true), '') AS organization_id,
  NULLIF(current_setting('hirearchy.correlation_id', true), '') AS correlation_id`;

function expectCapabilityScope(expression) {
  assert.match(expression, /r26\.session_id/);
  assert.match(expression, /r26\.token_hash/);
  assert.match(expression, /candidate_token_envelopes/);
}

export async function checkRuntimeRolesAndDefaultDeny({ admin, pools, ids }) {
  const runtimeRoles = [
    'app_evaluator',
    'app_candidate_gateway',
    'app_control_worker',
  ];
  const { rows: roles } = await admin.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb,
            rolcreaterole, rolreplication, rolinherit
       FROM pg_catalog.pg_roles
      WHERE rolname = ANY($1::name[])`,
    [runtimeRoles],
  );
  assert.equal(roles.length, runtimeRoles.length);
  for (const role of roles) {
    assert.equal(
      role.rolcanlogin,
      true,
      `${role.rolname} must be a LOGIN role`,
    );
    for (const attribute of [
      'rolsuper',
      'rolbypassrls',
      'rolcreatedb',
      'rolcreaterole',
      'rolreplication',
      'rolinherit',
    ]) {
      assert.equal(
        role[attribute],
        false,
        `${role.rolname}.${attribute} must be false`,
      );
    }
  }

  const { rows: memberships } = await admin.query(
    `SELECT member_role.rolname AS member, granted_role.rolname AS granted
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
       JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
      WHERE member_role.rolname = ANY($1::name[])`,
    [runtimeRoles],
  );
  assert.deepEqual(
    memberships,
    [],
    'runtime roles must not inherit or assume any role',
  );

  const { rows: tables } = await admin.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            pg_catalog.pg_get_userbyid(c.relowner) AS owner
       FROM pg_catalog.pg_class AS c
       JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'hirearchy' AND c.relname = ANY($1::name[])
      ORDER BY c.relname`,
    [TABLES],
  );
  assert.equal(tables.length, TABLES.length);
  for (const table of tables) {
    assert.equal(
      table.relrowsecurity,
      true,
      `${table.relname} must enable RLS`,
    );
    assert.equal(
      table.relforcerowsecurity,
      true,
      `${table.relname} must force RLS`,
    );
    assert.equal(table.owner, 'hirearchy_migrator');
  }

  const { rows: policies } = await admin.query(
    `SELECT tablename, policyname, roles::text[] AS roles, cmd, qual, with_check
       FROM pg_catalog.pg_policies
      WHERE schemaname = 'hirearchy' AND tablename = ANY($1::text[])
      ORDER BY tablename, policyname`,
    [TABLES],
  );
  assert.deepEqual(
    policies.map(({ tablename, policyname, roles, cmd }) => ({
      tablename,
      policyname,
      roles,
      cmd,
    })),
    [
      {
        tablename: 'assessment_sessions',
        policyname: 'r26_candidate_session_select',
        roles: ['hirearchy_migrator'],
        cmd: 'SELECT',
      },
      {
        tablename: 'assessment_sessions',
        policyname: 'r26_candidate_session_update',
        roles: ['hirearchy_migrator'],
        cmd: 'UPDATE',
      },
    ],
    'only capability-scoped definer SELECT/UPDATE policies may exist on core tenant tables',
  );

  for (const policy of policies) {
    expectCapabilityScope(policy.qual);
    if (policy.cmd === 'UPDATE') expectCapabilityScope(policy.with_check);
  }

  const { rows: tablePrivileges } = await admin.query(
    `SELECT role.rolname, table_row.relname, privilege.name, granted.has_privilege
       FROM pg_catalog.pg_roles AS role
       CROSS JOIN pg_catalog.pg_class AS table_row
       JOIN pg_catalog.pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
       CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS privilege(name)
       CROSS JOIN LATERAL (
         SELECT pg_catalog.has_table_privilege(role.oid, table_row.oid, privilege.name) AS has_privilege
       ) AS granted
      WHERE role.rolname = ANY($1::name[])
        AND schema_row.nspname = 'hirearchy'
        AND table_row.relname = ANY($2::name[])
        AND granted.has_privilege
      ORDER BY role.rolname, table_row.relname, privilege.name`,
    [runtimeRoles, TABLES],
  );
  assert.deepEqual(
    tablePrivileges,
    [],
    'runtime roles must have no tenant table privileges',
  );

  const { rows: sensitivePrivileges } = await admin.query(
    `SELECT role.rolname, table_row.relname, privilege.name
       FROM pg_catalog.pg_roles AS role
       CROSS JOIN pg_catalog.pg_class AS table_row
       JOIN pg_catalog.pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
       CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS privilege(name)
      WHERE role.rolname = ANY($1::name[])
        AND schema_row.nspname = 'hirearchy'
        AND table_row.relname = ANY($2::name[])
        AND pg_catalog.has_table_privilege(role.oid, table_row.oid, privilege.name)
      ORDER BY role.rolname, table_row.relname, privilege.name`,
    [runtimeRoles, SENSITIVE_TABLES],
  );
  assert.deepEqual(
    sensitivePrivileges,
    [],
    'runtime roles must have no direct AI or execution table privileges',
  );

  const { rows: sensitivePolicies } = await admin.query(
    `SELECT tablename, policyname, roles::text[] AS roles
       FROM pg_catalog.pg_policies
      WHERE schemaname = 'hirearchy' AND tablename = ANY($1::text[])
      ORDER BY tablename, policyname`,
    [SENSITIVE_TABLES],
  );
  assert.deepEqual(
    sensitivePolicies.filter(({ roles }) =>
      roles.some((role) =>
        ['app_evaluator', 'app_control_worker'].includes(role),
      ),
    ),
    [],
    'AI and execution tables must not have evaluator or worker RLS policies',
  );

  const { rows: functionPrivileges } = await admin.query(
    `SELECT role.rolname, procedure.proname
       FROM pg_catalog.pg_roles AS role
       CROSS JOIN pg_catalog.pg_proc AS procedure
       JOIN pg_catalog.pg_namespace AS schema_row ON schema_row.oid = procedure.pronamespace
      WHERE role.rolname = ANY($1::name[])
        AND schema_row.nspname = 'hirearchy'
        AND pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
      ORDER BY role.rolname, procedure.proname`,
    [runtimeRoles],
  );
  assert.deepEqual(
    functionPrivileges,
    [{ rolname: 'app_candidate_gateway', proname: 'r26_candidate_command' }],
    'only the fixed candidate command may be executable by a runtime role',
  );

  for (const role of runtimeRoles) {
    const { rows: access } = await admin.query(
      `SELECT pg_catalog.has_schema_privilege($1, 'hirearchy', 'USAGE') AS schema_usage,
              pg_catalog.has_schema_privilege($1, 'hirearchy', 'CREATE') AS schema_create,
              pg_catalog.has_table_privilege($1, 'hirearchy.organizations', 'SELECT') AS table_select,
              pg_catalog.has_table_privilege($1, 'hirearchy.organizations', 'INSERT') AS table_insert,
              pg_catalog.has_table_privilege($1, 'hirearchy.organizations', 'UPDATE') AS table_update,
              pg_catalog.has_table_privilege($1, 'hirearchy.organizations', 'DELETE') AS table_delete`,
      [role],
    );
    assert.deepEqual(
      access[0],
      {
        schema_usage: role === 'app_candidate_gateway',
        schema_create: false,
        table_select: false,
        table_insert: false,
        table_update: false,
        table_delete: false,
      },
      `${role} must retain table denial and only the explicit candidate command schema access`,
    );

    const pool = pools[role];
    const { rows: identity } = await pool.query(
      'SELECT current_user AS current_user, session_user AS session_user',
    );
    assert.equal(identity[0].current_user, role);
    assert.equal(identity[0].session_user, role);

    if (role === 'app_evaluator' || role === 'app_control_worker') {
      await checkSensitiveDirectReadsDenied(pool, {
        organizationId: ids.organizationA,
        sessionId: ids.sessionA,
        principalId: ids.principalShared,
        role,
      });
    }

    await assert.rejects(
      pool.query('SELECT * FROM hirearchy.organizations'),
      (error) => error.code === '42501',
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO hirearchy.organizations (id) VALUES ('00000000-0000-4000-8000-000000000001')",
      ),
      (error) => error.code === '42501',
    );
    await assert.rejects(
      pool.query(
        "UPDATE hirearchy.organizations SET id = '00000000-0000-4000-8000-000000000002'",
      ),
      (error) => error.code === '42501',
    );
    await assert.rejects(
      pool.query('DELETE FROM hirearchy.organizations'),
      (error) => error.code === '42501',
    );
    await assert.rejects(
      pool.query('SET ROLE hirearchy_migrator'),
      (error) => error.code === '42501',
    );
    await assert.rejects(
      pool.query('CREATE TABLE hirearchy.r2_forbidden (id integer)'),
      (error) => error.code === '42501',
    );
    await assert.rejects(
      pool.query('SELECT hirearchy.reject_immutable_columns()'),
      (error) => error.code === '42501',
    );

    const client = await pool.connect();
    try {
      await client.query('SET row_security = off');
      await assert.rejects(
        client.query('SELECT * FROM hirearchy.organizations'),
        (error) => error.code === '42501',
      );
      await client.query('RESET row_security');
    } finally {
      client.release();
    }
  }
}

async function checkSensitiveDirectReadsDenied(
  pool,
  { organizationId, sessionId, principalId, role },
) {
  for (const table of SENSITIVE_TABLES) {
    const identitySources =
      role === 'app_evaluator' ? ['r27', 'hirearchy'] : ['none'];
    for (const identitySource of identitySources) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (role === 'app_evaluator') {
          await client.query(
            `SELECT pg_catalog.set_config('r27.organization_id', $1, true),
                    pg_catalog.set_config('r27.session_id', $2, true),
                    pg_catalog.set_config('r27.principal_id', $3, true),
                    pg_catalog.set_config('hirearchy.evaluator_principal_id', $4, true)`,
            [
              organizationId,
              sessionId,
              identitySource === 'r27' ? principalId : '',
              identitySource === 'hirearchy' ? principalId : '',
            ],
          );
        }
        await assert.rejects(
          client.query(`SELECT * FROM hirearchy.${table}`),
          (error) => error.code === '42501',
          `${role} must not directly read ${table} with ${identitySource} identity context`,
        );
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
  }
}

export async function checkLegacySensitiveDirectReads({ admin, pools, ids }) {
  const { rows: legacyPrivileges } = await admin.query(
    `SELECT role.rolname, table_row.relname,
            pg_catalog.has_schema_privilege(role.oid, schema_row.oid, 'USAGE') AS schema_usage,
            pg_catalog.has_table_privilege(role.oid, table_row.oid, 'SELECT') AS table_select
       FROM pg_catalog.pg_roles AS role
       CROSS JOIN pg_catalog.pg_class AS table_row
       JOIN pg_catalog.pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
      WHERE role.rolname = ANY(ARRAY['app_evaluator', 'app_control_worker']::name[])
        AND schema_row.nspname = 'hirearchy'
        AND table_row.relname = ANY($1::name[])
      ORDER BY role.rolname, table_row.relname`,
    [SENSITIVE_TABLES],
  );
  assert.deepEqual(
    legacyPrivileges,
    ['app_control_worker', 'app_evaluator'].flatMap((rolname) =>
      SENSITIVE_TABLES.map((relname) => ({
        rolname,
        relname,
        schema_usage: true,
        table_select: true,
      })),
    ),
    'pre-0013 evaluator and worker grants expose direct evidence-table SELECT',
  );

  const { rows: legacyPolicies } = await admin.query(
    `SELECT tablename, policyname, roles::text[] AS roles, qual
       FROM pg_catalog.pg_policies
      WHERE schemaname = 'hirearchy' AND tablename = ANY($1::text[])
      ORDER BY tablename, policyname`,
    [SENSITIVE_TABLES],
  );
  const directPolicies = legacyPolicies.filter(({ roles }) =>
    roles.some((role) =>
      ['app_evaluator', 'app_control_worker'].includes(role),
    ),
  );
  assert.deepEqual(
    directPolicies.map(({ tablename, policyname, roles }) => ({
      tablename,
      policyname,
      roles,
    })),
    [
      {
        tablename: 'candidate_ai_interactions',
        policyname: 'r212_control_worker_ai_interactions_select',
        roles: ['app_control_worker'],
      },
      {
        tablename: 'candidate_ai_interactions',
        policyname: 'r212_evaluator_ai_interactions_select',
        roles: ['app_evaluator'],
      },
      {
        tablename: 'candidate_execution_operations',
        policyname: 'r213_control_worker_execution_select',
        roles: ['app_control_worker'],
      },
      {
        tablename: 'candidate_execution_operations',
        policyname: 'r213_evaluator_execution_select',
        roles: ['app_evaluator'],
      },
    ],
    'pre-0013 direct policies must match the legacy grants being upgraded',
  );
  for (const { policyname, qual } of directPolicies.filter(({ roles }) =>
    roles.includes('app_evaluator'),
  )) {
    assert.match(qual, /r27\.principal_id/);
    assert.match(qual, /hirearchy\.evaluator_principal_id/);
    assert.ok(policyname.startsWith('r21'));
  }

  for (const table of SENSITIVE_TABLES) {
    for (const identitySource of ['r27', 'hirearchy']) {
      const client = await pools.app_evaluator.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT pg_catalog.set_config('r27.organization_id', $1, true),
                  pg_catalog.set_config('r27.session_id', $2, true),
                  pg_catalog.set_config('r27.principal_id', $3, true),
                  pg_catalog.set_config('hirearchy.evaluator_principal_id', $4, true)`,
          [
            ids.organizationA,
            ids.sessionA,
            identitySource === 'r27' ? ids.principalShared : '',
            identitySource === 'hirearchy' ? ids.principalShared : '',
          ],
        );
        await assert.rejects(
          client.query(
            `SELECT * FROM hirearchy.${table}
              WHERE organization_id = $1 AND session_id = $2`,
            [ids.organizationA, ids.sessionA],
          ),
          (error) =>
            error.code === '42501' &&
            /reviewer_assignments/.test(error.message),
          `pre-0013 app_evaluator query must expose its missing reviewer_assignments dependency with ${identitySource} GUC`,
        );
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
  }

  for (const table of SENSITIVE_TABLES) {
    const idColumn =
      table === 'candidate_ai_interactions' ? 'interaction_id' : 'operation_id';
    const { rows } = await pools.app_control_worker.query(
      `SELECT ${idColumn} AS id
         FROM hirearchy.${table}
        WHERE organization_id = $1 AND session_id = $2`,
      [ids.organizationA, ids.sessionA],
    );
    assert.deepEqual(
      rows,
      [
        {
          id:
            table === 'candidate_ai_interactions'
              ? 'r2-upgrade-ai-evidence'
              : 'r2-upgrade-execution-evidence',
        },
      ],
      `pre-0013 app_control_worker can read ${table}`,
    );
  }
}

export async function checkRuntimePrincipalIdentityDenied({ pools, ids }) {
  for (const [role, pool] of Object.entries(pools)) {
    await assert.rejects(
      pool.query(
        'UPDATE hirearchy.application_principals SET auth_user_id = NULL WHERE id = $1',
        [ids.principalA],
      ),
      (error) => error.code === '42501',
      `${role} must not clear a principal subject`,
    );
    await assert.rejects(
      pool.query(
        'UPDATE hirearchy.application_principals SET auth_user_id = $1 WHERE id = $2',
        [ids.subjectB, ids.principalA],
      ),
      (error) => error.code === '42501',
      `${role} must not replace a principal subject`,
    );
  }
}

async function withFixtureOrganization(pool, organizationId, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (organizationId !== undefined) {
      await client.query(
        "SELECT pg_catalog.set_config('hirearchy.organization_id', $1, true)",
        [organizationId],
      );
    }
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function checkStep(label, operation) {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${label}: ${error.message}`, { cause: error });
  }
}

export async function checkRlsDeniesWithoutPolicy(fixturePool) {
  const { rows } = await fixturePool.query(
    'SELECT id FROM hirearchy.assessment_sessions ORDER BY id',
  );
  assert.deepEqual(
    rows,
    [],
    'RLS with a table grant and no policy must deny rows',
  );
}

export async function checkFixtureRlsAndGucResidual({ fixturePool, ids }) {
  const noContext = await checkStep('missing context on sessions', () =>
    fixturePool.query(
      'SELECT id, organization_id FROM hirearchy.assessment_sessions ORDER BY id',
    ),
  );
  assert.deepEqual(
    noContext.rows,
    [],
    'missing tenant context must select no rows',
  );

  for (const [organizationId, expectedSessionId] of [
    [ids.organizationA, ids.sessionA],
    [ids.organizationB, ids.sessionB],
  ]) {
    const result = await checkStep(
      `organization ${organizationId} session filter`,
      () =>
        withFixtureOrganization(fixturePool, organizationId, (client) =>
          client.query(
            'SELECT id, organization_id FROM hirearchy.assessment_sessions ORDER BY id',
          ),
        ),
    );
    assert.deepEqual(result.rows, [
      { id: expectedSessionId, organization_id: organizationId },
    ]);
  }

  const visibleOrganizations = await checkStep('organization row filter', () =>
    withFixtureOrganization(fixturePool, ids.organizationA, (client) =>
      client.query('SELECT id FROM hirearchy.organizations ORDER BY id'),
    ),
  );
  assert.deepEqual(visibleOrganizations.rows, [{ id: ids.organizationA }]);
  const visibleMemberships = await checkStep('membership row filter', () =>
    withFixtureOrganization(fixturePool, ids.organizationA, (client) =>
      client.query(
        'SELECT organization_id, principal_id FROM hirearchy.organization_memberships ORDER BY principal_id',
      ),
    ),
  );
  assert.deepEqual(
    visibleMemberships.rows,
    [ids.principalA, ids.principalShared].sort().map((principalId) => ({
      organization_id: ids.organizationA,
      principal_id: principalId,
    })),
  );

  const malformed = await checkStep('malformed context on sessions', () =>
    withFixtureOrganization(fixturePool, 'not-a-uuid', (client) =>
      client.query('SELECT id FROM hirearchy.assessment_sessions'),
    ),
  );
  assert.deepEqual(
    malformed.rows,
    [],
    'malformed tenant context must select no rows',
  );

  await checkStep('own-org INSERT policy and rollback', async () => {
    const insertClient = await fixturePool.connect();
    try {
      await insertClient.query('BEGIN');
      await insertClient.query(
        "SELECT pg_catalog.set_config('hirearchy.organization_id', $1, true)",
        [ids.organizationA],
      );
      await insertClient.query(
        `INSERT INTO hirearchy.assessment_sessions (id, organization_id, issuer_principal_id)
         VALUES ('r2-fixture-valid-insert', $1, $2)`,
        [ids.organizationA, ids.principalA],
      );
      await insertClient.query('ROLLBACK');
    } catch (error) {
      await insertClient.query('ROLLBACK');
      throw error;
    } finally {
      insertClient.release();
    }
  });

  await assert.rejects(
    checkStep('restricted cross-tenant FK insertion', () =>
      withFixtureOrganization(fixturePool, ids.organizationA, (client) =>
        client.query(
          `INSERT INTO hirearchy.assessment_sessions (id, organization_id, issuer_principal_id)
           VALUES ('r2-fixture-cross-tenant-invalid', $1, $2)`,
          [ids.organizationA, ids.principalB],
        ),
      ),
    ),
    (error) => (error.cause?.code ?? error.code) === '23503',
    'minimal fixture INSERT policy must still enforce the composite tenant foreign key',
  );

  // This disposable-only role can forge its tenant GUC; the test does not treat a custom GUC as identity proof.
  const forged = await withFixtureOrganization(
    fixturePool,
    ids.organizationA,
    (client) => client.query('SELECT id FROM hirearchy.assessment_sessions'),
  );
  assert.deepEqual(forged.rows, [{ id: ids.sessionA }]);
}

function expectedGucs(context) {
  return {
    principal_id: context.principalId,
    subject_id: context.authSubjectId,
    auth_session_id: context.authSessionId,
    assurance: context.assurance,
    organization_id: context.organizationId,
    correlation_id: context.correlationId,
  };
}

async function readGucs(client) {
  const { rows } = await client.query(`SELECT ${GUC_COLUMNS}`);
  return rows[0];
}

async function assertNoGucs(pool) {
  const { rows } = await pool.query(`SELECT ${GUC_COLUMNS}`);
  assert.deepEqual(rows[0], {
    principal_id: null,
    subject_id: null,
    auth_session_id: null,
    assurance: null,
    organization_id: null,
    correlation_id: null,
  });
}

async function waitForActiveQuery(admin, backendPid, tag) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await admin.query(
      `SELECT state, query
         FROM pg_catalog.pg_stat_activity
        WHERE pid = $1 AND state = 'active' AND position($2 IN query) > 0`,
      [backendPid, tag],
    );
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    'Timed out waiting for the PostgreSQL cancellation query to become active',
  );
}

async function waitForQueryExit(admin, backendPid, tag) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await admin.query(
      `SELECT state
         FROM pg_catalog.pg_stat_activity
        WHERE pid = $1 AND state = 'active' AND position($2 IN query) > 0`,
      [backendPid, tag],
    );
    if (!rows.length) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

export async function checkTrustedTransactionPool({
  admin,
  evaluatorPool,
  candidatePool,
  contextA,
  contextB,
}) {
  for (const [pool, context] of [
    [evaluatorPool, contextA],
    [evaluatorPool, contextB],
  ]) {
    const inside = await withTrustedEvaluatorTransaction(
      pool,
      context,
      readGucs,
    );
    assert.deepEqual(inside, expectedGucs(context));
    await assertNoGucs(pool);
  }

  let operationCalled = false;
  const missingContext = { ...contextA };
  delete missingContext.authSessionId;
  await assert.rejects(
    withTrustedEvaluatorTransaction(evaluatorPool, missingContext, async () => {
      operationCalled = true;
    }),
    TypeError,
  );
  const malformedContext = { ...contextA, principalId: 'bad-id' };
  await assert.rejects(
    withTrustedEvaluatorTransaction(
      evaluatorPool,
      malformedContext,
      async () => {
        operationCalled = true;
      },
    ),
    TypeError,
  );
  const invalidAssurance = { ...contextA, assurance: 'aal3' };
  await assert.rejects(
    withTrustedEvaluatorTransaction(
      evaluatorPool,
      invalidAssurance,
      async () => {
        operationCalled = true;
      },
    ),
    TypeError,
  );
  assert.equal(
    operationCalled,
    false,
    'invalid context must be rejected before repository work',
  );

  await assert.rejects(
    withTrustedEvaluatorTransaction(candidatePool, contextA, async () => {
      operationCalled = true;
    }),
    /restricted app_evaluator identity/,
  );
  assert.equal(operationCalled, false);

  const acquisitionSecret = 'fixture-only-secret-that-must-not-escape';
  const failingPool = {
    async connect() {
      throw new Error(`password=${acquisitionSecret}`);
    },
  };
  await assert.rejects(
    withTrustedEvaluatorTransaction(
      failingPool,
      contextA,
      async () => undefined,
    ),
    (error) =>
      error.name === 'PostgresTransactionError' &&
      !error.message.includes(acquisitionSecret),
  );

  await assert.rejects(
    withTrustedEvaluatorTransaction(evaluatorPool, contextA, async () => {
      throw new Error('fixture operation failure');
    }),
    /fixture operation failure/,
  );
  await assertNoGucs(evaluatorPool);

  await assert.rejects(
    withTrustedEvaluatorTransaction(evaluatorPool, contextA, async (client) => {
      await client.query("SET LOCAL statement_timeout = '40ms'");
      await client.query('SELECT pg_catalog.pg_sleep(5)');
    }),
    (error) => error.name === 'PostgresTransactionError',
  );
  await assertNoGucs(evaluatorPool);

  const controller = new AbortController();
  const tag = `r2_foundation_cancel_${Date.now()}`;
  let backendPid;
  let resolvePid;
  const pidReady = new Promise((resolve) => {
    resolvePid = resolve;
  });
  const pending = withTrustedEvaluatorTransaction(
    evaluatorPool,
    contextA,
    async (client) => {
      const { rows } = await client.query(
        'SELECT pg_catalog.pg_backend_pid() AS pid',
      );
      backendPid = rows[0].pid;
      resolvePid(backendPid);
      await client.query(`SELECT pg_catalog.pg_sleep(30) /* ${tag} */`);
    },
    { signal: controller.signal },
  );
  pending.catch(() => {});
  await waitForActiveQuery(admin, await pidReady, tag);
  controller.abort();
  const result = await Promise.race([
    pending.then(
      () => ({ status: 'resolved' }),
      (error) => ({ status: 'rejected', error }),
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve({ status: 'timeout' }), 5000),
    ),
  ]);
  if (result.status === 'timeout') {
    if (backendPid)
      await admin.query('SELECT pg_catalog.pg_cancel_backend($1)', [
        backendPid,
      ]);
    await pending.catch(() => undefined);
    assert.fail('an abort signal must cancel an active PostgreSQL query');
  }
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.name, 'AbortError');
  assert.equal(
    await waitForQueryExit(admin, backendPid, tag),
    true,
    'aborting must stop the PostgreSQL backend query',
  );
  await assertNoGucs(evaluatorPool);

  const terminationTag = `r2_foundation_terminate_${Date.now()}`;
  let terminatedBackendPid;
  let resolveTerminatedPid;
  const terminatedPidReady = new Promise((resolve) => {
    resolveTerminatedPid = resolve;
  });
  const interrupted = withTrustedEvaluatorTransaction(
    evaluatorPool,
    contextA,
    async (client) => {
      const { rows } = await client.query(
        'SELECT pg_catalog.pg_backend_pid() AS pid',
      );
      terminatedBackendPid = rows[0].pid;
      resolveTerminatedPid(terminatedBackendPid);
      await client.query(
        `SELECT pg_catalog.pg_sleep(30) /* ${terminationTag} */`,
      );
    },
  );
  interrupted.catch(() => {});
  await waitForActiveQuery(admin, await terminatedPidReady, terminationTag);
  const { rows: terminated } = await admin.query(
    'SELECT pg_catalog.pg_terminate_backend($1) AS terminated',
    [terminatedBackendPid],
  );
  assert.equal(terminated[0].terminated, true);
  await assert.rejects(
    interrupted,
    (error) =>
      error.name === 'PostgresTransactionError' &&
      error.message === 'PostgreSQL transaction failed',
  );
  assert.equal(
    await waitForQueryExit(admin, terminatedBackendPid, terminationTag),
    true,
    'administrator termination must stop the active PostgreSQL backend',
  );
  const { rows: replacement } = await evaluatorPool.query(
    `SELECT pg_catalog.pg_backend_pid() AS pid, ${GUC_COLUMNS}`,
  );
  assert.notEqual(
    replacement[0].pid,
    terminatedBackendPid,
    'the terminated checked-out connection must be discarded',
  );
  assert.deepEqual(
    {
      principal_id: replacement[0].principal_id,
      subject_id: replacement[0].subject_id,
      auth_session_id: replacement[0].auth_session_id,
      assurance: replacement[0].assurance,
      organization_id: replacement[0].organization_id,
      correlation_id: replacement[0].correlation_id,
    },
    {
      principal_id: null,
      subject_id: null,
      auth_session_id: null,
      assurance: null,
      organization_id: null,
      correlation_id: null,
    },
  );
}

export async function checkLegacyCompatibility(admin) {
  const { rows } = await admin.query(
    'SELECT value FROM public.r2_compatibility_sentinel WHERE id = 1',
  );
  assert.deepEqual(rows, [{ value: 'preserve-existing-public-schema' }]);
}
