import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Pool } from 'pg';
import { applyMigrations } from '../../database/postgres/migrate.mjs';
import {
  FIXTURE_IDS,
  applyR23DisposableSchema,
  assertCandidateTokenStorage,
  initializeCandidateTokenStorage,
  issueAssessment,
  recoverCandidateToken,
  listOrganizationReviewers,
  assignReviewer,
  revokeReviewerAssignment,
  listSessionReviewerAssignments,
  R25IdempotencyConflict,
  R23ScopeDenied,
} from '../../database/postgres/r23/adapter.mjs';
import { seedR24SessionFixtures } from '../r24/postgres-session-security-check.mjs';
import {
  encryptCandidateToken,
  decryptCandidateToken,
  candidateTokenHash,
} from '../../apps/web/src/sessions/candidate-token-storage.mjs';

const POSTGRES_IMAGE =
  'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';

export async function runR25PostgresIssuanceSecurityChecks({
  admin,
  evaluatorPool: passedEvaluatorPool,
  candidatePool: passedCandidatePool,
  workerPool: passedWorkerPool,
  connection,
  password,
  runtimePassword,
}) {
  let evaluatorPool = passedEvaluatorPool;
  let candidatePool = passedCandidatePool;
  let workerPool = passedWorkerPool;
  let locallyCreatedPools = false;

  if (!evaluatorPool && connection && runtimePassword) {
    locallyCreatedPools = true;
    evaluatorPool = new Pool({
      ...connection,
      user: 'r23_gateway',
      password: runtimePassword,
      max: 5,
    });
    candidatePool = new Pool({
      ...connection,
      user: 'app_candidate_gateway',
      password: runtimePassword,
      max: 2,
    });
    workerPool = new Pool({
      ...connection,
      user: 'app_control_worker',
      password: runtimePassword,
      max: 2,
    });
  }

  await seedR24SessionFixtures(admin);
  const priorStorageMarker = await admin.query(
    'SELECT slot, version, database_id, key_check FROM hirearchy.candidate_token_storage_meta WHERE slot = 1',
  );

  try {
    // Keep marker initialization isolated from any state supplied by a caller.
    await admin.query('DELETE FROM hirearchy.candidate_token_storage_meta');
    const encryptionKeyA = randomBytes(32);
    const encryptionKeyB = randomBytes(32);

    // =========================================================================
    // 1. Candidate Token Storage Meta Table & HMAC Key Verification
    // =========================================================================
    {
      // Empty meta table throws CANDIDATE_TOKEN_STORAGE_UNBOUND
      await assert.rejects(
        async () => {
          await assertCandidateTokenStorage(admin, { key: encryptionKeyA });
        },
        (err) => err?.code === 'CANDIDATE_TOKEN_STORAGE_UNBOUND',
        'Unbound database without storage marker must throw CANDIDATE_TOKEN_STORAGE_UNBOUND',
      );

      // Concurrent initialization must create one binding and never replace it.
      let marker;
      if (connection && password) {
        const initializationClients = [0, 1].map(
          () =>
            new Client({
              ...connection,
              user: 'postgres',
              password,
            }),
        );
        try {
          await Promise.all(
            initializationClients.map((client) => client.connect()),
          );
          const attempts = await Promise.allSettled(
            initializationClients.map((client) =>
              initializeCandidateTokenStorage(client, { key: encryptionKeyA }),
            ),
          );
          const initialized = attempts.filter(
            (attempt) => attempt.status === 'fulfilled',
          );
          const rejected = attempts.filter(
            (attempt) => attempt.status === 'rejected',
          );
          assert.equal(initialized.length, 1);
          assert.equal(rejected.length, 1);
          assert.ok(
            ['23505', 'CANDIDATE_TOKEN_STORAGE_EXISTS'].includes(
              rejected[0].reason?.code,
            ),
            'Concurrent initialization loses safely to the existing binding',
          );
          marker = initialized[0].value;
        } finally {
          await Promise.all(
            initializationClients.map((client) => client.end().catch(() => {})),
          );
        }
      } else {
        marker = await initializeCandidateTokenStorage(admin, {
          key: encryptionKeyA,
        });
      }
      assert.equal(marker.version, 1);
      assert.ok(marker.databaseId);
      assert.ok(marker.keyCheck);
      const initializedMarker = await admin.query(
        'SELECT slot, version, database_id, key_check FROM hirearchy.candidate_token_storage_meta WHERE slot = 1',
      );
      assert.deepEqual(
        initializedMarker.rows,
        [
          {
            slot: 1,
            version: marker.version,
            database_id: marker.databaseId,
            key_check: marker.keyCheck,
          },
        ],
        'The losing concurrent initializer must not replace the winning marker',
      );

      // Initializing again must throw CANDIDATE_TOKEN_STORAGE_EXISTS
      await assert.rejects(
        async () => {
          await initializeCandidateTokenStorage(admin, { key: encryptionKeyA });
        },
        (err) => err?.code === 'CANDIDATE_TOKEN_STORAGE_EXISTS',
      );

      // Validating with the correct key succeeds
      const verified = await assertCandidateTokenStorage(admin, {
        key: encryptionKeyA,
      });
      assert.equal(verified.version, 1);
      assert.equal(verified.database_id, marker.databaseId);

      // Validating with a different key throws CANDIDATE_TOKEN_KEY_MISMATCH
      await assert.rejects(
        async () => {
          await assertCandidateTokenStorage(admin, { key: encryptionKeyB });
        },
        (err) => err?.code === 'CANDIDATE_TOKEN_KEY_MISMATCH',
        'Wrong encryption key must throw CANDIDATE_TOKEN_KEY_MISMATCH',
      );

      // Tampered database_id throws CANDIDATE_TOKEN_STORAGE_MARKER_INVALID
      await admin.query(
        `UPDATE hirearchy.candidate_token_storage_meta
       SET database_id = 'invalid_format!'
       WHERE slot = 1`,
      );
      await assert.rejects(
        async () => {
          await assertCandidateTokenStorage(admin, { key: encryptionKeyA });
        },
        (err) => err?.code === 'CANDIDATE_TOKEN_STORAGE_MARKER_INVALID',
      );

      // Restore valid database_id
      await admin.query(
        `UPDATE hirearchy.candidate_token_storage_meta
       SET database_id = $1, key_check = $2
       WHERE slot = 1`,
        [marker.databaseId, marker.keyCheck],
      );

      // Check constraint: slot = 1 only
      await assert.rejects(
        async () => {
          await admin.query(
            `INSERT INTO hirearchy.candidate_token_storage_meta (slot, version, database_id, key_check)
           VALUES (2, 1, 'dummy_database_id_22', 'dummy_key_check_43_characters_long_____')`,
          );
        },
        /check constraint/i,
        'Inserting slot != 1 must violate CHECK (slot = 1)',
      );

      // Unprivileged roles cannot query candidate_token_storage_meta directly
      for (const [pool, roleName] of [
        [evaluatorPool, 'r23_gateway'],
        [candidatePool, 'app_candidate_gateway'],
        [workerPool, 'app_control_worker'],
      ]) {
        await assert.rejects(
          async () => {
            await pool.query(
              'SELECT * FROM hirearchy.candidate_token_storage_meta',
            );
          },
          /permission denied/i,
          `Role ${roleName} must not have direct SELECT on candidate_token_storage_meta`,
        );
      }

      const runtimeSetter = await admin.query(
        "SELECT pg_catalog.to_regprocedure('r25.set_candidate_token_storage_meta(integer,text,text)') AS setter",
      );
      assert.equal(
        runtimeSetter.rows[0].setter,
        null,
        'Runtime roles must not have an upsert path that can replace the database binding',
      );
    }

    // =========================================================================
    // 2. Assessment Issuance - Role & Membership Authorization
    // =========================================================================
    const plainToken1 = randomBytes(32).toString('base64url');
    const session1Id = `r25-sess-001-${randomBytes(4).toString('hex')}`;
    const tokenHash1 = candidateTokenHash(plainToken1);
    const tokenCiphertext1 = encryptCandidateToken(
      plainToken1,
      session1Id,
      encryptionKeyA,
    );

    {
      // Recruiter A in Org A can successfully issue assessment
      const created = await issueAssessment(evaluatorPool, {
        supabaseUserId: FIXTURE_IDS.userA.subjectId,
        organizationId: FIXTURE_IDS.orgA,
        sessionId: session1Id,
        scenarioId: 'scenario-002-booking-notification-retry',
        scenarioVersion: '1.0.0',
        scenarioTitle: 'Booking notification retry',
        durationSeconds: 3600,
        candidateTokenHash: tokenHash1,
        candidateTokenCiphertext: tokenCiphertext1,
        idempotencyKey: 'idem-recruiter-a-1',
        requestHash: 'hash-req-1',
        payloadHash: 'hash-pay-1',
        terminalEnabled: true,
        taskRubricSnapshot: { criteria: ['retry-handling'] },
        aiCapabilitySnapshot: { assistant: true },
      });

      assert.equal(created.sessionId, session1Id);
      assert.equal(created.organizationId, FIXTURE_IDS.orgA);
      assert.equal(created.issuerPrincipalId, FIXTURE_IDS.userA.principalId);
      assert.equal(created.status, 'CREATED');
      assert.equal(created.isReplay, false);
      assert.equal(created.durationSeconds, 3600);

      // Reviewer in Org A cannot issue assessment (ROLE_DENIED)
      await assert.rejects(
        async () => {
          await issueAssessment(evaluatorPool, {
            supabaseUserId: FIXTURE_IDS.userAB.subjectId,
            organizationId: FIXTURE_IDS.orgA,
            sessionId: `r25-sess-fail-${randomBytes(4).toString('hex')}`,
            scenarioId: 'scenario-002-booking-notification-retry',
            scenarioVersion: '1.0.0',
            scenarioTitle: 'Booking notification retry',
            candidateTokenHash: candidateTokenHash(
              randomBytes(32).toString('base64url'),
            ),
            candidateTokenCiphertext: 'v1.dummy.dummy.dummy',
          });
        },
        (err) => err?.code === 'ROLE_DENIED',
        'Reviewer cannot issue assessment',
      );

      // Admin in Org A cannot issue assessment (ROLE_DENIED)
      await assert.rejects(
        async () => {
          await issueAssessment(evaluatorPool, {
            supabaseUserId: FIXTURE_IDS.adminA.subjectId,
            organizationId: FIXTURE_IDS.orgA,
            sessionId: `r25-sess-fail-admin-${randomBytes(4).toString('hex')}`,
            scenarioId: 'scenario-002-booking-notification-retry',
            scenarioVersion: '1.0.0',
            scenarioTitle: 'Booking notification retry',
            candidateTokenHash: candidateTokenHash(
              randomBytes(32).toString('base64url'),
            ),
            candidateTokenCiphertext: 'v1.dummy.dummy.dummy',
          });
        },
        (err) => err?.code === 'ROLE_DENIED',
        'Admin cannot issue assessment',
      );

      // Recruiter A in Org A cannot issue into Org B (SCOPE_DENIED)
      await assert.rejects(
        async () => {
          await issueAssessment(evaluatorPool, {
            supabaseUserId: FIXTURE_IDS.userA.subjectId,
            organizationId: FIXTURE_IDS.orgB,
            sessionId: `r25-sess-fail-cross-${randomBytes(4).toString('hex')}`,
            scenarioId: 'scenario-002-booking-notification-retry',
            scenarioVersion: '1.0.0',
            scenarioTitle: 'Booking notification retry',
            candidateTokenHash: candidateTokenHash(
              randomBytes(32).toString('base64url'),
            ),
            candidateTokenCiphertext: 'v1.dummy.dummy.dummy',
          });
        },
        (err) => err instanceof R23ScopeDenied,
        'Cross-organization issuance must be denied',
      );

      // Revoked user cannot issue assessment
      await assert.rejects(
        async () => {
          await issueAssessment(evaluatorPool, {
            supabaseUserId: FIXTURE_IDS.userRevoked.subjectId,
            organizationId: FIXTURE_IDS.orgA,
            sessionId: `r25-sess-fail-revoked-${randomBytes(4).toString('hex')}`,
            scenarioId: 'scenario-002-booking-notification-retry',
            scenarioVersion: '1.0.0',
            scenarioTitle: 'Booking notification retry',
            candidateTokenHash: candidateTokenHash(
              randomBytes(32).toString('base64url'),
            ),
            candidateTokenCiphertext: 'v1.dummy.dummy.dummy',
          });
        },
        (err) => err instanceof R23ScopeDenied,
        'Revoked member cannot issue assessment',
      );
    }

    // =========================================================================
    // 3. Candidate Token Envelope Security, Immutability & Access Isolation
    // =========================================================================
    {
      // The issuer recruiter (Recruiter A) can recover the token
      const recovered = await recoverCandidateToken(evaluatorPool, {
        supabaseUserId: FIXTURE_IDS.userA.subjectId,
        organizationId: FIXTURE_IDS.orgA,
        sessionId: session1Id,
      });

      assert.ok(recovered);
      assert.equal(recovered.sessionId, session1Id);
      assert.equal(recovered.organizationId, FIXTURE_IDS.orgA);
      assert.equal(recovered.candidateTokenHash, tokenHash1);
      assert.equal(recovered.candidateTokenCiphertext, tokenCiphertext1);

      // Decrypt recovered ciphertext: must match original plain token
      const decrypted = decryptCandidateToken(
        recovered.candidateTokenCiphertext,
        session1Id,
        encryptionKeyA,
      );
      assert.equal(decrypted, plainToken1);

      // Decrypt with wrong session ID must fail
      assert.throws(() => {
        decryptCandidateToken(
          recovered.candidateTokenCiphertext,
          'wrong-session-id',
          encryptionKeyA,
        );
      });

      // Another recruiter in Org A (Recruiter A2) CANNOT recover Recruiter A's session token
      await assert.rejects(
        async () => {
          await recoverCandidateToken(evaluatorPool, {
            supabaseUserId: FIXTURE_IDS.recruiterA2.subjectId,
            organizationId: FIXTURE_IDS.orgA,
            sessionId: session1Id,
          });
        },
        (err) =>
          err?.code === 'PERMISSION_DENIED' ||
          err?.code === 'SESSION_NOT_FOUND',
        'Non-issuer recruiter cannot recover candidate token',
      );

      // Reviewer in Org A cannot recover candidate token
      await assert.rejects(
        async () => {
          await recoverCandidateToken(evaluatorPool, {
            supabaseUserId: FIXTURE_IDS.userAB.subjectId,
            organizationId: FIXTURE_IDS.orgA,
            sessionId: session1Id,
          });
        },
        (err) =>
          err?.code === 'PERMISSION_DENIED' || err?.code === 'ROLE_DENIED',
        'Reviewer cannot recover candidate token',
      );

      // Recruiter B in Org B cannot recover Org A's candidate token
      await assert.rejects(
        async () => {
          await recoverCandidateToken(evaluatorPool, {
            supabaseUserId: FIXTURE_IDS.recruiterB.subjectId,
            organizationId: FIXTURE_IDS.orgB,
            sessionId: session1Id,
          });
        },
        (err) => err?.code === 'SESSION_NOT_FOUND',
        'Cross-organization token recovery must fail',
      );

      // Immutability trigger: Attempting to update candidate_token_envelopes fails
      await assert.rejects(
        async () => {
          await admin.query(
            `UPDATE hirearchy.candidate_token_envelopes
           SET candidate_token_hash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
           WHERE session_id = $1`,
            [session1Id],
          );
        },
        /23514|Immutable/,
        'Updating candidate_token_envelopes must be rejected by immutability trigger',
      );

      // Restricted roles cannot SELECT candidate_token_envelopes
      for (const [pool, roleName] of [
        [evaluatorPool, 'r23_gateway'],
        [candidatePool, 'app_candidate_gateway'],
        [workerPool, 'app_control_worker'],
      ]) {
        await assert.rejects(
          async () => {
            await pool.query(
              'SELECT * FROM hirearchy.candidate_token_envelopes',
            );
          },
          /permission denied/i,
          `Role ${roleName} must not have direct SELECT on candidate_token_envelopes`,
        );
      }
    }

    // =========================================================================
    // 4. Idempotency Matrix (Cases A, B, C, D, E) & Immutability
    // =========================================================================
    {
      const idemKey = `idem-matrix-${Date.now()}`;
      const reqHash = 'req-hash-matrix-v1';
      const payHash = 'pay-hash-matrix-v1';
      const sessionMatrixId = `r25-sess-mat-${randomBytes(4).toString('hex')}`;
      const tokenMatrix = randomBytes(32).toString('base64url');
      const tokenHashMat = candidateTokenHash(tokenMatrix);
      const tokenCipherMat = encryptCandidateToken(
        tokenMatrix,
        sessionMatrixId,
        encryptionKeyA,
      );

      // Case A: First issuance
      const caseA = await issueAssessment(evaluatorPool, {
        supabaseUserId: FIXTURE_IDS.userA.subjectId,
        organizationId: FIXTURE_IDS.orgA,
        sessionId: sessionMatrixId,
        scenarioId: 'scenario-002-booking-notification-retry',
        scenarioVersion: '1.0.0',
        scenarioTitle: 'Booking notification retry',
        durationSeconds: 1800,
        candidateTokenHash: tokenHashMat,
        candidateTokenCiphertext: tokenCipherMat,
        idempotencyKey: idemKey,
        requestHash: reqHash,
        payloadHash: payHash,
      });
      assert.equal(
        caseA.isReplay,
        false,
        'Case A first issuance returns is_replay = false',
      );
      assert.equal(caseA.sessionId, sessionMatrixId);

      // Case B: Replay with identical idempotency key and identical request hash
      const caseB = await issueAssessment(evaluatorPool, {
        supabaseUserId: FIXTURE_IDS.userA.subjectId,
        organizationId: FIXTURE_IDS.orgA,
        sessionId: `different-session-id-${randomBytes(4).toString('hex')}`,
        scenarioId: 'scenario-002-booking-notification-retry',
        scenarioVersion: '1.0.0',
        scenarioTitle: 'Booking notification retry',
        durationSeconds: 1800,
        candidateTokenHash: candidateTokenHash(
          randomBytes(32).toString('base64url'),
        ),
        candidateTokenCiphertext: 'v1.different.ciphertext.tag',
        idempotencyKey: idemKey,
        requestHash: reqHash, // Same request hash
        payloadHash: payHash,
      });
      assert.equal(
        caseB.isReplay,
        true,
        'Case B replay returns is_replay = true',
      );
      assert.equal(
        caseB.sessionId,
        sessionMatrixId,
        'Case B returns original session ID',
      );

      // Case C: Conflict with same idempotency key but different request hash
      await assert.rejects(
        async () => {
          await issueAssessment(evaluatorPool, {
            supabaseUserId: FIXTURE_IDS.userA.subjectId,
            organizationId: FIXTURE_IDS.orgA,
            sessionId: `different-session-id-${randomBytes(4).toString('hex')}`,
            scenarioId: 'scenario-002-booking-notification-retry',
            scenarioVersion: '1.0.0',
            scenarioTitle: 'Booking notification retry',
            candidateTokenHash: candidateTokenHash(
              randomBytes(32).toString('base64url'),
            ),
            candidateTokenCiphertext: 'v1.different.ciphertext.tag',
            idempotencyKey: idemKey,
            requestHash: 'completely-different-request-hash',
            payloadHash: 'completely-different-payload-hash',
          });
        },
        (err) => err instanceof R25IdempotencyConflict,
        'Case C must throw R25IdempotencyConflict when request hash differs',
      );

      // Case D: Cross-organization isolation
      // Recruiter B in Org B can use the same idempotency key without conflict
      const sessionOrgB = `r25-sess-org-b-${randomBytes(4).toString('hex')}`;
      const tokenOrgB = randomBytes(32).toString('base64url');
      const caseD = await issueAssessment(evaluatorPool, {
        supabaseUserId: FIXTURE_IDS.recruiterB.subjectId,
        organizationId: FIXTURE_IDS.orgB,
        sessionId: sessionOrgB,
        scenarioId: 'scenario-002-booking-notification-retry',
        scenarioVersion: '1.0.0',
        scenarioTitle: 'Booking notification retry',
        durationSeconds: 1800,
        candidateTokenHash: candidateTokenHash(tokenOrgB),
        candidateTokenCiphertext: encryptCandidateToken(
          tokenOrgB,
          sessionOrgB,
          encryptionKeyA,
        ),
        idempotencyKey: idemKey, // Same idempotency key!
        requestHash: 'org-b-request-hash',
        payloadHash: 'org-b-payload-hash',
      });
      assert.equal(
        caseD.isReplay,
        false,
        'Case D across org returns is_replay = false',
      );
      assert.equal(caseD.organizationId, FIXTURE_IDS.orgB);
      assert.equal(caseD.sessionId, sessionOrgB);

      // Case E: Concurrent convergence
      const concurrentKey = `idem-concurrent-${Date.now()}`;
      const concurrentReqHash = 'req-hash-concurrent';
      const concurrentPayHash = 'pay-hash-concurrent';
      const concurrentSessionId = `r25-sess-conc-${randomBytes(4).toString('hex')}`;
      const concurrentToken = randomBytes(32).toString('base64url');
      const concurrentHash = candidateTokenHash(concurrentToken);
      const concurrentCipher = encryptCandidateToken(
        concurrentToken,
        concurrentSessionId,
        encryptionKeyA,
      );

      const concurrentPromises = Array.from({ length: 5 }, () =>
        issueAssessment(evaluatorPool, {
          supabaseUserId: FIXTURE_IDS.userA.subjectId,
          organizationId: FIXTURE_IDS.orgA,
          sessionId: concurrentSessionId,
          scenarioId: 'scenario-002-booking-notification-retry',
          scenarioVersion: '1.0.0',
          scenarioTitle: 'Booking notification retry',
          durationSeconds: 3600,
          candidateTokenHash: concurrentHash,
          candidateTokenCiphertext: concurrentCipher,
          idempotencyKey: concurrentKey,
          requestHash: concurrentReqHash,
          payloadHash: concurrentPayHash,
        }),
      );

      const results = await Promise.all(concurrentPromises);
      assert.equal(results.length, 5);
      const newCreations = results.filter((r) => r.isReplay === false);
      const replays = results.filter((r) => r.isReplay === true);
      assert.equal(
        newCreations.length,
        1,
        'Exactly one concurrent call creates the session',
      );
      assert.equal(
        replays.length,
        4,
        'Remaining concurrent calls replay safely',
      );
      for (const r of results) {
        assert.equal(r.sessionId, concurrentSessionId);
      }

      // Immutability of assessment_issuances
      await assert.rejects(
        async () => {
          await admin.query(
            `UPDATE hirearchy.assessment_issuances
           SET request_hash = 'tampered-request-hash'
           WHERE idempotency_key = $1`,
            [idemKey],
          );
        },
        /23514|Immutable/,
        'Updating assessment_issuances must be rejected by immutability trigger',
      );

      // Restricted roles cannot SELECT assessment_issuances directly
      for (const [pool, roleName] of [
        [evaluatorPool, 'r23_gateway'],
        [candidatePool, 'app_candidate_gateway'],
        [workerPool, 'app_control_worker'],
      ]) {
        await assert.rejects(
          async () => {
            await pool.query('SELECT * FROM hirearchy.assessment_issuances');
          },
          /permission denied/i,
          `Role ${roleName} must not have direct SELECT on assessment_issuances`,
        );
      }
    }

    // =========================================================================
    // 5. Reviewer Listing & Assignment Lifecycle
    // =========================================================================
    {
      // List organization reviewers
      const reviewersOrgA = await listOrganizationReviewers(evaluatorPool, {
        supabaseUserId: FIXTURE_IDS.userA.subjectId,
        organizationId: FIXTURE_IDS.orgA,
      });

      // In Org A: userAB is active reviewer. userRevoked is revoked (excluded).
      assert.ok(
        reviewersOrgA.some(
          (r) => r.principalId === FIXTURE_IDS.userAB.principalId,
        ),
      );
      assert.ok(
        !reviewersOrgA.some(
          (r) => r.principalId === FIXTURE_IDS.userRevoked.principalId,
        ),
      );
      assert.ok(
        !reviewersOrgA.some(
          (r) => r.principalId === FIXTURE_IDS.userA.principalId,
        ),
      );
      assert.ok(
        !reviewersOrgA.some(
          (r) => r.principalId === FIXTURE_IDS.adminA.principalId,
        ),
      );

      // Assign Reviewer: Issuer Recruiter A assigns Reviewer AB
      const assign1Id = `assign-1-${randomBytes(4).toString('hex')}`;
      const assignment1 = await assignReviewer(evaluatorPool, {
        supabaseUserId: FIXTURE_IDS.userA.subjectId,
        organizationId: FIXTURE_IDS.orgA,
        sessionId: session1Id,
        reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
        assignmentId: assign1Id,
      });

      assert.equal(assignment1.assignmentId, assign1Id);
      assert.equal(assignment1.sessionId, session1Id);
      assert.equal(assignment1.organizationId, FIXTURE_IDS.orgA);
      assert.equal(
        assignment1.reviewerPrincipalId,
        FIXTURE_IDS.userAB.principalId,
      );
      assert.equal(
        assignment1.assignedByPrincipalId,
        FIXTURE_IDS.userA.principalId,
      );
      assert.equal(assignment1.version, 1);
      assert.equal(assignment1.revokedAt, null);
      assert.equal(assignment1.isReplay, false);

      // Non-issuer recruiter (Recruiter A2) cannot assign reviewer to Recruiter A's session
      await assert.rejects(
        async () => {
          await assignReviewer(evaluatorPool, {
            supabaseUserId: FIXTURE_IDS.recruiterA2.subjectId,
            organizationId: FIXTURE_IDS.orgA,
            sessionId: session1Id,
            reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
            assignmentId: `assign-fail-${randomBytes(4).toString('hex')}`,
          });
        },
        (err) =>
          err?.code === 'ROLE_DENIED' || err?.code === 'SESSION_NOT_FOUND',
        'Non-issuer recruiter cannot assign reviewer to this session',
      );

      // Attempting to assign a non-reviewer (e.g. Recruiter A2) fails (INVALID_REVIEWER)
      await assert.rejects(
        async () => {
          await assignReviewer(evaluatorPool, {
            supabaseUserId: FIXTURE_IDS.userA.subjectId,
            organizationId: FIXTURE_IDS.orgA,
            sessionId: session1Id,
            reviewerPrincipalId: FIXTURE_IDS.recruiterA2.principalId,
            assignmentId: `assign-fail-role-${randomBytes(4).toString('hex')}`,
          });
        },
        (err) => err?.code === 'INVALID_REVIEWER',
        'Assigning a non-reviewer must fail',
      );

      // Idempotent assign: Assigning the same active reviewer again returns existing assignment
      const assignReplay = await assignReviewer(evaluatorPool, {
        supabaseUserId: FIXTURE_IDS.userA.subjectId,
        organizationId: FIXTURE_IDS.orgA,
        sessionId: session1Id,
        reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
        assignmentId: `different-assignment-id-${randomBytes(4).toString('hex')}`,
      });
      assert.equal(assignReplay.isReplay, true);
      assert.equal(assignReplay.assignmentId, assign1Id);
      assert.equal(assignReplay.version, 1);

      // List session reviewer assignments
      const assignmentsList = await listSessionReviewerAssignments(
        evaluatorPool,
        {
          supabaseUserId: FIXTURE_IDS.userA.subjectId,
          organizationId: FIXTURE_IDS.orgA,
          sessionId: session1Id,
        },
      );
      assert.equal(assignmentsList.length, 1);
      assert.equal(assignmentsList[0].assignmentId, assign1Id);
      assert.equal(assignmentsList[0].isActive, true);

      // Revoke Reviewer Assignment
      // Non-issuer recruiter cannot revoke
      await assert.rejects(
        async () => {
          await revokeReviewerAssignment(evaluatorPool, {
            supabaseUserId: FIXTURE_IDS.recruiterA2.subjectId,
            organizationId: FIXTURE_IDS.orgA,
            sessionId: session1Id,
            assignmentId: assign1Id,
          });
        },
        (err) =>
          err?.code === 'ROLE_DENIED' || err?.code === 'SESSION_NOT_FOUND',
        'Non-issuer recruiter cannot revoke reviewer assignment',
      );

      // Issuer recruiter revokes assignment
      const revoked = await revokeReviewerAssignment(evaluatorPool, {
        supabaseUserId: FIXTURE_IDS.userA.subjectId,
        organizationId: FIXTURE_IDS.orgA,
        sessionId: session1Id,
        assignmentId: assign1Id,
      });
      assert.equal(revoked, true, 'First revocation returns true');

      // Safe idempotent retry: Revoking already-revoked assignment returns false without error
      const revokeAgain = await revokeReviewerAssignment(evaluatorPool, {
        supabaseUserId: FIXTURE_IDS.userA.subjectId,
        organizationId: FIXTURE_IDS.orgA,
        sessionId: session1Id,
        assignmentId: assign1Id,
      });
      assert.equal(revokeAgain, false, 'Second revocation returns false');

      // Verify session assignments list reflects revocation
      const updatedAssignments = await listSessionReviewerAssignments(
        evaluatorPool,
        {
          supabaseUserId: FIXTURE_IDS.userA.subjectId,
          organizationId: FIXTURE_IDS.orgA,
          sessionId: session1Id,
        },
      );
      assert.equal(updatedAssignments.length, 1);
      assert.equal(updatedAssignments[0].assignmentId, assign1Id);
      assert.equal(updatedAssignments[0].isActive, false);
      assert.ok(updatedAssignments[0].revokedAt);
      assert.equal(updatedAssignments[0].version, 2);

      // Reviewer can be re-assigned after revocation!
      const assign2Id = `assign-2-${randomBytes(4).toString('hex')}`;
      const reassignment = await assignReviewer(evaluatorPool, {
        supabaseUserId: FIXTURE_IDS.userA.subjectId,
        organizationId: FIXTURE_IDS.orgA,
        sessionId: session1Id,
        reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
        assignmentId: assign2Id,
      });
      assert.equal(reassignment.isReplay, false);
      assert.equal(reassignment.assignmentId, assign2Id);
      assert.equal(reassignment.version, 1);

      // Reviewer assignments list now shows 2 assignments (1 active, 1 revoked)
      const twoAssignments = await listSessionReviewerAssignments(
        evaluatorPool,
        {
          supabaseUserId: FIXTURE_IDS.userA.subjectId,
          organizationId: FIXTURE_IDS.orgA,
          sessionId: session1Id,
        },
      );
      assert.equal(twoAssignments.length, 2);
      assert.equal(twoAssignments[0].assignmentId, assign2Id);
      assert.equal(twoAssignments[0].isActive, true);
      assert.equal(twoAssignments[1].assignmentId, assign1Id);
      assert.equal(twoAssignments[1].isActive, false);
    }

    // =========================================================================
    // 6. Atomicity & Rollback Guarantees
    // =========================================================================
    {
      const failSessionId = `r25-sess-rollback-${randomBytes(4).toString('hex')}`;

      // Attempting to insert a duplicate token hash must fail and rollback session
      await assert.rejects(
        async () => {
          await issueAssessment(evaluatorPool, {
            supabaseUserId: FIXTURE_IDS.userA.subjectId,
            organizationId: FIXTURE_IDS.orgA,
            sessionId: failSessionId,
            scenarioId: 'scenario-002-booking-notification-retry',
            scenarioVersion: '1.0.0',
            scenarioTitle: 'Booking notification retry',
            candidateTokenHash: tokenHash1, // duplicate hash of session1!
            candidateTokenCiphertext: 'v1.dummy.dummy.dummy',
          });
        },
        /unique constraint|duplicate key/i,
        'Duplicate candidate token hash must violate unique constraint',
      );

      // Verify session was NOT created (rollback)
      const { rows: orphanRows } = await admin.query(
        'SELECT id FROM hirearchy.assessment_sessions WHERE id = $1',
        [failSessionId],
      );
      assert.equal(
        orphanRows.length,
        0,
        'Transaction must rollback completely on token envelope failure',
      );
    }
  } finally {
    await admin.query('DELETE FROM hirearchy.candidate_token_storage_meta');
    if (priorStorageMarker.rowCount === 1) {
      const [prior] = priorStorageMarker.rows;
      await admin.query(
        `INSERT INTO hirearchy.candidate_token_storage_meta
          (slot, version, database_id, key_check) VALUES ($1, $2, $3, $4)`,
        [prior.slot, prior.version, prior.database_id, prior.key_check],
      );
    }
    if (locallyCreatedPools) {
      await evaluatorPool?.end().catch(() => {});
      await candidatePool?.end().catch(() => {});
      await workerPool?.end().catch(() => {});
    }
  }
}

