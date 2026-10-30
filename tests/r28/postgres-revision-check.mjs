import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  createR23PostgresAdapter,
  assertCandidateTokenStorage,
  R23ScopeDenied,
} from '../../database/postgres/r23/adapter.mjs';
import { createR26CandidateAdapter } from '../../database/postgres/r26/adapter.mjs';

const SCENARIO_ID = 'scenario-002-booking-notification-retry';
const SCENARIO_VERSION = '1.0.0';
const SCENARIO_TITLE = 'R2.8 persistent revision history';

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
    credentialEnvelope: Buffer.from('synthetic R2.8 Auth envelope'),
    identity: actor.identity,
    expiresAt: new Date(Date.now() + 3_600_000),
    accessExpiresAt: new Date(Date.now() + 3_000_000),
  });
  await adapter.withActiveSession(
    { handleHash: actor.handleHash },
    async (_session, authz) => authz.consumeCallback(actor.callbackHash),
  );
}

async function readRevision(
  adapter,
  actor,
  organizationId,
  sessionId,
  sequence,
) {
  try {
    return await adapter.withActiveSession(
      { handleHash: actor.handleHash },
      async (_session, authz) => {
        await authz.selectOrganization(actor.identity, organizationId);
        return authz.getFileRevision(
          actor.identity,
          organizationId,
          sessionId,
          sequence,
        );
      },
    );
  } catch (error) {
    if (error instanceof R23ScopeDenied || error?.code === 'SCOPE_DENIED') {
      return null;
    }
    throw error;
  }
}

