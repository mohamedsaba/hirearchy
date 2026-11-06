import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

// Regression checks exercise only the owned disposable gateway connection.
export async function checkProofBoundary(
  gateway,
  admin,
  privateKey,
  token,
  organizationId,
) {
  const { rows: policies } = await admin.query(
    `SELECT tablename,policyname,roles::text[] AS roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='hirearchy' AND tablename IN ('application_principals','organization_memberships','assessment_sessions') AND 'staging_verifier_owner'=ANY(roles) ORDER BY policyname`,
  );
  assert.deepEqual(
    policies.map((row) => [row.policyname, row.cmd, row.roles]),
    [
      [
        'staging_verifier_assessment_session_insert',
        'INSERT',
        ['staging_verifier_owner'],
      ],
      [
        'staging_verifier_assessment_session_lock',
        'UPDATE',
        ['staging_verifier_owner'],
      ],
      [
        'staging_verifier_assessment_session_select',
        'SELECT',
        ['staging_verifier_owner'],
      ],
      [
        'staging_verifier_membership_select',
        'SELECT',
        ['staging_verifier_owner'],
      ],
      [
        'staging_verifier_principal_select',
        'SELECT',
        ['staging_verifier_owner'],
      ],
    ],
  );
  for (const policy of policies) {
    const predicate = policy.cmd === 'INSERT' ? policy.with_check : policy.qual;
    assert.match(predicate, /staging\.(principal_id|subject_id)/);
    if (policy.tablename !== 'application_principals')
      assert.match(predicate, /staging\.organization_id/);
    if (policy.policyname === 'staging_verifier_assessment_session_lock') {
      assert.equal(policy.with_check, 'false');
      assert.match(policy.qual, /staging\.session_id/);
    }
  }
  const { rows: privileges } = await admin.query(
    "SELECT has_schema_privilege('app_evaluator','hirearchy','USAGE') AS evaluator,has_schema_privilege('r23_gateway','hirearchy','USAGE') AS gateway",
  );
  assert.deepEqual(privileges, [{ evaluator: false, gateway: false }]);
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString(),
  );
  const now = Math.floor(Date.now() / 1000);
  const proof = (changes = {}) =>
    Buffer.from(
      canonical({
        v: 1,
        iss: 'hirearchy-staging',
        aud: 'hirearchy-postgres',
        kid: 'rehearsal-1',
        iat: now,
        exp: now + 60,
        auth_exp: claims.exp,
        jti: randomUUID(),
        sub: claims.sub,
        sid: claims.session_id,
        op: 'session.open',
        args: { organizationId },
        ...changes,
      }),
    );
  const execute = (payload, signature = sign(null, payload, privateKey)) =>
    gateway.query('SELECT staging.dispatch($1::bytea,$2::bytea) AS result', [
      payload,
      signature,
    ]);
  const rejected = async (payload, signature) =>
    assert.rejects(execute(payload, signature), (error) =>
      ['28000', '42501', '23505', '22023'].includes(error.code),
    );
  await assert.rejects(
    gateway.query('SELECT * FROM hirearchy.staging_verification_keys'),
    { code: '42501' },
  );
  await assert.rejects(gateway.query('SET ROLE staging_verifier_owner'), {
    code: '42501',
  });
  await gateway.query(
    "SELECT set_config('staging.subject_id',$1,false),set_config('staging.organization_id',$2,false)",
    [claims.sub, organizationId],
  );
  const valid = proof();
  await rejected(valid, Buffer.alloc(64));
  for (const changes of [
    { iss: 'untrusted' },
    { aud: 'elsewhere' },
    { kid: 'missing' },
    { exp: now - 1 },
    { exp: now + 3600 },
    { iat: now + 30 },
    { sub: randomUUID() },
    { sid: randomUUID() },
    { args: { organizationId: randomUUID() } },
    { args: { organizationId, subjectId: randomUUID() } },
    { injectedSubject: randomUUID() },
    { op: 'unavailable' },
    { v: 2 },
  ])
    await rejected(proof(changes));
  await execute(valid);
  await rejected(valid);
  await admin.query(
    "UPDATE hirearchy.staging_verification_keys SET revoked_at=now() WHERE key_id='rehearsal-1'",
  );
  await rejected(proof());
  const rotated = generateKeyPairSync('ed25519');
  await admin.query(
    "INSERT INTO hirearchy.staging_verification_keys(key_id,issuer,audience,public_key,valid_from,valid_until) VALUES('rehearsal-2','hirearchy-staging','hirearchy-postgres',$1,now()-interval '1 minute',now()+interval '1 day')",
    [rotated.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)],
  );
  const next = proof({ kid: 'rehearsal-2' });
  await execute(next, sign(null, next, rotated.privateKey));
  await admin.query(
    "UPDATE hirearchy.staging_verification_keys SET revoked_at=NULL WHERE key_id='rehearsal-1'",
  );

  const originalExpiry = (
    await admin.query('SELECT not_after FROM auth.sessions WHERE id=$1', [
      claims.session_id,
    ])
  ).rows[0].not_after;
  await admin.query(
    "UPDATE auth.sessions SET not_after=now()+interval '30 seconds' WHERE id=$1",
    [claims.session_id],
  );
  await execute(proof());
  const boundedSession = await admin.query(
    'SELECT app.expires_at <= auth.not_after AS bounded FROM hirearchy.staging_sessions app JOIN auth.sessions auth ON auth.id=app.auth_session_id WHERE app.auth_session_id=$1 AND app.organization_id=$2',
    [claims.session_id, organizationId],
  );
  assert.equal(boundedSession.rows[0].bounded, true);
  await admin.query(
    "UPDATE auth.sessions SET not_after=now()-interval '1 second' WHERE id=$1",
    [claims.session_id],
  );
  await rejected(proof());
  await admin.query('UPDATE auth.sessions SET not_after=$1 WHERE id=$2', [
    originalExpiry,
    claims.session_id,
  ]);

  const secondOrganizationId = randomUUID();
  const { rows: principalRows } = await admin.query(
    'SELECT id FROM hirearchy.application_principals WHERE auth_user_id=$1',
    [claims.sub],
  );
  assert.equal(principalRows.length, 1);
  await admin.query('INSERT INTO hirearchy.organizations(id) VALUES($1)', [
    secondOrganizationId,
  ]);
  await admin.query(
    `INSERT INTO hirearchy.organization_memberships
       (organization_id, principal_id, role, status, joined_at, version)
     VALUES ($1, $2, 'recruiter', 'active', pg_catalog.clock_timestamp(), 1)`,
    [secondOrganizationId, principalRows[0].id],
  );
  const secondOpen = proof({
    kid: 'rehearsal-2',
    jti: randomUUID(),
    args: { organizationId: secondOrganizationId },
  });
  await execute(secondOpen, sign(null, secondOpen, rotated.privateKey));
  const revoke = proof({
    kid: 'rehearsal-2',
    jti: randomUUID(),
    op: 'session.revoke',
    args: { organizationId: secondOrganizationId },
  });
  await execute(revoke, sign(null, revoke, rotated.privateKey));
  const { rows: sessionRows } = await admin.query(
    `SELECT organization_id, revoked_at IS NOT NULL AS revoked
       FROM hirearchy.staging_sessions
      WHERE auth_session_id=$1
      ORDER BY organization_id`,
    [claims.session_id],
  );
  assert.deepEqual(
    sessionRows,
    [
      { organization_id: organizationId, revoked: false },
      { organization_id: secondOrganizationId, revoked: true },
    ].sort((left, right) =>
      left.organization_id.localeCompare(right.organization_id),
    ),
  );
}

