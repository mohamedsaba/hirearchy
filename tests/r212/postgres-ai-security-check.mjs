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
import {
  installR212AiFixture,
  getEvaluatorAiInteractions,
  createR212AiAdapter,
} from '../../database/postgres/r212/adapter.mjs';

const SCENARIO_ID = 'scenario-002-booking-notification-retry';
const SCENARIO_VERSION = '1.0.0';
const SCENARIO_TITLE = 'Booking notification retry';

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomSessionId(label) {
  return `sess_r212_${label}_${randomBytes(8).toString('hex')}`;
}

function defaultAiSnapshot(enabled = true, maxInteractions = 5) {
  return {
    enabled,
    contractVersion: 'r212-synthetic-v1',
    configuredProviderId: 'synthetic-test-provider',
    configuredModelId: 'synthetic-model-r212',
    configurationVersion: '1.0.0',
    maxInteractions,
    maxPromptChars: 4000,
  };
}

function defaultScenarioSnapshot(durationSeconds = 600) {
  return {
    scenario: {
      id: SCENARIO_ID,
      version: SCENARIO_VERSION,
      title: SCENARIO_TITLE,
      durationSeconds,
      brief: 'Synthetic scenario for R2.12 AI Assistance verification.',
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
    aiEnabled = true,
    maxInteractions = 5,
    activate = true,
    submit = false,
    pastDeadline = false,
  } = {},
) {
  const sessionId = randomSessionId(label);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hash(token);
  const aiSnapshot = defaultAiSnapshot(aiEnabled, maxInteractions);
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
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, $9, true, NULL, $10, $11)`,
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
        JSON.stringify(aiSnapshot),
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
       ) VALUES ($1, $2, $3, $4, $5, $6, 'CREATED', $7, true, NULL, $8, $9)`,
      [
        sessionId,
        organizationId,
        issuerPrincipalId,
        SCENARIO_ID,
        SCENARIO_VERSION,
        SCENARIO_TITLE,
        durationSeconds,
        JSON.stringify(aiSnapshot),
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

  if (activate && !pastDeadline) {
    // Activate using candidate command as app_candidate_gateway
    await candidatePool.query(
      `SELECT hirearchy.r26_candidate_command($1, $2, 'activate', '{}'::pg_catalog.jsonb)`,
      [tokenHash, sessionId],
    );

    if (submit) {
      const { rows } = await admin.query(
        `SELECT state.workspace_digest FROM hirearchy.r26_workspace_state($1) AS state`,
        [sessionId],
      );
      const digest = rows[0].workspace_digest;
      await candidatePool.query(
        `SELECT hirearchy.r26_candidate_command($1, $2, 'submit', jsonb_build_object('requestId', $3::text, 'expectedWorkspaceDigest', $4::text))`,
        [
          tokenHash,
          sessionId,
          `req_sub_${randomBytes(4).toString('hex')}`,
          digest,
        ],
      );
    }
  }

  return { sessionId, token, tokenHash, organizationId, aiSnapshot };
}

export async function runR212PostgresAiSecurityChecks({
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

  const adapter = createR212AiAdapter({ pool: candidatePool });

  const sessionHelper = (opts = {}) =>
    createTestSession(admin, candidatePool, {
      organizationId: orgA,
      issuerPrincipalId: recruiterA,
      ...opts,
    });

  try {
    console.log('--- Starting R2.12 PostgreSQL AI Security Check Suite ---');

    // =========================================================================
    // Case 1: AI Permitted vs Disabled Assessments
    // =========================================================================
    console.log('Test 1: AI permitted vs disabled assessments');
    {
      const disabledSession = await sessionHelper({
        label: 'disabled_ai',
        aiEnabled: false,
      });

      const disabledResult = await adapter.admitAiInteraction({
        tokenHash: disabledSession.tokenHash,
        sessionId: disabledSession.sessionId,
        requestId: 'req_case1_disabled',
        candidatePrompt: 'How do I implement backoff?',
      });

      assert.equal(disabledResult.status, 'DENIED');
      assert.equal(disabledResult.reason, 'NOT_ENABLED');
      assert.equal(disabledResult.remainingBudget, 0);

      const enabledSession = await sessionHelper({
        label: 'enabled_ai',
        aiEnabled: true,
      });

      const enabledResult = await adapter.admitAiInteraction({
        tokenHash: enabledSession.tokenHash,
        sessionId: enabledSession.sessionId,
        requestId: 'req_case1_enabled',
        candidatePrompt: 'How do I implement backoff?',
      });

      assert.equal(enabledResult.status, 'ADMITTED');
      assert.ok(enabledResult.interaction);
      assert.equal(
        enabledResult.interaction.candidatePrompt,
        'How do I implement backoff?',
      );
      assert.equal(enabledResult.interaction.status, 'ADMITTED');
      assert.equal(enabledResult.remainingBudget, 4);
    }
    console.log('  PASS Case 1');

    // =========================================================================
    // Case 2: Valid Candidate Authorization
    // =========================================================================
    console.log('Test 2: Valid candidate authorization lifecycle');
    {
      const s = await sessionHelper({ label: 'valid_auth' });

      const admitResult = await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case2_valid',
        candidatePrompt: 'Explain retry logic for booking notifications',
      });
      assert.equal(admitResult.status, 'ADMITTED');

      const completed = await adapter.completeAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case2_valid',
        assistantResponse:
          '[Synthetic Assistant] Use time.sleep with exponential backoff.',
        durationMs: 450,
      });

      assert.equal(completed.status, 'COMPLETED');
      assert.equal(
        completed.assistantResponse,
        '[Synthetic Assistant] Use time.sleep with exponential backoff.',
      );
      assert.ok(completed.sequenceCompleted > completed.sequenceStart);
      assert.ok(completed.completedAt);

      const view = await adapter.getCandidateAiView({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
      });

      assert.equal(view.enabled, true);
      assert.equal(view.remainingInteractions, 4);
      assert.equal(view.totalInteractionsAllowed, 5);
      assert.equal(view.interactions.length, 1);
      assert.equal(view.interactions[0].status, 'COMPLETED');
    }
    console.log('  PASS Case 2');

    // =========================================================================
    // Case 3: Invalid and Foreign Bearer Denial
    // =========================================================================
    console.log('Test 3: Invalid and foreign bearer denial');
    {
      const s1 = await sessionHelper({ label: 'bearer_s1' });
      const s2 = await sessionHelper({ label: 'bearer_s2' });

      const invalidTokenHash = hash('bogus-invalid-candidate-token');

      await assert.rejects(
        adapter.admitAiInteraction({
          tokenHash: invalidTokenHash,
          sessionId: s1.sessionId,
          requestId: 'req_case3_invalid',
          candidatePrompt: 'Test prompt',
        }),
        (err) => err?.code === '42501',
        'Invalid token must be denied with 42501',
      );

      // Foreign bearer: valid token from s2 used on s1
      await assert.rejects(
        adapter.admitAiInteraction({
          tokenHash: s2.tokenHash,
          sessionId: s1.sessionId,
          requestId: 'req_case3_foreign',
          candidatePrompt: 'Test prompt',
        }),
        (err) => err?.code === '42501' || err?.code === 'R2604',
        'Foreign session bearer token must be denied',
      );
    }
    console.log('  PASS Case 3');

    // =========================================================================
    // Case 4: Cross-Tenant Conversation Denial
    // =========================================================================
    console.log('Test 4: Cross-tenant conversation denial');
    {
      const sOrgA = await createTestSession(admin, candidatePool, {
        label: 'tenant_org_a',
        organizationId: orgA,
        issuerPrincipalId: recruiterA,
      });

      // Candidate bearer belonging to Org A admits interaction in Org A
      await adapter.admitAiInteraction({
        tokenHash: sOrgA.tokenHash,
        sessionId: sOrgA.sessionId,
        requestId: 'req_case4_org_a',
        candidatePrompt: 'Org A confidential prompt',
      });

      // Evaluator in Org B attempts to read Org A session AI evidence
      await assert.rejects(
        getEvaluatorAiInteractions(evaluatorPool, {
          organizationId: orgB,
          sessionId: sOrgA.sessionId,
          reviewerPrincipalId: reviewerB,
        }),
        (err) => err?.code === '42501',
        'Cross-tenant evaluator query must be denied with 42501',
      );
    }
    console.log('  PASS Case 4');

    // =========================================================================
    // Case 5: Prompt Size Limit (4000 Chars)
    // =========================================================================
    console.log('Test 5: Prompt size limit (4000 chars)');
    {
      const s = await sessionHelper({ label: 'prompt_size' });

      // Exactly 4000 characters: valid
      const prompt4000 = 'A'.repeat(4000);
      const res4000 = await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case5_4000',
        candidatePrompt: prompt4000,
      });
      assert.equal(res4000.status, 'ADMITTED');

      // 4001 characters: rejected
      const prompt4001 = 'A'.repeat(4001);
      const res4001 = await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case5_4001',
        candidatePrompt: prompt4001,
      });
      assert.equal(res4001.status, 'DENIED');
      assert.equal(res4001.reason, 'PROMPT_TOO_LARGE');
    }
    console.log('  PASS Case 5');

    // =========================================================================
    // Case 6: Duplicate Request Replay (Same Prompt -> Exact Replay)
    // =========================================================================
    console.log('Test 6: Duplicate request replay');
    {
      const s = await sessionHelper({ label: 'replay' });

      const firstAdmission = await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case6_replay',
        candidatePrompt: 'Deterministic idempotent prompt',
      });
      assert.equal(firstAdmission.status, 'ADMITTED');
      const interactionId = firstAdmission.interaction.interactionId;

      // Complete it
      await adapter.completeAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case6_replay',
        assistantResponse: 'Deterministic assistant response',
      });

      // Check event count before replay
      const { rows: eventsBefore } = await admin.query(
        `SELECT count(*)::int AS count FROM hirearchy.candidate_session_events WHERE session_id = $1`,
        [s.sessionId],
      );

      // Replay identical prompt with same requestId
      const replay = await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case6_replay',
        candidatePrompt: 'Deterministic idempotent prompt',
      });

      assert.equal(replay.status, 'REPLAY');
      assert.equal(replay.interaction.interactionId, interactionId);
      assert.equal(
        replay.interaction.candidatePrompt,
        'Deterministic idempotent prompt',
      );
      assert.equal(replay.interaction.status, 'COMPLETED');

      // Check event count after replay: no duplicate events were created
      const { rows: eventsAfter } = await admin.query(
        `SELECT count(*)::int AS count FROM hirearchy.candidate_session_events WHERE session_id = $1`,
        [s.sessionId],
      );
      assert.equal(eventsAfter[0].count, eventsBefore[0].count);
    }
    console.log('  PASS Case 6');

    // =========================================================================
    // Case 7: Changed-Intent Conflict (Same RequestId, Different Prompt -> 409)
    // =========================================================================
    console.log('Test 7: Changed-intent conflict (409 conflict)');
    {
      const s = await sessionHelper({ label: 'conflict' });

      await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case7_conflict',
        candidatePrompt: 'Initial prompt message',
      });

      // Reuse same requestId with a different prompt
      const conflictResult = await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case7_conflict',
        candidatePrompt: 'Altered different prompt intent',
      });

      assert.equal(conflictResult.status, 'CONFLICT');
      assert.match(conflictResult.reason, /different intent/i);
    }
    console.log('  PASS Case 7');

    // =========================================================================
    // Case 8: Concurrent Budget Admission (Cannot Exceed 5)
    // =========================================================================
    console.log(
      'Test 8: Concurrent budget admission (exactly 5 admitted out of 10)',
    );
    {
      const s = await sessionHelper({
        label: 'concurrent_admission',
        maxInteractions: 5,
      });

      // Fire 10 simultaneous admissions
      const requests = Array.from({ length: 10 }, (_, i) =>
        adapter.admitAiInteraction({
          tokenHash: s.tokenHash,
          sessionId: s.sessionId,
          requestId: `req_case8_concurrent_${i}`,
          candidatePrompt: `Concurrent prompt ${i}`,
        }),
      );

      const results = await Promise.all(requests);

      const admitted = results.filter((r) => r.status === 'ADMITTED');
      const denied = results.filter((r) => r.status === 'DENIED');

      assert.equal(admitted.length, 5, 'Exactly 5 requests must be admitted');
      assert.equal(denied.length, 5, 'Exactly 5 requests must be denied');

      for (const d of denied) {
        assert.equal(d.reason, 'BUDGET_EXHAUSTED');
        assert.equal(d.remainingBudget, 0);
      }

      // Check database table
      const { rows } = await admin.query(
        `SELECT count(*)::int AS count FROM hirearchy.candidate_ai_interactions WHERE session_id = $1`,
        [s.sessionId],
      );
      assert.equal(rows[0].count, 5);
    }
    console.log('  PASS Case 8');

    // =========================================================================
    // Case 9: Exhausted Request Budget Denial
    // =========================================================================
    console.log('Test 9: Exhausted request budget denial');
    {
      const s = await sessionHelper({
        label: 'exhausted_budget',
        maxInteractions: 3,
      });

      // Admit and complete 3 interactions
      for (let i = 1; i <= 3; i++) {
        const admitted = await adapter.admitAiInteraction({
          tokenHash: s.tokenHash,
          sessionId: s.sessionId,
          requestId: `req_case9_${i}`,
          candidatePrompt: `Prompt ${i}`,
        });
        assert.equal(admitted.status, 'ADMITTED');
        await adapter.completeAiInteraction({
          tokenHash: s.tokenHash,
          sessionId: s.sessionId,
          requestId: `req_case9_${i}`,
          assistantResponse: `Response ${i}`,
        });
      }

      // 4th request must be denied
      const res4 = await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case9_4',
        candidatePrompt: 'Prompt 4 exceeding budget',
      });

      assert.equal(res4.status, 'DENIED');
      assert.equal(res4.reason, 'BUDGET_EXHAUSTED');
      assert.equal(res4.remainingBudget, 0);
    }
    console.log('  PASS Case 9');

    // =========================================================================
    // Case 10: Timeout Boundary (Requests Past Deadline Rejected)
    // =========================================================================
    console.log('Test 10: Timeout boundary (requests past deadline rejected)');
    {
      const s = await sessionHelper({
        label: 'timeout_session',
        pastDeadline: true,
      });

      const res = await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case10_timed_out',
        candidatePrompt: 'Prompt after timeout',
      });

      assert.equal(res.status, 'DENIED');
      assert.equal(res.reason, 'DEADLINE_EXCEEDED');
      assert.equal(res.remainingBudget, 0);
    }
    console.log('  PASS Case 10');

    // =========================================================================
    // Case 11: Submission Finality (Requests After Session Submission Rejected)
    // =========================================================================
    console.log('Test 11: Submission finality');
    {
      // 11a: New request after submission is rejected
      const submittedSession = await sessionHelper({
        label: 'submitted_session',
        submit: true,
      });

      const admitPostSubmit = await adapter.admitAiInteraction({
        tokenHash: submittedSession.tokenHash,
        sessionId: submittedSession.sessionId,
        requestId: 'req_case11_post_submit',
        candidatePrompt: 'Prompt after submit',
      });

      assert.equal(admitPostSubmit.status, 'DENIED');
      assert.equal(admitPostSubmit.reason, 'SESSION_CLOSED');

      // 11b: In-flight request admitted before submit cannot complete after submit
      const inflightSession = await sessionHelper({
        label: 'inflight_session',
      });

      await adapter.admitAiInteraction({
        tokenHash: inflightSession.tokenHash,
        sessionId: inflightSession.sessionId,
        requestId: 'req_case11_inflight',
        candidatePrompt: 'Admitted before submission',
      });

      // Submit the session
      const { rows } = await admin.query(
        `SELECT state.workspace_digest FROM hirearchy.r26_workspace_state($1) AS state`,
        [inflightSession.sessionId],
      );
      await candidatePool.query(
        `SELECT hirearchy.r26_candidate_command($1, $2, 'submit', jsonb_build_object('requestId', 'req_sub_inflight'::text, 'expectedWorkspaceDigest', $3::text))`,
        [
          inflightSession.tokenHash,
          inflightSession.sessionId,
          rows[0].workspace_digest,
        ],
      );

      // In-flight completion must fail
      await assert.rejects(
        adapter.completeAiInteraction({
          tokenHash: inflightSession.tokenHash,
          sessionId: inflightSession.sessionId,
          requestId: 'req_case11_inflight',
          assistantResponse: 'Late response after submit',
        }),
        (err) => err?.code === 'R2605',
        'In-flight completion after session submission must fail with R2605',
      );
    }
    console.log('  PASS Case 11');

    // =========================================================================
    // Case 12: Provider Failure (Factual Error Event Persisted)
    // =========================================================================
    console.log(
      'Test 12: Provider failure recording (factual error event persisted)',
    );
    {
      const s = await sessionHelper({ label: 'provider_fail' });

      await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case12_fail',
        candidatePrompt: 'Trigger simulated provider error',
      });

      const failed = await adapter.failAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case12_fail',
        failureReason: 'SYNTHETIC_PROVIDER_FAILURE',
        errorMessage: 'Synthetic provider simulated internal failure',
        durationMs: 120,
      });

      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.failureReason, 'SYNTHETIC_PROVIDER_FAILURE');
      assert.equal(
        failed.errorMessage,
        'Synthetic provider simulated internal failure',
      );
      assert.equal(failed.assistantResponse, null);
      assert.ok(failed.sequenceCompleted);

      // Verify AI_REQUEST_FAILED event in candidate_session_events
      const { rows: eventRows } = await admin.query(
        `SELECT event_type, payload
         FROM hirearchy.candidate_session_events
         WHERE session_id = $1 AND sequence = $2`,
        [s.sessionId, failed.sequenceCompleted],
      );

      assert.equal(eventRows.length, 1);
      assert.equal(eventRows[0].event_type, 'AI_REQUEST_FAILED');
      assert.equal(
        eventRows[0].payload.failureReason,
        'SYNTHETIC_PROVIDER_FAILURE',
      );
      assert.equal(
        eventRows[0].payload.errorMessage,
        'Synthetic provider simulated internal failure',
      );
    }
    console.log('  PASS Case 12');

    // =========================================================================
    // Case 13: Process Restart Recovery (Committed Interactions Survive Restart)
    // =========================================================================
    console.log('Test 13: Process restart recovery');
    {
      const s = await sessionHelper({ label: 'restart_recov' });

      await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case13_survive',
        candidatePrompt: 'Prompt that must survive restart',
      });

      await adapter.completeAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case13_survive',
        assistantResponse: 'Assistant durable reply',
      });

      // Disconnect and create a brand new client
      const freshClient = new Client({
        ...connection,
        user: 'app_candidate_gateway',
        password: runtimePassword,
      });
      await freshClient.connect();

      try {
        const freshAdapter = createR212AiAdapter({ pool: freshClient });
        const view = await freshAdapter.getCandidateAiView({
          tokenHash: s.tokenHash,
          sessionId: s.sessionId,
        });

        assert.equal(view.interactions.length, 1);
        assert.equal(view.interactions[0].requestId, 'req_case13_survive');
        assert.equal(
          view.interactions[0].candidatePrompt,
          'Prompt that must survive restart',
        );
        assert.equal(
          view.interactions[0].assistantResponse,
          'Assistant durable reply',
        );
        assert.equal(view.interactions[0].status, 'COMPLETED');
      } finally {
        await freshClient.end();
      }
    }
    console.log('  PASS Case 13');

    // =========================================================================
    // Case 14: No Candidate-Token Leakage in Interaction Payloads
    // =========================================================================
    console.log('Test 14: No candidate-token leakage');
    {
      const s = await sessionHelper({ label: 'leak_check' });

      await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case14_leak',
        candidatePrompt: 'Check for leaked credentials',
      });

      await adapter.completeAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case14_leak',
        assistantResponse: 'Response checked',
      });

      // Query raw candidate_ai_interactions table
      const { rows: aiRows } = await admin.query(
        `SELECT * FROM hirearchy.candidate_ai_interactions WHERE session_id = $1`,
        [s.sessionId],
      );

      // Query raw candidate_session_events table
      const { rows: eventRows } = await admin.query(
        `SELECT * FROM hirearchy.candidate_session_events WHERE session_id = $1`,
        [s.sessionId],
      );

      const allAiText = JSON.stringify(aiRows);
      const allEventsText = JSON.stringify(eventRows);

      assert.equal(
        allAiText.includes(s.token),
        false,
        'Raw token must not appear in candidate_ai_interactions',
      );
      assert.equal(
        allAiText.includes(s.tokenHash),
        false,
        'Token hash must not appear in candidate_ai_interactions',
      );
      assert.equal(
        allEventsText.includes(s.token),
        false,
        'Raw token must not appear in candidate_session_events',
      );
      assert.equal(
        allEventsText.includes(s.tokenHash),
        false,
        'Token hash must not appear in candidate_session_events',
      );
    }
    console.log('  PASS Case 14');

    // =========================================================================
    // Case 15: Correct Message Sequencing in candidate_session_events
    // =========================================================================
    console.log(
      'Test 15: Correct message sequencing in candidate_session_events',
    );
    {
      const s = await sessionHelper({ label: 'sequencing' });

      // 1. Session activation is sequence 1
      // 2. AI Request 1 Started -> seq 2
      // 3. AI Request 1 Completed -> seq 3
      // 4. AI Request 2 Started -> seq 4
      // 5. AI Request 2 Failed -> seq 5

      const ad1 = await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case15_1',
        candidatePrompt: 'First prompt',
      });
      assert.equal(ad1.interaction.sequenceStart, 2);

      const comp1 = await adapter.completeAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case15_1',
        assistantResponse: 'First response',
      });
      assert.equal(comp1.sequenceCompleted, 3);

      const ad2 = await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case15_2',
        candidatePrompt: 'Second prompt',
      });
      assert.equal(ad2.interaction.sequenceStart, 4);

      const fail2 = await adapter.failAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case15_2',
        failureReason: 'PROVIDER_ERROR',
        errorMessage: 'Something broke',
      });
      assert.equal(fail2.sequenceCompleted, 5);

      // Verify sequence ordering from database
      const { rows: events } = await admin.query(
        `SELECT sequence, event_type
         FROM hirearchy.candidate_session_events
         WHERE session_id = $1
         ORDER BY sequence ASC`,
        [s.sessionId],
      );

      assert.deepEqual(
        events.map((e) => [Number(e.sequence), e.event_type]),
        [
          [1, 'SESSION_ACTIVATED'],
          [2, 'AI_REQUEST_STARTED'],
          [3, 'AI_RESPONSE_COMPLETED'],
          [4, 'AI_REQUEST_STARTED'],
          [5, 'AI_REQUEST_FAILED'],
        ],
      );
    }
    console.log('  PASS Case 15');

    // =========================================================================
    // Case 16: Restricted Reviewer Evidence Access (Active Reviewer Can Read)
    // =========================================================================
    console.log('Test 16: Active reviewer evidence access');
    {
      const s = await sessionHelper({ label: 'evaluator_read' });

      await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case16_eval',
        candidatePrompt: 'Evidence prompt for human reviewer',
      });

      await adapter.completeAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case16_eval',
        assistantResponse: 'Assistant factual response',
      });

      // Assign reviewerA to this session in Org A
      const assignmentId = `asgn_${randomBytes(6).toString('hex')}`;
      await admin.query(
        `INSERT INTO hirearchy.reviewer_assignments (
           id, organization_id, session_id, reviewer_principal_id,
           assigned_by_principal_id, assigned_at
         ) VALUES ($1, $2, $3, $4, $5, clock_timestamp())`,
        [assignmentId, orgA, s.sessionId, reviewerA, recruiterA],
      );

      // Reviewer queries AI evidence via evaluator pool
      const interactions = await getEvaluatorAiInteractions(evaluatorPool, {
        organizationId: orgA,
        sessionId: s.sessionId,
        reviewerPrincipalId: reviewerA,
      });

      assert.equal(interactions.length, 1);
      assert.equal(interactions[0].requestId, 'req_case16_eval');
      assert.equal(
        interactions[0].candidatePrompt,
        'Evidence prompt for human reviewer',
      );
      assert.equal(
        interactions[0].assistantResponse,
        'Assistant factual response',
      );
      assert.equal(interactions[0].status, 'COMPLETED');
    }
    console.log('  PASS Case 16');

    // =========================================================================
    // Case 17: Revoked Reviewer Denial (Revoked Reviewer Cannot Read)
    // =========================================================================
    console.log('Test 17: Revoked reviewer access denial');
    {
      const s = await sessionHelper({ label: 'evaluator_revoked' });

      const assignmentId = `asgn_${randomBytes(6).toString('hex')}`;
      await admin.query(
        `INSERT INTO hirearchy.reviewer_assignments (
           id, organization_id, session_id, reviewer_principal_id,
           assigned_by_principal_id, assigned_at, revoked_at
         ) VALUES ($1, $2, $3, $4, $5, clock_timestamp() - interval '1 hour', clock_timestamp())`,
        [assignmentId, orgA, s.sessionId, reviewerA, recruiterA],
      );

      // Attempt to query AI evidence with revoked reviewer
      await assert.rejects(
        getEvaluatorAiInteractions(evaluatorPool, {
          organizationId: orgA,
          sessionId: s.sessionId,
          reviewerPrincipalId: reviewerA,
        }),
        (err) => err?.code === '42501',
        'Revoked reviewer assignment must be denied with 42501',
      );
    }
    console.log('  PASS Case 17');

    // =========================================================================
    // Case 18: No Direct Table Mutation by Unprivileged Roles
    // =========================================================================
    console.log('Test 18: Table RLS enforcement and immutability guards');
    {
      const s = await sessionHelper({ label: 'direct_mutation' });

      // Direct INSERT by app_candidate_gateway must be denied
      await assert.rejects(
        candidatePool.query(
          `INSERT INTO hirearchy.candidate_ai_interactions (
             organization_id, session_id, interaction_id, request_id,
             sequence_start, candidate_prompt, status
           ) VALUES ($1, $2, 'ai_direct_1', 'req_direct_1', 1, 'Sneak prompt', 'ADMITTED')`,
          [s.organizationId, s.sessionId],
        ),
        (err) => err?.code === '42501',
        'Direct INSERT by app_candidate_gateway must fail with 42501',
      );

      // Direct DELETE by app_candidate_gateway must be denied
      await assert.rejects(
        candidatePool.query(
          `DELETE FROM hirearchy.candidate_ai_interactions WHERE session_id = $1`,
          [s.sessionId],
        ),
        (err) => err?.code === '42501',
        'Direct DELETE by app_candidate_gateway must fail with 42501',
      );

      // Direct UPDATE by app_evaluator must be denied
      await assert.rejects(
        evaluatorPool.query(
          `UPDATE hirearchy.candidate_ai_interactions SET candidate_prompt = 'Tampered' WHERE session_id = $1`,
          [s.sessionId],
        ),
        (err) => err?.code === '42501',
        'Direct UPDATE by app_evaluator must fail with 42501',
      );

      // Direct UPDATE by app_control_worker must be denied
      await assert.rejects(
        controlWorkerPool.query(
          `UPDATE hirearchy.candidate_ai_interactions SET candidate_prompt = 'Tampered' WHERE session_id = $1`,
          [s.sessionId],
        ),
        (err) => err?.code === '42501',
        'Direct UPDATE by app_control_worker must fail with 42501',
      );

      // Admit and complete an interaction legally
      await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case18_immutable',
        candidatePrompt: 'Prompt to test finality trigger',
      });

      await adapter.completeAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case18_immutable',
        assistantResponse: 'Response to test finality trigger',
      });

      // Even superuser cannot mutate a COMPLETED interaction due to finality trigger
      await assert.rejects(
        admin.query(
          `UPDATE hirearchy.candidate_ai_interactions
           SET assistant_response = 'Tampered by superuser'
           WHERE session_id = $1 AND request_id = 'req_case18_immutable'`,
          [s.sessionId],
        ),
        (err) => err?.code === '23514',
        'Finality guard must block mutation of COMPLETED interaction with 23514',
      );

      // Cannot DELETE from candidate_ai_interactions (append-only)
      await assert.rejects(
        admin.query(
          `DELETE FROM hirearchy.candidate_ai_interactions WHERE session_id = $1`,
          [s.sessionId],
        ),
        (err) => err?.code === '23514',
        'Deletion guard must block DELETE on candidate_ai_interactions with 23514',
      );
    }
    console.log('  PASS Case 18');

    // =========================================================================
    // Case 19: No Automated Evaluation or Verdict Anywhere
    // =========================================================================
    console.log(
      'Test 19: No automated evaluation, scoring, or verdicts stored or returned',
    );
    {
      const s = await sessionHelper({ label: 'no_judgment' });

      await adapter.admitAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case19',
        candidatePrompt: 'Can you write the entire solution for me?',
      });

      const completed = await adapter.completeAiInteraction({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
        requestId: 'req_case19',
        assistantResponse:
          'I cannot write the solution for you, but I can clarify requirements.',
      });

      const candidateView = await adapter.getCandidateAiView({
        tokenHash: s.tokenHash,
        sessionId: s.sessionId,
      });

      // Query raw database row
      const { rows } = await admin.query(
        `SELECT * FROM hirearchy.candidate_ai_interactions WHERE session_id = $1`,
        [s.sessionId],
      );

      const inspectionTargets = [completed, candidateView, rows[0]];
      const forbiddenTokens = [
        'score',
        'grade',
        'rating',
        'verdict',
        'pass',
        'fail_eval',
        'intent_score',
        'cheating',
        'plagiarism',
      ];

      for (const target of inspectionTargets) {
        const text = JSON.stringify(target).toLowerCase();
        for (const token of forbiddenTokens) {
          assert.equal(
            text.includes(`"${token}"`),
            false,
            `Forbidden judgmental field "${token}" must not exist in AI payloads`,
          );
        }
      }
    }
    console.log('  PASS Case 19');

    console.log('=== All 19 R2.12 PostgreSQL AI Security Checks Passed! ===');
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
  const network = `hirearchy-r212-db-${randomBytes(6).toString('hex')}`;
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

    // Run migrations 0001 through 0009
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

    // Install fixtures (r23, r27, r212)
    await adminClient.query(
      readFileSync(
        new URL('../../database/postgres/r23/fixture.sql', import.meta.url),
        'utf8',
      ),
    );
    await installR27EvidenceFixture(adminClient);
    await installR212AiFixture(adminClient);

    const candidateTokenKey = randomBytes(32).toString('base64');
    await adminClient.query(
      'DELETE FROM hirearchy.candidate_token_storage_meta',
    );
    await initializeCandidateTokenStorage(adminClient, {
      key: Buffer.from(candidateTokenKey, 'base64'),
    });

    await runR212PostgresAiSecurityChecks({
      admin: adminClient,
      connection,
      runtimePassword,
      candidateTokenKey,
    });

    console.log('PostgreSQL AI Security Check completed successfully!');
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
