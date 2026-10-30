import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createR23PostgresAdapter,
  R23ScopeDenied,
  R23SessionDenied,
} from '../../database/postgres/r23/adapter.mjs';

const FUNCTIONS = [
  'authorize_organization',
  'consume_callback',
  'create_session',
  'list_memberships',
  'lock_active_session',
  'lock_session_for_logout',
  'revoke_session',
  'save_credential_envelope',
  'select_organization',
];
const TABLES = [
  ['r23', 'principal_subject_bindings'],
  ['r23', 'server_sessions'],
  ['hirearchy', 'application_principals'],
  ['hirearchy', 'organization_memberships'],
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secretDigest(secret = randomBytes(32).toString('base64url')) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function future(minutes = 15) {
  return new Date(Date.now() + minutes * 60_000);
}

function assertDenied(operation, ErrorType, label) {
  return assert.rejects(
    operation,
    (error) => error instanceof ErrorType,
    label,
  );
}

async function assertContextClear(pool) {
  const { rows } = await pool.query(`
    SELECT NULLIF(pg_catalog.current_setting('r23.session_handle_hash', true), '') AS handle_hash,
           NULLIF(pg_catalog.current_setting('r23.auth_subject_id', true), '') AS subject_id,
           NULLIF(pg_catalog.current_setting('r23.auth_session_id', true), '') AS session_id,
           NULLIF(pg_catalog.current_setting('r23.auth_assurance', true), '') AS assurance,
           NULLIF(pg_catalog.current_setting('r23.principal_id', true), '') AS principal_id,
           NULLIF(pg_catalog.current_setting('r23.organization_id', true), '') AS organization_id
  `);
  assert.deepEqual(rows[0], {
    handle_hash: null,
    subject_id: null,
    session_id: null,
    assurance: null,
    principal_id: null,
    organization_id: null,
  });
  assert.equal(pool.totalCount, 1);
  assert.equal(pool.idleCount, 1);
  assert.equal(pool.waitingCount, 0);
}

async function assertFixtureCatalog(admin) {
  const { rows: tables } = await admin.query(
    `SELECT namespace.nspname AS schema_name, relation.relname,
            relation.relrowsecurity, relation.relforcerowsecurity
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE (namespace.nspname, relation.relname) IN (
        SELECT entry.schema_name, entry.table_name
        FROM ROWS FROM (
          pg_catalog.unnest($1::pg_catalog.name[]),
          pg_catalog.unnest($2::pg_catalog.name[])
        ) AS entry(schema_name, table_name)
      )`,
    [TABLES.map(([schema]) => schema), TABLES.map(([, name]) => name)],
  );
  assert.equal(tables.length, TABLES.length);
  for (const table of tables) {
    assert.equal(table.relrowsecurity, true);
    assert.equal(table.relforcerowsecurity, true);
  }

  const { rows: functions } = await admin.query(
    `SELECT procedure.proname, procedure.prosecdef, procedure.proconfig,
            owner.rolname AS owner_name,
            pg_catalog.has_function_privilege('r23_gateway', procedure.oid, 'EXECUTE') AS gateway_execute,
            EXISTS (
              SELECT 1 FROM pg_catalog.aclexplode(
                COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
              ) AS acl
              WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
            ) AS public_execute
       FROM pg_catalog.pg_proc AS procedure
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
      WHERE namespace.nspname = 'r23'
      ORDER BY procedure.proname`,
  );
  assert.equal(functions.length, FUNCTIONS.length + 2);
  for (const procedure of functions) {
    assert.equal(procedure.prosecdef, true);
    assert.equal(procedure.owner_name, 'r23_session_owner');
    assert.equal(procedure.public_execute, false);
    assert.ok(procedure.proconfig?.includes('search_path=""'));
    assert.equal(
      procedure.gateway_execute,
      FUNCTIONS.includes(procedure.proname),
      `only fixed R2.3 commands execute as r23_gateway: ${procedure.proname}`,
    );
  }

  const { rows: roles } = await admin.query(`
    SELECT role.rolname, role.rolcanlogin, role.rolsuper, role.rolbypassrls,
           role.rolcreatedb, role.rolcreaterole, role.rolreplication,
           role.rolinherit,
           EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS membership
                   WHERE membership.roleid = role.oid OR membership.member = role.oid) AS has_membership
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname IN ('r23_gateway', 'r23_session_owner')
     ORDER BY role.rolname
  `);
  assert.deepEqual(roles, [
    {
      rolname: 'r23_gateway',
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolinherit: false,
      has_membership: false,
    },
    {
      rolname: 'r23_session_owner',
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolinherit: false,
      has_membership: false,
    },
  ]);

  const { rows: privileges } = await admin.query(`
    SELECT namespace.nspname, relation.relname, privilege.name
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                         ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS privilege(name)
     WHERE namespace.nspname IN ('hirearchy', 'r23')
       AND pg_catalog.has_table_privilege('r23_gateway', relation.oid, privilege.name)
     ORDER BY namespace.nspname, relation.relname, privilege.name
  `);
  assert.deepEqual(privileges, []);
  const { rows: schemaPrivileges } = await admin.query(`
    SELECT pg_catalog.has_schema_privilege('r23_gateway', 'r23', 'USAGE') AS r23_usage,
           pg_catalog.has_schema_privilege('r23_gateway', 'r23', 'CREATE') AS r23_create,
           pg_catalog.has_schema_privilege('r23_gateway', 'hirearchy', 'USAGE') AS hirearchy_usage,
           pg_catalog.has_schema_privilege('r23_gateway', 'auth', 'USAGE') AS auth_usage
  `);
  assert.deepEqual(schemaPrivileges[0], {
    r23_usage: true,
    r23_create: false,
    hirearchy_usage: false,
    auth_usage: false,
  });

  const { rows: policies } = await admin.query(`
    SELECT schemaname, tablename, policyname, roles
      FROM pg_catalog.pg_policies
     WHERE schemaname IN ('hirearchy', 'r23')
       AND ('r23_gateway' = ANY(roles) OR 'public' = ANY(roles))
  `);
  assert.deepEqual(policies, []);
}

function assertConnectionUrlSafety() {
  const badUrls = [
    'postgres://r23_gateway:pw@127.0.0.1:5432/postgres?host=evil.example',
    'postgres://r23_gateway:pw@127.0.0.1:5432/postgres?options=-c%20search_path=public',
    'postgres://r23_gateway:pw@evil.example:5432/postgres',
    'postgres://r23_gateway:pw@192.168.1.1:5432/postgres',
    'postgres://r23_gateway:pw@10.0.0.1:5432/postgres',
    'postgres://r23_gateway:pw@8.8.8.8:5432/postgres',
    'postgres://r23_gateway:pw@localhost:5432/postgres',
    'postgres://r23_gateway:pw@127.0.0.1:5432/postgres#fragment',
    'postgres://postgres:pw@127.0.0.1:5432/postgres',
    'postgres://app_evaluator:pw@127.0.0.1:5432/postgres',
    'postgres://r23_gateway@127.0.0.1:5432/postgres',
    'postgres://r23_gateway:pw@127.0.0.1/postgres',
    'postgres://r23_gateway:pw@127.0.0.1:5432/hirearchy',
    'http://r23_gateway:pw@127.0.0.1:5432/postgres',
    '',
    null,
    undefined,
    'not a url',
  ];

  for (const badUrl of badUrls) {
    assert.throws(
      () =>
        createR23PostgresAdapter({
          connectionString: badUrl,
          assertVerifiedIdentity: () => {},
        }),
      TypeError,
      `rejected invalid connection string: ${badUrl}`,
    );
  }
}

// This disposable DB check uses an injected test brand; the HTTP lane proves real Auth validation.
export async function runR23MembershipChecks({
  admin,
  pool,
  organizations,
  principals,
}) {
  assertConnectionUrlSafety();
  assert.ok(admin && typeof admin.query === 'function');
  assert.ok(
    pool &&
      typeof pool.query === 'function' &&
      typeof pool.connect === 'function',
  );
  assert.ok(organizations?.a && organizations?.b && principals);
  await assertFixtureCatalog(admin);

  const organizationC = randomUUID();
  await admin.query('INSERT INTO hirearchy.organizations(id) VALUES ($1)', [
    organizationC,
  ]);
  await admin.query(
    `INSERT INTO hirearchy.organization_memberships
       (organization_id, principal_id, role, status, joined_at, version)
     VALUES ($1, $2, 'reviewer', 'active', pg_catalog.clock_timestamp(), 1)`,
    [organizationC, principals.signup],
  );

  const principalIds = Object.values(principals);
  const { rows: boundRows } = await admin.query(
    `SELECT id AS principal_id, auth_user_id AS subject_id
       FROM hirearchy.application_principals
      WHERE id = ANY($1::pg_catalog.uuid[])`,
    [principalIds],
  );
  assert.equal(boundRows.length, principalIds.length);
  const subjectByPrincipal = new Map(
    boundRows.map((row) => [row.principal_id, row.subject_id]),
  );

  const branded = new WeakSet();
  const assertVerifiedIdentity = (identity) => {
    if (!identity || !branded.has(identity))
      throw new Error('unverified identity');
    return identity;
  };
  const identities = Object.fromEntries(
    Object.entries(principals).map(([name, principalId]) => {
      const subjectId = subjectByPrincipal.get(principalId);
      assert.match(subjectId ?? '', UUID);
      const identity = Object.freeze({
        subjectId,
        sessionId: randomUUID(),
        assurance: 'aal1',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      branded.add(identity);
      return [name, identity];
    }),
  );
  const adapter = createR23PostgresAdapter({ pool, assertVerifiedIdentity });
  const sessions = {};
  const callbacks = {};
  const csrf = {};
  for (const name of Object.keys(principals)) {
    const handle = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const callbackToken = randomBytes(32).toString('base64url');
    sessions[name] = {
      handleHash: secretDigest(handle),
      envelope: randomBytes(96),
    };
    csrf[name] = secretDigest(csrfToken);
    callbacks[name] = secretDigest(callbackToken);
    const bound = await adapter.createSession({
      handleHash: sessions[name].handleHash,
      csrfHash: csrf[name],
      callbackHash: callbacks[name],
      credentialEnvelope: sessions[name].envelope,
      identity: identities[name],
      expiresAt: future(),
      accessExpiresAt: future(5),
    });
    assert.equal(bound.principalId, principals[name]);
    await assertContextClear(pool);
  }

  await assertDenied(
    () =>
      adapter.createSession({
        handleHash: secretDigest(),
        csrfHash: secretDigest(),
        callbackHash: secretDigest(),
        credentialEnvelope: randomBytes(32),
        identity: { ...identities.a },
        expiresAt: future(),
        accessExpiresAt: future(),
      }),
    R23SessionDenied,
    'unbranded principal binding denial',
  );

  const callbackResult = await adapter.withActiveSession(
    { handleHash: sessions.a.handleHash },
    async (session, authz) => {
      assert.equal(session.callbackPending, true);
      await assertDenied(
        () => authz.listMemberships(identities.a),
        R23SessionDenied,
        'pending callback cannot list memberships',
      );
      await assertDenied(
        () => authz.saveCredentialEnvelope(randomBytes(96), future()),
        R23SessionDenied,
        'pending callback cannot refresh credentials',
      );
      await assertDenied(
        () => authz.consumeCallback(secretDigest()),
        R23SessionDenied,
        'wrong callback nonce denied',
      );
      await authz.consumeCallback(callbacks.a);
      assert.equal(session.callbackPending, false);
      return authz.listMemberships(identities.a);
    },
  );
  assert.deepEqual(
    callbackResult.map(({ organizationId }) => organizationId),
    [organizations.a],
  );
  await assertDenied(
    () =>
      adapter.withActiveSession(
        { handleHash: sessions.a.handleHash },
        async (_session, authz) => authz.consumeCallback(callbacks.a),
      ),
    R23SessionDenied,
    'callback replay denied',
  );

  for (const name of ['b', 'ab', 'revoked', 'signup']) {
    await adapter.withActiveSession(
      { handleHash: sessions[name].handleHash, csrfHash: csrf[name] },
      async (session, authz) => {
        assert.equal(session.callbackPending, true);
        if (session.callbackPending)
          await authz.consumeCallback(callbacks[name]);
        const memberships = await authz.listMemberships(identities[name]);
        const expected =
          name === 'b'
            ? [organizations.b]
            : name === 'ab'
              ? [organizations.a, organizations.b]
              : name === 'signup'
                ? [organizationC]
                : [];
        assert.deepEqual(
          memberships.map(({ organizationId }) => organizationId).sort(),
          expected.sort(),
          `${name} sees only current memberships`,
        );
        assert.equal(session.selectedOrganizationId, null);
      },
    );
    await assertContextClear(pool);
  }

  await adapter.withActiveSession(
    { handleHash: sessions.a.handleHash },
    async (_session, authz) => {
      await authz.selectOrganization(identities.a, organizations.a);
      const access = await authz.authorizeOrganization(
        identities.a,
        organizations.a,
      );
      assert.equal(access.organizationId, organizations.a);
    },
  );
  await assertDenied(
    () =>
      adapter.withActiveSession(
        { handleHash: sessions.a.handleHash },
        async (_session, authz) =>
          authz.authorizeOrganization(identities.a, organizations.b),
      ),
    R23ScopeDenied,
    'URL substitution cannot change the stored organization selection',
  );
  await assertDenied(
    () =>
      adapter.withActiveSession(
        { handleHash: sessions.b.handleHash },
        async (_session, authz) =>
          authz.selectOrganization(identities.b, organizations.a),
      ),
    R23ScopeDenied,
    'foreign organization selection denied',
  );
  await assertDenied(
    () =>
      adapter.withActiveSession(
        { handleHash: sessions.a.handleHash },
        async (_session, authz) => authz.listMemberships(identities.b),
      ),
    R23SessionDenied,
    'a different verified subject cannot use the stored session',
  );

  await adapter.withActiveSession(
    { handleHash: sessions.ab.handleHash },
    async (_session, authz) => {
      await authz.selectOrganization(identities.ab, organizations.a);
      await authz.selectOrganization(identities.ab, organizations.b);
      const access = await authz.authorizeOrganization(
        identities.ab,
        organizations.b,
      );
      assert.equal(access.organizationId, organizations.b);
    },
  );

  await adapter.withActiveSession(
    { handleHash: sessions.signup.handleHash },
    async (_session, authz) => {
      await authz.selectOrganization(identities.signup, organizationC);
      await authz.authorizeOrganization(identities.signup, organizationC);
    },
  );
  await admin.query(
    `UPDATE hirearchy.organization_memberships
        SET status = 'revoked', revoked_at = pg_catalog.clock_timestamp(), version = version + 1
      WHERE organization_id = $1 AND principal_id = $2`,
    [organizationC, principals.signup],
  );
  await assertDenied(
    () =>
      adapter.withActiveSession(
        { handleHash: sessions.signup.handleHash },
        async (_session, authz) =>
          authz.authorizeOrganization(identities.signup, organizationC),
      ),
    R23ScopeDenied,
    'committed revocation denies the next organization admission',
  );

  await assertDenied(
    () =>
      adapter.withActiveSession(
        { handleHash: sessions.b.handleHash, csrfHash: secretDigest() },
        async () => {},
      ),
    R23ScopeDenied,
    'wrong CSRF digest denies a protected operation',
  );
  const closed = await adapter.closeSession(sessions.a.handleHash, csrf.a);
  assert.deepEqual(
    {
      subjectId: closed.subjectId,
      authSessionId: closed.authSessionId,
      credentialEnvelope: closed.credentialEnvelope,
    },
    {
      subjectId: identities.a.subjectId,
      authSessionId: identities.a.sessionId,
      credentialEnvelope: sessions.a.envelope,
    },
  );
  const { rows: revokedRows } = await admin.query(
    `SELECT revoked_at IS NOT NULL AS revoked,
            credential_envelope IS NULL AS credentials_cleared,
            csrf_hash IS NULL AS csrf_cleared,
            callback_hash IS NULL AS callback_cleared,
            selected_organization_id IS NULL AS selection_cleared
       FROM r23.server_sessions WHERE handle_hash = $1`,
    [sessions.a.handleHash],
  );
  assert.deepEqual(revokedRows[0], {
    revoked: true,
    credentials_cleared: true,
    csrf_cleared: true,
    callback_cleared: true,
    selection_cleared: true,
  });
  await assertDenied(
    () =>
      adapter.withActiveSession(
        { handleHash: sessions.a.handleHash },
        async () => {},
      ),
    R23SessionDenied,
    'committed logout denies later operations',
  );
  assert.equal(await adapter.closeSession(sessions.a.handleHash, csrf.a), null);
  await assertContextClear(pool);
}