// Standalone runner if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const adminPassword = randomBytes(24).toString('base64url');
  const runtimePassword = randomBytes(24).toString('base64url');
  const name = `hirearchy-r25-pg-${process.pid}-${randomBytes(4).toString('hex')}`;

  function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new Error(
        `${command} failed: ${result.stderr || result.error?.message || ''}`,
      );
    }
    return String(result.stdout ?? '').trim();
  }

  let admin;
  let evaluatorPool;
  let candidatePool;
  let workerPool;
  let migrator;

  try {
    run('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      `POSTGRES_PASSWORD=${adminPassword}`,
      POSTGRES_IMAGE,
    ]);

    const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(
      run('docker', ['port', name, '5432/tcp']),
    );
    if (!portMatch) throw new Error('PostgreSQL container port mapping failed');
    const port = Number(portMatch[1]);

    const connection = {
      host: '127.0.0.1',
      port,
      database: 'postgres',
    };

    let ready = false;
    for (let i = 0; i < 50; i++) {
      const probe = new Client({
        ...connection,
        user: 'postgres',
        password: adminPassword,
      });
      try {
        await probe.connect();
        await probe.query('SELECT 1');
        await probe.end();
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!ready) throw new Error('Database failed to start in time');

    admin = new Client({
      ...connection,
      user: 'postgres',
      password: adminPassword,
    });
    await admin.connect();

    // Bootstrap roles
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const bootstrapSql = readFileSync(
      join(root, 'database/postgres/bootstrap-roles.sql'),
      'utf8',
    );
    await admin.query(bootstrapSql);
    await admin.query(`
      ALTER ROLE hirearchy_migrator PASSWORD '${adminPassword}';
      ALTER ROLE app_evaluator PASSWORD '${runtimePassword}';
      ALTER ROLE app_candidate_gateway PASSWORD '${runtimePassword}';
      ALTER ROLE app_control_worker PASSWORD '${runtimePassword}';
      CREATE ROLE r23_gateway LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    `);

    // Run migrations (0001, 0002, 0003)
    migrator = new Client({
      ...connection,
      user: 'hirearchy_migrator',
      password: adminPassword,
    });
    await migrator.connect();
    await applyMigrations(migrator);
    await migrator.end();
    migrator = undefined;

    // Apply disposable R2.3 / R2.4 / R2.5 fixture schema
    await applyR23DisposableSchema(admin);

    // Seed test fixtures
    await seedR24SessionFixtures(admin);

    evaluatorPool = new Pool({
      ...connection,
      user: 'r23_gateway',
      password: runtimePassword,
      max: 5,
    });

    candidatePool = new Pool({
      ...connection,
      user: 'app_candidate_gateway',
      password: runtimePassword,
      max: 2,
    });

    workerPool = new Pool({
      ...connection,
      user: 'app_control_worker',
      password: runtimePassword,
      max: 2,
    });

    await runR25PostgresIssuanceSecurityChecks({
      admin,
      evaluatorPool,
      candidatePool,
      workerPool,
      connection,
      password: adminPassword,
    });

    console.log(
      'PASS R2.5 PostgreSQL assessment issuance, token security, idempotency, and reviewer assignment checks',
    );
  } finally {
    await evaluatorPool?.end().catch(() => {});
    await candidatePool?.end().catch(() => {});
    await workerPool?.end().catch(() => {});
    await migrator?.end().catch(() => {});
    await admin?.end().catch(() => {});
    try {
      run('docker', ['stop', '--time', '5', name]);
    } catch {}
  }
}
