import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  createR23PostgresAdapter,
  assertCandidateTokenStorage,
  R23ScopeDenied,
  R210ConcurrencyConflict,
  R210EvidenceMismatch,
  R210FinalizedPacketImmutable,
} from '../../database/postgres/r23/adapter.mjs';
import { createR26CandidateAdapter } from '../../database/postgres/r26/adapter.mjs';

const SCENARIO_ID = 'scenario-002-booking-notification-retry';
const SCENARIO_VERSION = '1.0.0';
const SCENARIO_TITLE = 'R2.10 structured human review packets';

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
    credentialEnvelope: Buffer.from('synthetic R2.10 Auth envelope'),
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
      'README.md': '# R2.10 test fixture\n',
      'src/service.py': 'def calculate():\n    return 1\n',
    },
  },
) {
  const sessionId = `sess_r210_${label}_${randomBytes(8).toString('hex')}`;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hash(token);
  const snapshotText = JSON.stringify({
    scenario: {
      id: SCENARIO_ID,
      version: SCENARIO_VERSION,
      title: SCENARIO_TITLE,
      durationSeconds: 600,
      brief: 'Structured human review packets test scenario.',
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
    [organizationId, sessionId, tokenHash, 'synthetic-R210-envelope'],
  );

  for (const reviewerPrincipalId of reviewerPrincipalIds) {
    const assignmentId = randomId('r210-assignment-');
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

async function getReviewPacket(adapter, actor, organizationId, sessionId) {
  return adapter.withActiveSession(
    { handleHash: actor.handleHash },
    async (_session, authz) => {
      await authz.selectOrganization(actor.identity, organizationId);
      return authz.getReviewPacket(actor.identity, organizationId, sessionId);
    },
  );
}

async function saveReviewPacketDraft(
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
      return authz.saveReviewPacketDraft(
        actor.identity,
        organizationId,
        sessionId,
        input,
      );
    },
  );
}

async function finalizeReviewPacket(
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
      return authz.finalizeReviewPacket(
        actor.identity,
        organizationId,
        sessionId,
        input,
      );
    },
  );
}

