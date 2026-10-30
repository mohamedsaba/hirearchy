import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Pool } from 'pg';
import {
  assertCandidateTokenStorage,
  initializeCandidateTokenStorage,
} from '../../database/postgres/r23/adapter.mjs';
import { applyMigrations } from '../../database/postgres/migrate.mjs';
import { installR27EvidenceFixture } from '../../database/postgres/r27/adapter.mjs';
import { installR212AiFixture } from '../../database/postgres/r212/adapter.mjs';
import {
  installR213ExecutionFixture,
  createR213ExecutionAdapter,
  getEvaluatorExecutions,
} from '../../database/postgres/r213/adapter.mjs';

const RESTRICTED_RECIPE_ID = 'reservation-moves.pytest';
const RESTRICTED_RECIPE_VERSION = '3';
const RESTRICTED_RECIPE_DIGEST =
  'eeac2baaf62ce107c7511268e862657ae24bb171cd1dec6ca01797c16ffbaad8';
const RESTRICTED_EXECUTOR_PROVENANCE = 'restricted-executor-service';

const SYNTHETIC_RECIPE_ID = 'recipe-python-check-v1';
const SYNTHETIC_RECIPE_VERSION = '1.0.0';
const SYNTHETIC_RECIPE_DIGEST =
  '0760fc4197b0b1654be37456fc70f7c1a9159520ca78cd5b3115e7a5affd6fd2';

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomSessionId(label) {
  return `sess_r214_${label}_${randomBytes(8).toString('hex')}`;
}

function createScenarioSnapshot(
  scenarioId = 'reservation-moves',
  scenarioVersion = 'v3',
  title = 'Reservation moves',
  durationSeconds = 600,
) {
  return {
    scenario: {
      id: scenarioId,
      version: scenarioVersion,
      templateId: 'reservation-moves-v3',
      recipe: {
        id: RESTRICTED_RECIPE_ID,
        version: RESTRICTED_RECIPE_VERSION,
        digest: RESTRICTED_RECIPE_DIGEST,
      },
      starterWorkspaceDigest:
        'c1e172b193fd0c5e78f81ef5bf74ea95a07b6be3215829d5fa8e5116423b0694',
      validatedVersionId: randomUUID(),
      validatedContentDigest: 'a'.repeat(64),
      title,
      durationSeconds,
      brief: 'Test scenario for R2.14 Execution bridge verification.',
      acceptanceCriteria: ['Pass reservation moves unit tests.'],
      filePath: 'reservation.py',
      type: 'single_file',
      originalContent: 'def move(): pass\n',
    },
    workspaceFiles: {
      'reservation.py': 'def move(): pass\n',
    },
  };
}