async function createCandidateSession(
  admin,
  {
    organizationId,
    issuerPrincipalId,
    reviewerPrincipalId,
    label = 'test',
    starterFiles = {
      'README.md': '# R2.8 test fixture\n',
      'src/service.py': 'def calculate():\n    return 1\n',
    },
  },
) {
  const sessionId = `sess_r28_${label}_${randomBytes(8).toString('hex')}`;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hash(token);
  const snapshotText = JSON.stringify({
    scenario: {
      id: SCENARIO_ID,
      version: SCENARIO_VERSION,
      title: SCENARIO_TITLE,
      durationSeconds: 600,
      brief: 'Authoritative candidate revision history.',
    },
    workspaceFiles: starterFiles,
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
    [organizationId, sessionId, tokenHash, 'synthetic-R28-envelope'],
  );

  const assignmentId = randomId('r28-assignment-');
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

  return {
    sessionId,
    token,
    tokenHash,
    assignmentId,
    starterFiles,
    snapshotText,
  };
}

export async function runR28PostgresRevisionChecks({
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

  let candidatePool = new Pool({
    ...connection,
    user: 'app_candidate_gateway',
    password: runtimePassword,
    application_name: 'hirearchy-r28-candidate-revision-check',
    max: 5,
  });

  let gatewayPool = new Pool({
    ...connection,
    user: 'r23_gateway',
    password: runtimePassword,
    application_name: 'hirearchy-r28-gateway-revision-check',
    max: 5,
  });

  let candidateAdapter = createR26CandidateAdapter({
    connectionString: `postgres://app_candidate_gateway:${encodeURIComponent(runtimePassword)}@${connection.host}:${connection.port}/${connection.database ?? 'postgres'}`,
  });

  let authorization = createR23PostgresAdapter({
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

  try {
    // 0. Setup organizations, principals, and memberships
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
      [orgB, actors.reviewerAB.principalId, 'reviewer', 'active', null],
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
    for (const actor of fixtureActors) {
      await createAuthenticatedActor(authorization, actor);
    }

    // Create main candidate session in Org A
    const mainSession = await createCandidateSession(admin, {
      organizationId: orgA,
      issuerPrincipalId: actors.recruiterA.principalId,
      reviewerPrincipalId: actors.reviewerAB.principalId,
      label: 'main',
    });
    const { sessionId, tokenHash } = mainSession;

    // Activate session (sequence 1: SESSION_ACTIVATED)
    const activated = await candidateAdapter.command({
      tokenHash,
      sessionId,
      action: 'activate',
      input: {},
    });
    assert.equal(activated.status, 'ACTIVE');

    // =========================================================================
    // Test 1: Initial valid save creates one correct revision.
    // =========================================================================
    const req1 = randomId('r28-save-1-');
    const content1 = 'def calculate():\n    return 42\n';
    const initialDigest = hash('def calculate():\n    return 1\n');
    const digest1 = hash(content1);

    const save1 = await candidateAdapter.command({
      tokenHash,
      sessionId,
      action: 'save',
      input: {
        requestId: req1,
        path: 'src/service.py',
        content: content1,
        expectedVersion: '0',
      },
    });
    assert.equal(save1.operation?.replayed, false);

    const rev1Rows = await admin.query(
      `SELECT * FROM hirearchy.candidate_file_revisions
       WHERE session_id = $1 AND file_path = 'src/service.py' AND version = 1`,
      [sessionId],
    );
    assert.equal(
      rev1Rows.rowCount,
      1,
      'Test 1: exactly 1 revision row created for version 1',
    );
    const r1 = rev1Rows.rows[0];
    assert.equal(r1.version, '1');
    assert.equal(r1.previous_version, '0');
    assert.equal(r1.content, content1);
    assert.equal(
      r1.content_length,
      String(Buffer.byteLength(content1, 'utf8')),
    );
    assert.equal(r1.content_digest, digest1);
    assert.equal(r1.previous_digest, initialDigest);
    assert.equal(r1.request_id, req1);
    assert.equal(r1.event_sequence, '2');
    assert.equal(r1.content_encoding, 'utf-8');
    assert.equal(r1.organization_id, orgA);

    // =========================================================================
    // Test 2: Second save creates the next version.
    // =========================================================================
    const req2 = randomId('r28-save-2-');
    const content2 = 'def calculate():\n    return 99\n';
    const digest2 = hash(content2);

    const save2 = await candidateAdapter.command({
      tokenHash,
      sessionId,
      action: 'save',
      input: {
        requestId: req2,
        path: 'src/service.py',
        content: content2,
        expectedVersion: '1',
      },
    });
    assert.equal(save2.operation?.replayed, false);

    const rev2Rows = await admin.query(
      `SELECT * FROM hirearchy.candidate_file_revisions
       WHERE session_id = $1 AND file_path = 'src/service.py' ORDER BY version`,
      [sessionId],
    );
    assert.equal(
      rev2Rows.rowCount,
      2,
      'Test 2: exactly 2 revisions for src/service.py',
    );
    const r2 = rev2Rows.rows[1];
    assert.equal(r2.version, '2');
    assert.equal(r2.previous_version, '1');
    assert.equal(r2.content, content2);
    assert.equal(
      r2.content_length,
      String(Buffer.byteLength(content2, 'utf8')),
    );
    assert.equal(r2.content_digest, digest2);
    assert.equal(r2.previous_digest, digest1);
    assert.equal(r2.request_id, req2);
    assert.equal(r2.event_sequence, '3');

    // =========================================================================
    // Test 3: Third save accurately captures deleted/rewritten content.
    // =========================================================================
    const req3 = randomId('r28-save-3-');
    const content3 = '';
    const digest3 = hash(content3);

    const save3 = await candidateAdapter.command({
      tokenHash,
      sessionId,
      action: 'save',
      input: {
        requestId: req3,
        path: 'src/service.py',
        content: content3,
        expectedVersion: '2',
      },
    });
    assert.equal(save3.operation?.replayed, false);

    const rev3Rows = await admin.query(
      `SELECT * FROM hirearchy.candidate_file_revisions
       WHERE session_id = $1 AND file_path = 'src/service.py' AND version = 3`,
      [sessionId],
    );
    assert.equal(
      rev3Rows.rowCount,
      1,
      'Test 3: revision 3 captures empty content',
    );
    const r3 = rev3Rows.rows[0];
    assert.equal(r3.version, '3');
    assert.equal(r3.previous_version, '2');
    assert.equal(r3.content, '');
    assert.equal(r3.content_length, '0');
    assert.equal(r3.content_digest, digest3);
    assert.equal(r3.previous_digest, digest2);
    assert.equal(r3.request_id, req3);
    assert.equal(r3.event_sequence, '4');

    // Save another file: README.md
    const reqReadme = randomId('r28-save-readme-');
    const contentReadme = '# Persistent candidate revision history\n';
    const readmeInitialDigest = hash('# R2.8 test fixture\n');
    const readmeDigest = hash(contentReadme);

    await candidateAdapter.command({
      tokenHash,
      sessionId,
      action: 'save',
      input: {
        requestId: reqReadme,
        path: 'README.md',
        content: contentReadme,
        expectedVersion: '0',
      },
    });

    const readmeRevRows = await admin.query(
      `SELECT * FROM hirearchy.candidate_file_revisions
       WHERE session_id = $1 AND file_path = 'README.md'`,
      [sessionId],
    );
    assert.equal(
      readmeRevRows.rowCount,
      1,
      'Test 3: README.md version 1 created',
    );
    assert.equal(readmeRevRows.rows[0].version, '1');
    assert.equal(readmeRevRows.rows[0].previous_version, '0');
    assert.equal(readmeRevRows.rows[0].content_digest, readmeDigest);
    assert.equal(readmeRevRows.rows[0].previous_digest, readmeInitialDigest);

    // =========================================================================
    // Test 4: Each content digest matches stored bytes.
    // =========================================================================
    const allRevs = await admin.query(
      `SELECT * FROM hirearchy.candidate_file_revisions WHERE session_id = $1`,
      [sessionId],
    );
    assert.equal(
      allRevs.rowCount,
      4,
      'Test 4: exactly 4 revisions stored so far',
    );
    for (const rev of allRevs.rows) {
      assert.equal(
        rev.content_digest,
        hash(rev.content),
        `Digest must match sha256 of stored bytes for file ${rev.file_path} v${rev.version}`,
      );
      assert.equal(
        rev.content_length,
        String(Buffer.byteLength(rev.content, 'utf8')),
        `Content length must match byte length of stored content for file ${rev.file_path} v${rev.version}`,
      );
    }

    // =========================================================================
    // Test 5: Event sequence links to the correct accepted revision.
    // =========================================================================
    const events = await admin.query(
      `SELECT * FROM hirearchy.candidate_session_events
       WHERE session_id = $1 AND event_type = 'WORKSPACE_CHANGED'
       ORDER BY sequence`,
      [sessionId],
    );
    assert.equal(
      events.rowCount,
      4,
      'Test 5: exactly 4 WORKSPACE_CHANGED events',
    );
    for (const evt of events.rows) {
      const match = await admin.query(
        `SELECT * FROM hirearchy.candidate_file_revisions
         WHERE session_id = $1 AND event_sequence = $2`,
        [sessionId, evt.sequence],
      );
      assert.equal(
        match.rowCount,
        1,
        `Test 5: sequence ${evt.sequence} maps to exactly one revision`,
      );
      const rev = match.rows[0];
      assert.equal(rev.request_id, evt.payload.requestId);
      assert.equal(rev.file_path, evt.payload.path);
      assert.equal(rev.version, evt.payload.version);
      assert.equal(rev.previous_version, evt.payload.previousVersion);
      assert.equal(rev.content_digest, evt.payload.digest);
      assert.equal(rev.previous_digest, evt.payload.previousDigest);
    }

    // =========================================================================
    // Test 6: Same save request replay does not duplicate a revision.
    // =========================================================================
    const countBeforeReplay = await admin.query(
      `SELECT count(*) FROM hirearchy.candidate_file_revisions WHERE session_id = $1`,
      [sessionId],
    );
    const replayResult = await candidateAdapter.command({
      tokenHash,
      sessionId,
      action: 'save',
      input: {
        requestId: reqReadme,
        path: 'README.md',
        content: contentReadme,
        expectedVersion: '0',
      },
    });
    assert.equal(
      replayResult.operation?.replayed,
      true,
      'Test 6: command returns replayed: true',
    );
    const countAfterReplay = await admin.query(
      `SELECT count(*) FROM hirearchy.candidate_file_revisions WHERE session_id = $1`,
      [sessionId],
    );
    assert.equal(
      countAfterReplay.rows[0].count,
      countBeforeReplay.rows[0].count,
      'Test 6: replay must not duplicate revision row',
    );

    // =========================================================================
    // Test 7: Changed payload with reused save identity conflicts.
    // =========================================================================
    await assert.rejects(
      candidateAdapter.command({
        tokenHash,
        sessionId,
        action: 'save',
        input: {
          requestId: reqReadme,
          path: 'README.md',
          content: '# Changed payload with same requestId\n',
          expectedVersion: '1',
        },
      }),
      (err) => err?.code === 'REQUEST_CONFLICT' || err?.code === 'R2601',
      'Test 7: reused requestId with different payload must fail with REQUEST_CONFLICT',
    );

    // =========================================================================
    // Test 8: Concurrent conflicting saves preserve one correct winner.
    // =========================================================================
    const req8a = randomId('r28-req-8a-');
    const req8b = randomId('r28-req-8b-');
    const [res8a, res8b] = await Promise.allSettled([
      candidateAdapter.command({
        tokenHash,
        sessionId,
        action: 'save',
        input: {
          requestId: req8a,
          path: 'README.md',
          content: '# Branch A\n',
          expectedVersion: '1',
        },
      }),
      candidateAdapter.command({
        tokenHash,
        sessionId,
        action: 'save',
        input: {
          requestId: req8b,
          path: 'README.md',
          content: '# Branch B\n',
          expectedVersion: '1',
        },
      }),
    ]);
    const fulfilled = [res8a, res8b].filter((r) => r.status === 'fulfilled');
    const rejected = [res8a, res8b].filter((r) => r.status === 'rejected');
    assert.equal(
      fulfilled.length,
      1,
      'Test 8: exactly one concurrent save succeeds',
    );
    assert.equal(
      rejected.length,
      1,
      'Test 8: exactly one concurrent save fails',
    );
    assert.ok(
      rejected[0].reason?.code === 'WORKSPACE_CONFLICT' ||
        rejected[0].reason?.code === 'R2602',
      'Test 8: loser rejected with WORKSPACE_CONFLICT',
    );

    const readmeV2Count = await admin.query(
      `SELECT count(*) FROM hirearchy.candidate_file_revisions
       WHERE session_id = $1 AND file_path = 'README.md' AND version = 2`,
      [sessionId],
    );
    assert.equal(
      readmeV2Count.rows[0].count,
      '1',
      'Test 8: exactly one v2 revision exists',
    );

    // =========================================================================
    // Test 9: Failed transaction leaves no partial revision.
    // =========================================================================
    const failReq = randomId('r28-fail-path-');
    await assert.rejects(
      candidateAdapter.command({
        tokenHash,
        sessionId,
        action: 'save',
        input: {
          requestId: failReq,
          path: '../escaped_path.py',
          content: 'def rogue(): pass\n',
          expectedVersion: '0',
        },
      }),
      (err) => err?.code === 'INVALID_REQUEST' || err?.code === 'R2603',
      'Test 9: invalid path rejected',
    );
    const partialRev = await admin.query(
      `SELECT count(*) FROM hirearchy.candidate_file_revisions
       WHERE session_id = $1 AND request_id = $2`,
      [sessionId, failReq],
    );
    assert.equal(
      partialRev.rows[0].count,
      '0',
      'Test 9: no partial revision inserted',
    );
    const partialOp = await admin.query(
      `SELECT count(*) FROM hirearchy.candidate_session_operations
       WHERE session_id = $1 AND request_id = $2`,
      [sessionId, failReq],
    );
    assert.equal(
      partialOp.rows[0].count,
      '0',
      'Test 9: no partial operation inserted',
    );

    // =========================================================================
    // Test 10: Database dependency failure does not acknowledge an uncommitted save.
    // =========================================================================
    const failClient = await candidatePool.connect();
    try {
      await failClient.query('BEGIN');
      await assert.rejects(
        failClient.query(
          `INSERT INTO hirearchy.candidate_file_revisions (
             organization_id, session_id, file_path, version,
             request_id, event_sequence, accepted_at,
             content_encoding, content, content_length,
             content_digest, previous_version, previous_digest
           ) VALUES ($1, $2, 'src/service.py', 10, 'uncomm-req', 99, now(), 'utf-8', 'x', 1, $3, 0, $4)`,
          [orgA, sessionId, hash('x'), initialDigest],
        ),
        (err) => err?.code === '42501' || err?.code === '23514',
        'Test 10: direct uncommitted insert rejected',
      );
      await failClient.query('ROLLBACK');
    } finally {
      failClient.release();
    }

    // =========================================================================
    // Test 11: Submission freezes the last accepted work.
    // =========================================================================
    const preSubmitView = await candidateAdapter.command({
      tokenHash,
      sessionId,
      action: 'read',
      input: {},
    });
    const submitReq = randomId('r28-submit-');
    const submitResult = await candidateAdapter.command({
      tokenHash,
      sessionId,
      action: 'submit',
      input: {
        requestId: submitReq,
        expectedWorkspaceDigest: preSubmitView.workspaceDigest,
      },
    });
    assert.equal(
      submitResult.status,
      'SUBMITTED',
      'Test 11: session submitted',
    );

    const subQuery = await admin.query(
      `SELECT * FROM hirearchy.candidate_session_submissions WHERE session_id = $1`,
      [sessionId],
    );
    assert.equal(subQuery.rowCount, 1, 'Test 11: submission row exists');
    const manifest = subQuery.rows[0].manifest;
    const serviceManifest = manifest.find((f) => f.path === 'src/service.py');
    const readmeManifest = manifest.find((f) => f.path === 'README.md');
    assert.equal(serviceManifest.version, '3');
    assert.equal(serviceManifest.content, '');
    assert.equal(readmeManifest.version, '2');

    // =========================================================================
    // Test 12: Save after finality is denied.
    // =========================================================================
    await assert.rejects(
      candidateAdapter.command({
        tokenHash,
        sessionId,
        action: 'save',
        input: {
          requestId: randomId('r28-post-sub-'),
          path: 'README.md',
          content: '# Forbidden post-submission\n',
          expectedVersion: '2',
        },
      }),
      (err) => err?.code === 'SESSION_CONFLICT' || err?.code === 'R2605',
      'Test 12: save after submission rejected with SESSION_CONFLICT',
    );

    // =========================================================================
    // Test 13: Revision mutation is denied.
    // =========================================================================
    await assert.rejects(
      admin.query(
        `UPDATE hirearchy.candidate_file_revisions SET content = 'tampered' WHERE session_id = $1`,
        [sessionId],
      ),
      (err) => err?.code === '23514',
      'Test 13: admin mutation rejected by candidate_file_revisions_immutable trigger (23514)',
    );
    await assert.rejects(
      candidatePool.query(
        `UPDATE hirearchy.candidate_file_revisions SET content = 'tampered' WHERE session_id = $1`,
        [sessionId],
      ),
      (err) => err?.code === '42501',
      'Test 13: candidate role mutation rejected with 42501',
    );
    await assert.rejects(
      gatewayPool.query(
        `UPDATE hirearchy.candidate_file_revisions SET content = 'tampered' WHERE session_id = $1`,
        [sessionId],
      ),
      (err) => err?.code === '42501',
      'Test 13: gateway role mutation rejected with 42501',
    );

    // =========================================================================
    // Test 14: Revision deletion is denied.
    // =========================================================================
    await assert.rejects(
      admin.query(
        `DELETE FROM hirearchy.candidate_file_revisions WHERE session_id = $1`,
        [sessionId],
      ),
      (err) => err?.code === '23514',
      'Test 14: admin deletion rejected by candidate_file_revisions_immutable trigger (23514)',
    );
    await assert.rejects(
      candidatePool.query(
        `DELETE FROM hirearchy.candidate_file_revisions WHERE session_id = $1`,
        [sessionId],
      ),
      (err) => err?.code === '42501',
      'Test 14: candidate role deletion rejected with 42501',
    );
    await assert.rejects(
      gatewayPool.query(
        `DELETE FROM hirearchy.candidate_file_revisions WHERE session_id = $1`,
        [sessionId],
      ),
      (err) => err?.code === '42501',
      'Test 14: gateway role deletion rejected with 42501',
    );

    // =========================================================================
    // Evaluator Revision Retrieval Checks for Main Session (ReviewerAB assigned)
    // =========================================================================
    const rev1Evaluator = await readRevision(
      authorization,
      actors.reviewerAB,
      orgA,
      sessionId,
      '2',
    );
    assert.ok(rev1Evaluator, 'Evaluator can read revision sequence 2');
    assert.equal(rev1Evaluator.availability, 'available');
    assert.equal(
      rev1Evaluator.provenance,
      'hirearchy.candidate_file_revisions',
    );
    assert.equal(rev1Evaluator.filePath, 'src/service.py');
    assert.equal(rev1Evaluator.version, '1');
    assert.equal(rev1Evaluator.previousVersion, '0');
    assert.equal(rev1Evaluator.content, content1);
    assert.equal(
      rev1Evaluator.contentLength,
      Buffer.byteLength(content1, 'utf8'),
    );
    assert.equal(rev1Evaluator.contentDigest, digest1);
    assert.equal(rev1Evaluator.previousDigest, initialDigest);
    assert.equal(
      rev1Evaluator.previousContent,
      'def calculate():\n    return 1\n',
    );
    assert.equal(
      rev1Evaluator.starterContent,
      'def calculate():\n    return 1\n',
    );
    assert.equal(rev1Evaluator.submittedContent, '');
    assert.equal(rev1Evaluator.isSubmitted, false);

    const rev2Evaluator = await readRevision(
      authorization,
      actors.reviewerAB,
      orgA,
      sessionId,
      '3',
    );
    assert.ok(rev2Evaluator);
    assert.equal(rev2Evaluator.version, '2');
    assert.equal(rev2Evaluator.previousVersion, '1');
    assert.equal(rev2Evaluator.content, content2);
    assert.equal(rev2Evaluator.previousContent, content1);
    assert.equal(rev2Evaluator.isSubmitted, false);

    const rev3Evaluator = await readRevision(
      authorization,
      actors.reviewerAB,
      orgA,
      sessionId,
      '4',
    );
    assert.ok(rev3Evaluator);
    assert.equal(rev3Evaluator.version, '3');
    assert.equal(rev3Evaluator.previousVersion, '2');
    assert.equal(rev3Evaluator.content, '');
    assert.equal(rev3Evaluator.previousContent, content2);
    assert.equal(
      rev3Evaluator.isSubmitted,
      true,
      'Test 11/Evaluator: version 3 is final submitted version',
    );

    // =========================================================================
    // Test 15: Cross-session revision access is denied.
    // =========================================================================
    const session2 = await createCandidateSession(admin, {
      organizationId: orgA,
      issuerPrincipalId: actors.recruiterA.principalId,
      reviewerPrincipalId: actors.reviewerA.principalId, // only reviewerA!
      label: 'session2',
    });
    await candidateAdapter.command({
      tokenHash: session2.tokenHash,
      sessionId: session2.sessionId,
      action: 'activate',
      input: {},
    });
    await candidateAdapter.command({
      tokenHash: session2.tokenHash,
      sessionId: session2.sessionId,
      action: 'save',
      input: {
        requestId: randomId('s2-save-'),
        path: 'src/service.py',
        content: 'def s2(): return 2\n',
        expectedVersion: '0',
      },
    });
    const s2View = await candidateAdapter.command({
      tokenHash: session2.tokenHash,
      sessionId: session2.sessionId,
      action: 'read',
      input: {},
    });
    await candidateAdapter.command({
      tokenHash: session2.tokenHash,
      sessionId: session2.sessionId,
      action: 'submit',
      input: {
        requestId: randomId('s2-sub-'),
        expectedWorkspaceDigest: s2View.workspaceDigest,
      },
    });

    // ReviewerAB is NOT assigned to session2 -> must return null
    const crossSessRev = await readRevision(
      authorization,
      actors.reviewerAB,
      orgA,
      session2.sessionId,
      '2',
    );
    assert.equal(
      crossSessRev,
      null,
      'Test 15: unassigned reviewer cannot read session2 revisions',
    );

    // ReviewerA IS assigned to session2 -> can read
    const assignedRev = await readRevision(
      authorization,
      actors.reviewerA,
      orgA,
      session2.sessionId,
      '2',
    );
    assert.ok(
      assignedRev,
      'Test 15: assigned reviewerA can read session2 revisions',
    );
    assert.equal(assignedRev.availability, 'available');

    // =========================================================================
    // Test 16: Cross-organization revision access is denied.
    // =========================================================================
    const sessionB = await createCandidateSession(admin, {
      organizationId: orgB,
      issuerPrincipalId: actors.recruiterB.principalId,
      reviewerPrincipalId: actors.reviewerB.principalId,
      label: 'orgB',
    });
    await candidateAdapter.command({
      tokenHash: sessionB.tokenHash,
      sessionId: sessionB.sessionId,
      action: 'activate',
      input: {},
    });
    await candidateAdapter.command({
      tokenHash: sessionB.tokenHash,
      sessionId: sessionB.sessionId,
      action: 'save',
      input: {
        requestId: randomId('sb-save-'),
        path: 'src/service.py',
        content: 'def orgB(): pass\n',
        expectedVersion: '0',
      },
    });
    const sbView = await candidateAdapter.command({
      tokenHash: sessionB.tokenHash,
      sessionId: sessionB.sessionId,
      action: 'read',
      input: {},
    });
    await candidateAdapter.command({
      tokenHash: sessionB.tokenHash,
      sessionId: sessionB.sessionId,
      action: 'submit',
      input: {
        requestId: randomId('sb-sub-'),
        expectedWorkspaceDigest: sbView.workspaceDigest,
      },
    });

    // ReviewerA (only member in Org A) tries reading revision in Org B
    const crossOrgRev = await readRevision(
      authorization,
      actors.reviewerA,
      orgB,
      sessionB.sessionId,
      '2',
    );
    assert.equal(
      crossOrgRev,
      null,
      'Test 16: reviewerA denied cross-org revision retrieval',
    );

    // ReviewerAB (member of Org A) querying Org B's session under Org A returns null
    const crossOrgRevSessionId = await readRevision(
      authorization,
      actors.reviewerAB,
      orgA,
      sessionB.sessionId,
      '2',
    );
    assert.equal(
      crossOrgRevSessionId,
      null,
      'Test 16: foreign organization session IDs return null',
    );

    // =========================================================================
    // Test 17: Unassigned reviewer retrieval is denied.
    // =========================================================================
    // ReviewerB has active membership in Org A, but was NOT assigned to mainSession
    const unassignedRev = await readRevision(
      authorization,
      actors.reviewerB,
      orgA,
      sessionId,
      '2',
    );
    assert.equal(
      unassignedRev,
      null,
      'Test 17: unassigned reviewer in same org denied retrieval',
    );

    // =========================================================================
    // Test 18: Revoked assignment blocks new reads.
    // =========================================================================
    const session4 = await createCandidateSession(admin, {
      organizationId: orgA,
      issuerPrincipalId: actors.recruiterA.principalId,
      reviewerPrincipalId: actors.reviewerAB.principalId,
      label: 'session4',
    });
    await candidateAdapter.command({
      tokenHash: session4.tokenHash,
      sessionId: session4.sessionId,
      action: 'activate',
      input: {},
    });
    await candidateAdapter.command({
      tokenHash: session4.tokenHash,
      sessionId: session4.sessionId,
      action: 'save',
      input: {
        requestId: randomId('s4-save-'),
        path: 'src/service.py',
        content: 'def s4(): return 4\n',
        expectedVersion: '0',
      },
    });
    const s4View = await candidateAdapter.command({
      tokenHash: session4.tokenHash,
      sessionId: session4.sessionId,
      action: 'read',
      input: {},
    });
    await candidateAdapter.command({
      tokenHash: session4.tokenHash,
      sessionId: session4.sessionId,
      action: 'submit',
      input: {
        requestId: randomId('s4-sub-'),
        expectedWorkspaceDigest: s4View.workspaceDigest,
      },
    });

    const s4Before = await readRevision(
      authorization,
      actors.reviewerAB,
      orgA,
      session4.sessionId,
      '2',
    );
    assert.ok(s4Before, 'Test 18: read succeeds before revocation');
    assert.equal(s4Before.availability, 'available');

    // Admin revokes assignment
    await admin.query(
      `UPDATE hirearchy.reviewer_assignments
       SET revoked_at = pg_catalog.clock_timestamp()
       WHERE session_id = $1 AND reviewer_principal_id = $2`,
      [session4.sessionId, actors.reviewerAB.principalId],
    );

    const s4After = await readRevision(
      authorization,
      actors.reviewerAB,
      orgA,
      session4.sessionId,
      '2',
    );
    assert.equal(
      s4After,
      null,
      'Test 18: read returns null after assignment revocation',
    );

    // =========================================================================
    // Test 19: Revoked membership blocks new reads.
    // =========================================================================
    const revokedMemRev = await readRevision(
      authorization,
      actors.reviewerRevoked,
      orgA,
      sessionId,
      '2',
    );
    assert.equal(revokedMemRev, null, 'Test 19: revoked reviewer denied');

    // Dynamically revoke reviewerA
    await admin.query(
      `UPDATE hirearchy.organization_memberships
       SET status = 'revoked', revoked_at = pg_catalog.clock_timestamp()
       WHERE organization_id = $1 AND principal_id = $2`,
      [orgA, actors.reviewerA.principalId],
    );
    const dynamicRev = await readRevision(
      authorization,
      actors.reviewerA,
      orgA,
      session2.sessionId,
      '2',
    );
    assert.equal(
      dynamicRev,
      null,
      'Test 19: read returns null after membership revocation',
    );

    // =========================================================================
    // Test 20: Historical pre-R2.8 missing content stays marked unavailable.
    // =========================================================================
    const histSessionId = `sess_r28_hist_${randomBytes(8).toString('hex')}`;
    const histStarterContent = 'def hist_starter():\n    return True\n';
    const histSubmittedContent = 'def hist_submitted():\n    return True\n';
    const histSnapshot = JSON.stringify({
      scenario: {
        id: SCENARIO_ID,
        version: SCENARIO_VERSION,
        title: SCENARIO_TITLE,
        durationSeconds: 600,
      },
      workspaceFiles: {
        'src/service.py': histStarterContent,
      },
    });

    await admin.query(
      `INSERT INTO hirearchy.assessment_sessions (
         id, organization_id, issuer_principal_id, scenario_id,
         scenario_version, scenario_title, status, created_at, activated_at,
         submitted_at, duration_seconds, closure_reason, scenario_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, 'SUBMITTED', now() - interval '10 min', now() - interval '8 min', now() - interval '1 min', 600, 'candidate_submission', $7)`,
      [
        histSessionId,
        orgA,
        actors.recruiterA.principalId,
        SCENARIO_ID,
        SCENARIO_VERSION,
        SCENARIO_TITLE,
        histSnapshot,
      ],
    );

    await admin.query(
      `INSERT INTO hirearchy.reviewer_assignments (
         id, organization_id, session_id, reviewer_principal_id,
         assigned_by_principal_id, assigned_at, version
       ) VALUES ($1, $2, $3, $4, $5, now() - interval '9 min', 1)`,
      [
        randomId('hist-assign-'),
        orgA,
        histSessionId,
        actors.reviewerAB.principalId,
        actors.recruiterA.principalId,
      ],
    );

    await admin.query(
      `INSERT INTO hirearchy.candidate_session_events (
         organization_id, session_id, sequence, event_type, happened_at, payload
       ) VALUES
         ($1, $2, 1, 'SESSION_ACTIVATED', now() - interval '8 min', jsonb_build_object('scenarioDigest', $3::text)),
         ($1, $2, 2, 'WORKSPACE_CHANGED', now() - interval '5 min', jsonb_build_object(
           'requestId', 'hist-req-1',
           'path', 'src/service.py',
           'previousVersion', '0',
           'version', '1',
           'previousDigest', $4::text,
           'digest', $5::text
         )),
         ($1, $2, 3, 'SESSION_SUBMITTED', now() - interval '1 min', jsonb_build_object(
           'closureReason', 'candidate_submission',
           'workspaceDigest', $6::text,
           'manifestDigest', $7::text
         ))`,
      [
        orgA,
        histSessionId,
        hash(histSnapshot),
        hash(histStarterContent),
        hash(histSubmittedContent),
        hash('hist-ws'),
        hash('hist-man'),
      ],
    );

    await admin.query(
      `INSERT INTO hirearchy.candidate_session_submissions (
         organization_id, session_id, submitted_at, closure_reason,
         workspace_digest, manifest_digest, manifest
       ) VALUES ($1, $2, now() - interval '1 min', 'candidate_submission', $3, $4, $5::jsonb)`,
      [
        orgA,
        histSessionId,
        hash('hist-ws'),
        hash('hist-man'),
        JSON.stringify([
          {
            path: 'src/service.py',
            content: histSubmittedContent,
            version: '1',
            digest: hash(histSubmittedContent),
          },
        ]),
      ],
    );

    // Note: Absolutely NO candidate_file_revisions rows inserted for histSessionId
    const histRev = await readRevision(
      authorization,
      actors.reviewerAB,
      orgA,
      histSessionId,
      '2',
    );
    assert.ok(
      histRev,
      'Test 20: historical revision query returns a revision object',
    );
    assert.equal(
      histRev.availability,
      'unavailable',
      'Test 20: availability is unavailable',
    );
    assert.equal(histRev.content, null, 'Test 20: content is null');
    assert.equal(histRev.contentLength, 0, 'Test 20: contentLength is 0');
    assert.equal(
      histRev.provenance,
      'hirearchy.candidate_session_events',
      'Test 20: provenance is events table',
    );
    assert.deepEqual(
      histRev.limitations,
      [
        'Intermediate file contents were not retained; save events provide metadata only.',
      ],
      'Test 20: limitation note present',
    );
    assert.equal(histRev.filePath, 'src/service.py');
    assert.equal(histRev.version, '1');
    assert.equal(histRev.previousVersion, '0');
    assert.equal(histRev.requestId, 'hist-req-1');
    assert.equal(histRev.eventSequence, '2');
    assert.equal(histRev.previousContent, histStarterContent);
    assert.equal(histRev.starterContent, histStarterContent);
    assert.equal(histRev.submittedContent, histSubmittedContent);
    assert.equal(histRev.isSubmitted, true);

    // =========================================================================
    // Test 21: Storage capacity and oversized content fail safely.
    // =========================================================================
    // 21a: Single file content > 100,000 bytes
    const capSession = await createCandidateSession(admin, {
      organizationId: orgA,
      issuerPrincipalId: actors.recruiterA.principalId,
      reviewerPrincipalId: actors.reviewerAB.principalId,
      label: 'cap',
    });
    await candidateAdapter.command({
      tokenHash: capSession.tokenHash,
      sessionId: capSession.sessionId,
      action: 'activate',
      input: {},
    });

    await assert.rejects(
      candidateAdapter.command({
        tokenHash: capSession.tokenHash,
        sessionId: capSession.sessionId,
        action: 'save',
        input: {
          requestId: randomId('cap-large-'),
          path: 'src/service.py',
          content: 'x'.repeat(100001),
          expectedVersion: '0',
        },
      }),
      (err) => err?.code === 'PAYLOAD_TOO_LARGE' || err?.code === 'R2609',
      'Test 21a: single file exceeding 100,000 bytes fails with PAYLOAD_TOO_LARGE',
    );

    // 21b: Cumulative revision storage exceeding 10MB (10,485,760 bytes)
    // We populate capSession with revisions totaling ~10,485,720 bytes.
    // Each revision is 99,864 bytes. 105 revisions * 99,864 = 10,485,720 bytes.
    const chunkBytes = 99864;
    const chunkText = 'y'.repeat(chunkBytes);
    const chunkDigest = hash(chunkText);

    // Generate batch insert for operations, events, and revisions
    await admin.query(
      `WITH batch AS (
         SELECT i,
                'cumul-req-' || i AS req_id,
                i + 1 AS seq,
                i AS ver,
                i - 1 AS prev_ver,
                CASE WHEN i = 1 THEN $4 ELSE $5 END AS prev_dig
         FROM generate_series(1, 105) AS i
       ), ops AS (
         INSERT INTO hirearchy.candidate_session_operations (
           organization_id, session_id, request_id, action, intent_digest, result, accepted_at
         )
         SELECT $1, $2, batch.req_id, 'save', $5, '{}'::jsonb, now()
         FROM batch
       ), evts AS (
         INSERT INTO hirearchy.candidate_session_events (
           organization_id, session_id, sequence, event_type, happened_at, payload
         )
         SELECT $1, $2, batch.seq, 'WORKSPACE_CHANGED', now(),
           jsonb_build_object('path', 'src/service.py', 'version', batch.ver::text, 'previousVersion', batch.prev_ver::text, 'digest', $5, 'previousDigest', batch.prev_dig, 'requestId', batch.req_id)
         FROM batch
       )
       INSERT INTO hirearchy.candidate_file_revisions (
         organization_id, session_id, file_path, version,
         request_id, event_sequence, accepted_at,
         content_encoding, content, content_length,
         content_digest, previous_version, previous_digest
       )
       SELECT $1, $2, 'src/service.py', batch.ver,
         batch.req_id, batch.seq, now(),
         'utf-8', $3, $6,
         $5, batch.prev_ver, batch.prev_dig
       FROM batch`,
      [
        orgA,
        capSession.sessionId,
        chunkText,
        initialDigest,
        chunkDigest,
        chunkBytes,
      ],
    );

    // Update candidate_workspace_files to version 105 so expectedVersion = 105
    await admin.query(
      `UPDATE hirearchy.candidate_workspace_files
       SET version = 105, content = $1, content_digest = $2
       WHERE session_id = $3 AND file_path = 'src/service.py'`,
      [chunkText, chunkDigest, capSession.sessionId],
    );

    // Candidate attempts a save of 100 bytes:
    // 10,485,720 + 100 = 10,485,820 > 10,485,760 bytes limit!
    await assert.rejects(
      candidateAdapter.command({
        tokenHash: capSession.tokenHash,
        sessionId: capSession.sessionId,
        action: 'save',
        input: {
          requestId: randomId('cap-overflow-'),
          path: 'src/service.py',
          content: 'z'.repeat(100),
          expectedVersion: '105',
        },
      }),
      (err) => err?.code === 'PAYLOAD_TOO_LARGE' || err?.code === 'R2609',
      'Test 21b: cumulative revisions exceeding 10MB fails with PAYLOAD_TOO_LARGE',
    );

    // =========================================================================
    // Test 22: Restart preserves all recorded revisions.
    // =========================================================================
    await Promise.all([
      candidatePool.end().catch(() => undefined),
      gatewayPool.end().catch(() => undefined),
      candidateAdapter.close().catch(() => undefined),
      authorization.close().catch(() => undefined),
    ]);

    // Fresh reconnect
    const freshGatewayPool = new Pool({
      ...connection,
      user: 'r23_gateway',
      password: runtimePassword,
      application_name: 'hirearchy-r28-fresh-restart-check',
      max: 2,
    });
    const freshAuth = createR23PostgresAdapter({
      pool: freshGatewayPool,
      assertVerifiedIdentity,
    });

    try {
      const persistedRev1 = await readRevision(
        freshAuth,
        actors.reviewerAB,
        orgA,
        sessionId,
        '2',
      );
      assert.ok(persistedRev1, 'Test 22: revision 1 survived restart');
      assert.equal(persistedRev1.availability, 'available');
      assert.equal(persistedRev1.version, '1');
      assert.equal(persistedRev1.content, content1);
      assert.equal(persistedRev1.contentDigest, digest1);
      assert.equal(persistedRev1.isSubmitted, false);

      const persistedRev3 = await readRevision(
        freshAuth,
        actors.reviewerAB,
        orgA,
        sessionId,
        '4',
      );
      assert.ok(persistedRev3, 'Test 22: revision 3 survived restart');
      assert.equal(persistedRev3.availability, 'available');
      assert.equal(persistedRev3.version, '3');
      assert.equal(persistedRev3.content, '');
      assert.equal(persistedRev3.contentDigest, digest3);
      assert.equal(persistedRev3.isSubmitted, true);
    } finally {
      await freshAuth.close().catch(() => undefined);
      await freshGatewayPool.end().catch(() => undefined);
    }
  } finally {
    await candidateAdapter.close().catch(() => undefined);
    await authorization.close().catch(() => undefined);
    await Promise.all([
      candidatePool.end().catch(() => undefined),
      gatewayPool.end().catch(() => undefined),
    ]);
  }
}