export async function runR210PostgresReviewPacketChecks({
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
    application_name: 'hirearchy-r210-candidate-check',
    max: 5,
  });

  let gatewayPool = new Pool({
    ...connection,
    user: 'r23_gateway',
    password: runtimePassword,
    application_name: 'hirearchy-r210-gateway-check',
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

    // 1. Create candidate session in Org A (Reviewer A & B assigned)
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
    const req1 = randomId('r210-save-1-');
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
    const submitReq = randomId('r210-submit-');
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

    // Query events from DB
    const { rows: events } = await admin.query(
      `SELECT sequence, event_type, payload
       FROM hirearchy.candidate_session_events
       WHERE session_id = $1
       ORDER BY sequence ASC`,
      [sessionId],
    );
    assert.equal(events.length, 3);
    const event1Digest = events[0].payload.scenarioDigest;
    assert.match(event1Digest, /^[0-9a-f]{64}$/);

    // Create session A2 in Org A (for cross-session checks)
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

    // Create session B in Org B (for cross-org checks)
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
    // Check 1: Authorized reviewer creates a draft review packet
    // =========================================================================
    // Reviewer A starts with no packet
    const initialGet = await getReviewPacket(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
    );
    assert.equal(initialGet, null, 'Review packet initially null');

    const draft1 = await saveReviewPacketDraft(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      {
        summary: 'Initial draft assessment of candidate performance.',
        strengths: ['Clean code structure', 'Fast activation'],
        concerns: ['Needs more unit tests'],
        unresolvedQuestions: ['Why was service.py chosen for calculation?'],
        referencedObservationIds: [],
        referencedEvidence: [],
      },
    );

    assert.ok(draft1.id, 'Packet ID generated');
    assert.match(
      draft1.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    assert.equal(draft1.organizationId, orgA);
    assert.equal(draft1.sessionId, sessionId);
    assert.equal(draft1.authorPrincipalId, actors.reviewerA.principalId);
    assert.equal(draft1.status, 'DRAFT');
    assert.equal(
      draft1.summary,
      'Initial draft assessment of candidate performance.',
    );
    assert.deepEqual(draft1.strengths, [
      'Clean code structure',
      'Fast activation',
    ]);
    assert.deepEqual(draft1.concerns, ['Needs more unit tests']);
    assert.deepEqual(draft1.unresolvedQuestions, [
      'Why was service.py chosen for calculation?',
    ]);
    assert.deepEqual(draft1.referencedObservationIds, []);
    assert.deepEqual(draft1.referencedEvidence, []);
    assert.equal(draft1.version, 1);
    assert.equal(draft1.finalizedAt, null);
    assert.equal(draft1.finalDigest, null);
    assert.ok(draft1.createdAt);
    assert.ok(draft1.updatedAt);

    // =========================================================================
    // Check 2: Draft persists across restart (verified via query)
    // =========================================================================
    const persistedDraft = await getReviewPacket(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
    );
    assert.ok(persistedDraft);
    assert.equal(persistedDraft.id, draft1.id);
    assert.equal(persistedDraft.version, 1);
    assert.equal(persistedDraft.summary, draft1.summary);

    // =========================================================================
    // Check 3: Draft update increments version
    // =========================================================================
    const draft2 = await saveReviewPacketDraft(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      {
        summary: 'Revised draft: candidate completed calculation task.',
        strengths: ['Clean code structure', 'Accurate return value'],
        concerns: ['Minimal test suite'],
        unresolvedQuestions: [],
        referencedObservationIds: [],
        referencedEvidence: [],
        expectedVersion: 1,
      },
    );
    assert.equal(draft2.id, draft1.id);
    assert.equal(draft2.version, 2);
    assert.equal(
      draft2.summary,
      'Revised draft: candidate completed calculation task.',
    );
    assert.ok(Array.isArray(draft2.history));
    assert.equal(draft2.history.length, 1);
    assert.equal(draft2.history[0].version, 1);
    assert.equal(draft2.history[0].summary, draft1.summary);
    assert.ok(draft2.history[0].validFrom);
    assert.ok(draft2.history[0].validUntil);
    assert.ok(draft2.history[0].recordedAt);

    // =========================================================================
    // Check 4: Concurrent stale update conflicts (optimistic concurrency)
    // =========================================================================
    // Calling with stale expectedVersion: 1 when current version is 2
    await assert.rejects(
      saveReviewPacketDraft(authorization, actors.reviewerA, orgA, sessionId, {
        summary: 'Stale update attempting to overwrite version 2.',
        strengths: [],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [],
        referencedEvidence: [],
        expectedVersion: 1,
      }),
      (err) =>
        err instanceof R210ConcurrencyConflict ||
        err?.code === 'CONCURRENCY_CONFLICT' ||
        err?.sqlState === 'R2104',
      'Stale update must fail with R210ConcurrencyConflict',
    );

    // Also with out-of-range expectedVersion: 99
    await assert.rejects(
      saveReviewPacketDraft(authorization, actors.reviewerA, orgA, sessionId, {
        summary: 'Out of range version update.',
        strengths: [],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [],
        referencedEvidence: [],
        expectedVersion: 99,
      }),
      (err) =>
        err instanceof R210ConcurrencyConflict ||
        err?.code === 'CONCURRENCY_CONFLICT' ||
        err?.sqlState === 'R2104',
      'Mismatched expectedVersion must fail with R210ConcurrencyConflict',
    );

    // Verify version remains 2
    const verifyV2 = await getReviewPacket(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
    );
    assert.equal(verifyV2.version, 2);

    // =========================================================================
    // Check 5: Valid observation reference succeeds
    // =========================================================================
    const obsA = await createObservation(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      {
        evidenceSourceType: 'timeline_event',
        eventSequence: '1',
        evidenceDigest: event1Digest,
        body: 'Candidate activated session cleanly.',
      },
    );
    assert.ok(obsA.id);

    const draft3 = await saveReviewPacketDraft(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      {
        summary: 'Draft with valid observation citation.',
        strengths: ['Prompt activation'],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [obsA.id],
        referencedEvidence: [],
        expectedVersion: 2,
      },
    );
    assert.equal(draft3.version, 3);
    assert.deepEqual(draft3.referencedObservationIds, [obsA.id]);

    // =========================================================================
    // Check 6: Foreign/private observation reference fails
    // =========================================================================
    // Reviewer B creates an observation
    const obsB = await createObservation(
      authorization,
      actors.reviewerB,
      orgA,
      sessionId,
      {
        evidenceSourceType: 'timeline_event',
        eventSequence: '1',
        evidenceDigest: event1Digest,
        body: 'Reviewer B private observation note.',
      },
    );
    assert.ok(obsB.id);

    // Reviewer A attempts to reference Reviewer B's private observation
    await assert.rejects(
      saveReviewPacketDraft(authorization, actors.reviewerA, orgA, sessionId, {
        summary: 'Attempting to reference Reviewer B observation.',
        strengths: [],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [obsB.id],
        referencedEvidence: [],
        expectedVersion: 3,
      }),
      (err) =>
        err instanceof R210EvidenceMismatch ||
        err?.code === 'INVALID_REFERENCE' ||
        err?.sqlState === 'R2102',
      'Foreign/private observation reference must fail with R210EvidenceMismatch',
    );

    // Non-existent observation UUID
    await assert.rejects(
      saveReviewPacketDraft(authorization, actors.reviewerA, orgA, sessionId, {
        summary: 'Attempting non-existent observation reference.',
        strengths: [],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [randomUUID()],
        referencedEvidence: [],
        expectedVersion: 3,
      }),
      (err) =>
        err instanceof R210EvidenceMismatch ||
        err?.code === 'INVALID_REFERENCE' ||
        err?.sqlState === 'R2102',
      'Non-existent observation reference must fail with R210EvidenceMismatch',
    );

    // =========================================================================
    // Check 7: Invalid event/revision reference fails & valid reference succeeds
    // =========================================================================
    // 7a. Invalid event sequence
    await assert.rejects(
      saveReviewPacketDraft(authorization, actors.reviewerA, orgA, sessionId, {
        summary: 'Draft with invalid event sequence.',
        strengths: [],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [],
        referencedEvidence: [
          {
            evidenceSourceType: 'timeline_event',
            eventSequence: '9999',
            filePath: null,
            fileVersion: null,
            evidenceDigest: hash('invented'),
          },
        ],
        expectedVersion: 3,
      }),
      (err) =>
        err instanceof R210EvidenceMismatch ||
        err?.code === 'INVALID_REFERENCE' ||
        err?.sqlState === 'R2102',
      'Invented event sequence must fail with R210EvidenceMismatch',
    );

    // 7b. Invalid event digest mismatch
    await assert.rejects(
      saveReviewPacketDraft(authorization, actors.reviewerA, orgA, sessionId, {
        summary: 'Draft with mismatched digest.',
        strengths: [],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [],
        referencedEvidence: [
          {
            evidenceSourceType: 'timeline_event',
            eventSequence: '1',
            filePath: null,
            fileVersion: null,
            evidenceDigest:
              '0000000000000000000000000000000000000000000000000000000000000000',
          },
        ],
        expectedVersion: 3,
      }),
      (err) =>
        err instanceof R210EvidenceMismatch ||
        err?.code === 'INVALID_REFERENCE' ||
        err?.sqlState === 'R2102',
      'Mismatched evidence digest must fail with R210EvidenceMismatch',
    );

    // 7c. Non-existent file path in file_revision
    await assert.rejects(
      saveReviewPacketDraft(authorization, actors.reviewerA, orgA, sessionId, {
        summary: 'Draft with fake file path.',
        strengths: [],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [],
        referencedEvidence: [
          {
            evidenceSourceType: 'file_revision',
            eventSequence: '2',
            filePath: 'nonexistent.py',
            fileVersion: '1',
            evidenceDigest: digest1,
          },
        ],
        expectedVersion: 3,
      }),
      (err) =>
        err instanceof R210EvidenceMismatch ||
        err?.code === 'INVALID_REFERENCE' ||
        err?.sqlState === 'R2102',
      'Fake file path must fail with R210EvidenceMismatch',
    );

    // 7d. Non-existent file version
    await assert.rejects(
      saveReviewPacketDraft(authorization, actors.reviewerA, orgA, sessionId, {
        summary: 'Draft with fake file version.',
        strengths: [],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [],
        referencedEvidence: [
          {
            evidenceSourceType: 'file_revision',
            eventSequence: '2',
            filePath: 'src/service.py',
            fileVersion: '99',
            evidenceDigest: digest1,
          },
        ],
        expectedVersion: 3,
      }),
      (err) =>
        err instanceof R210EvidenceMismatch ||
        err?.code === 'INVALID_REFERENCE' ||
        err?.sqlState === 'R2102',
      'Fake file version must fail with R210EvidenceMismatch',
    );

    // 7e. Valid file revision reference succeeds
    const draft4 = await saveReviewPacketDraft(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      {
        summary: 'Draft referencing genuine file revision and observation.',
        strengths: ['Correct implementation of calculation'],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [obsA.id],
        referencedEvidence: [
          {
            evidenceSourceType: 'file_revision',
            eventSequence: '2',
            filePath: 'src/service.py',
            fileVersion: '1',
            evidenceDigest: digest1,
            label: 'Initial calculate() implementation',
          },
        ],
        expectedVersion: 3,
      },
    );
    assert.equal(draft4.version, 4);
    assert.equal(draft4.referencedEvidence.length, 1);
    assert.equal(draft4.referencedEvidence[0].filePath, 'src/service.py');

    // =========================================================================
    // Check 8: Cross-session reference fails
    // =========================================================================
    const { rows: a2Events } = await admin.query(
      `SELECT sequence, payload FROM hirearchy.candidate_session_events WHERE session_id = $1`,
      [sessionA2.sessionId],
    );
    const a2Digest = a2Events[0].payload.scenarioDigest;

    await assert.rejects(
      saveReviewPacketDraft(authorization, actors.reviewerA, orgA, sessionId, {
        summary: 'Attempting cross-session evidence citation.',
        strengths: [],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [],
        referencedEvidence: [
          {
            evidenceSourceType: 'timeline_event',
            eventSequence: '99',
            filePath: null,
            fileVersion: null,
            evidenceDigest: a2Digest,
          },
        ],
        expectedVersion: 4,
      }),
      (err) =>
        err instanceof R210EvidenceMismatch ||
        err?.code === 'INVALID_REFERENCE' ||
        err?.sqlState === 'R2102',
      'Cross-session evidence reference must fail with R210EvidenceMismatch',
    );

    // =========================================================================
    // Check 9: Cross-organization access fails
    // =========================================================================
    // Reviewer in Org B tries to read/save packet in Org A
    await assert.rejects(
      getReviewPacket(authorization, actors.reviewerInOrgB, orgA, sessionId),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Cross-org packet read must fail with SCOPE_DENIED',
    );

    await assert.rejects(
      saveReviewPacketDraft(
        authorization,
        actors.reviewerInOrgB,
        orgA,
        sessionId,
        {
          summary: 'Cross-org attack draft.',
          strengths: [],
          concerns: [],
          unresolvedQuestions: [],
          referencedObservationIds: [],
          referencedEvidence: [],
        },
      ),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Cross-org draft save must fail with SCOPE_DENIED',
    );

    // Reviewer A tries to access session B in Org B
    await assert.rejects(
      getReviewPacket(
        authorization,
        actors.reviewerA,
        orgB,
        sessionB.sessionId,
      ),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Accessing other org session must fail with SCOPE_DENIED',
    );

    // =========================================================================
    // Check 10: Recruiter and admin private-packet access fails
    // =========================================================================
    await assert.rejects(
      getReviewPacket(authorization, actors.recruiterA, orgA, sessionId),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Recruiter cannot access review packets',
    );

    await assert.rejects(
      saveReviewPacketDraft(authorization, actors.recruiterA, orgA, sessionId, {
        summary: 'Recruiter draft attempt.',
        strengths: [],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [],
        referencedEvidence: [],
      }),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Recruiter cannot save review packets',
    );

    await assert.rejects(
      finalizeReviewPacket(authorization, actors.recruiterA, orgA, sessionId, {
        expectedVersion: 1,
      }),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Recruiter cannot finalize review packets',
    );

    await assert.rejects(
      getReviewPacket(authorization, actors.adminA, orgA, sessionId),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Org admin cannot access review packets',
    );

    // =========================================================================
    // Check 11: Another reviewer access fails (strict private reviewer boundary)
    // =========================================================================
    // Reviewer B is assigned to mainSession, but has not created a packet yet
    const reviewerBPacketInitial = await getReviewPacket(
      authorization,
      actors.reviewerB,
      orgA,
      sessionId,
    );
    assert.equal(
      reviewerBPacketInitial,
      null,
      "Reviewer B must not see Reviewer A's review packet",
    );

    // Reviewer B creates their own review packet
    const draftB = await saveReviewPacketDraft(
      authorization,
      actors.reviewerB,
      orgA,
      sessionId,
      {
        summary: "Reviewer B's private review packet draft.",
        strengths: ['Speed'],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [obsB.id],
        referencedEvidence: [],
      },
    );
    assert.ok(draftB.id);
    assert.notEqual(draftB.id, draft4.id);
    assert.equal(draftB.authorPrincipalId, actors.reviewerB.principalId);

    // Reviewer A still sees only Reviewer A's packet
    const reviewerAPacket = await getReviewPacket(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
    );
    assert.equal(reviewerAPacket.id, draft4.id);
    assert.equal(reviewerAPacket.version, 4);

    // =========================================================================
    // Check 12: Revoked assignment / membership denies access
    // =========================================================================
    // Revoke Reviewer B's assignment
    await admin.query(
      `UPDATE hirearchy.reviewer_assignments
       SET revoked_at = pg_catalog.clock_timestamp()
       WHERE organization_id = $1 AND session_id = $2 AND reviewer_principal_id = $3`,
      [orgA, sessionId, actors.reviewerB.principalId],
    );

    await assert.rejects(
      getReviewPacket(authorization, actors.reviewerB, orgA, sessionId),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Revoked reviewer cannot read review packet',
    );

    await assert.rejects(
      saveReviewPacketDraft(authorization, actors.reviewerB, orgA, sessionId, {
        summary: 'Revoked reviewer draft attempt.',
        strengths: [],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [],
        referencedEvidence: [],
        expectedVersion: 1,
      }),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Revoked reviewer cannot save review packet draft',
    );

    await assert.rejects(
      finalizeReviewPacket(authorization, actors.reviewerB, orgA, sessionId, {
        expectedVersion: 1,
      }),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Revoked reviewer cannot finalize review packet',
    );

    // Revoked membership actor
    await assert.rejects(
      getReviewPacket(authorization, actors.reviewerRevoked, orgA, sessionId),
      (err) => err instanceof R23ScopeDenied || err?.code === 'SCOPE_DENIED',
      'Revoked membership cannot access review packets',
    );

    // =========================================================================
    // Check 13: Finalization creates an immutable packet
    // =========================================================================
    // Finalize Reviewer A's packet (currently version 4)
    const finalized = await finalizeReviewPacket(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      { expectedVersion: 4 },
    );

    assert.equal(finalized.id, draft4.id);
    assert.equal(finalized.status, 'FINALIZED');
    assert.equal(finalized.version, 5);
    assert.ok(finalized.finalizedAt);
    assert.match(finalized.finalizedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.ok(finalized.finalDigest);
    assert.match(finalized.finalDigest, /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(finalized.history));
    assert.equal(finalized.history.length, 4); // 4 prior versions in history (v1, v2, v3, v4)

    // =========================================================================
    // Check 14: Finalization audit records correct author/time
    // =========================================================================
    assert.equal(finalized.authorPrincipalId, actors.reviewerA.principalId);
    const finalizedTime = new Date(finalized.finalizedAt).getTime();
    assert.ok(
      Math.abs(Date.now() - finalizedTime) < 60_000,
      'finalizedAt within last minute',
    );

    // Verify database row matches finalized packet
    const { rows: dbRows } = await admin.query(
      `SELECT final_digest, finalized_at, author_principal_id
       FROM hirearchy.evaluator_review_packets
       WHERE id = $1`,
      [finalized.id],
    );
    assert.equal(dbRows[0].final_digest, finalized.finalDigest);
    assert.equal(dbRows[0].author_principal_id, finalized.authorPrincipalId);

    // =========================================================================
    // Check 15: Finalized updates are rejected
    // =========================================================================
    // 15a. Adapter saveReviewPacketDraft rejects with R210FinalizedPacketImmutable
    await assert.rejects(
      saveReviewPacketDraft(authorization, actors.reviewerA, orgA, sessionId, {
        summary: 'Attempting to update finalized packet.',
        strengths: [],
        concerns: [],
        unresolvedQuestions: [],
        referencedObservationIds: [],
        referencedEvidence: [],
        expectedVersion: 5,
      }),
      (err) =>
        err instanceof R210FinalizedPacketImmutable ||
        err?.code === 'PACKET_FINALIZED' ||
        err?.sqlState === 'R2105',
      'Draft save on finalized packet must fail with R210FinalizedPacketImmutable',
    );

    // 15b. Direct SQL UPDATE by admin on finalized row rejected by trigger (23514)
    await assert.rejects(
      admin.query(
        `UPDATE hirearchy.evaluator_review_packets
         SET summary = 'Direct tampering attempt'
         WHERE id = $1`,
        [finalized.id],
      ),
      (err) => err?.code === '23514',
      'Direct UPDATE on finalized review packet must fail with 23514',
    );

    // 15c. Direct SQL DELETE by admin on finalized row rejected by trigger (23514)
    await assert.rejects(
      admin.query(
        `DELETE FROM hirearchy.evaluator_review_packets WHERE id = $1`,
        [finalized.id],
      ),
      (err) => err?.code === '23514',
      'Direct DELETE on finalized review packet must fail with 23514',
    );

    // =========================================================================
    // Check 16: Repeated finalization cannot change the result (idempotency)
    // =========================================================================
    // Calling with the finalized version (5) returns existing packet without mutation
    const refinalizedCurrent = await finalizeReviewPacket(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      { expectedVersion: 5 },
    );
    assert.equal(refinalizedCurrent.id, finalized.id);
    assert.equal(refinalizedCurrent.status, 'FINALIZED');
    assert.equal(refinalizedCurrent.version, 5);
    assert.equal(refinalizedCurrent.finalDigest, finalized.finalDigest);
    assert.equal(refinalizedCurrent.finalizedAt, finalized.finalizedAt);
    assert.equal(refinalizedCurrent.history.length, finalized.history.length);

    // Calling with original expectedVersion (4) also returns existing packet
    const refinalizedOriginal = await finalizeReviewPacket(
      authorization,
      actors.reviewerA,
      orgA,
      sessionId,
      { expectedVersion: 4 },
    );
    assert.equal(refinalizedOriginal.id, finalized.id);
    assert.equal(refinalizedOriginal.version, 5);
    assert.equal(refinalizedOriginal.finalDigest, finalized.finalDigest);

    // =========================================================================
    // Check 17: Source candidate evidence is never mutated
    // =========================================================================
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
    // Check 18: No automatic score or decision is generated
    // =========================================================================
    const prohibitedKeys = [
      'score',
      'verdict',
      'rating',
      'grade',
      'rank',
      'hire',
      'recommendation',
      'decision',
      'pass',
    ];
    for (const key of prohibitedKeys) {
      assert.equal(
        key in finalized,
        false,
        `Review packet must not contain automatic verdict field: ${key}`,
      );
    }

    // =========================================================================
    // Check 19: Direct unauthorized SQL access fails
    // =========================================================================
    // 19a. r23_gateway direct SELECT
    await assert.rejects(
      gatewayPool.query('SELECT * FROM hirearchy.evaluator_review_packets'),
      (err) => err?.code === '42501',
      'Direct table SELECT by r23_gateway must be denied (42501)',
    );
    await assert.rejects(
      gatewayPool.query(
        'SELECT * FROM hirearchy.evaluator_review_packet_history',
      ),
      (err) => err?.code === '42501',
      'Direct history SELECT by r23_gateway must be denied (42501)',
    );

    // 19b. app_candidate_gateway direct SELECT
    await assert.rejects(
      candidatePool.query('SELECT * FROM hirearchy.evaluator_review_packets'),
      (err) => err?.code === '42501',
      'Direct table SELECT by app_candidate_gateway must be denied (42501)',
    );
    await assert.rejects(
      candidatePool.query(
        'SELECT * FROM hirearchy.evaluator_review_packet_history',
      ),
      (err) => err?.code === '42501',
      'Direct history SELECT by app_candidate_gateway must be denied (42501)',
    );

    // 19c. History table is append-only: direct UPDATE/DELETE fails
    await assert.rejects(
      admin.query(
        `UPDATE hirearchy.evaluator_review_packet_history
         SET summary = 'Tampered history'
         WHERE packet_id = $1`,
        [finalized.id],
      ),
      (err) => err?.code === '23514',
      'Direct UPDATE on review packet history must fail with 23514',
    );

    await assert.rejects(
      admin.query(
        `DELETE FROM hirearchy.evaluator_review_packet_history
         WHERE packet_id = $1`,
        [finalized.id],
      ),
      (err) => err?.code === '23514',
      'Direct DELETE on review packet history must fail with 23514',
    );
  } finally {
    await candidateAdapter?.close().catch(() => {});
    await authorization?.close().catch(() => {});
    await candidatePool?.end().catch(() => {});
    await gatewayPool?.end().catch(() => {});
  }
}