async function createTestSession(
  admin,
  candidatePool,
  {
    label,
    organizationId,
    issuerPrincipalId,
    scenarioId = 'reservation-moves',
    scenarioVersion = 'v3',
    scenarioTitle = 'Reservation moves',
    durationSeconds = 600,
    terminalEnabled = true,
    activate = true,
    submit = false,
    pastDeadline = false,
  } = {},
) {
  const sessionId = randomSessionId(label);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hash(token);
  const scenarioJson = JSON.stringify(
    createScenarioSnapshot(
      scenarioId,
      scenarioVersion,
      scenarioTitle,
      durationSeconds,
    ),
  );

  if (pastDeadline) {
    const twoHoursAgo = new Date(Date.now() - 7200 * 1000);
    const threeHoursAgo = new Date(Date.now() - 10800 * 1000);
    await admin.query(
      `INSERT INTO hirearchy.assessment_sessions (
         id, organization_id, issuer_principal_id, scenario_id,
         scenario_version, scenario_title, status, created_at, activated_at, duration_seconds,
         terminal_enabled, task_rubric_snapshot, ai_capability_snapshot,
         scenario_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, $9, $10, NULL, NULL, $11)`,
      [
        sessionId,
        organizationId,
        issuerPrincipalId,
        scenarioId,
        scenarioVersion,
        scenarioTitle,
        threeHoursAgo,
        twoHoursAgo,
        durationSeconds,
        terminalEnabled,
        scenarioJson,
      ],
    );

    await admin.query(
      `INSERT INTO hirearchy.candidate_session_events (
         organization_id, session_id, sequence, event_type, happened_at, payload
       ) VALUES ($1, $2, 1, 'SESSION_ACTIVATED', $3, '{"scenarioDigest":"abc"}'::pg_catalog.jsonb)`,
      [organizationId, sessionId, twoHoursAgo],
    );
  } else {
    await admin.query(
      `INSERT INTO hirearchy.assessment_sessions (
         id, organization_id, issuer_principal_id, scenario_id,
         scenario_version, scenario_title, status, duration_seconds,
         terminal_enabled, task_rubric_snapshot, ai_capability_snapshot,
         scenario_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, 'CREATED', $7, $8, NULL, NULL, $9)`,
      [
        sessionId,
        organizationId,
        issuerPrincipalId,
        scenarioId,
        scenarioVersion,
        scenarioTitle,
        durationSeconds,
        terminalEnabled,
        scenarioJson,
      ],
    );
  }

  await admin.query(
    `INSERT INTO hirearchy.candidate_token_envelopes (
       organization_id, session_id, candidate_token_hash,
       candidate_token_ciphertext
     ) VALUES ($1, $2, $3, $4)`,
    [organizationId, sessionId, tokenHash, 'synthetic-ciphertext'],
  );

  let workspaceDigest = null;

  if (activate && !pastDeadline) {
    await candidatePool.query(
      `SELECT hirearchy.r26_candidate_command($1, $2, 'activate', '{}'::pg_catalog.jsonb)`,
      [tokenHash, sessionId],
    );

    const { rows } = await admin.query(
      `SELECT state.workspace_digest FROM hirearchy.r26_workspace_state($1) AS state`,
      [sessionId],
    );
    workspaceDigest = rows[0]?.workspace_digest;

    if (submit) {
      await candidatePool.query(
        `SELECT hirearchy.r26_candidate_command($1, $2, 'submit', jsonb_build_object('requestId', $3::text, 'expectedWorkspaceDigest', $4::text))`,
        [
          tokenHash,
          sessionId,
          `req_sub_${randomBytes(4).toString('hex')}`,
          workspaceDigest,
        ],
      );
    }
  }

  return { sessionId, token, tokenHash, organizationId, workspaceDigest };
}

