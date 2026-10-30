import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  createR23PostgresAdapter,
  R23ScopeDenied,
} from '../../database/postgres/r23/adapter.mjs';
import { createR26CandidateAdapter } from '../../database/postgres/r26/adapter.mjs';
import { assertCandidateTokenStorage } from '../../database/postgres/r23/adapter.mjs';

const SCENARIO_ID = 'scenario-002-booking-notification-retry';
const SCENARIO_VERSION = '1.0.0';
const SCENARIO_TITLE = 'R2.7 evidence fixture';
const NO_TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
];
const EVIDENCE_TABLES = [
  'candidate_workspace_files',
  'candidate_session_events',
  'candidate_session_operations',
  'candidate_session_submissions',
  'assessment_sessions',
  'reviewer_assignments',
  'organization_memberships',
];

const hash = (value) =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const randomId = (prefix) => `${prefix}${randomBytes(10).toString('hex')}`;

function makeActor() {
  return {
    principalId: randomUUID(),
    subjectId: randomUUID(),
    authSessionId: randomUUID(),
    handleHash: hash(randomBytes(32).toString('hex')),
    callbackHash: hash(randomBytes(32).toString('hex')),
    identity: null,
  };
}

function assertVerifiedIdentity(identity) {
  if (
    !identity ||
    identity.expiresAt <= Math.floor(Date.now() / 1000) ||
    !['aal1', 'aal2'].includes(identity.assurance)
  ) {
    throw new Error('Synthetic verified identity rejected');
  }
  return identity;
}

async function createAuthenticatedActor(adapter, actor) {
  actor.identity = {
    subjectId: actor.subjectId,
    sessionId: actor.authSessionId,
    assurance: 'aal1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  await adapter.createSession({
    handleHash: actor.handleHash,
    csrfHash: hash(randomBytes(32).toString('hex')),
    callbackHash: actor.callbackHash,
    credentialEnvelope: Buffer.from('synthetic R2.7 Auth envelope'),
    identity: actor.identity,
    expiresAt: new Date(Date.now() + 3_600_000),
    accessExpiresAt: new Date(Date.now() + 3_000_000),
  });
  await adapter.withActiveSession(
    { handleHash: actor.handleHash },
    async (_session, authz) => authz.consumeCallback(actor.callbackHash),
  );
}

async function readEvidence(adapter, actor, organizationId, sessionId, query) {
  return adapter.withActiveSession(
    { handleHash: actor.handleHash },
    async (_session, authz) => {
      await authz.selectOrganization(actor.identity, organizationId);
      return authz.getSubmittedEvidence(
        actor.identity,
        organizationId,
        sessionId,
        query,
      );
    },
  );
}

async function createSubmittedSession(
  admin,
  candidateAdapter,
  {
    organizationId,
    issuerPrincipalId,
    reviewerPrincipalId,
    label,
    saveCount = 2,
  },
) {
  const sessionId = `sess_r27_${label}_${randomBytes(8).toString('hex')}`;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hash(token);
  const workspaceFiles = {
    'README.md': '# R2.7 fixture\n',
    'src/service.py': 'def value():\n    return 1\n',
  };
  const snapshotText = JSON.stringify({
    scenario: {
      id: SCENARIO_ID,
      version: SCENARIO_VERSION,
      title: SCENARIO_TITLE,
      durationSeconds: 600,
      brief: 'Synthetic disposable evidence only.',
    },
    workspaceFiles,
  });
  await admin.query(
    `INSERT INTO hirearchy.assessment_sessions (
       id, organization_id, issuer_principal_id, scenario_id,
       scenario_version, scenario_title, status, duration_seconds,
       scenario_snapshot
     ) VALUES ($1, $2, $3, $4, $5, $6, 'CREATED', 600, $7)`,
    [
      sessionId,
      organizationId,
      issuerPrincipalId,
      SCENARIO_ID,
      SCENARIO_VERSION,
      SCENARIO_TITLE,
      snapshotText,
    ],
  );
  await admin.query(
    `INSERT INTO hirearchy.candidate_token_envelopes (
       organization_id, session_id, candidate_token_hash,
       candidate_token_ciphertext
     ) VALUES ($1, $2, $3, $4)`,
    [organizationId, sessionId, tokenHash, 'synthetic-R27-envelope'],
  );
  const assignmentId = randomId('r27-assignment-');
  await admin.query(
    `INSERT INTO hirearchy.reviewer_assignments (
       id, organization_id, session_id, reviewer_principal_id,
       assigned_by_principal_id, assigned_at, version
     ) VALUES ($1, $2, $3, $4, $5, pg_catalog.clock_timestamp(), 1)`,
    [
      assignmentId,
      organizationId,
      sessionId,
      reviewerPrincipalId,
      issuerPrincipalId,
    ],
  );

  const activated = await candidateAdapter.command({
    tokenHash,
    sessionId,
    action: 'activate',
    input: {},
  });
  let saved = activated;
  for (let index = 0; index < saveCount; index += 1) {
    const version = saved.files.find(
      (file) => file.path === 'src/service.py',
    ).version;
    saved = await candidateAdapter.command({
      tokenHash,
      sessionId,
      action: 'save',
      input: {
        requestId: randomId('r27-save-'),
        path: 'src/service.py',
        content: `def value():\n    return ${index + 2}\n`,
        expectedVersion: version,
      },
    });
  }
  const submitted = await candidateAdapter.command({
    tokenHash,
    sessionId,
    action: 'submit',
    input: {
      requestId: randomId('r27-submit-'),
      expectedWorkspaceDigest: saved.workspaceDigest,
    },
  });
  return { sessionId, token, tokenHash, assignmentId, submitted };
}

