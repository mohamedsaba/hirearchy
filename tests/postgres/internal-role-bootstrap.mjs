import assert from 'node:assert/strict';

export async function checkInternalRoleBootstrap(admin, bootstrapSql) {
  async function inTransaction(check) {
    await admin.query('BEGIN');
    try {
      await check();
    } finally {
      await admin.query('ROLLBACK');
    }
  }

  await inTransaction(async () => {
    await admin.query(bootstrapSql);
    await admin.query(bootstrapSql);
    const { rows } = await admin.query(`
      SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb,
             rolcreaterole, rolreplication, rolinherit, rolconfig,
             pg_catalog.has_schema_privilege(oid, 'hirearchy', 'USAGE') AS app_access
      FROM pg_catalog.pg_roles
      WHERE rolname IN ('r23_gateway', 'r23_session_owner', 'staging_verifier_owner')
      ORDER BY rolname
    `);
    assert.equal(rows.length, 3);
    for (const role of rows) {
      assert.equal(role.rolcanlogin, role.rolname === 'r23_gateway');
      for (const attribute of [
        'rolsuper',
        'rolbypassrls',
        'rolcreatedb',
        'rolcreaterole',
        'rolreplication',
        'rolinherit',
        'app_access',
      ]) {
        assert.equal(role[attribute], false, `${role.rolname}: ${attribute}`);
      }
      assert.equal(role.rolconfig, null);
    }
  });

  await inTransaction(async () => {
    await admin.query('CREATE ROLE r23_session_owner LOGIN NOINHERIT');
    await admin.query('SAVEPOINT before_bootstrap');
    await assert.rejects(admin.query(bootstrapSql), /Internal role .* unsafe/);
    await admin.query('ROLLBACK TO SAVEPOINT before_bootstrap');
    const { rows } = await admin.query(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = 'r23_gateway'",
    );
    assert.equal(
      rows.length,
      0,
      'earlier role creation must roll back on failure',
    );
  });

  for (const unsafeSetup of [
    'CREATE ROLE r23_gateway LOGIN SUPERUSER NOINHERIT',
    'CREATE ROLE r23_gateway LOGIN NOINHERIT; CREATE ROLE r215_test_member NOLOGIN; GRANT r215_test_member TO r23_gateway',
    "CREATE ROLE r23_gateway LOGIN NOINHERIT; ALTER ROLE r23_gateway SET search_path = 'public'",
    "CREATE ROLE r23_gateway LOGIN NOINHERIT; ALTER ROLE r23_gateway IN DATABASE postgres SET search_path = 'public'",
    'CREATE ROLE staging_verifier_owner LOGIN NOINHERIT',
    'CREATE ROLE staging_verifier_owner NOLOGIN SUPERUSER NOINHERIT',
    'CREATE ROLE staging_verifier_owner NOLOGIN NOINHERIT; CREATE ROLE r215_test_member NOLOGIN; GRANT r215_test_member TO staging_verifier_owner',
    "CREATE ROLE staging_verifier_owner NOLOGIN NOINHERIT; ALTER ROLE staging_verifier_owner SET search_path = 'public'",
  ]) {
    await inTransaction(async () => {
      await admin.query(unsafeSetup);
      await assert.rejects(
        admin.query(bootstrapSql),
        /Internal role .* unsafe/,
      );
    });
    const { rows } = await admin.query(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ('r23_gateway', 'r23_session_owner', 'staging_verifier_owner', 'r215_test_member')",
    );
    assert.equal(rows.length, 0, 'test-created roles must roll back');
  }
}
