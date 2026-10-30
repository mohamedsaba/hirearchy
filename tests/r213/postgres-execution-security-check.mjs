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

const SCENARIO_ID = 'scenario-002-booking-notification-retry';
const SCENARIO_VERSION = '1.0.0';
const SCENARIO_TITLE = 'Booking notification retry';
const APPROVED_RECIPE_ID = 'recipe-python-check-v1';
const APPROVED_RECIPE_VERSION = '1.0.0';
const APPROVED_RECIPE_DIGEST =
  '0760fc4197b0b1654be37456fc70f7c1a9159520ca78cd5b3115e7a5affd6fd2';

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomSessionId(label) {
  return `sess_r213_${label}_${randomBytes(8).toString('hex')}`;
}

function defaultScenarioSnapshot(durationSeconds = 600) {
  return {
    scenario: {
      id: SCENARIO_ID,
      version: SCENARIO_VERSION,
      title: SCENARIO_TITLE,
      durationSeconds,
      brief: 'Synthetic scenario for R2.13 Execution verification.',
      acceptanceCriteria: ['Implement booking retry with exponential backoff.'],
      filePath: 'bookings/service.py',
      type: 'single_file',
      originalContent: 'def confirm(): pass\n',
    },
    workspaceFiles: {
      'bookings/service.py': 'def confirm(): pass\n',
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
  const scenarioJson = JSON.stringify(defaultScenarioSnapshot(durationSeconds));

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
        SCENARIO_ID,
        SCENARIO_VERSION,
        SCENARIO_TITLE,
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
        SCENARIO_ID,
        SCENARIO_VERSION,
        SCENARIO_TITLE,
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

export async function runR213PostgresExecutionSecurityChecks({
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

  // Setup test organizations and principals
  const orgA = randomUUID();
  const orgB = randomUUID();
  const recruiterA = randomUUID();
  const reviewerA = randomUUID();
  const reviewerB = randomUUID();

  await admin.query(
    'INSERT INTO hirearchy.organizations (id) VALUES ($1), ($2)',
    [orgA, orgB],
  );

  await admin.query(
    `INSERT INTO hirearchy.application_principals (id, auth_user_id) VALUES
     ($1, $2), ($3, $4), ($5, $6)`,
    [
      recruiterA,
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
     ($3, $4, 'reviewer', 'active', clock_timestamp(), 1),
     ($5, $6, 'reviewer', 'active', clock_timestamp(), 1)`,
    [orgA, recruiterA, orgA, reviewerA, orgB, reviewerB],
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

  const controlWorkerPool = new Pool({
    ...connection,
    user: 'app_control_worker',
    password: runtimePassword,
    max: 5,
  });

  const adapter = createR213ExecutionAdapter({ pool: candidatePool });

  const sessionHelper = (opts = {}) =>
    createTestSession(admin, candidatePool, {
      organizationId: orgA,
      issuerPrincipalId: recruiterA,
      ...opts,
    });

  try {
    console.log(
      '--- Starting R2.13 PostgreSQL Execution Security Check Suite ---',
    );

    // =========================================================================
    // Check 1: Authorized candidate execution admission and lifecycle
    // =========================================================================
    console.log('Check 1: Authorized candidate execution admission');
    {
      const s = await sessionHelper({ label: 'case1_auth' });
      assert.ok(s.workspaceDigest);

      const admitResult = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case1_valid',
        expectedWorkspaceDigest: s.workspaceDigest,
        recipeId: APPROVED_RECIPE_ID,
        recipeVersion: APPROVED_RECIPE_VERSION,
        recipeDigest: APPROVED_RECIPE_DIGEST,
      });

      assert.equal(admitResult.status, 'ADMITTED');
      assert.ok(admitResult.intent);
      assert.equal(admitResult.intent.approvedRecipeId, APPROVED_RECIPE_ID);
      assert.equal(
        admitResult.intent.canonicalWorkspaceSnapshotDigest,
        s.workspaceDigest,
      );
      assert.equal(admitResult.intent.protocolVersion, 'r213-execution-v1');
      assert.ok(admitResult.intent.fence > 0);

      assert.ok(admitResult.operation);
      assert.equal(admitResult.operation.status, 'ADMITTED');
      assert.equal(
        admitResult.operation.provenance,
        'synthetic-execution-adapter',
      );
      assert.equal(admitResult.operation.isSynthetic, true);
      assert.equal(admitResult.operation.exitCode, null);

      // Verify event was logged
      const { rows: eventRows } = await admin.query(
        `SELECT * FROM hirearchy.candidate_session_events WHERE session_id = $1 AND event_type = 'EXECUTION_REQUESTED'`,
        [s.sessionId],
      );
      assert.equal(eventRows.length, 1);
      assert.equal(
        eventRows[0].payload.operationId,
        admitResult.operation.operationId,
      );

      // Complete execution
      const completed = await adapter.completeCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        operationId: admitResult.operation.operationId,
        fence: admitResult.operation.fence,
        generation: 1,
        exitCode: 0,
        stdout: '=== 3 passed in 0.42s ===',
        stderr: '',
        durationMs: 420,
        cleanupStatus: 'CLEAN',
      });

      assert.equal(completed.status, 'COMPLETED');
      assert.equal(completed.exitCode, 0);
      assert.equal(completed.stdout, '=== 3 passed in 0.42s ===');
      assert.equal(completed.stdoutDigest, hash('=== 3 passed in 0.42s ==='));
      assert.ok(completed.sequenceCompleted > completed.sequenceStart);
      assert.ok(completed.completedAt);
      assert.equal(completed.isSynthetic, true);

      // Verify completion event
      const { rows: compEvents } = await admin.query(
        `SELECT * FROM hirearchy.candidate_session_events WHERE session_id = $1 AND event_type = 'EXECUTION_COMPLETED'`,
        [s.sessionId],
      );
      assert.equal(compEvents.length, 1);

      // Verify candidate execution view
      const view = await adapter.getCandidateExecutionsView({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
      });
      assert.equal(view.terminalEnabled, true);
      assert.equal(view.remainingExecutions, 9);
      assert.equal(view.maxExecutions, 10);
      assert.equal(view.operations.length, 1);
      assert.equal(view.operations[0].status, 'COMPLETED');
    }
    console.log('  PASS Check 1');

    // =========================================================================
    // Check 2: Disabled execution capability denial (terminal_enabled = false)
    // =========================================================================
    console.log('Check 2: Disabled execution capability denial');
    {
      const disabledSession = await sessionHelper({
        label: 'case2_disabled',
        terminalEnabled: false,
      });

      const result = await adapter.admitCandidateExecution({
        tokenHash: disabledSession.tokenHash,
        sessionId: disabledSession.sessionId,
        requestId: 'req_case2_disabled',
        expectedWorkspaceDigest: disabledSession.workspaceDigest,
        recipeId: APPROVED_RECIPE_ID,
        recipeVersion: APPROVED_RECIPE_VERSION,
        recipeDigest: APPROVED_RECIPE_DIGEST,
      });

      assert.equal(result.status, 'DENIED');
      assert.equal(result.reason, 'TERMINAL_DISABLED');

      const { rows: opRows } = await admin.query(
        `SELECT count(*) FROM hirearchy.candidate_execution_operations WHERE session_id = $1`,
        [disabledSession.sessionId],
      );
      assert.equal(Number(opRows[0].count), 0);
    }
    console.log('  PASS Check 2');

    // =========================================================================
    // Check 3: Invalid and foreign bearer denial
    // =========================================================================
    console.log('Check 3: Invalid and foreign bearer denial');
    {
      const s1 = await sessionHelper({ label: 'case3_s1' });
      const s2 = await sessionHelper({ label: 'case3_s2' });

      const invalidTokenHash = hash('bogus-invalid-token');

      await assert.rejects(
        () =>
          adapter.admitCandidateExecution({
            tokenHash: invalidTokenHash,
            sessionId: s1.sessionId,
            requestId: 'req_case3_invalid',
            expectedWorkspaceDigest: s1.workspaceDigest,
          }),
        (err) => err?.code === '42501',
      );

      // Bearer s1 against session s2
      await assert.rejects(
        () =>
          adapter.admitCandidateExecution({
            tokenHash: s1.tokenHash,
            sessionId: s2.sessionId,
            requestId: 'req_case3_foreign',
            expectedWorkspaceDigest: s2.workspaceDigest,
          }),
        (err) => err?.code === '42501',
      );
    }
    console.log('  PASS Check 3');

    // =========================================================================
    // Check 4: Cross-tenant denial
    // =========================================================================
    console.log('Check 4: Cross-tenant denial');
    {
      const sOrgA = await sessionHelper({ label: 'case4_orgA' });

      await adapter.admitCandidateExecution({
        tokenHash: sOrgA.tokenHash,
        sessionId: sOrgA.sessionId,
        requestId: 'req_case4_orgA',
        expectedWorkspaceDigest: sOrgA.workspaceDigest,
      });

      // Reviewer B belongs to Org B; should be denied reading executions of Org A session
      await assert.rejects(
        () =>
          getEvaluatorExecutions(evaluatorPool, {
            organizationId: orgB,
            sessionId: sOrgA.sessionId,
            reviewerPrincipalId: reviewerB,
          }),
        (err) => err?.code === '42501',
      );

      await assert.rejects(
        () =>
          getEvaluatorExecutions(evaluatorPool, {
            organizationId: orgA,
            sessionId: sOrgA.sessionId,
            reviewerPrincipalId: reviewerB,
          }),
        (err) => err?.code === '42501',
      );
    }
    console.log('  PASS Check 4');

    // =========================================================================
    // Check 5: Deadline expiration
    // =========================================================================
    console.log('Check 5: Deadline expiration');
    {
      const sExpired = await sessionHelper({
        label: 'case5_expired',
        pastDeadline: true,
      });

      const { rows } = await admin.query(
        `SELECT state.workspace_digest FROM hirearchy.r26_workspace_state($1) AS state`,
        [sExpired.sessionId],
      );
      const digest = rows[0]?.workspace_digest ?? hash('fallback');

      const result = await adapter.admitCandidateExecution({
        tokenHash: sExpired.tokenHash,
        sessionId: sExpired.sessionId,
        requestId: 'req_case5_expired',
        expectedWorkspaceDigest: digest,
      });

      assert.equal(result.status, 'DENIED');
      assert.equal(result.reason, 'DEADLINE_EXCEEDED');
    }
    console.log('  PASS Check 5');

    // =========================================================================
    // Check 6: Invalid recipe denial
    // =========================================================================
    console.log('Check 6: Invalid recipe denial');
    {
      const s = await sessionHelper({ label: 'case6_recipe' });

      // Bad recipeId
      const resBadId = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case6_badid',
        expectedWorkspaceDigest: s.workspaceDigest,
        recipeId: 'recipe-arbitrary-docker-exec',
      });
      assert.equal(resBadId.status, 'DENIED');
      assert.equal(resBadId.reason, 'INVALID_RECIPE');

      // Bad version
      const resBadVer = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case6_badver',
        expectedWorkspaceDigest: s.workspaceDigest,
        recipeId: APPROVED_RECIPE_ID,
        recipeVersion: '2.0.0',
      });
      assert.equal(resBadVer.status, 'DENIED');
      assert.equal(resBadVer.reason, 'INVALID_RECIPE');

      // Bad digest
      const resBadDig = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case6_baddig',
        expectedWorkspaceDigest: s.workspaceDigest,
        recipeId: APPROVED_RECIPE_ID,
        recipeVersion: APPROVED_RECIPE_VERSION,
        recipeDigest: hash('unapproved-recipe-spec'),
      });
      assert.equal(resBadDig.status, 'DENIED');
      assert.equal(resBadDig.reason, 'INVALID_RECIPE');
    }
    console.log('  PASS Check 6');

    // =========================================================================
    // Check 7: Persisted snapshot digest binding
    // =========================================================================
    console.log('Check 7: Persisted snapshot digest binding');
    {
      const s = await sessionHelper({ label: 'case7_binding' });

      // Stale/unpersisted digest
      const resWrongDigest = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case7_wrong_digest',
        expectedWorkspaceDigest: hash('unpersisted-browser-draft-state'),
      });

      assert.equal(resWrongDigest.status, 'DENIED');
      assert.equal(resWrongDigest.reason, 'STALE_WORKSPACE');
    }
    console.log('  PASS Check 7');

    // =========================================================================
    // Check 8: Stale workspace-version conflict
    // =========================================================================
    console.log('Check 8: Stale workspace-version conflict');
    {
      const s = await sessionHelper({ label: 'case8_stale_ver' });
      const oldDigest = s.workspaceDigest;

      // Update workspace file via candidate command
      await candidatePool.query(
        `SELECT hirearchy.r26_candidate_command($1, $2, 'save', jsonb_build_object(
           'requestId', 'req_case8_save',
           'path', 'bookings/service.py',
           'content', 'def confirm(): return True\n',
           'expectedVersion', '0'
         ))`,
        [s.tokenHash, s.sessionId],
      );

      const { rows } = await admin.query(
        `SELECT state.workspace_digest FROM hirearchy.r26_workspace_state($1) AS state`,
        [s.sessionId],
      );
      const newDigest = rows[0].workspace_digest;
      assert.notEqual(oldDigest, newDigest);

      // Attempting to admit with oldDigest should fail with STALE_WORKSPACE
      const staleRes = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case8_stale',
        expectedWorkspaceDigest: oldDigest,
      });
      assert.equal(staleRes.status, 'DENIED');
      assert.equal(staleRes.reason, 'STALE_WORKSPACE');

      // Attempting to admit with newDigest succeeds
      const freshRes = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case8_fresh',
        expectedWorkspaceDigest: newDigest,
      });
      assert.equal(freshRes.status, 'ADMITTED');
    }
    console.log('  PASS Check 8');

    // =========================================================================
    // Check 9: Duplicate request replay
    // =========================================================================
    console.log('Check 9: Duplicate request replay');
    {
      const s = await sessionHelper({ label: 'case9_replay' });

      const firstAdmit = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case9_replay',
        expectedWorkspaceDigest: s.workspaceDigest,
      });
      assert.equal(firstAdmit.status, 'ADMITTED');

      // Same requestId and same intent
      const replayAdmit = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case9_replay',
        expectedWorkspaceDigest: s.workspaceDigest,
      });

      assert.equal(replayAdmit.status, 'REPLAY');
      assert.equal(
        replayAdmit.operation.operationId,
        firstAdmit.operation.operationId,
      );
      assert.equal(replayAdmit.intent.fence, firstAdmit.intent.fence);

      // Check view: only 1 execution row exists
      const view = await adapter.getCandidateExecutionsView({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
      });
      assert.equal(view.operations.length, 1);
      assert.equal(view.remainingExecutions, 9);
    }
    console.log('  PASS Check 9');

    // =========================================================================
    // Check 10: Changed-intent conflict
    // =========================================================================
    console.log('Check 10: Changed-intent conflict');
    {
      const s = await sessionHelper({ label: 'case10_conflict' });

      const firstAdmit = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case10_conflict',
        expectedWorkspaceDigest: s.workspaceDigest,
      });
      assert.equal(firstAdmit.status, 'ADMITTED');

      // Same requestId with changed expectedWorkspaceDigest
      const conflictRes = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case10_conflict',
        expectedWorkspaceDigest: hash('changed-intent-digest'),
      });

      assert.equal(conflictRes.status, 'CONFLICT');
      assert.ok(conflictRes.reason.includes('different intent'));
    }
    console.log('  PASS Check 10');

    // =========================================================================
    // Check 11: Concurrent budget enforcement (max 10)
    // =========================================================================
    console.log('Check 11: Concurrent budget enforcement');
    {
      const s = await sessionHelper({ label: 'case11_budget' });

      // Admit 10 executions
      for (let i = 0; i < 10; i++) {
        const res = await adapter.admitCandidateExecution({
          tokenHash: s.tokenHash,
          sessionId: s.sessionId,
          requestId: `req_case11_budget_${i}`,
          expectedWorkspaceDigest: s.workspaceDigest,
        });
        assert.equal(res.status, 'ADMITTED');
      }

      // 11th admission must be DENIED (BUDGET_EXHAUSTED)
      const exhaustedRes = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case11_budget_10',
        expectedWorkspaceDigest: s.workspaceDigest,
      });

      assert.equal(exhaustedRes.status, 'DENIED');
      assert.equal(exhaustedRes.reason, 'BUDGET_EXHAUSTED');

      // Verify concurrency serialization on a second session
      const sConcurrent = await sessionHelper({ label: 'case11_concurrent' });
      const concurrentRequests = Array.from({ length: 15 }, (_, i) =>
        adapter.admitCandidateExecution({
          tokenHash: sConcurrent.tokenHash,
          sessionId: sConcurrent.sessionId,
          requestId: `req_case11_concurrent_${i}`,
          expectedWorkspaceDigest: sConcurrent.workspaceDigest,
        }),
      );

      const results = await Promise.all(concurrentRequests);
      const admittedCount = results.filter(
        (r) => r.status === 'ADMITTED',
      ).length;
      const deniedCount = results.filter(
        (r) => r.status === 'DENIED' && r.reason === 'BUDGET_EXHAUSTED',
      ).length;

      assert.equal(admittedCount, 10);
      assert.equal(deniedCount, 5);
    }
    console.log('  PASS Check 11');

    // =========================================================================
    // Check 12: Submitted-session finality
    // =========================================================================
    console.log('Check 12: Submitted-session finality');
    {
      const s = await sessionHelper({ label: 'case12_finality', submit: true });

      const res = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case12_submitted',
        expectedWorkspaceDigest: s.workspaceDigest,
      });

      assert.equal(res.status, 'DENIED');
      assert.equal(res.reason, 'SESSION_CLOSED');
    }
    console.log('  PASS Check 12');

    // =========================================================================
    // Check 13: Synthetic receipt provenance
    // =========================================================================
    console.log('Check 13: Synthetic receipt provenance');
    {
      const s = await sessionHelper({ label: 'case13_prov' });

      const admit = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case13_prov',
        expectedWorkspaceDigest: s.workspaceDigest,
      });

      assert.equal(admit.operation.provenance, 'synthetic-execution-adapter');
      assert.equal(admit.operation.isSynthetic, true);

      const completed = await adapter.completeCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        operationId: admit.operation.operationId,
        fence: admit.operation.fence,
        exitCode: 1,
        stdout: '1 failed, 2 passed',
        stderr: 'AssertionError: Backoff missing',
      });

      assert.equal(completed.provenance, 'synthetic-execution-adapter');
      assert.equal(completed.isSynthetic, true);
      assert.match(completed.stdoutDigest, /^[0-9a-f]{64}$/);
      assert.match(completed.stderrDigest, /^[0-9a-f]{64}$/);
    }
    console.log('  PASS Check 13');

    // =========================================================================
    // Check 14: Forged client receipt rejection
    // =========================================================================
    console.log('Check 14: Forged client receipt rejection');
    {
      const s = await sessionHelper({ label: 'case14_forgery' });

      // Attempt direct INSERT as app_candidate_gateway
      await assert.rejects(
        () =>
          candidatePool.query(
            `INSERT INTO hirearchy.candidate_execution_operations (
               organization_id, session_id, operation_id, request_id, sequence_start,
               workspace_digest, workspace_version, recipe_id, recipe_version, recipe_digest,
               generation, fence, status, exit_code
             ) VALUES (
               $1, $2, 'op_exec_forged', 'req_forged', 10,
               $3, 1, 'recipe-python-check-v1', '1.0.0', $4,
               1, 10, 'COMPLETED', 0
             )`,
            [orgA, s.sessionId, s.workspaceDigest, APPROVED_RECIPE_DIGEST],
          ),
        (err) => err?.code === '42501',
      );

      // Attempt direct UPDATE as app_candidate_gateway
      await assert.rejects(
        () =>
          candidatePool.query(
            `UPDATE hirearchy.candidate_execution_operations SET exit_code = 0 WHERE session_id = $1`,
            [s.sessionId],
          ),
        (err) => err?.code === '42501',
      );

      // Attempt direct DELETE as app_candidate_gateway
      await assert.rejects(
        () =>
          candidatePool.query(
            `DELETE FROM hirearchy.candidate_execution_operations WHERE session_id = $1`,
            [s.sessionId],
          ),
        (err) => err?.code === '42501',
      );
    }
    console.log('  PASS Check 14');

    // =========================================================================
    // Check 15: Stale generation/fence rejection
    // =========================================================================
    console.log('Check 15: Stale generation/fence rejection');
    {
      const s = await sessionHelper({ label: 'case15_fence' });

      const admit = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case15_fence',
        expectedWorkspaceDigest: s.workspaceDigest,
      });

      const trueFence = Number(admit.operation.fence);

      // Stale fence
      await assert.rejects(
        () =>
          adapter.completeCandidateExecution({
            tokenHash: s.tokenHash,
            sessionId: s.sessionId,
            operationId: admit.operation.operationId,
            fence: trueFence - 1,
            exitCode: 0,
            stdout: 'done',
          }),
        (err) => err?.code === '23514',
      );

      // Stale generation
      await assert.rejects(
        () =>
          adapter.completeCandidateExecution({
            tokenHash: s.tokenHash,
            sessionId: s.sessionId,
            operationId: admit.operation.operationId,
            fence: trueFence,
            generation: 2,
            exitCode: 0,
            stdout: 'done',
          }),
        (err) => err?.code === '23514',
      );
    }
    console.log('  PASS Check 15');

    // =========================================================================
    // Check 16: UNKNOWN does not become success automatically
    // =========================================================================
    console.log('Check 16: UNKNOWN does not become success automatically');
    {
      const s = await sessionHelper({ label: 'case16_unknown' });

      const admit = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case16_unknown',
        expectedWorkspaceDigest: s.workspaceDigest,
      });

      const failed = await adapter.failCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        operationId: admit.operation.operationId,
        fence: admit.operation.fence,
        status: 'UNKNOWN',
        failureReason: 'EXECUTOR_TIMEOUT',
        errorMessage: 'Executor communication lost: connection reset by peer',
        isUnknown: true,
      });

      assert.equal(failed.status, 'UNKNOWN');
      assert.equal(failed.exitCode, null);
      assert.equal(failed.isUnknown, true);
      assert.equal(failed.cleanupStatus, 'UNKNOWN');

      // Verify in candidate view
      const view = await adapter.getCandidateExecutionsView({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
      });
      assert.equal(view.operations[0].status, 'UNKNOWN');
      assert.equal(view.operations[0].exitCode, null);
      assert.equal(view.operations[0].isUnknown, true);
    }
    console.log('  PASS Check 16');

    // =========================================================================
    // Check 17: Revoked reviewer denied evidence retrieval
    // =========================================================================
    console.log('Check 17: Revoked reviewer denied evidence retrieval');
    {
      const s = await sessionHelper({ label: 'case17_reviewer' });

      // Execute and complete one operation
      const admit = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case17_run',
        expectedWorkspaceDigest: s.workspaceDigest,
      });

      await adapter.completeCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        operationId: admit.operation.operationId,
        fence: admit.operation.fence,
        exitCode: 0,
        stdout: 'passed',
      });

      // Submit session
      await candidatePool.query(
        `SELECT hirearchy.r26_candidate_command($1, $2, 'submit', jsonb_build_object('requestId', 'req_case17_sub', 'expectedWorkspaceDigest', $3::text))`,
        [s.tokenHash, s.sessionId, s.workspaceDigest],
      );

      // Assign Reviewer A
      const assignmentId = randomUUID();
      await admin.query(
        `INSERT INTO hirearchy.reviewer_assignments (
           id, organization_id, session_id, reviewer_principal_id, assigned_by_principal_id, assigned_at, version
         ) VALUES ($1, $2, $3, $4, $5, clock_timestamp(), 1)`,
        [assignmentId, orgA, s.sessionId, reviewerA, recruiterA],
      );

      // Reviewer A retrieves executions successfully
      const evalExecs = await getEvaluatorExecutions(evaluatorPool, {
        organizationId: orgA,
        sessionId: s.sessionId,
        reviewerPrincipalId: reviewerA,
      });
      assert.equal(evalExecs.length, 1);
      assert.equal(evalExecs[0].status, 'COMPLETED');
      assert.equal(evalExecs[0].provenance, 'synthetic-execution-adapter');
      assert.equal(evalExecs[0].isSynthetic, true);

      // Now revoke Reviewer A's assignment
      await admin.query(
        `UPDATE hirearchy.reviewer_assignments SET revoked_at = clock_timestamp() WHERE id = $1`,
        [assignmentId],
      );

      // Access is denied for revoked reviewer
      await assert.rejects(
        () =>
          getEvaluatorExecutions(evaluatorPool, {
            organizationId: orgA,
            sessionId: s.sessionId,
            reviewerPrincipalId: reviewerA,
          }),
        (err) => err?.code === '42501',
      );
    }
    console.log('  PASS Check 17');

    // =========================================================================
    // Check 18: Immutable evidence retention
    // =========================================================================
    console.log('Check 18: Immutable evidence retention');
    {
      const s = await sessionHelper({ label: 'case18_immutable' });

      const admit = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case18_op',
        expectedWorkspaceDigest: s.workspaceDigest,
      });

      const completed = await adapter.completeCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        operationId: admit.operation.operationId,
        fence: admit.operation.fence,
        exitCode: 0,
        stdout: 'passed',
      });

      // Attempt to modify immutable columns via admin
      await assert.rejects(
        () =>
          admin.query(
            `UPDATE hirearchy.candidate_execution_operations
             SET sequence_start = 9999
             WHERE operation_id = $1`,
            [completed.operationId],
          ),
        (err) => err?.code === '23514',
      );

      // Attempt to modify final completed status/exit_code via admin
      await assert.rejects(
        () =>
          admin.query(
            `UPDATE hirearchy.candidate_execution_operations
             SET exit_code = 42
             WHERE operation_id = $1`,
            [completed.operationId],
          ),
        (err) => err?.code === '23514',
      );

      // Attempt to delete completed record
      await assert.rejects(
        () =>
          admin.query(
            `DELETE FROM hirearchy.candidate_execution_operations WHERE operation_id = $1`,
            [completed.operationId],
          ),
        (err) => err?.code === '23514',
      );
    }
    console.log('  PASS Check 18');

    // =========================================================================
    // Check 19: No secret/token leakage
    // =========================================================================
    console.log('Check 19: No secret/token leakage');
    {
      const s = await sessionHelper({ label: 'case19_leak' });

      const admit = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case19_leak',
        expectedWorkspaceDigest: s.workspaceDigest,
      });

      await adapter.completeCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        operationId: admit.operation.operationId,
        fence: admit.operation.fence,
        exitCode: 0,
        stdout: 'passed',
      });

      const view = await adapter.getCandidateExecutionsView({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
      });

      const viewJson = JSON.stringify(view);
      assert.equal(viewJson.includes(s.token), false);
      assert.equal(viewJson.includes(s.tokenHash), false);
      assert.equal(viewJson.includes(runtimePassword), false);

      const { rows: events } = await admin.query(
        `SELECT payload FROM hirearchy.candidate_session_events WHERE session_id = $1`,
        [s.sessionId],
      );
      for (const ev of events) {
        const evJson = JSON.stringify(ev.payload);
        assert.equal(evJson.includes(s.token), false);
        assert.equal(evJson.includes(s.tokenHash), false);
        assert.equal(evJson.includes(runtimePassword), false);
      }
    }
    console.log('  PASS Check 19');

    // =========================================================================
    // Check 20: No automatic hiring verdict
    // =========================================================================
    console.log('Check 20: No automatic hiring verdict');
    {
      const s = await sessionHelper({ label: 'case20_no_verdict' });

      const admit = await adapter.admitCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case20_verdict',
        expectedWorkspaceDigest: s.workspaceDigest,
      });

      const completed = await adapter.completeCandidateExecution({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        operationId: admit.operation.operationId,
        fence: admit.operation.fence,
        exitCode: 0,
        stdout: 'passed',
      });

      const view = await adapter.getCandidateExecutionsView({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
      });

      // Verify that no automatic judgment fields exist
      const op = view.operations[0];
      assert.equal('score' in op, false);
      assert.equal('verdict' in op, false);
      assert.equal('pass_decision' in op, false);
      assert.equal('recommendation' in op, false);
      assert.equal('competence' in op, false);
      assert.equal('rank' in op, false);

      // Verify database record has only factual execution attributes
      const { rows } = await admin.query(
        `SELECT * FROM hirearchy.candidate_execution_operations WHERE operation_id = $1`,
        [completed.operationId],
      );
      const row = rows[0];
      assert.equal(row.status, 'COMPLETED');
      assert.equal(row.exit_code, 0);
      assert.equal(row.score, undefined);
      assert.equal(row.verdict, undefined);
    }
    console.log('  PASS Check 20');

    console.log(
      '=== All 20 R2.13 PostgreSQL Execution Security Checks Passed! ===',
    );
  } finally {
    await candidatePool.end();
    await evaluatorPool.end();
    await controlWorkerPool.end();
  }
}

// Standalone runner using disposable PostgreSQL container
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pgImage =
    'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
  const network = `hirearchy-r213-db-${randomBytes(6).toString('hex')}`;
  const database = `${network}-db`;
  const password = randomBytes(32).toString('hex');
  const runtimePassword = randomBytes(32).toString('hex');

  const docker = (...args) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  const waitFor = async (check) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if (await check()) return;
      } catch {}
      await delay(200);
    }
    throw new Error('Disposable PostgreSQL container readiness failed');
  };

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

    // Run migrations 0001 through 0010
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

    await runR213PostgresExecutionSecurityChecks({
      admin: adminClient,
      connection,
      runtimePassword,
      candidateTokenKey,
    });

    console.log('PostgreSQL Execution Security Check completed successfully!');
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