async function createSubmittedSessionWithoutStarter(
  admin,
  { organizationId, issuerPrincipalId, reviewerPrincipalId },
) {
  const sessionId = `sess_r27_no_starter_${randomBytes(8).toString('hex')}`;
  const assignmentId = randomId('r27-assignment-');
  const createdAt = new Date(Date.now() - 5_000);
  const activatedAt = new Date(Date.now() - 3_000);
  const submittedAt = new Date(Date.now() - 1_000);
  const content = 'def retained():\n    return True\n';
  const fileDigest = hash(content);
  const snapshotText = JSON.stringify({
    scenario: {
      id: SCENARIO_ID,
      version: SCENARIO_VERSION,
      title: SCENARIO_TITLE,
      durationSeconds: 600,
    },
  });
  const scenarioDigest = hash(snapshotText);
  await admin.query(
    `INSERT INTO hirearchy.assessment_sessions (
       id, organization_id, issuer_principal_id, scenario_id,
       scenario_version, scenario_title, status, created_at, activated_at,
       submitted_at, duration_seconds, closure_reason, scenario_snapshot
     ) VALUES ($1, $2, $3, $4, $5, $6, 'SUBMITTED', $7, $8, $9, 600,
       'candidate_submission', $10)`,
    [
      sessionId,
      organizationId,
      issuerPrincipalId,
      SCENARIO_ID,
      SCENARIO_VERSION,
      SCENARIO_TITLE,
      createdAt,
      activatedAt,
      submittedAt,
      snapshotText,
    ],
  );
  await admin.query(
    `INSERT INTO hirearchy.reviewer_assignments (
       id, organization_id, session_id, reviewer_principal_id,
       assigned_by_principal_id, assigned_at, version
     ) VALUES ($1, $2, $3, $4, $5, $6, 1)`,
    [
      assignmentId,
      organizationId,
      sessionId,
      reviewerPrincipalId,
      issuerPrincipalId,
      createdAt,
    ],
  );
  const manifest = [
    {
      path: 'src/legacy.py',
      content,
      version: '0',
      digest: fileDigest,
    },
  ];
  await admin.query(
    `WITH submitted_manifest AS (
       SELECT $4::pg_catalog.jsonb AS files
     ), identity AS (
       SELECT pg_catalog.jsonb_agg(
         pg_catalog.jsonb_build_object(
           'path', file.value ->> 'path',
           'version', file.value ->> 'version',
           'digest', file.value ->> 'digest'
         ) ORDER BY file.value ->> 'path'
       ) AS files
       FROM submitted_manifest, pg_catalog.jsonb_array_elements(submitted_manifest.files) AS file(value)
     )
     INSERT INTO hirearchy.candidate_session_submissions (
       organization_id, session_id, submitted_at, closure_reason,
       workspace_digest, manifest_digest, manifest
     )
     SELECT $1, $2, $3, 'candidate_submission',
       pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(identity.files::pg_catalog.text, 'UTF8')), 'hex'),
       pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(submitted_manifest.files::pg_catalog.text, 'UTF8')), 'hex'),
       submitted_manifest.files
     FROM submitted_manifest CROSS JOIN identity`,
    [organizationId, sessionId, submittedAt, JSON.stringify(manifest)],
  );
  const submission = await admin.query(
    `SELECT workspace_digest, manifest_digest
       FROM hirearchy.candidate_session_submissions WHERE session_id = $1`,
    [sessionId],
  );
  await admin.query(
    `INSERT INTO hirearchy.candidate_session_events (
       organization_id, session_id, sequence, event_type, happened_at, payload
     ) VALUES
       ($1, $2, 1, 'SESSION_ACTIVATED', $3,
        pg_catalog.jsonb_build_object('scenarioDigest', $4::pg_catalog.text)),
       ($1, $2, 2, 'SESSION_SUBMITTED', $5,
        pg_catalog.jsonb_build_object(
          'closureReason', 'candidate_submission',
          'workspaceDigest', $6::pg_catalog.text,
          'manifestDigest', $7::pg_catalog.text
        ))`,
    [
      organizationId,
      sessionId,
      activatedAt,
      scenarioDigest,
      submittedAt,
      submission.rows[0].workspace_digest,
      submission.rows[0].manifest_digest,
    ],
  );
  return { sessionId, assignmentId };
}