export async function runR214PostgresBridgeSecurityChecks({
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

  const orgA = randomUUID();
  const orgB = randomUUID();
  const recruiterA = randomUUID();
  const recruiterB = randomUUID();
  const reviewerA = randomUUID();
  const reviewerB = randomUUID();

  await admin.query(
    'INSERT INTO hirearchy.organizations (id) VALUES ($1), ($2)',
    [orgA, orgB],
  );

  await admin.query(
    `INSERT INTO hirearchy.application_principals (id, auth_user_id) VALUES
     ($1, $2), ($3, $4), ($5, $6), ($7, $8)`,
    [
      recruiterA,
      randomUUID(),
      recruiterB,
      randomUUID(),
      reviewerA,
      randomUUID(),
      reviewerB,
      randomUUID(),
    ],
  );

  await admin.query(
    `INSERT INTO hirearchy.organization_memberships (organization_id, principal_id, role, status, joined_at, version) VALUES
     ($1, $2, 'recruiter', 'active', clock_timestamp(), 1),
     ($3, $4, 'recruiter', 'active', clock_timestamp(), 1),
     ($5, $6, 'reviewer', 'active', clock_timestamp(), 1),
     ($7, $8, 'reviewer', 'active', clock_timestamp(), 1)`,
    [orgA, recruiterA, orgB, recruiterB, orgA, reviewerA, orgB, reviewerB],
  );

  const candidatePool = new Pool({
    ...connection,
    user: 'app_candidate_gateway',
    password: runtimePassword,
    max: 15,
  });

  const evaluatorPool = new Pool({
    ...connection,
    user: 'app_evaluator',
    password: runtimePassword,
    max: 5,
  });

  const adapter = createR213ExecutionAdapter({ pool: candidatePool });

  const sessionHelper = (opts = {}) =>
    createTestSession(admin, candidatePool, {
      organizationId: orgA,
      issuerPrincipalId: opts.organizationId === orgB ? recruiterB : recruiterA,
      ...opts,
    });

  try {
    console.log(
      '--- Starting R2.14 PostgreSQL Trusted Execution Bridge Security Check Suite ---',
    );

    // =========================================================================
    // Check 1: Scenario Whitelist Gating (restricted-executor admits reservation-moves v3, denies others)
    // =========================================================================
    console.log(
      'Check 1: Scenario whitelist gating for real restricted executor recipe',
    );
    {
      // 1A. Matching scenario 'reservation-moves' v3
      const validSession = await sessionHelper({
        label: 'chk1_valid_scen',
        scenarioId: 'reservation-moves',
        scenarioVersion: 'v3',
      });

      const admitValid = await adapter.admitCandidateExecution({
        tokenHash: validSession.tokenHash,
        sessionId: validSession.sessionId,
        requestId: 'req_chk1_valid',
        expectedWorkspaceDigest: validSession.workspaceDigest,
        recipeId: RESTRICTED_RECIPE_ID,
        recipeVersion: RESTRICTED_RECIPE_VERSION,
        recipeDigest: RESTRICTED_RECIPE_DIGEST,
        provenance: RESTRICTED_EXECUTOR_PROVENANCE,
      });

      assert.equal(admitValid.status, 'ADMITTED');
      assert.equal(admitValid.operation.recipeId, RESTRICTED_RECIPE_ID);
      assert.equal(
        admitValid.operation.provenance,
        RESTRICTED_EXECUTOR_PROVENANCE,
      );
      assert.equal(admitValid.operation.isSynthetic, false);

      // Complete execution and verify provenance is preserved
      const completedValid = await adapter.completeCandidateExecution({
        tokenHash: validSession.tokenHash,
        sessionId: validSession.sessionId,
        operationId: admitValid.operation.operationId,
        fence: admitValid.operation.fence,
        generation: 1,
        exitCode: 0,
        stdout: 'pytest -q PASSED',
        stderr: '',
        durationMs: 380,
        cleanupStatus: 'CLEAN',
        provenance: RESTRICTED_EXECUTOR_PROVENANCE,
      });

      assert.equal(completedValid.status, 'COMPLETED');
      assert.equal(completedValid.provenance, RESTRICTED_EXECUTOR_PROVENANCE);
      assert.equal(completedValid.isSynthetic, false);

      // 1B. Incompatible scenario (e.g. scenario-002) attempting restricted executor recipe
      const nonReservationSession = await sessionHelper({
        label: 'chk1_invalid_scen',
        scenarioId: 'scenario-002-booking-notification-retry',
        scenarioVersion: '1.0.0',
      });

      const admitInvalid = await adapter.admitCandidateExecution({
        tokenHash: nonReservationSession.tokenHash,
        sessionId: nonReservationSession.sessionId,
        requestId: 'req_chk1_invalid',
        expectedWorkspaceDigest: nonReservationSession.workspaceDigest,
        recipeId: RESTRICTED_RECIPE_ID,
        recipeVersion: RESTRICTED_RECIPE_VERSION,
        recipeDigest: RESTRICTED_RECIPE_DIGEST,
        provenance: RESTRICTED_EXECUTOR_PROVENANCE,
      });

      assert.equal(admitInvalid.status, 'DENIED');
      assert.equal(admitInvalid.reason, 'SCENARIO_INCOMPATIBLE');

      const wrongVersion = await sessionHelper({
        label: 'chk1_invalid_version',
        scenarioId: 'reservation-moves',
        scenarioVersion: 'v2',
      });
      const admitWrongVersion = await adapter.admitCandidateExecution({
        tokenHash: wrongVersion.tokenHash,
        sessionId: wrongVersion.sessionId,
        requestId: 'req_chk1_invalid_version',
        expectedWorkspaceDigest: wrongVersion.workspaceDigest,
        recipeId: RESTRICTED_RECIPE_ID,
        recipeVersion: RESTRICTED_RECIPE_VERSION,
        recipeDigest: RESTRICTED_RECIPE_DIGEST,
        provenance: RESTRICTED_EXECUTOR_PROVENANCE,
      });
      assert.equal(admitWrongVersion.status, 'DENIED');
      assert.equal(admitWrongVersion.reason, 'SCENARIO_INCOMPATIBLE');
    }
    console.log('  PASS Check 1');

    // =========================================================================
    // Check 2: Stale workspace digest conflict (409 STALE_WORKSPACE)
    // =========================================================================
    console.log('Check 2: Stale workspace digest conflict');
    {
      const s = await sessionHelper({ label: 'chk2_stale' });
      const bogusDigest =
        '0000000000000000000000000000000000000000000000000000000000000000';

      const admitRes = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_chk2_stale',
        expectedWorkspaceDigest: bogusDigest,
        recipeId: SYNTHETIC_RECIPE_ID,
        recipeVersion: SYNTHETIC_RECIPE_VERSION,
        recipeDigest: SYNTHETIC_RECIPE_DIGEST,
      });

      assert.equal(admitRes.status, 'DENIED');
      assert.equal(admitRes.reason, 'STALE_WORKSPACE');
    }
    console.log('  PASS Check 2');

    // =========================================================================
    // Check 3: Budget and deadline checks before dispatch
    // =========================================================================
    console.log('Check 3: Budget and deadline checks before dispatch');
    {
      // 3A. Deadline expiration
      const expiredSession = await sessionHelper({
        label: 'chk3_expired',
        pastDeadline: true,
      });

      const expiredAdmit = await adapter.admitCandidateExecution({
        tokenHash: expiredSession.tokenHash,
        sessionId: expiredSession.sessionId,
        requestId: 'req_chk3_expired',
        expectedWorkspaceDigest:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      });
      assert.equal(expiredAdmit.status, 'DENIED');
      assert.equal(expiredAdmit.reason, 'DEADLINE_EXCEEDED');

      // 3B. Execution budget exhaustion (10 runs limit)
      const budgetSession = await sessionHelper({ label: 'chk3_budget' });
      for (let i = 1; i <= 10; i++) {
        const ad = await adapter.admitCandidateExecution({
          tokenHash: budgetSession.tokenHash,
          sessionId: budgetSession.sessionId,
          requestId: `req_budget_${i}`,
          expectedWorkspaceDigest: budgetSession.workspaceDigest,
        });
        assert.equal(ad.status, 'ADMITTED');

        await adapter.completeCandidateExecution({
          tokenHash: budgetSession.tokenHash,
          sessionId: budgetSession.sessionId,
          operationId: ad.operation.operationId,
          fence: ad.operation.fence,
          generation: 1,
          exitCode: 0,
        });
      }

      // 11th run attempt
      const exhaustedAdmit = await adapter.admitCandidateExecution({
        tokenHash: budgetSession.tokenHash,
        sessionId: budgetSession.sessionId,
        requestId: 'req_budget_11',
        expectedWorkspaceDigest: budgetSession.workspaceDigest,
      });
      assert.equal(exhaustedAdmit.status, 'DENIED');
      assert.equal(exhaustedAdmit.reason, 'BUDGET_EXHAUSTED');
    }
    console.log('  PASS Check 3');

    // =========================================================================
    // Check 4: Foreign bearer / cross-tenant denial
    // =========================================================================
    console.log('Check 4: Foreign bearer and cross-tenant denial');
    {
      const sA = await sessionHelper({
        label: 'chk4_sA',
        organizationId: orgA,
      });
      const sB = await sessionHelper({
        label: 'chk4_sB',
        organizationId: orgB,
      });

      // Token of sA against session of sB
      await assert.rejects(
        () =>
          adapter.admitCandidateExecution({
            tokenHash: sA.tokenHash,
            sessionId: sB.sessionId,
            requestId: 'req_chk4_cross',
            expectedWorkspaceDigest: sB.workspaceDigest,
          }),
        (err) => err?.code === '42501',
      );

      // Unauthenticated token
      await assert.rejects(
        () =>
          adapter.admitCandidateExecution({
            tokenHash: hash('bogus-token'),
            sessionId: sA.sessionId,
            requestId: 'req_chk4_unauth',
            expectedWorkspaceDigest: sA.workspaceDigest,
          }),
        (err) => err?.code === '42501',
      );
    }
    console.log('  PASS Check 4');

    // =========================================================================
    // Check 5: Duplicate request replay
    // =========================================================================
    console.log('Check 5: Duplicate request replay idempotent response');
    {
      const s = await sessionHelper({ label: 'chk5_replay' });
      const reqId = 'req_chk5_idempotent';

      const ad = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: reqId,
        expectedWorkspaceDigest: s.workspaceDigest,
        recipeId: RESTRICTED_RECIPE_ID,
        recipeVersion: RESTRICTED_RECIPE_VERSION,
        recipeDigest: RESTRICTED_RECIPE_DIGEST,
        provenance: RESTRICTED_EXECUTOR_PROVENANCE,
      });
      assert.equal(ad.status, 'ADMITTED');

      await adapter.completeCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        operationId: ad.operation.operationId,
        fence: ad.operation.fence,
        generation: 1,
        exitCode: 0,
        stdout: 'Completed real run',
        provenance: RESTRICTED_EXECUTOR_PROVENANCE,
      });

      // Re-admit identical request
      const replayAd = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: reqId,
        expectedWorkspaceDigest: s.workspaceDigest,
        recipeId: RESTRICTED_RECIPE_ID,
        recipeVersion: RESTRICTED_RECIPE_VERSION,
        recipeDigest: RESTRICTED_RECIPE_DIGEST,
        provenance: RESTRICTED_EXECUTOR_PROVENANCE,
      });
      assert.equal(replayAd.status, 'REPLAY');
      assert.equal(replayAd.operation.operationId, ad.operation.operationId);
      assert.equal(replayAd.operation.status, 'COMPLETED');
      assert.equal(
        replayAd.operation.provenance,
        RESTRICTED_EXECUTOR_PROVENANCE,
      );
      assert.equal(replayAd.operation.isSynthetic, false);
    }
    console.log('  PASS Check 5');

    // =========================================================================
    // Check 6: Changed intent conflict (409 REQUEST_CONFLICT)
    // =========================================================================
    console.log('Check 6: Changed intent conflict on request ID reuse');
    {
      const s = await sessionHelper({ label: 'chk6_conflict' });
      const reqId = 'req_chk6_conflict_01';

      const ad = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: reqId,
        expectedWorkspaceDigest: s.workspaceDigest,
      });
      assert.equal(ad.status, 'ADMITTED');

      // Attempt to reuse reqId with different expected workspace digest
      const changedDigest =
        '1111111111111111111111111111111111111111111111111111111111111111';
      const conflictAd = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: reqId,
        expectedWorkspaceDigest: changedDigest,
      });
      assert.equal(conflictAd.status, 'CONFLICT');
    }
    console.log('  PASS Check 6');

    // =========================================================================
    // Check 7: Fencing & generation consistency
    // =========================================================================
    console.log('Check 7: Fencing and generation consistency');
    {
      const s = await sessionHelper({ label: 'chk7_fencing' });
      const ad = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_chk7_fencing',
        expectedWorkspaceDigest: s.workspaceDigest,
      });
      assert.equal(ad.status, 'ADMITTED');

      // Stale fence rejected
      await assert.rejects(
        () =>
          adapter.completeCandidateExecution({
            tokenHash: s.tokenHash,
            sessionId: s.sessionId,
            operationId: ad.operation.operationId,
            fence: Number(ad.operation.fence) + 99,
            generation: 1,
            exitCode: 0,
          }),
        (err) => err?.code === '23514',
      );

      // Stale generation rejected
      await assert.rejects(
        () =>
          adapter.completeCandidateExecution({
            tokenHash: s.tokenHash,
            sessionId: s.sessionId,
            operationId: ad.operation.operationId,
            fence: ad.operation.fence,
            generation: 2,
            exitCode: 0,
          }),
        (err) => err?.code === '23514',
      );
    }
    console.log('  PASS Check 7');

    // =========================================================================
    // Check 8: UNKNOWN outcome preservation
    // =========================================================================
    console.log(
      'Check 8: UNKNOWN outcome preservation and cleanup verification',
    );
    {
      const s = await sessionHelper({ label: 'chk8_unknown' });
      const ad = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_chk8_unknown',
        expectedWorkspaceDigest: s.workspaceDigest,
        recipeId: RESTRICTED_RECIPE_ID,
        recipeVersion: RESTRICTED_RECIPE_VERSION,
        recipeDigest: RESTRICTED_RECIPE_DIGEST,
        provenance: RESTRICTED_EXECUTOR_PROVENANCE,
      });
      assert.equal(ad.status, 'ADMITTED');

      const failed = await adapter.failCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        operationId: ad.operation.operationId,
        fence: ad.operation.fence,
        generation: 1,
        status: 'UNKNOWN',
        failureReason: 'EXECUTION_UNKNOWN',
        errorMessage: 'Worker lost contact with container daemon',
        cleanupStatus: 'UNKNOWN',
        isUnknown: true,
        provenance: RESTRICTED_EXECUTOR_PROVENANCE,
      });

      assert.equal(failed.status, 'UNKNOWN');
      assert.equal(failed.isUnknown, true);
      assert.equal(failed.cleanupStatus, 'UNKNOWN');
      assert.equal(failed.provenance, RESTRICTED_EXECUTOR_PROVENANCE);
      assert.equal(failed.isSynthetic, false);

      // Check view: UNKNOWN remains UNKNOWN
      const view = await adapter.getCandidateExecutionsView({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
      });
      const op = view.operations.find(
        (o) => o.operationId === ad.operation.operationId,
      );
      assert.ok(op);
      assert.equal(op.status, 'UNKNOWN');
      assert.equal(op.isUnknown, true);
      assert.equal(op.cleanupStatus, 'UNKNOWN');
      assert.equal(op.provenance, RESTRICTED_EXECUTOR_PROVENANCE);
      assert.equal(op.isSynthetic, false);
    }
    console.log('  PASS Check 8');

    // =========================================================================
    // Check 9: Submitted candidate finality
    // =========================================================================
    console.log('Check 9: Submitted candidate finality');
    {
      const submittedSession = await sessionHelper({
        label: 'chk9_submitted',
        submit: true,
      });

      // Attempt to admit in submitted session
      const submitAdmit = await adapter.admitCandidateExecution({
        tokenHash: submittedSession.tokenHash,
        sessionId: submittedSession.sessionId,
        requestId: 'req_chk9_submitted',
        expectedWorkspaceDigest: submittedSession.workspaceDigest,
      });
      assert.equal(submitAdmit.status, 'DENIED');
      assert.equal(submitAdmit.reason, 'SESSION_CLOSED');

      // Modifying completed operation is rejected
      const activeSession = await sessionHelper({ label: 'chk9_mod' });
      const ad = await adapter.admitCandidateExecution({
        tokenHash: activeSession.tokenHash,
        sessionId: activeSession.sessionId,
        requestId: 'req_chk9_mod',
        expectedWorkspaceDigest: activeSession.workspaceDigest,
      });
      await adapter.completeCandidateExecution({
        tokenHash: activeSession.tokenHash,
        sessionId: activeSession.sessionId,
        operationId: ad.operation.operationId,
        fence: ad.operation.fence,
        generation: 1,
        exitCode: 0,
      });

      await assert.rejects(
        () =>
          admin.query(
            `UPDATE hirearchy.candidate_execution_operations SET exit_code = 99 WHERE operation_id = $1`,
            [ad.operation.operationId],
          ),
        (err) => err?.code === '23514',
      );
    }
    console.log('  PASS Check 9');

    // =========================================================================
    // Check 10: No secret/token leakage
    // =========================================================================
    console.log('Check 10: No secret or credential leakage across views');
    {
      const s = await sessionHelper({ label: 'chk10_leak' });
      const ad = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_chk10_leak',
        expectedWorkspaceDigest: s.workspaceDigest,
      });

      await adapter.completeCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        operationId: ad.operation.operationId,
        fence: ad.operation.fence,
        generation: 1,
        exitCode: 0,
        stdout: 'test output',
      });

      const candidateView = await adapter.getCandidateExecutionsView({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
      });

      const serializedView = JSON.stringify(candidateView);
      assert.ok(!serializedView.includes('ciphertext'));
      assert.ok(!serializedView.includes(s.token));
      assert.ok(!serializedView.includes(s.tokenHash));
      assert.ok(!serializedView.includes(runtimePassword));

      // Evaluator view query check
      const reviewerAssignment = randomUUID();
      await admin.query(
        `INSERT INTO hirearchy.reviewer_assignments (
           id, organization_id, session_id, reviewer_principal_id, assigned_by_principal_id, assigned_at, version
         ) VALUES ($1, $2, $3, $4, $5, clock_timestamp(), 1)`,
        [reviewerAssignment, orgA, s.sessionId, reviewerA, recruiterA],
      );

      // Submit session so reviewer can inspect
      await candidatePool.query(
        `SELECT hirearchy.r26_candidate_command($1, $2, 'submit', jsonb_build_object('requestId', $3::text, 'expectedWorkspaceDigest', $4::text))`,
        [s.tokenHash, s.sessionId, 'req_sub_leak', s.workspaceDigest],
      );

      const evaluatorExecutions = await getEvaluatorExecutions(evaluatorPool, {
        organizationId: orgA,
        sessionId: s.sessionId,
        reviewerPrincipalId: reviewerA,
      });

      const serializedEvaluator = JSON.stringify(evaluatorExecutions);
      assert.ok(!serializedEvaluator.includes('ciphertext'));
      assert.ok(!serializedEvaluator.includes(s.token));
      assert.ok(!serializedEvaluator.includes(s.tokenHash));
      assert.ok(!serializedEvaluator.includes(runtimePassword));
    }
    console.log('  PASS Check 10');

    console.log(
      '=== All 10 R2.14 PostgreSQL Trusted Execution Bridge Security Checks Passed! ===',
    );
  } finally {
    await candidatePool.end().catch(() => {});
    await evaluatorPool.end().catch(() => {});
  }
}