export async function checkReviewerRowLockBoundary({
  admin,
  organizationId,
  sessionId,
  reviewerPrincipalId,
  issuerPrincipalId,
}) {
  const createdSessionId = `sess_lock_probe_${randomUUID().replaceAll('-', '')}`;
  const createdAssignmentId = randomUUID();
  await admin.query(
    'INSERT INTO hirearchy.assessment_sessions(id,organization_id,issuer_principal_id) VALUES($1,$2,$3)',
    [createdSessionId, organizationId, issuerPrincipalId],
  );
  await admin.query(
    'INSERT INTO hirearchy.reviewer_assignments(id,organization_id,session_id,reviewer_principal_id,assigned_by_principal_id) VALUES($1,$2,$3,$4,$5)',
    [
      createdAssignmentId,
      organizationId,
      createdSessionId,
      reviewerPrincipalId,
      issuerPrincipalId,
    ],
  );

  try {
    const { rows: policies } = await admin.query(
      `SELECT tablename,cmd,roles::text[] AS roles,qual,with_check
         FROM pg_policies
        WHERE schemaname='hirearchy'
          AND policyname IN ('staging_verifier_assessment_session_lock','staging_verifier_reviewer_assignment_lock')
        ORDER BY policyname`,
    );
    assert.deepEqual(
      policies.map((policy) => [policy.tablename, policy.cmd, policy.roles]),
      [
        ['assessment_sessions', 'UPDATE', ['staging_verifier_owner']],
        ['reviewer_assignments', 'UPDATE', ['staging_verifier_owner']],
      ],
    );
    for (const policy of policies) {
      assert.match(policy.qual, /staging\.organization_id/);
      assert.match(policy.qual, /SUBMITTED/);
      assert.equal(policy.with_check, 'false');
    }
    assert.match(policies[0].qual, /staging\.principal_id/);
    assert.match(policies[0].qual, /staging\.session_id/);
    assert.match(policies[0].qual, /revoked_at IS NULL/);
    assert.match(policies[1].qual, /staging\.principal_id/);
    assert.match(policies[1].qual, /staging\.session_id/);
    assert.match(policies[1].qual, /revoked_at IS NULL/);

    const { rows: privileges } = await admin.query(
      `SELECT
         has_table_privilege('staging_verifier_owner','hirearchy.assessment_sessions','UPDATE') AS session_table_update,
         has_column_privilege('staging_verifier_owner','hirearchy.assessment_sessions','id','UPDATE') AS session_id_update,
         has_column_privilege('staging_verifier_owner','hirearchy.assessment_sessions','status','UPDATE') AS session_status_update,
         has_table_privilege('staging_verifier_owner','hirearchy.reviewer_assignments','UPDATE') AS assignment_table_update,
         has_column_privilege('staging_verifier_owner','hirearchy.reviewer_assignments','id','UPDATE') AS assignment_id_update,
         has_column_privilege('staging_verifier_owner','hirearchy.reviewer_assignments','revoked_at','UPDATE') AS assignment_revoked_update`,
    );
    assert.deepEqual(privileges, [
      {
        session_table_update: false,
        session_id_update: true,
        session_status_update: false,
        assignment_table_update: false,
        assignment_id_update: true,
        assignment_revoked_update: false,
      },
    ]);
    const { rows: runtimePrivileges } = await admin.query(
      `SELECT role_name,
              has_table_privilege(role_name,'hirearchy.assessment_sessions','UPDATE')
                OR has_column_privilege(role_name,'hirearchy.assessment_sessions','id','UPDATE')
                OR has_table_privilege(role_name,'hirearchy.reviewer_assignments','UPDATE')
                OR has_column_privilege(role_name,'hirearchy.reviewer_assignments','id','UPDATE') AS has_update
         FROM unnest(ARRAY['app_candidate_gateway','app_evaluator','app_control_worker']) AS role_name
        ORDER BY role_name`,
    );
    assert.deepEqual(runtimePrivileges, [
      { role_name: 'app_candidate_gateway', has_update: false },
      { role_name: 'app_control_worker', has_update: false },
      { role_name: 'app_evaluator', has_update: false },
    ]);
    const { rows: roleFlags } = await admin.query(
      `SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb
         FROM pg_catalog.pg_roles WHERE rolname='staging_verifier_owner'`,
    );
    assert.deepEqual(roleFlags, [
      {
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      },
    ]);

    async function lockCounts(
      organizationContext,
      principalContext,
      targetSessionId,
      requestSessionContext = targetSessionId,
    ) {
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL ROLE staging_verifier_owner');
        await admin.query(
          "SELECT pg_catalog.set_config('staging.organization_id',$1,true),pg_catalog.set_config('staging.principal_id',$2,true),pg_catalog.set_config('staging.session_id',$3,true)",
          [
            organizationContext ?? '',
            principalContext ?? '',
            requestSessionContext ?? '',
          ],
        );
        const sessionPlain = await admin.query(
          'SELECT status FROM hirearchy.assessment_sessions WHERE organization_id=$1::uuid AND id=$2',
          [organizationId, targetSessionId],
        );
        const sessionLock = await admin.query(
          'SELECT status FROM hirearchy.assessment_sessions WHERE organization_id=$1::uuid AND id=$2 FOR SHARE',
          [organizationId, targetSessionId],
        );
        const assignmentPlain = await admin.query(
          'SELECT id FROM hirearchy.reviewer_assignments WHERE organization_id=$1::uuid AND session_id=$2 AND reviewer_principal_id=$3::uuid AND revoked_at IS NULL',
          [organizationId, targetSessionId, reviewerPrincipalId],
        );
        const assignmentLock = await admin.query(
          'SELECT id FROM hirearchy.reviewer_assignments WHERE organization_id=$1::uuid AND session_id=$2 AND reviewer_principal_id=$3::uuid AND revoked_at IS NULL FOR SHARE',
          [organizationId, targetSessionId, reviewerPrincipalId],
        );
        await admin.query('COMMIT');
        return {
          sessionPlain: sessionPlain.rowCount,
          sessionLock: sessionLock.rowCount,
          assignmentPlain: assignmentPlain.rowCount,
          assignmentLock: assignmentLock.rowCount,
        };
      } catch (error) {
        await admin.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }

    const authorized = await lockCounts(
      organizationId,
      reviewerPrincipalId,
      sessionId,
    );
    assert.deepEqual(authorized, {
      sessionPlain: 1,
      sessionLock: 1,
      assignmentPlain: 1,
      assignmentLock: 1,
    });
    assert.deepEqual(
      await lockCounts(randomUUID(), reviewerPrincipalId, sessionId),
      {
        sessionPlain: 0,
        sessionLock: 0,
        assignmentPlain: 0,
        assignmentLock: 0,
      },
    );
    assert.deepEqual(
      await lockCounts(organizationId, issuerPrincipalId, sessionId),
      {
        sessionPlain: 1,
        sessionLock: 0,
        assignmentPlain: 1,
        assignmentLock: 0,
      },
    );
    assert.deepEqual(
      await lockCounts(
        organizationId,
        reviewerPrincipalId,
        sessionId,
        createdSessionId,
      ),
      {
        sessionPlain: 1,
        sessionLock: 0,
        assignmentPlain: 1,
        assignmentLock: 0,
      },
    );
    for (const [organizationContext, principalContext] of [
      [organizationId, null],
      [null, reviewerPrincipalId],
    ]) {
      assert.deepEqual(
        await lockCounts(organizationContext, principalContext, sessionId),
        {
          sessionPlain: 0,
          sessionLock: 0,
          assignmentPlain: 0,
          assignmentLock: 0,
        },
      );
    }
    assert.deepEqual(
      await lockCounts(organizationId, reviewerPrincipalId, sessionId, null),
      {
        sessionPlain: 1,
        sessionLock: 0,
        assignmentPlain: 1,
        assignmentLock: 0,
      },
    );
    assert.deepEqual(
      await lockCounts(organizationId, reviewerPrincipalId, createdSessionId),
      {
        sessionPlain: 1,
        sessionLock: 0,
        assignmentPlain: 1,
        assignmentLock: 0,
      },
    );

    for (const [sql, parameters] of [
      [
        'UPDATE hirearchy.assessment_sessions SET id=id WHERE organization_id=$1::uuid AND id=$2',
        [organizationId, sessionId],
      ],
      [
        'UPDATE hirearchy.reviewer_assignments SET id=id WHERE organization_id=$1::uuid AND session_id=$2 AND reviewer_principal_id=$3::uuid',
        [organizationId, sessionId, reviewerPrincipalId],
      ],
    ]) {
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL ROLE staging_verifier_owner');
        await admin.query(
          "SELECT pg_catalog.set_config('staging.organization_id',$1,true),pg_catalog.set_config('staging.principal_id',$2,true),pg_catalog.set_config('staging.session_id',$3,true)",
          [organizationId, reviewerPrincipalId, sessionId],
        );
        await assert.rejects(admin.query(sql, parameters), {
          code: '42501',
        });
      } finally {
        await admin.query('ROLLBACK');
      }
    }
    const { rows: unchanged } = await admin.query(
      `SELECT (SELECT status FROM hirearchy.assessment_sessions WHERE organization_id=$1 AND id=$2) AS session_status,
              (SELECT revoked_at IS NULL FROM hirearchy.reviewer_assignments WHERE organization_id=$1 AND session_id=$2 AND reviewer_principal_id=$3) AS assignment_active`,
      [organizationId, sessionId, reviewerPrincipalId],
    );
    assert.deepEqual(unchanged, [
      { session_status: 'SUBMITTED', assignment_active: true },
    ]);
  } finally {
    await admin.query(
      'DELETE FROM hirearchy.reviewer_assignments WHERE organization_id=$1 AND id=$2',
      [organizationId, createdAssignmentId],
    );
    await admin.query(
      'DELETE FROM hirearchy.assessment_sessions WHERE organization_id=$1 AND id=$2',
      [organizationId, createdSessionId],
    );
  }
}