async function assertRoleDenied(pool, sql, values, fixtureContext) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_catalog.set_config('r26.session_id', $1, true),
              pg_catalog.set_config('r26.token_hash', $2, true),
              pg_catalog.set_config('r23.session_handle_hash', $3, true),
              pg_catalog.set_config('r23.auth_subject_id', $4, true),
              pg_catalog.set_config('r23.auth_session_id', $5, true),
              pg_catalog.set_config('r23.principal_id', $6, true),
              pg_catalog.set_config('r23.organization_id', $7, true),
              pg_catalog.set_config('r27.organization_id', $7, true),
              pg_catalog.set_config('r27.session_id', $1, true),
              pg_catalog.set_config('r27.principal_id', $6, true)`,
      [
        fixtureContext.sessionId,
        fixtureContext.tokenHash,
        fixtureContext.handleHash,
        fixtureContext.subjectId,
        fixtureContext.authSessionId,
        fixtureContext.principalId,
        fixtureContext.organizationId,
      ],
    );
    await assert.rejects(
      client.query(sql, values),
      (error) => error?.code === '42501',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

export async function runR27PostgresEvidenceChecks({
  admin,
  connection,
  runtimePassword,
  candidateTokenKey,
}) {
  assert.ok(admin && connection && runtimePassword);
  assert.match(candidateTokenKey ?? '', /^[A-Za-z0-9+/]{43}=$/);
  await assertCandidateTokenStorage(admin, {
    key: Buffer.from(candidateTokenKey, 'base64'),
  });

  const candidatePool = new Pool({
    ...connection,
    user: 'app_candidate_gateway',
    password: runtimePassword,
    application_name: 'hirearchy-r27-candidate-denial-check',
    max: 2,
  });
  const gatewayPool = new Pool({
    ...connection,
    user: 'r23_gateway',
    password: runtimePassword,
    application_name: 'hirearchy-r27-evidence-check',
    max: 5,
  });
  const candidateAdapter = createR26CandidateAdapter({
    connectionString: `postgres://app_candidate_gateway:${encodeURIComponent(runtimePassword)}@${connection.host}:${connection.port}/${connection.database ?? 'postgres'}`,
  });
  const authorization = createR23PostgresAdapter({
    pool: gatewayPool,
    assertVerifiedIdentity,
  });
  const orgA = randomUUID();
  const orgB = randomUUID();
  const actors = {
    recruiterA: makeActor(),
    reviewerA: makeActor(),
    reviewerAB: makeActor(),
    reviewerB: makeActor(),
    reviewerRevoked: makeActor(),
    adminA: makeActor(),
    recruiterB: makeActor(),
  };
  const fixtureActors = Object.values(actors);
  const insertedReviewerBOrgA = true;
  let candidateFixture;
  let foreignFixture;
  let revokedFixture;
  let missingStarterFixture;
  try {
    await admin.query(
      'INSERT INTO hirearchy.organizations (id) VALUES ($1), ($2)',
      [orgA, orgB],
    );
    for (const actor of fixtureActors) {
      await admin.query(
        `INSERT INTO hirearchy.application_principals (id, auth_user_id)
         VALUES ($1, $2)`,
        [actor.principalId, actor.subjectId],
      );
    }
    const memberships = [
      [orgA, actors.recruiterA.principalId, 'recruiter', 'active', null],
      [orgA, actors.reviewerA.principalId, 'reviewer', 'active', null],
      [orgA, actors.reviewerAB.principalId, 'reviewer', 'active', null],
      [orgA, actors.reviewerB.principalId, 'reviewer', 'active', null],
      [
        orgA,
        actors.reviewerRevoked.principalId,
        'reviewer',
        'revoked',
        new Date(),
      ],
      [orgA, actors.adminA.principalId, 'admin', 'active', null],
      [orgB, actors.recruiterB.principalId, 'recruiter', 'active', null],
      [orgB, actors.reviewerB.principalId, 'reviewer', 'active', null],
      [orgB, actors.reviewerAB.principalId, 'admin', 'active', null],
    ];
    for (const [
      organizationId,
      principalId,
      role,
      status,
      revokedAt,
    ] of memberships) {
      await admin.query(
        `INSERT INTO hirearchy.organization_memberships (
           organization_id, principal_id, role, status, joined_at,
           revoked_at, version
         ) VALUES ($1, $2, $3, $4, pg_catalog.clock_timestamp(), $5, 1)`,
        [organizationId, principalId, role, status, revokedAt],
      );
    }
    for (const actor of fixtureActors)
      await createAuthenticatedActor(authorization, actor);

    candidateFixture = await createSubmittedSession(admin, candidateAdapter, {
      organizationId: orgA,
      issuerPrincipalId: actors.recruiterA.principalId,
      reviewerPrincipalId: actors.reviewerAB.principalId,
      label: 'assigned',
    });
    foreignFixture = await createSubmittedSession(admin, candidateAdapter, {
      organizationId: orgB,
      issuerPrincipalId: actors.recruiterB.principalId,
      reviewerPrincipalId: actors.reviewerB.principalId,
      label: 'foreign',
    });
    revokedFixture = await createSubmittedSession(admin, candidateAdapter, {
      organizationId: orgA,
      issuerPrincipalId: actors.recruiterA.principalId,
      reviewerPrincipalId: actors.reviewerAB.principalId,
      label: 'revoked',
    });
    missingStarterFixture = await createSubmittedSessionWithoutStarter(admin, {
      organizationId: orgA,
      issuerPrincipalId: actors.recruiterA.principalId,
      reviewerPrincipalId: actors.reviewerAB.principalId,
    });

    await assert.rejects(
      authorization.withActiveSession(
        { handleHash: actors.reviewerAB.handleHash },
        async (_session, authz) =>
          authz.getSubmittedEvidence(
            actors.reviewerAB.identity,
            orgA,
            candidateFixture.sessionId,
          ),
      ),
      (error) => error instanceof R23ScopeDenied,
      'evidence requires explicit organization selection',
    );

    const evidencePageOne = await readEvidence(
      authorization,
      actors.reviewerAB,
      orgA,
      candidateFixture.sessionId,
      { limit: 2 },
    );
    assert.ok(evidencePageOne);
    assert.equal(evidencePageOne.permission, 'assigned_reviewer');
    assert.equal(evidencePageOne.status, 'SUBMITTED');
    assert.deepEqual(
      evidencePageOne.events.map((event) => event.sequence),
      ['1', '2'],
    );
    assert.equal(evidencePageOne.pagination.nextAfterSequence, '2');
    assert.ok(
      evidencePageOne.revisions.some(
        (revision) =>
          revision.source === 'starter' && revision.content !== null,
      ),
    );
    assert.ok(
      evidencePageOne.revisions.some(
        (revision) =>
          revision.source === 'event_metadata' && revision.content === null,
      ),
    );
    const evidencePageTwo = await readEvidence(
      authorization,
      actors.reviewerAB,
      orgA,
      candidateFixture.sessionId,
      { afterSequence: evidencePageOne.pagination.nextAfterSequence, limit: 2 },
    );
    assert.ok(evidencePageTwo);
    assert.deepEqual(
      evidencePageTwo.events.map((event) => event.sequence),
      ['3', '4'],
    );
    assert.equal(evidencePageTwo.pagination.nextAfterSequence, null);
    assert.equal(evidencePageTwo.events.at(-1)?.type, 'SESSION_SUBMITTED');
    assert.equal(
      evidencePageTwo.events.at(-1)?.provenance,
      'hirearchy.candidate_session_events',
    );
    assert.deepEqual(
      evidencePageTwo.submission.files,
      candidateFixture.submitted.submission.files,
    );
    const evidenceText =
      JSON.stringify(evidencePageOne) + JSON.stringify(evidencePageTwo);
    for (const secret of [
      candidateFixture.token,
      candidateFixture.tokenHash,
      'synthetic-R27-envelope',
    ]) {
      assert.equal(evidenceText.includes(secret), false);
    }

    const missingStarter = await readEvidence(
      authorization,
      actors.reviewerAB,
      orgA,
      missingStarterFixture.sessionId,
      {},
    );
    assert.ok(missingStarter);
    assert.equal(missingStarter.scenario.starterFiles, null);
    assert.ok(
      missingStarter.availability.limitations.some((limitation) =>
        limitation.includes('no starter file content'),
      ),
    );
    assert.equal(
      missingStarter.revisions.some(
        (revision) => revision.source === 'starter',
      ),
      false,
    );
    assert.deepEqual(
      missingStarter.revisions.map((revision) => revision.source),
      ['submitted'],
    );

    assert.equal(
      await readEvidence(
        authorization,
        actors.reviewerB,
        orgA,
        candidateFixture.sessionId,
      ),
      null,
      'active reviewer membership without an assignment grants no evidence',
    );
    assert.equal(
      await readEvidence(
        authorization,
        actors.recruiterA,
        orgA,
        candidateFixture.sessionId,
      ),
      null,
      'issuer recruiter membership grants no evidence',
    );
    assert.equal(
      await readEvidence(
        authorization,
        actors.adminA,
        orgA,
        candidateFixture.sessionId,
      ),
      null,
      'administrator membership grants no evidence',
    );
    assert.equal(
      await readEvidence(
        authorization,
        actors.reviewerAB,
        orgA,
        foreignFixture.sessionId,
      ),
      null,
      'foreign organization session IDs return no evidence',
    );
    assert.equal(
      await readEvidence(
        authorization,
        actors.reviewerAB,
        orgB,
        foreignFixture.sessionId,
      ),
      null,
      'AB admin membership in organization B grants no evidence',
    );
    await assert.rejects(
      authorization.withActiveSession(
        { handleHash: actors.reviewerAB.handleHash },
        async (_session, authz) => {
          await authz.selectOrganization(actors.reviewerAB.identity, orgB);
          return authz.getSubmittedEvidence(
            actors.reviewerAB.identity,
            orgA,
            candidateFixture.sessionId,
            { afterSequence: '2', limit: 2 },
          );
        },
      ),
      (error) => error instanceof R23ScopeDenied,
      'the current selected organization is checked on each page request',
    );
    assert.equal(
      await readEvidence(
        authorization,
        actors.reviewerRevoked,
        orgA,
        candidateFixture.sessionId,
      ).catch((error) => error instanceof R23ScopeDenied),
      true,
      'revoked reviewer membership is denied',
    );
    await admin.query(
      `UPDATE hirearchy.reviewer_assignments
          SET revoked_at = pg_catalog.clock_timestamp(), version = version + 1
        WHERE id = $1`,
      [revokedFixture.assignmentId],
    );
    assert.equal(
      await readEvidence(
        authorization,
        actors.reviewerAB,
        orgA,
        revokedFixture.sessionId,
      ),
      null,
      'revoked assignment grants no evidence on a later call',
    );

    await assert.rejects(
      readEvidence(
        authorization,
        actors.reviewerAB,
        orgA,
        candidateFixture.sessionId,
        {
          afterSequence: '01',
        },
      ),
      TypeError,
      'malformed sequence cursor is rejected before SQL',
    );
    await assert.rejects(
      readEvidence(authorization, actors.reviewerAB, orgA, 'bad session id'),
      TypeError,
      'malformed session ID is rejected before SQL',
    );

    const largeFixture = await createSubmittedSession(admin, candidateAdapter, {
      organizationId: orgA,
      issuerPrincipalId: actors.recruiterA.principalId,
      reviewerPrincipalId: actors.reviewerAB.principalId,
      label: 'numeric-pagination',
      saveCount: 12,
    });
    const largeFirst = await readEvidence(
      authorization,
      actors.reviewerAB,
      orgA,
      largeFixture.sessionId,
      { limit: 10 },
    );
    assert.equal(largeFirst.pagination.nextAfterSequence, '10');
    assert.equal(largeFirst.events.at(-1).sequence, '10');
    const largeSecond = await readEvidence(
      authorization,
      actors.reviewerAB,
      orgA,
      largeFixture.sessionId,
      { limit: 10, afterSequence: largeFirst.pagination.nextAfterSequence },
    );
    assert.deepEqual(
      largeSecond.events.map((event) => event.sequence),
      ['11', '12', '13', '14'],
    );
    assert.equal(largeSecond.pagination.nextAfterSequence, null);

    const privilegeRows = await admin.query(
      `SELECT role.rolname, relation.relname, privilege.name,
              pg_catalog.has_table_privilege(role.oid, relation.oid, privilege.name) AS granted
         FROM pg_catalog.pg_roles AS role
         CROSS JOIN pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         CROSS JOIN (VALUES ${NO_TABLE_PRIVILEGES.map((privilege) => `('${privilege}')`).join(', ')}) AS privilege(name)
        WHERE role.rolname = ANY($1::pg_catalog.name[])
          AND namespace.nspname = 'hirearchy'
          AND relation.relname = ANY($2::pg_catalog.name[])
          AND pg_catalog.has_table_privilege(role.oid, relation.oid, privilege.name)
        ORDER BY role.rolname, relation.relname, privilege.name`,
      [['r23_gateway', 'app_candidate_gateway'], EVIDENCE_TABLES],
    );
    assert.deepEqual(privilegeRows.rows, []);
    const functionPrivileges = await admin.query(
      `SELECT role.rolname, procedure.proname
         FROM pg_catalog.pg_roles AS role
         CROSS JOIN pg_catalog.pg_proc AS procedure
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'r27'
          AND role.rolname = ANY($1::pg_catalog.name[])
          AND pg_catalog.has_function_privilege(role.oid, procedure.oid, 'EXECUTE')
        ORDER BY role.rolname, procedure.proname`,
      [
        [
          'r23_gateway',
          'app_candidate_gateway',
          'app_evaluator',
          'app_control_worker',
        ],
      ],
    );
    assert.deepEqual(functionPrivileges.rows, [
      { rolname: 'r23_gateway', proname: 'get_submitted_evidence' },
    ]);
    const rlsRows = await admin.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_catalog.pg_class
        WHERE oid = ANY(ARRAY[
          'hirearchy.candidate_session_events'::pg_catalog.regclass,
          'hirearchy.candidate_session_submissions'::pg_catalog.regclass
        ]) ORDER BY relname`,
    );
    assert.equal(rlsRows.rows.length, 2);
    assert.ok(
      rlsRows.rows.every(
        (row) => row.relrowsecurity && row.relforcerowsecurity,
      ),
    );

    const before = await admin.query(
      `SELECT session.status, session.activated_at, session.submitted_at,
              session.closure_reason, session.scenario_snapshot,
              submission.manifest::pg_catalog.text AS manifest,
              submission.workspace_digest, submission.manifest_digest,
              (SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'sequence', event.sequence::pg_catalog.text,
                   'type', event.event_type,
                   'payload', event.payload
                 ) ORDER BY event.sequence
               ) FROM hirearchy.candidate_session_events AS event
                WHERE event.session_id = session.id) AS events,
              (SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object('path', file.file_path,
                   'content', file.content, 'version', file.version::pg_catalog.text,
                   'digest', file.content_digest) ORDER BY file.file_path
               ) FROM hirearchy.candidate_workspace_files AS file
                WHERE file.session_id = session.id) AS files
         FROM hirearchy.assessment_sessions AS session
         JOIN hirearchy.candidate_session_submissions AS submission
           ON submission.organization_id = session.organization_id
          AND submission.session_id = session.id
        WHERE session.id = $1`,
      [candidateFixture.sessionId],
    );
    const denialContext = {
      organizationId: orgA,
      sessionId: candidateFixture.sessionId,
      tokenHash: candidateFixture.tokenHash,
      handleHash: actors.reviewerAB.handleHash,
      subjectId: actors.reviewerAB.subjectId,
      authSessionId: actors.reviewerAB.authSessionId,
      principalId: actors.reviewerAB.principalId,
    };
    for (const pool of [candidatePool, gatewayPool]) {
      for (const [sql, values] of [
        [
          'SELECT * FROM hirearchy.candidate_workspace_files WHERE session_id = $1',
          [foreignFixture.sessionId],
        ],
        [
          'SELECT * FROM hirearchy.candidate_session_events WHERE session_id = $1',
          [foreignFixture.sessionId],
        ],
        [
          `INSERT INTO hirearchy.candidate_session_events
            (organization_id, session_id, sequence, event_type, happened_at, payload)
           VALUES ($1, $2, 99, 'SESSION_SUBMITTED', pg_catalog.clock_timestamp(), '{}'::pg_catalog.jsonb)`,
          [orgA, candidateFixture.sessionId],
        ],
        [
          `UPDATE hirearchy.candidate_workspace_files
              SET content = 'forged', version = version + 1
            WHERE session_id = $1 AND file_path = 'src/service.py'`,
          [candidateFixture.sessionId],
        ],
        [
          `UPDATE hirearchy.candidate_session_submissions
              SET manifest = '[]'::pg_catalog.jsonb WHERE session_id = $1`,
          [candidateFixture.sessionId],
        ],
        [
          `UPDATE hirearchy.assessment_sessions
              SET status = 'ACTIVE', submitted_at = NULL, closure_reason = NULL
            WHERE id = $1`,
          [candidateFixture.sessionId],
        ],
        [
          'DELETE FROM hirearchy.candidate_session_events WHERE session_id = $1',
          [candidateFixture.sessionId],
        ],
      ]) {
        await assertRoleDenied(pool, sql, values, denialContext);
      }
    }
    await assert.rejects(
      candidatePool.query(
        `SELECT r27.get_submitted_evidence(
           $1::pg_catalog.uuid, $2::pg_catalog.uuid, 'aal1', $3::pg_catalog.uuid,
           $4::pg_catalog.text, '0', 50
         )`,
        [
          actors.reviewerAB.subjectId,
          actors.reviewerAB.authSessionId,
          orgA,
          candidateFixture.sessionId,
        ],
      ),
      (error) => error?.code === '42501',
      'candidate bearer role cannot invoke the evaluator evidence function',
    );
    const unauthenticatedCall = await gatewayPool.query(
      `SELECT r27.get_submitted_evidence(
         $1::pg_catalog.uuid, $2::pg_catalog.uuid, 'aal1', $3::pg_catalog.uuid,
         $4::pg_catalog.text, '0', 50
       ) AS evidence`,
      [
        actors.reviewerAB.subjectId,
        actors.reviewerAB.authSessionId,
        orgA,
        candidateFixture.sessionId,
      ],
    );
    assert.equal(unauthenticatedCall.rows[0].evidence, null);
    const after = await admin.query(
      `SELECT session.status, session.activated_at, session.submitted_at,
              session.closure_reason, session.scenario_snapshot,
              submission.manifest::pg_catalog.text AS manifest,
              submission.workspace_digest, submission.manifest_digest,
              (SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'sequence', event.sequence::pg_catalog.text,
                   'type', event.event_type,
                   'payload', event.payload
                 ) ORDER BY event.sequence
               ) FROM hirearchy.candidate_session_events AS event
                WHERE event.session_id = session.id) AS events,
              (SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object('path', file.file_path,
                   'content', file.content, 'version', file.version::pg_catalog.text,
                   'digest', file.content_digest) ORDER BY file.file_path
               ) FROM hirearchy.candidate_workspace_files AS file
                WHERE file.session_id = session.id) AS files
         FROM hirearchy.assessment_sessions AS session
         JOIN hirearchy.candidate_session_submissions AS submission
           ON submission.organization_id = session.organization_id
          AND submission.session_id = session.id
        WHERE session.id = $1`,
      [candidateFixture.sessionId],
    );
    assert.deepEqual(
      after.rows,
      before.rows,
      'forged GUC and direct SQL attempts leave frozen evidence unchanged',
    );
  } finally {
    await candidateAdapter.close().catch(() => undefined);
    await authorization.close().catch(() => undefined);
    await Promise.all([
      candidatePool.end().catch(() => undefined),
      gatewayPool.end().catch(() => undefined),
    ]);
    if (insertedReviewerBOrgA) {
      await admin
        .query(
          `DELETE FROM hirearchy.organization_memberships
          WHERE organization_id = $1 AND principal_id = $2`,
          [orgA, actors.reviewerB.principalId],
        )
        .catch(() => undefined);
    }
  }
}