// Standalone runner using disposable PostgreSQL container
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  function docker(...args) {
    return execFileSync('docker', args, { encoding: 'utf8' }).trim();
  }

  async function waitFor(fn, timeoutMs = 25000, intervalMs = 200) {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeoutMs) {
      try {
        if (await fn()) return;
      } catch (error) {
        lastError = error;
      }
      await delay(intervalMs);
    }
    throw new Error(
      `Timeout waiting for condition: ${lastError?.message ?? ''}`,
    );
  }

  const runId = randomBytes(6).toString('hex');
  const network = `hirearchy-r214-net-${runId}`;
  const database = `hirearchy-r214-db-${runId}-db`;
  const password = `pg-secret-${runId}`;
  const runtimePassword = `runtime-secret-${runId}`;
  const pgImage = 'postgres:16-alpine';

  let adminClient;
  let migratorClient;

  try {
    console.log(`Spinning up disposable PostgreSQL container: ${database}`);
    docker('network', 'create', network);
    docker(
      'run',
      '-d',
      '--name',
      database,
      '--network',
      network,
      '--network-alias',
      'db',
      '-p',
      '127.0.0.1::5432',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '--tmpfs',
      '/var/lib/postgresql/data',
      pgImage,
    );

    const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(
      docker('port', database, '5432/tcp'),
    );
    assert.ok(portMatch, 'Failed to get mapped port for database');
    const port = Number(portMatch[1]);
    const connection = {
      host: '127.0.0.1',
      port,
      database: 'postgres',
      connectionTimeoutMillis: 3000,
    };

    await waitFor(async () => {
      const probe = new Client({ ...connection, user: 'postgres', password });
      try {
        await probe.connect();
        await probe.query('SELECT 1');
        return true;
      } finally {
        await probe.end().catch(() => {});
      }
    });

    adminClient = new Client({ ...connection, user: 'postgres', password });
    await adminClient.connect();

    // Bootstrap roles
    await adminClient.query(
      readFileSync(
        new URL('../../database/postgres/bootstrap-roles.sql', import.meta.url),
        'utf8',
      ),
    );

    await adminClient.query(`
      ALTER ROLE hirearchy_migrator PASSWORD '${password}';
      ALTER ROLE app_evaluator PASSWORD '${runtimePassword}';
      ALTER ROLE app_candidate_gateway PASSWORD '${runtimePassword}';
      ALTER ROLE app_control_worker PASSWORD '${runtimePassword}';
      CREATE ROLE r23_gateway LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      CREATE ROLE supabase_auth_admin LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
      ALTER ROLE supabase_auth_admin SET search_path = auth;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    `);

    // Run migrations 0001 through 0011
    migratorClient = new Client({
      ...connection,
      user: 'hirearchy_migrator',
      password,
    });
    await migratorClient.connect();
    const { appliedVersions } = await applyMigrations(migratorClient);
    console.log(`Applied migrations: ${appliedVersions.join(', ')}`);
    await migratorClient.end();
    migratorClient = undefined;

    // Install fixtures (r23, r27, r212, r213)
    await adminClient.query(
      readFileSync(
        new URL('../../database/postgres/r23/fixture.sql', import.meta.url),
        'utf8',
      ),
    );
    await installR27EvidenceFixture(adminClient);
    await installR212AiFixture(adminClient);
    await installR213ExecutionFixture(adminClient);

    const candidateTokenKey = randomBytes(32).toString('base64');
    await adminClient.query(
      'DELETE FROM hirearchy.candidate_token_storage_meta',
    );
    await initializeCandidateTokenStorage(adminClient, {
      key: Buffer.from(candidateTokenKey, 'base64'),
    });

    await runR214PostgresBridgeSecurityChecks({
      admin: adminClient,
      connection,
      runtimePassword,
      candidateTokenKey,
    });

    console.log('PostgreSQL Bridge Security Check completed successfully!');
  } catch (error) {
    console.error('Test run failed:', error);
    process.exitCode = 1;
  } finally {
    try {
      await migratorClient?.end().catch(() => {});
      await adminClient?.end().catch(() => {});
    } catch {}
    try {
      docker('rm', '-f', database);
    } catch {}
    try {
      docker('network', 'rm', network);
    } catch {}
  }
}
