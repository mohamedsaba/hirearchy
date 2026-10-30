import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { assertVerifiedIdentity } from './auth.mjs';
import { createMembershipLane, MembershipLaneError } from './membership.mjs';

const FUNCTIONS = [
  'accept_invitation',
  'bind_principal',
  'bootstrap_organization',
  'read_membership',
  'revoke_membership',
];
const TABLES = [
  ['hirearchy', 'organizations'],
  ['hirearchy', 'application_principals'],
  ['hirearchy', 'organization_memberships'],
  ['hirearchy', 'assessment_sessions'],
  ['r22b', 'principal_subject_bindings'],
  ['r22b', 'bootstrap_permits'],
  ['r22b', 'invitations'],
];

function opaqueSecret() {
  return randomBytes(32).toString('base64url');
}

function secretDigest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedEmail(identity) {
  assert.equal(identity.emailVerified, true);
  assert.equal(typeof identity.email, 'string');
  return identity.email.trim().toLowerCase();
}

function expiry(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

async function verified(verify, token) {
  return assertVerifiedIdentity(await verify(token));
}

async function assertDenied(operation, label = 'authorization denial') {
  await assert.rejects(
    operation,
    (error) => error instanceof MembershipLaneError,
    label,
  );
}

async function assertPgDenied(
  operation,
  code = '42501',
  label = 'database denial',
) {
  await assert.rejects(operation, (error) => error?.code === code, label);
}

async function assertLocalContextClear(pool) {
  const { rows } = await pool.query(`
    SELECT NULLIF(pg_catalog.current_setting('hirearchy.auth_subject_id', true), '') AS subject_id,
           NULLIF(pg_catalog.current_setting('hirearchy.auth_session_id', true), '') AS session_id,
           NULLIF(pg_catalog.current_setting('hirearchy.auth_assurance', true), '') AS assurance,
           NULLIF(pg_catalog.current_setting('hirearchy.actor_principal_id', true), '') AS principal_id,
           NULLIF(pg_catalog.current_setting('hirearchy.organization_id', true), '') AS organization_id
  `);
  assert.deepEqual(rows[0], {
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
  const names = TABLES.map(([, table]) => table);
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
        )
          AS entry(schema_name, table_name)
      )
      ORDER BY namespace.nspname, relation.relname`,
    [TABLES.map(([schema]) => schema), names],
  );
  assert.equal(tables.length, TABLES.length);
  for (const table of tables) {
    assert.equal(table.relrowsecurity, true);
    assert.equal(table.relforcerowsecurity, true);
  }

  const { rows: functions } = await admin.query(
    `SELECT procedure.proname, procedure.prosecdef, procedure.proconfig,
            owner.rolname AS owner_name,
            pg_catalog.has_function_privilege('app_evaluator', procedure.oid, 'EXECUTE') AS evaluator_execute,
            EXISTS (
              SELECT 1
              FROM pg_catalog.aclexplode(
                COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
              ) AS acl
              WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
            ) AS public_execute
       FROM pg_catalog.pg_proc AS procedure
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
      WHERE namespace.nspname = 'r22b'
        AND procedure.proname = ANY($1::pg_catalog.name[])
      ORDER BY procedure.proname`,
    [FUNCTIONS],
  );
  assert.equal(functions.length, FUNCTIONS.length);
  for (const procedure of functions) {
    assert.equal(procedure.prosecdef, true);
    assert.equal(procedure.owner_name, 'r22b_membership_owner');
    assert.equal(procedure.evaluator_execute, true);
    assert.equal(procedure.public_execute, false);
    assert.ok(procedure.proconfig?.includes('search_path=""'));
  }

  const { rows: roles } = await admin.query(`
    SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
           rolreplication, rolinherit
    FROM pg_catalog.pg_roles
    WHERE rolname = 'r22b_membership_owner'
  `);
  assert.deepEqual(roles, [
    {
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolinherit: false,
    },
  ]);
  const { rows: memberships } = await admin.query(`
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS role
      ON role.oid = membership.roleid OR role.oid = membership.member
    WHERE role.rolname IN ('r22b_membership_owner', 'app_evaluator')
  `);
  assert.deepEqual(memberships, []);

  const { rows: privileges } = await admin.query(`
    SELECT namespace.nspname, relation.relname, privilege.name
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                       ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS privilege(name)
    WHERE namespace.nspname IN ('hirearchy', 'r22b')
      AND pg_catalog.has_table_privilege('app_evaluator', relation.oid, privilege.name)
    ORDER BY namespace.nspname, relation.relname, privilege.name
  `);
  assert.deepEqual(privileges, []);
  const { rows: schemaPrivileges } = await admin.query(`
    SELECT pg_catalog.has_schema_privilege('app_evaluator', 'r22b', 'USAGE') AS fixture_usage,
           pg_catalog.has_schema_privilege('app_evaluator', 'r22b', 'CREATE') AS fixture_create,
           pg_catalog.has_schema_privilege('app_evaluator', 'hirearchy', 'USAGE') AS core_usage
  `);
  assert.deepEqual(schemaPrivileges[0], {
    fixture_usage: true,
    fixture_create: false,
    core_usage: false,
  });

  const { rows: ownerColumnPrivileges } = await admin.query(`
    SELECT pg_catalog.has_column_privilege(
             'r22b_membership_owner', 'hirearchy.organizations', 'id', 'UPDATE'
           ) AS organization_lock,
           pg_catalog.has_column_privilege(
             'r22b_membership_owner', 'hirearchy.application_principals', 'id', 'UPDATE'
           ) AS principal_lock,
           pg_catalog.has_column_privilege(
             'r22b_membership_owner', 'hirearchy.application_principals', 'auth_user_id', 'UPDATE'
           ) AS auth_subject_update,
           pg_catalog.has_column_privilege(
             'r22b_membership_owner', 'hirearchy.organization_memberships', 'status', 'UPDATE'
           ) AS membership_status_update,
           pg_catalog.has_column_privilege(
             'r22b_membership_owner', 'hirearchy.organization_memberships', 'role', 'UPDATE'
           ) AS membership_role_update
  `);
  assert.deepEqual(ownerColumnPrivileges[0], {
    organization_lock: true,
    principal_lock: true,
    auth_subject_update: false,
    membership_status_update: true,
    membership_role_update: false,
  });

  const { rows: policies } = await admin.query(`
    SELECT schemaname, tablename, policyname
    FROM pg_catalog.pg_policies
    WHERE schemaname IN ('hirearchy', 'r22b')
      AND ('app_evaluator' = ANY(roles) OR 'public' = ANY(roles))
  `);
  assert.deepEqual(policies, []);

  const { rows: constraints } = await admin.query(`
    SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid) AS definition
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'hirearchy.assessment_sessions'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
  `);
  assert.ok(
    constraints.some(
      ({ definition }) =>
        definition.includes(
          'FOREIGN KEY (organization_id, issuer_principal_id)',
        ) &&
        definition.includes(
          'REFERENCES hirearchy.organization_memberships(organization_id, principal_id)',
        ),
    ),
  );
}

export async function runMembershipChecks({ admin, pool, verify, tokens }) {
  assert.ok(admin && typeof admin.query === 'function');
  assert.ok(
    pool &&
      typeof pool.query === 'function' &&
      typeof pool.connect === 'function',
  );
  assert.equal(pool.options.max, 1);
  for (const name of ['a', 'b', 'ab', 'revoked', 'signup']) {
    assert.equal(typeof tokens[name], 'string');
  }
  await assertFixtureCatalog(admin);

  const identities = Object.fromEntries(
    await Promise.all(
      ['a', 'b', 'ab', 'revoked', 'signup'].map(async (name) => [
        name,
        await verified(verify, tokens[name]),
      ]),
    ),
  );
  const calls = [];
  let verifyCalls = 0;
  const lane = createMembershipLane({
    pool,
    verify: async (token) => {
      verifyCalls += 1;
      return verify(token);
    },
  });
  const invoke = async (name, ...args) => {
    calls.push(name);
    const before = verifyCalls;
    try {
      const result = await lane[name](...args);
      assert.equal(
        verifyCalls,
        before + 1,
        `${name} verifies the bearer token per call`,
      );
      return result;
    } catch (error) {
      assert.equal(
        verifyCalls,
        before + 1,
        `${name} verifies the bearer token per call`,
      );
      throw error;
    }
  };

  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const permitA = opaqueSecret();
  const permitB = opaqueSecret();
  const expiredPermit = opaqueSecret();
  const expiredOrganization = randomUUID();
  const permitExpiry = expiry(5 * 60_000);
  await admin.query(
    `INSERT INTO r22b.bootstrap_permits
       (permit_digest, subject_id, organization_id, expires_at)
     VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12)`,
    [
      secretDigest(permitA),
      identities.a.subjectId,
      organizationA,
      permitExpiry,
      secretDigest(permitB),
      identities.b.subjectId,
      organizationB,
      permitExpiry,
      secretDigest(expiredPermit),
      identities.a.subjectId,
      expiredOrganization,
      expiry(-1000),
    ],
  );

  const principalA = await invoke('bind', tokens.a);
  await assertLocalContextClear(pool);
  assert.equal(await invoke('bind', tokens.a), principalA);
  await assertLocalContextClear(pool);
  const missingSessionBind = pool.query(
    `WITH verified_context AS MATERIALIZED (
       SELECT pg_catalog.set_config('hirearchy.auth_subject_id', $1, true) AS subject_id,
              pg_catalog.set_config('hirearchy.auth_session_id', '', true) AS session_id,
              pg_catalog.set_config('hirearchy.auth_assurance', $2, true) AS assurance
     )
     SELECT r22b.bind_principal($1::pg_catalog.uuid)
     FROM verified_context
     WHERE verified_context.subject_id = $1
       AND verified_context.session_id = ''
       AND verified_context.assurance = $2`,
    [identities.a.subjectId, identities.a.assurance],
  );
  await assertPgDenied(
    () => missingSessionBind,
    '42501',
    'principal binding rejects a missing Auth session',
  );
  await assertLocalContextClear(pool);
  const invalidSubjectQuery = pool.query(
    `WITH verified_context AS MATERIALIZED (
       SELECT pg_catalog.set_config('hirearchy.auth_subject_id', $1, true) AS subject_id,
              pg_catalog.set_config('hirearchy.auth_session_id', $2, true) AS session_id,
              pg_catalog.set_config('hirearchy.auth_assurance', $3, true) AS assurance
     )
     SELECT r22b.bind_principal($4::pg_catalog.uuid)
     FROM verified_context
     WHERE verified_context.subject_id = $1
       AND verified_context.session_id = $2
       AND verified_context.assurance = $3`,
    [
      identities.a.subjectId,
      identities.a.sessionId,
      identities.a.assurance,
      identities.b.subjectId,
    ],
  );
  await assertPgDenied(
    () => invalidSubjectQuery,
    '42501',
    'binding rejects a mismatched subject context',
  );
  await assertLocalContextClear(pool);
  await assertDenied(() =>
    invoke('bootstrap', tokens.a, {
      organizationId: organizationB,
      permit: permitA,
    }),
  );
  await assertDenied(() =>
    invoke('bootstrap', tokens.a, {
      organizationId: expiredOrganization,
      permit: expiredPermit,
    }),
  );
  await assertDenied(() =>
    invoke('bootstrap', tokens.a, {
      organizationId: organizationB,
      permit: permitB,
    }),
  );

  const bootstrapA = await invoke('bootstrap', tokens.a, {
    organizationId: organizationA,
    permit: permitA,
  });
  assert.deepEqual(
    bootstrapA,
    await invoke('bootstrap', tokens.a, {
      organizationId: organizationA,
      permit: permitA,
    }),
  );
  assert.equal(bootstrapA.role, 'admin');
  assert.equal(bootstrapA.principalId, principalA);

  const principalB = (
    await invoke('bootstrap', tokens.b, {
      organizationId: organizationB,
      permit: permitB,
    })
  ).principalId;
  const membershipA = await invoke('read', tokens.a, organizationA);
  const membershipB = await invoke('read', tokens.b, organizationB);
  assert.equal(membershipA.principalId, principalA);
  assert.equal(membershipB.principalId, principalB);
  await assertDenied(() => invoke('read', tokens.a, organizationB));
  await assertDenied(() => invoke('read', tokens.b, organizationA));
  await assert.rejects(
    () => lane.read(tokens.a),
    TypeError,
    'organization selection is required',
  );
  await assert.rejects(
    () => lane.read(tokens.a, "' OR TRUE --"),
    TypeError,
    'organization selection rejects non-identifiers',
  );

  const missingAssuranceRead = pool.query(
    `WITH verified_context AS MATERIALIZED (
       SELECT pg_catalog.set_config('hirearchy.auth_subject_id', $1, true) AS subject_id,
              pg_catalog.set_config('hirearchy.auth_session_id', $2, true) AS session_id,
              pg_catalog.set_config('hirearchy.auth_assurance', '', true) AS assurance,
              pg_catalog.set_config('hirearchy.actor_principal_id', $3, true) AS principal_id,
              pg_catalog.set_config('hirearchy.organization_id', $4, true) AS organization_id
     )
     SELECT r22b.read_membership()
     FROM verified_context
     WHERE verified_context.subject_id = $1
       AND verified_context.session_id = $2
       AND verified_context.assurance = ''
       AND verified_context.principal_id = $3
       AND verified_context.organization_id = $4`,
    [identities.a.subjectId, identities.a.sessionId, principalA, organizationA],
  );
  await assertPgDenied(
    () => missingAssuranceRead,
    '42501',
    'membership read rejects missing assurance with other context present',
  );
  await assertLocalContextClear(pool);

  const principalAB = await invoke('bind', tokens.ab);
  const principalRevoked = await invoke('bind', tokens.revoked);
  const principalSignup = await invoke('bind', tokens.signup);
  assert.notEqual(principalAB, principalA);
  assert.notEqual(principalAB, principalB);
  assert.notEqual(principalRevoked, principalA);
  assert.notEqual(principalSignup, principalA);
  const { rows: signupMemberships } = await admin.query(
    `SELECT pg_catalog.count(*) AS membership_count
       FROM hirearchy.organization_memberships
      WHERE principal_id = $1`,
    [principalSignup],
  );
  assert.equal(signupMemberships[0].membership_count, '0');
  await assertDenied(
    () => invoke('read', tokens.signup, organizationA),
    'signup creates no membership',
  );

  await assertPgDenied(
    () =>
      admin.query(
        `INSERT INTO hirearchy.assessment_sessions
           (id, organization_id, issuer_principal_id)
         VALUES ($1, $2, $3)`,
        [`cross-tenant-${randomUUID()}`, organizationA, principalB],
      ),
    '23503',
    'assessment session rejects cross-tenant issuer',
  );

  await assertPgDenied(
    () =>
      admin.query(
        `INSERT INTO r22b.invitations
       (token_digest, organization_id, recipient_subject_id, recipient_email,
        role, issued_by_principal_id, expires_at)
     VALUES ($1, $2, $3, $4, 'reviewer', $5, $6)`,
        [
          secretDigest(opaqueSecret()),
          organizationA,
          identities.ab.subjectId,
          normalizedEmail(identities.ab),
          principalB,
          expiry(5 * 60_000),
        ],
      ),
    '23503',
  );

  const inviteAbA = opaqueSecret();
  const inviteAbB = opaqueSecret();
  const inviteRevoked = opaqueSecret();
  const inviteExpired = opaqueSecret();
  const inviteAfterRevoke = opaqueSecret();
  const inviteExpiry = expiry(5 * 60_000);
  await admin.query(
    `INSERT INTO r22b.invitations
       (token_digest, organization_id, recipient_subject_id, recipient_email,
        role, issued_by_principal_id, expires_at)
     VALUES
       ($1, $2, $3, $4, 'reviewer', $5, $6),
       ($7, $8, $9, $10, 'reviewer', $11, $12),
       ($13, $14, $15, $16, 'reviewer', $17, $18),
       ($19, $20, $21, $22, 'reviewer', $23, $24),
       ($25, $26, $27, $28, 'reviewer', $29, $30)`,
    [
      secretDigest(inviteAbA),
      organizationA,
      identities.ab.subjectId,
      normalizedEmail(identities.ab),
      principalA,
      inviteExpiry,
      secretDigest(inviteAbB),
      organizationB,
      identities.ab.subjectId,
      normalizedEmail(identities.ab),
      principalB,
      inviteExpiry,
      secretDigest(inviteRevoked),
      organizationA,
      identities.revoked.subjectId,
      normalizedEmail(identities.revoked),
      principalA,
      inviteExpiry,
      secretDigest(inviteExpired),
      organizationB,
      identities.ab.subjectId,
      normalizedEmail(identities.ab),
      principalB,
      expiry(-1000),
      secretDigest(inviteAfterRevoke),
      organizationA,
      identities.revoked.subjectId,
      normalizedEmail(identities.revoked),
      principalA,
      inviteExpiry,
    ],
  );

  await assertDenied(
    () =>
      invoke('acceptInvite', tokens.b, {
        organizationId: organizationA,
        inviteToken: inviteAbA,
      }),
    'invitation is recipient-bound',
  );
  await assertDenied(
    () =>
      invoke('acceptInvite', tokens.ab, {
        organizationId: organizationB,
        inviteToken: inviteExpired,
      }),
    'expired invitation denied',
  );
  await assertDenied(
    () =>
      invoke('acceptInvite', tokens.ab, {
        organizationId: organizationA,
        inviteToken: `${inviteAbA}; SELECT pg_catalog.pg_sleep(10)`,
      }),
    'invitation input is parameterized',
  );

  const acceptedA = await invoke('acceptInvite', tokens.ab, {
    organizationId: organizationA,
    inviteToken: inviteAbA,
  });
  assert.deepEqual(
    acceptedA,
    await invoke('acceptInvite', tokens.ab, {
      organizationId: organizationA,
      inviteToken: inviteAbA,
    }),
  );
  const acceptedB = await invoke('acceptInvite', tokens.ab, {
    organizationId: organizationB,
    inviteToken: inviteAbB,
  });
  assert.equal(acceptedA.principalId, principalAB);
  assert.equal(acceptedB.principalId, principalAB);
  assert.equal(
    (await invoke('read', tokens.ab, organizationA)).organizationId,
    organizationA,
  );
  assert.equal(
    (await invoke('read', tokens.ab, organizationB)).organizationId,
    organizationB,
  );
  await assertDenied(
    () =>
      invoke('acceptInvite', tokens.b, {
        organizationId: organizationA,
        inviteToken: inviteAbA,
      }),
    'used invitation rejects a different principal',
  );

  const revokedMembership = await invoke('acceptInvite', tokens.revoked, {
    organizationId: organizationA,
    inviteToken: inviteRevoked,
  });
  assert.equal(revokedMembership.principalId, principalRevoked);
  const revoked = await invoke('revoke', tokens.a, {
    organizationId: organizationA,
    principalId: principalRevoked,
  });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.membershipVersion, '2');
  await assertDenied(
    () => invoke('read', tokens.revoked, organizationA),
    'committed revocation blocks later reads',
  );
  await assertDenied(
    () =>
      invoke('acceptInvite', tokens.revoked, {
        organizationId: organizationA,
        inviteToken: inviteRevoked,
      }),
    'old invitation cannot restore revoked membership',
  );
  await assertDenied(
    () =>
      invoke('acceptInvite', tokens.revoked, {
        organizationId: organizationA,
        inviteToken: inviteAfterRevoke,
      }),
    'existing revoked membership fails closed',
  );
  await assertDenied(() =>
    invoke('revoke', tokens.b, {
      organizationId: organizationA,
      principalId: principalAB,
    }),
  );
  await assertDenied(() =>
    invoke('revoke', tokens.a, {
      organizationId: organizationB,
      principalId: principalB,
    }),
  );

  const forgedLane = createMembershipLane({
    pool,
    verify: async () => ({
      subjectId: identities.a.subjectId,
      sessionId: identities.a.sessionId,
      assurance: identities.a.assurance,
      email: identities.a.email,
      emailVerified: identities.a.emailVerified,
    }),
  });
  await assertDenied(() => forgedLane.read(tokens.a, organizationA));
  await assertDenied(
    () => invoke('read', 'not-a-valid-jwt', organizationA),
    'invalid bearer token denied',
  );
  await assertDenied(
    () => lane.read('', organizationA),
    'empty bearer token denied',
  );

  await assertPgDenied(() =>
    pool.query(
      'UPDATE hirearchy.application_principals SET auth_user_id = NULL WHERE id = $1',
      [principalA],
    ),
  );
  await assertPgDenied(() =>
    pool.query(
      `INSERT INTO hirearchy.organization_memberships
       (organization_id, principal_id, role, status, joined_at, revoked_at, version)
     VALUES ($1, $2, 'reviewer', 'active', pg_catalog.clock_timestamp(), NULL, 1)`,
      [organizationA, principalSignup],
    ),
  );
  await assertPgDenied(() => pool.query('SELECT * FROM r22b.invitations'));
  await assertPgDenied(() => pool.query('SELECT r22b.read_membership()'));
  await assertPgDenied(() =>
    pool.query('SELECT r22b.bind_principal($1::pg_catalog.uuid)', [
      identities.signup.subjectId,
    ]),
  );
  await assertLocalContextClear(pool);

  await pool.query('BEGIN');
  try {
    await assertPgDenied(
      () => pool.query('SET ROLE r22b_membership_owner'),
      '42501',
      'app_evaluator cannot assume the membership function owner role',
    );
  } finally {
    await pool.query('ROLLBACK');
  }
  await assertLocalContextClear(pool);

  await assertPgDenied(
    () =>
      admin.query(
        'UPDATE hirearchy.application_principals SET auth_user_id = $1 WHERE id = $2',
        [identities.b.subjectId, principalA],
      ),
    '23514',
  );
  await assertPgDenied(
    () =>
      admin.query(
        'INSERT INTO hirearchy.application_principals (id, auth_user_id) VALUES ($1, $2)',
        [randomUUID(), identities.a.subjectId],
      ),
    '23505',
  );

  assert.equal(
    verifyCalls,
    calls.length,
    'each valid lane operation re-verifies its token',
  );
  const { rows: runtimeRole } = await pool.query(`
    SELECT current_user::pg_catalog.text AS current_user,
           session_user::pg_catalog.text AS session_user
  `);
  assert.deepEqual(runtimeRole[0], {
    current_user: 'app_evaluator',
    session_user: 'app_evaluator',
  });
  await assertLocalContextClear(pool);
  return { organizationA, organizationB };
}