export async function checkInstallerBoundary(admin, installerSql) {
  const { rows: before } = await admin.query(
    "SELECT pg_catalog.to_regnamespace('r23') IS NULL AS available",
  );
  assert.equal(
    before[0].available,
    true,
    'the disposable test owns the schema name',
  );
  await admin.query('CREATE SCHEMA r23');
  let failure;
  try {
    await admin.query(installerSql);
  } catch (error) {
    failure = error;
  }
  await admin.query('ROLLBACK');
  try {
    assert(failure, 'installer must refuse a disposable fixture schema');
    assert.match(failure.message, /Disposable R23-R213 fixture schema exists/);
    const { rows } = await admin.query(
      "SELECT pg_catalog.to_regnamespace('r23') IS NOT NULL AS fixture_exists, pg_catalog.to_regnamespace('staging') AS staging_schema, pg_catalog.to_regprocedure('staging.dispatch(bytea,bytea)') AS dispatcher",
    );
    assert.equal(rows[0].fixture_exists, true);
    assert.equal(
      rows[0].staging_schema,
      null,
      'rejected installation must roll back',
    );
    assert.equal(
      rows[0].dispatcher,
      null,
      'rejected installation must not add an API',
    );
  } finally {
    await admin.query('DROP SCHEMA r23');
  }

  const roleSettings = [
    {
      name: 'missing fixed search path',
      configure: 'ALTER ROLE app_candidate_gateway RESET search_path',
      restore: 'ALTER ROLE app_candidate_gateway SET search_path=pg_catalog',
    },
    {
      name: 'additional search path',
      configure:
        'ALTER ROLE app_candidate_gateway SET search_path=pg_catalog,public',
      restore: 'ALTER ROLE app_candidate_gateway SET search_path=pg_catalog',
    },
    {
      name: 'caller identity setting',
      configure:
        "ALTER ROLE app_candidate_gateway SET app.current_principal_id='forged'",
      restore:
        'ALTER ROLE app_candidate_gateway RESET app.current_principal_id',
    },
    {
      name: 'database-specific override',
      configure:
        'ALTER ROLE app_candidate_gateway IN DATABASE postgres SET search_path=pg_catalog',
      restore:
        'ALTER ROLE app_candidate_gateway IN DATABASE postgres RESET search_path',
    },
  ];
  for (const setting of roleSettings) {
    try {
      await admin.query(setting.configure);
      let roleFailure;
      try {
        await admin.query(installerSql);
      } catch (error) {
        roleFailure = error;
      }
      await admin.query('ROLLBACK');
      assert(roleFailure, `installer must reject ${setting.name}`);
      assert.match(
        roleFailure.message,
        /app_candidate_gateway is missing or unsafe/,
      );
      const { rows } = await admin.query(
        "SELECT pg_catalog.to_regnamespace('staging') AS staging_schema, (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM hirearchy.durable_candidate_installation) AS durable_markers",
      );
      assert.deepEqual(rows, [{ staging_schema: null, durable_markers: 0 }]);
    } finally {
      await admin.query('ROLLBACK');
      await admin.query(setting.restore);
    }
  }
}
