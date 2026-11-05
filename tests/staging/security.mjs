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
}
