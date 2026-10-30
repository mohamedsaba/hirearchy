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
const SCENARIO_TITLE = 'R2.9 structured evaluator observations';

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
    credentialEnvelope: Buffer.from('synthetic R2.9 Auth envelope'),
    identity: actor.identity,
    expiresAt: new Date(Date.now() + 3_600_000),
    accessExpiresAt: new Date(Date.now() + 3_000_000),
  });
  await adapter.withActiveSession(
    { handleHash: actor.handleHash },
    async (_session, authz) => authz.consumeCallback(actor.callbackHash),
  );
}

async function createCandidateSession(
  admin,
  {
    organizationId,
    issuerPrincipalId,
    reviewerPrincipalIds = [],
    label = 'test',
    starterFiles = {
      'README.md': '# R2.9 test fixture\n',
      'src/service.py': 'def calculate():\n    return 1\n',
    },
  },
) {
  const sessionId = `sess_r29_${label}_${randomBytes(8).toString('hex')}`;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hash(token);
  const snapshotText = JSON.stringify({
    scenario: {
      id: SCENARIO_ID,
      version: SCENARIO_VERSION,
      title: SCENARIO_TITLE,
      durationSeconds: 600,
      brief: 'Structured evaluator observations test scenario.',
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
    [organizationId, sessionId, tokenHash, 'synthetic-R29-envelope'],
  );

  for (const reviewerPrincipalId of reviewerPrincipalIds) {
    const assignmentId = randomId('r29-assignment-');
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
  }

  return { sessionId, tokenHash };
}

async function createObservation(
  adapter,
  actor,
  organizationId,
  sessionId,
  input,
) {
  return adapter.withActiveSession(
    { handleHash: actor.handleHash },
    async (_session, authz) => {
      await authz.selectOrganization(actor.identity, organizationId);
      return authz.createObservation(
        actor.identity,
        organizationId,
        sessionId,
        input,
      );
    },
  );
}

async function updateObservation(
  adapter,
  actor,
  organizationId,
  sessionId,
  observationId,
  input,
) {
  return adapter.withActiveSession(
    { handleHash: actor.handleHash },
    async (_session, authz) => {
      await authz.selectOrganization(actor.identity, organizationId);
      return authz.updateObservation(
        actor.identity,
        organizationId,
        sessionId,
        observationId,
        input,
      );
    },
  );
}

async function listObservations(adapter, actor, organizationId, sessionId) {
  return adapter.withActiveSession(
    { handleHash: actor.handleHash },
    async (_session, authz) => {
      await authz.selectOrganization(actor.identity, organizationId);
      return authz.listObservations(actor.identity, organizationId, sessionId);
    },
  );
}

async function getObservation(
  adapter,
  actor,
  organizationId,
  sessionId,
  observationId,
) {
  return adapter.withActiveSession(
    { handleHash: actor.handleHash },
    async (_session, authz) => {
      await authz.selectOrganization(actor.identity, organizationId);
      return authz.getObservation(
        actor.identity,
        organizationId,
        sessionId,
        observationId,
      );
    },
  );
}

export async function runR29PostgresObservationChecks({
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
    application_name: 'hirearchy-r29-candidate-check',
    max: 5,
  });

  let gatewayPool = new Pool({
    ...connection,
    user: 'r23_gateway',
    password: runtimePassword,
    application_name: 'hirearchy-r29-gateway-check',
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
    reviewerB: makeActor(),
    reviewerRevoked: makeActor(),
    adminA: makeActor(),
    recruiterB: makeActor(),
    reviewerInOrgB: makeActor(),
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
      [orgB, actors.reviewerInOrgB.principalId, 'reviewer', 'active', null],
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

    // 1. Create main submitted candidate session in Org A (Reviewer A & B assigned)
    const mainSession = await createCandidateSession(admin, {
      organizationId: orgA,
      issuerPrincipalId: actors.recruiterA.principalId,
      reviewerPrincipalIds: [
        actors.reviewerA.principalId,
        actors.reviewerB.principalId,
      ],
      label: 'main',
    });
    const { sessionId, tokenHash } = mainSession;

    // Activate session (event sequence 1: SESSION_ACTIVATED)
    const activated = await candidateAdapter.command({
      tokenHash,
      sessionId,
      action: 'activate',
      input: {},
    });
    assert.equal(activated.status, 'ACTIVE');

    // Save file (event sequence 2: WORKSPACE_CHANGED, revision 1)
    const req1 = randomId('r29-save-1-');
    const content1 = 'def calculate():\n    return 42\n';
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
    assert.equal(save1.status, 'ACTIVE');

    // Submit session (event sequence 3: SESSION_SUBMITTED)
    const preSubmitView = await candidateAdapter.command({
      tokenHash,
      sessionId,
      action: 'read',
      input: {},
    });
    const submitReq = randomId('r29-submit-');
    const submitResult = await candidateAdapter.command({
      tokenHash,
      sessionId,
      action: 'submit',
      input: {
        requestId: submitReq,
        expectedWorkspaceDigest: preSubmitView.workspaceDigest,
      },
    });
    assert.equal(submitResult.status, 'SUBMITTED');

    // Query events from DB to get authoritative digests
    const { rows: events } = await admin.query(
      `SELECT sequence, event_type, payload
       FROM hirearchy.candidate_session_events
       WHERE session_id = $1
       ORDER BY sequence ASC`,
      [sessionId],
    );
    assert.equal(events.length, 3);
    const event1 = events[0]; // SESSION_ACTIVATED
    const event2 = events[1]; // WORKSPACE_CHANGED
    const event3 = events[2]; // SESSION_SUBMITTED
    assert.equal(event3.event_type, 'SESSION_SUBMITTED');

    const event1Digest = event1.payload.scenarioDigest;
    assert.match(event1Digest, /^[0-9a-f]{64}$/);

    const event2Digest = event2.payload.digest;
    assert.equal(event2Digest, digest1);

    // Also create second session in Org A (for cross-session checks)
    const sessionA2 = await createCandidateSession(admin, {
      organizationId: orgA,
      issuerPrincipalId: actors.recruiterA.principalId,
      reviewerPrincipalIds: [actors.reviewerA.principalId],
      label: 'a2',
    });
    await candidateAdapter.command({
      tokenHash: sessionA2.tokenHash,
      sessionId: sessionA2.sessionId,
      action: 'activate',
      input: {},
    });
    const viewA2 = await candidateAdapter.command({
      tokenHash: sessionA2.tokenHash,
      sessionId: sessionA2.sessionId,
      action: 'read',
      input: {},
    });
    await candidateAdapter.command({
      tokenHash: sessionA2.tokenHash,
      sessionId: sessionA2.sessionId,
      action: 'submit',
      input: {
        requestId: randomId('s2-sub-'),
        expectedWorkspaceDigest: viewA2.workspaceDigest,
      },
    });

    // Also create session in Org B (for cross-org checks)
    const sessionB = await createCandidateSession(admin, {
      organizationId: orgB,
      issuerPrincipalId: actors.recruiterB.principalId,
      reviewerPrincipalIds: [actors.reviewerInOrgB.principalId],
      label: 'b',
    });
    await candidateAdapter.command({
      tokenHash: sessionB.tokenHash,
      sessionId: sessionB.sessionId,
      action: 'activate',
      input: {},
    });
    const viewB = await candidateAdapter.command({
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
        expectedWorkspaceDigest: viewB.workspaceDigest,
      },
    });

    // =========================================================================
    // Check 1: Reviewer can create observation linked to timeline event
    // =========================================================================
    const obsTimeline = await createObservation(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      {
        evidenceSourceType: 'timeline_event',
        eventSequence: '1',
        evidenceDigest: event1Digest,
        body: 'Candidate activated the session on time.',
      },
    );

    assert.ok(obsTimeline.id, 'Observation ID generated');
    assert.match(
      obsTimeline.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    assert.equal(obsTimeline.organizationId, orgA);
    assert.equal(obsTimeline.sessionId, sessionId);
    assert.equal(obsTimeline.authorPrincipalId, actors.reviewerA.principalId);
    assert.equal(obsTimeline.evidenceSourceType, 'timeline_event');
    assert.equal(obsTimeline.eventSequence, '1');
    assert.equal(obsTimeline.filePath, null);
    assert.equal(obsTimeline.fileVersion, null);
    assert.equal(obsTimeline.evidenceDigest, event1Digest);
    assert.equal(obsTimeline.body, 'Candidate activated the session on time.');
    assert.equal(obsTimeline.version, 1);
    assert.equal(obsTimeline.visibility, 'private');
    assert.ok(obsTimeline.createdAt);
    assert.ok(obsTimeline.updatedAt);

    // =========================================================================
    // Check 2: Reviewer can create observation linked to file revision
    // =========================================================================
    const obsRevision = await createObservation(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      {
        evidenceSourceType: 'file_revision',
        eventSequence: '2',
        filePath: 'src/service.py',
        fileVersion: '1',
        evidenceDigest: digest1,
        body: 'Clean implementation of calculate() with proper return value.',
      },
    );

    assert.ok(obsRevision.id);
    assert.equal(obsRevision.organizationId, orgA);
    assert.equal(obsRevision.sessionId, sessionId);
    assert.equal(obsRevision.authorPrincipalId, actors.reviewerA.principalId);
    assert.equal(obsRevision.evidenceSourceType, 'file_revision');
    assert.equal(obsRevision.eventSequence, '2');
    assert.equal(obsRevision.filePath, 'src/service.py');
    assert.equal(obsRevision.fileVersion, '1');
    assert.equal(obsRevision.evidenceDigest, digest1);
    assert.equal(
      obsRevision.body,
      'Clean implementation of calculate() with proper return value.',
    );
    assert.equal(obsRevision.version, 1);
    assert.equal(obsRevision.visibility, 'private');

    // =========================================================================
    // Check 3: Invented event sequence is rejected
    // =========================================================================
    await assert.rejects(
      createObservation(authorization, actors.reviewerA, orgA, sessionId, {
        evidenceSourceType: 'timeline_event',
        eventSequence: '9999',
        evidenceDigest: hash('invented'),
        body: 'Observation on non-existent event.',
      }),
      (err) =>
        err?.code === 'R2902' ||
        err?.code === 'INVALID_ANCHOR' ||
        err?.sqlState === 'R2902' ||
        err?.message?.includes('not found') ||
        err?.message?.includes('R2902'),
      'Invented event sequence must be rejected with R2902',
    );

    // =========================================================================
    // Check 4: Invented file revision or invalid content digest is rejected
    // =========================================================================
    // 4a. Non-existent file path
    await assert.rejects(
      createObservation(authorization, actors.reviewerA, orgA, sessionId, {
        evidenceSourceType: 'file_revision',
        eventSequence: '2',
        filePath: 'nonexistent.py',
        fileVersion: '1',
        evidenceDigest: digest1,
        body: 'Observation on fake path.',
      }),
      (err) =>
        err?.code === 'R2902' ||
        err?.code === 'INVALID_ANCHOR' ||
        err?.sqlState === 'R2902',
      'Invented file path must be rejected with R2902',
    );

    // 4b. Non-existent file version
    await assert.rejects(
      createObservation(authorization, actors.reviewerA, orgA, sessionId, {
        evidenceSourceType: 'file_revision',
        eventSequence: '2',
        filePath: 'src/service.py',
        fileVersion: '99',
        evidenceDigest: digest1,
        body: 'Observation on fake file version.',
      }),
      (err) =>
        err?.code === 'R2902' ||
        err?.code === 'INVALID_ANCHOR' ||
        err?.sqlState === 'R2902',
      'Invented file version must be rejected with R2902',
    );

    // 4c. Digest mismatch
    const badDigest =
      '0000000000000000000000000000000000000000000000000000000000000000';
    await assert.rejects(
      createObservation(authorization, actors.reviewerA, orgA, sessionId, {
        evidenceSourceType: 'file_revision',
        eventSequence: '2',
        filePath: 'src/service.py',
        fileVersion: '1',
        evidenceDigest: badDigest,
        body: 'Observation with mismatched digest.',
      }),
      (err) =>
        err?.code === 'R2902' ||
        err?.code === 'INVALID_ANCHOR' ||
        err?.sqlState === 'R2902',
      'Mismatched content digest must be rejected with R2902',
    );

    // =========================================================================
    // Check 5: Cross-session evidence reference is rejected
    // =========================================================================
    // Try to link an observation in mainSession to an event sequence that belongs to sessionA2
    // If sequence does not exist or digest does not match mainSession events, it fails
    const { rows: a2Events } = await admin.query(
      `SELECT sequence, payload FROM hirearchy.candidate_session_events WHERE session_id = $1`,
      [sessionA2.sessionId],
    );
    const a2ActivatedDigest = a2Events[0].payload.scenarioDigest;

    // Sequence 99 on mainSession referencing sessionA2's digest
    await assert.rejects(
      createObservation(authorization, actors.reviewerA, orgA, sessionId, {
        evidenceSourceType: 'timeline_event',
        eventSequence: '99',
        evidenceDigest: a2ActivatedDigest,
        body: 'Cross-session evidence reference attempt.',
      }),
      (err) =>
        err?.code === 'R2902' ||
        err?.code === 'INVALID_ANCHOR' ||
        err?.sqlState === 'R2902',
      'Cross-session event reference must be rejected',
    );

    // =========================================================================
    // Check 6: Cross-org observation creation/read is rejected
    // =========================================================================
    // Reviewer A (Org A) tries to create observation on sessionB (Org B)
    await assert.rejects(
      createObservation(
        authorization,
        actors.reviewerA,
        orgB,
        sessionB.sessionId,
        {
          evidenceSourceType: 'timeline_event',
          eventSequence: '1',
          evidenceDigest: event1Digest,
          body: 'Cross-org attack.',
        },
      ),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Cross-org observation creation must be rejected with SCOPE_DENIED',
    );

    // Reviewer In Org B tries to read observations on mainSession (Org A)
    await assert.rejects(
      listObservations(authorization, actors.reviewerInOrgB, orgA, sessionId),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Cross-org observation list must be rejected with SCOPE_DENIED',
    );

    // =========================================================================
    // Check 7: Private notes: Reviewer B cannot see or edit Reviewer A's observations
    // =========================================================================
    // Reviewer B is assigned to mainSession in Org A, but observations are private!
    const reviewerBObservations = await listObservations(
      authorization,
      actors.reviewerB,
      orgA,
      sessionId,
    );
    assert.deepEqual(
      reviewerBObservations,
      [],
      "Reviewer B's observation list must not contain Reviewer A's observations",
    );

    const reviewerBGetA = await getObservation(
      authorization,
      actors.reviewerB,
      orgA,
      sessionId,
      obsTimeline.id,
    );
    assert.equal(
      reviewerBGetA,
      null,
      "Reviewer B must receive null when querying Reviewer A's observation",
    );

    // Reviewer B attempts to update Reviewer A's observation -> denied!
    await assert.rejects(
      updateObservation(
        authorization,
        actors.reviewerB,
        orgA,
        sessionId,
        obsTimeline.id,
        {
          expectedVersion: 1,
          body: 'Tampered by Reviewer B',
        },
      ),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      "Reviewer B updating Reviewer A's observation must fail with SCOPE_DENIED",
    );

    // Reviewer B creates their own observation
    const obsB = await createObservation(
      authorization,
      actors.reviewerB,
      orgA,
      sessionId,
      {
        evidenceSourceType: 'timeline_event',
        eventSequence: '1',
        evidenceDigest: event1Digest,
        body: 'Reviewer B private observation.',
      },
    );
    assert.ok(obsB.id);

    // Reviewer B sees only obsB
    const listB = await listObservations(
      authorization,
      actors.reviewerB,
      orgA,
      sessionId,
    );
    assert.equal(listB.length, 1);
    assert.equal(listB[0].id, obsB.id);

    // Reviewer A sees only their own observations
    const listA = await listObservations(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
    );
    assert.equal(listA.length, 2);
    assert.deepEqual(
      listA.map((o) => o.id).sort(),
      [obsTimeline.id, obsRevision.id].sort(),
    );

    // =========================================================================
    // Check 8: Recruiter cannot read or create private observations
    // =========================================================================
    await assert.rejects(
      createObservation(authorization, actors.recruiterA, orgA, sessionId, {
        evidenceSourceType: 'timeline_event',
        eventSequence: '1',
        evidenceDigest: event1Digest,
        body: 'Recruiter trying to create observation.',
      }),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Recruiter cannot create observations',
    );

    await assert.rejects(
      listObservations(authorization, actors.recruiterA, orgA, sessionId),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Recruiter cannot list observations',
    );

    await assert.rejects(
      getObservation(
        authorization,
        actors.recruiterA,
        orgA,
        sessionId,
        obsTimeline.id,
      ),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Recruiter cannot get observations',
    );

    // Org Admin also cannot access private notes
    await assert.rejects(
      listObservations(authorization, actors.adminA, orgA, sessionId),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Admin cannot list observations',
    );

    // =========================================================================
    // Check 9: Revoked assignment: Reviewer immediately denied access
    // =========================================================================
    // Revoke Reviewer B's assignment
    await admin.query(
      `UPDATE hirearchy.reviewer_assignments
       SET revoked_at = pg_catalog.clock_timestamp()
       WHERE organization_id = $1 AND session_id = $2 AND reviewer_principal_id = $3`,
      [orgA, sessionId, actors.reviewerB.principalId],
    );

    await assert.rejects(
      createObservation(authorization, actors.reviewerB, orgA, sessionId, {
        evidenceSourceType: 'timeline_event',
        eventSequence: '1',
        evidenceDigest: event1Digest,
        body: 'Post-revocation creation attempt.',
      }),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Revoked reviewer cannot create observations',
    );

    await assert.rejects(
      updateObservation(
        authorization,
        actors.reviewerB,
        orgA,
        sessionId,
        obsB.id,
        {
          expectedVersion: 1,
          body: 'Post-revocation update attempt.',
        },
      ),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Revoked reviewer cannot update observations',
    );

    await assert.rejects(
      listObservations(authorization, actors.reviewerB, orgA, sessionId),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Revoked reviewer cannot list observations',
    );

    // =========================================================================
    // Check 10: Revoked membership: Reviewer immediately denied access
    // =========================================================================
    await assert.rejects(
      listObservations(authorization, actors.reviewerRevoked, orgA, sessionId),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Revoked member cannot access observations',
    );

    // =========================================================================
    // Check 11: Concurrency control: Update with mismatched expectedVersion fails
    // =========================================================================
    // Current version of obsTimeline is 1. Calling with expectedVersion: 2 must fail!
    await assert.rejects(
      updateObservation(
        authorization,
        actors.reviewerA,
        orgA,
        sessionId,
        obsTimeline.id,
        {
          expectedVersion: 2,
          body: 'Conflict update attempt.',
        },
      ),
      (err) =>
        err?.code === 'R2904' ||
        err?.code === 'CONCURRENCY_CONFLICT' ||
        err?.sqlState === 'R2904',
      'Mismatched expectedVersion must fail with R2904 concurrency conflict',
    );

    // Also with expectedVersion: 99
    await assert.rejects(
      updateObservation(
        authorization,
        actors.reviewerA,
        orgA,
        sessionId,
        obsTimeline.id,
        {
          expectedVersion: 99,
          body: 'Conflict update attempt 99.',
        },
      ),
      (err) =>
        err?.code === 'R2904' ||
        err?.code === 'CONCURRENCY_CONFLICT' ||
        err?.sqlState === 'R2904',
      'Out of bounds expectedVersion must fail with R2904',
    );

    // Verify observation version has not changed
    const unchangedObs = await getObservation(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      obsTimeline.id,
    );
    assert.equal(unchangedObs.version, 1);
    assert.equal(unchangedObs.body, 'Candidate activated the session on time.');

    // =========================================================================
    // Check 12: Audit history: Observation update preserves previous versions
    // =========================================================================
    // Successful update 1: version 1 -> 2
    const updated1 = await updateObservation(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      obsTimeline.id,
      {
        expectedVersion: 1,
        body: 'Candidate activated the session early, within 10 seconds.',
      },
    );
    assert.equal(updated1.version, 2);
    assert.equal(
      updated1.body,
      'Candidate activated the session early, within 10 seconds.',
    );

    // Successful update 2: version 2 -> 3
    const updated2 = await updateObservation(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      obsTimeline.id,
      {
        expectedVersion: 2,
        body: 'Candidate activated the session early (verified via timestamp).',
      },
    );
    assert.equal(updated2.version, 3);
    assert.equal(
      updated2.body,
      'Candidate activated the session early (verified via timestamp).',
    );

    // Get observation with history
    const obsWithHistory = await getObservation(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      obsTimeline.id,
    );
    assert.equal(obsWithHistory.version, 3);
    assert.ok(Array.isArray(obsWithHistory.history));
    assert.equal(obsWithHistory.history.length, 2);

    // History entry 1 (snapshot of version 1)
    const h1 = obsWithHistory.history[0];
    assert.equal(h1.version, 1);
    assert.equal(h1.body, 'Candidate activated the session on time.');
    assert.equal(h1.evidenceSourceType, 'timeline_event');
    assert.equal(h1.eventSequence, '1');
    assert.equal(h1.evidenceDigest, event1Digest);
    assert.ok(h1.validFrom);
    assert.ok(h1.validUntil);
    assert.ok(h1.recordedAt);

    // History entry 2 (snapshot of version 2)
    const h2 = obsWithHistory.history[1];
    assert.equal(h2.version, 2);
    assert.equal(
      h2.body,
      'Candidate activated the session early, within 10 seconds.',
    );
    assert.equal(h2.evidenceSourceType, 'timeline_event');
    assert.equal(h2.eventSequence, '1');
    assert.equal(h2.evidenceDigest, event1Digest);

    // Verify history table is append-only and immutable against mutation
    await assert.rejects(
      admin.query(
        `UPDATE hirearchy.evaluator_observation_history SET body = 'Tampered' WHERE observation_id = $1`,
        [obsTimeline.id],
      ),
      (err) => err?.code === '23514',
      'Direct update to observation history must fail with 23514',
    );
    await assert.rejects(
      admin.query(
        `DELETE FROM hirearchy.evaluator_observation_history WHERE observation_id = $1`,
        [obsTimeline.id],
      ),
      (err) => err?.code === '23514',
      'Direct delete from observation history must fail with 23514',
    );

    // =========================================================================
    // Check 13: Immutability of candidate data
    // =========================================================================
    // Verify candidate tables were not modified by observation creation/updates
    const { rows: postEvents } = await admin.query(
      `SELECT count(*)::int AS count FROM hirearchy.candidate_session_events WHERE session_id = $1`,
      [sessionId],
    );
    assert.equal(postEvents[0].count, 3);

    const { rows: postRevs } = await admin.query(
      `SELECT count(*)::int AS count FROM hirearchy.candidate_file_revisions WHERE session_id = $1`,
      [sessionId],
    );
    assert.equal(postRevs[0].count, 1);

    const { rows: postSubs } = await admin.query(
      `SELECT count(*)::int AS count FROM hirearchy.candidate_session_submissions WHERE session_id = $1`,
      [sessionId],
    );
    assert.equal(postSubs[0].count, 1);

    // =========================================================================
    // Check 14: All database operations use restricted roles
    // =========================================================================
    // Direct table access from r23_gateway is rejected
    await assert.rejects(
      gatewayPool.query('SELECT * FROM hirearchy.evaluator_observations'),
      (err) => err?.code === '42501',
      'Direct table SELECT by r23_gateway must be denied (42501)',
    );
    await assert.rejects(
      gatewayPool.query(
        'SELECT * FROM hirearchy.evaluator_observation_history',
      ),
      (err) => err?.code === '42501',
      'Direct history SELECT by r23_gateway must be denied (42501)',
    );

    // Direct table access from candidate gateway is rejected
    await assert.rejects(
      candidatePool.query('SELECT * FROM hirearchy.evaluator_observations'),
      (err) => err?.code === '42501',
      'Direct table SELECT by app_candidate_gateway must be denied (42501)',
    );
    await assert.rejects(
      candidatePool.query(
        'SELECT * FROM hirearchy.evaluator_observation_history',
      ),
      (err) => err?.code === '42501',
      'Direct history SELECT by app_candidate_gateway must be denied (42501)',
    );
  } finally {
    await candidateAdapter?.close().catch(() => {});
    await authorization?.close().catch(() => {});
    await candidatePool?.end().catch(() => {});
    await gatewayPool?.end().catch(() => {});
  }
}
