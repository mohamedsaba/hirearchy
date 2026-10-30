import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import {
  FIXTURE_IDS,
  assertCandidateTokenStorage,
} from '../../database/postgres/r23/adapter.mjs';
import {
  createR26CandidateAdapter,
  R26CandidateError,
} from '../../database/postgres/r26/adapter.mjs';

const SCENARIO_ID = 'scenario-002-booking-notification-retry';
const SCENARIO_VERSION = '1.0.0';
const SCENARIO_TITLE = 'The second confirmation';

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function scenarioSnapshot(durationSeconds, workspaceFiles) {
  return {
    scenario: {
      id: SCENARIO_ID,
      version: SCENARIO_VERSION,
      title: SCENARIO_TITLE,
      durationSeconds,
      brief: 'A synthetic issued scenario for PostgreSQL lifecycle checks.',
      acceptanceCriteria: [
        'Repeated provider delivery does not create duplicate records.',
        'Separate checkouts remain separate.',
      ],
      filePath: 'bookings/service.py',
      type: 'multi_file',
      originalContent: 'must not appear in the candidate response',
    },
    workspaceFiles,
  };
}

function defaultFiles() {
  return {
    'README.md': '# Scenario fixture\n',
    'bookings/service.py': 'def confirm():\n    return True\n',
    'tests/test_bookings.py': 'def test_fixture():\n    assert True\n',
  };
}

function randomSessionId(label) {
  return `sess_r26_${label}_${randomBytes(8).toString('hex')}`;
}

async function createFixture(
  admin,
  {
    label,
    organizationId = FIXTURE_IDS.orgA,
    issuerPrincipalId = FIXTURE_IDS.recruiterA2.principalId,
    durationSeconds = 600,
    workspaceFiles = defaultFiles(),
    snapshot = true,
  },
) {
  const sessionId = randomSessionId(label);
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const envelope = snapshot
    ? JSON.stringify(scenarioSnapshot(durationSeconds, workspaceFiles))
    : null;
  await admin.query(
    `INSERT INTO hirearchy.assessment_sessions (
       id, organization_id, issuer_principal_id, scenario_id,
       scenario_version, scenario_title, status, duration_seconds,
       terminal_enabled, task_rubric_snapshot, ai_capability_snapshot,
       scenario_snapshot
     ) VALUES ($1, $2, $3, $4, $5, $6, 'CREATED', $7, true, NULL, NULL, $8)`,
    [
      sessionId,
      organizationId,
      issuerPrincipalId,
      SCENARIO_ID,
      SCENARIO_VERSION,
      SCENARIO_TITLE,
      durationSeconds,
      envelope,
    ],
  );
  await admin.query(
    `INSERT INTO hirearchy.candidate_token_envelopes (
       organization_id, session_id, candidate_token_hash,
       candidate_token_ciphertext
     ) VALUES ($1, $2, $3, $4)`,
    [organizationId, sessionId, tokenHash, 'synthetic-fixture-ciphertext'],
  );
  return { sessionId, token, tokenHash, envelope };
}

async function expectCandidateError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof R26CandidateError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

async function waitForLockWait(admin, timeoutMs = 1500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { rows } = await admin.query(
      `SELECT 1
         FROM pg_catalog.pg_stat_activity
        WHERE application_name = 'hirearchy-r26-candidate'
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE '%r26_candidate_command%'
        LIMIT 1`,
    );
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Candidate command did not reach the session lock');
}

async function waitUntilDeadline(admin, sessionId, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { rows } = await admin.query(
      `SELECT activated_at + duration_seconds * INTERVAL '1 second'
                <= pg_catalog.clock_timestamp() AS expired
         FROM hirearchy.assessment_sessions WHERE id = $1`,
      [sessionId],
    );
    if (rows[0]?.expired) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Candidate session deadline did not pass');
}

function assertNoCapabilitySecrets(view, tokenHash) {
  const body = JSON.stringify(view);
  assert.equal(
    body.includes(tokenHash),
    false,
    'view must not expose token hash',
  );
  assert.equal(
    body.includes(FIXTURE_IDS.orgA),
    false,
    'view must not expose organization ID',
  );
  assert.equal(
    body.includes('originalContent'),
    false,
    'view must omit original source field',
  );
}

export async function runR26PostgresCandidateChecks({
  admin,
  connection,
  runtimePassword,
  candidateTokenKey,
}) {
  assert.ok(
    admin,
    'R2.6 checks require the disposable PostgreSQL admin client',
  );
  assert.ok(
    connection && runtimePassword,
    'R2.6 checks require the disposable candidate role',
  );
  assert.match(candidateTokenKey ?? '', /^[A-Za-z0-9+/]{43}=$/);

  const markerBefore = await assertCandidateTokenStorage(admin, {
    key: Buffer.from(candidateTokenKey, 'base64'),
  });
  await assert.rejects(
    () =>
      assertCandidateTokenStorage(admin, {
        key: randomBytes(32),
      }),
    (error) => error?.code === 'CANDIDATE_TOKEN_KEY_MISMATCH',
  );
  const markerAfter = await admin.query(
    'SELECT slot, version, database_id, key_check FROM hirearchy.candidate_token_storage_meta WHERE slot = 1',
  );
  assert.deepEqual(markerAfter.rows[0], {
    slot: 1,
    version: markerBefore.version,
    database_id: markerBefore.database_id,
    key_check: markerBefore.key_check,
  });

  const roleState = await admin.query(
    `SELECT role.rolcanlogin, role.rolsuper, role.rolbypassrls,
            role.rolcreatedb, role.rolcreaterole, role.rolreplication,
            role.rolinherit,
            EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS membership
                     WHERE membership.roleid = role.oid OR membership.member = role.oid)
              AS has_membership,
            pg_catalog.has_schema_privilege(role.rolname, 'hirearchy', 'USAGE') AS hirearchy_usage,
            pg_catalog.has_function_privilege(role.rolname,
              'hirearchy.r26_candidate_command(text,text,text,jsonb)', 'EXECUTE') AS command_execute,
            pg_catalog.has_function_privilege(role.rolname,
              'hirearchy.r26_candidate_view(text,text,jsonb)', 'EXECUTE') AS helper_execute,
            EXISTS (
              SELECT 1 FROM pg_catalog.pg_namespace AS namespace
              WHERE namespace.nspname = 'hirearchy'
                AND namespace.nspowner = role.oid
            ) AS owns_schema,
            EXISTS (
              SELECT 1 FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = 'hirearchy'
                AND relation.relowner = role.oid
            ) AS owns_table,
            EXISTS (
              SELECT 1 FROM pg_catalog.pg_proc AS procedure
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = procedure.pronamespace
              WHERE namespace.nspname = 'hirearchy'
                AND procedure.proowner = role.oid
            ) AS owns_function,
            pg_catalog.has_table_privilege(role.rolname,
              'hirearchy.candidate_workspace_files', 'SELECT') AS file_select,
            pg_catalog.has_table_privilege(role.rolname,
              'hirearchy.candidate_workspace_files', 'UPDATE') AS file_update,
            pg_catalog.has_table_privilege(role.rolname,
              'hirearchy.candidate_session_events', 'SELECT') AS event_select,
            pg_catalog.has_table_privilege(role.rolname,
              'hirearchy.candidate_session_operations', 'SELECT') AS operation_select,
            pg_catalog.has_table_privilege(role.rolname,
              'hirearchy.candidate_session_submissions', 'SELECT') AS submission_select
       FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = 'app_candidate_gateway'`,
  );
  const role = roleState.rows[0];
  assert.ok(role);
  for (const unsafe of [
    'rolsuper',
    'rolbypassrls',
    'rolcreatedb',
    'rolcreaterole',
    'rolreplication',
    'rolinherit',
    'has_membership',
    'helper_execute',
    'owns_schema',
    'owns_table',
    'owns_function',
    'file_select',
    'file_update',
    'event_select',
    'operation_select',
    'submission_select',
  ]) {
    assert.equal(role[unsafe], false, `${unsafe} must remain unavailable`);
  }
  assert.equal(role.rolcanlogin, true);
  assert.equal(role.hirearchy_usage, true);
  assert.equal(role.command_execute, true);

  const connectionString = `postgres://app_candidate_gateway:${encodeURIComponent(runtimePassword)}@${connection.host}:${connection.port}/${connection.database ?? 'postgres'}`;
  const adapter = createR26CandidateAdapter({ connectionString });
  const candidateDirect = new Pool({
    ...connection,
    user: 'app_candidate_gateway',
    password: runtimePassword,
    max: 1,
  });
  const evaluator = new Pool({
    ...connection,
    user: 'app_evaluator',
    password: runtimePassword,
    max: 1,
  });
  let locker;
  let pendingConstraint = false;
  try {
    await assert.rejects(
      () =>
        evaluator.query(
          `SELECT hirearchy.r26_candidate_command($1, $2, 'read', '{}'::jsonb)`,
          ['0'.repeat(64), 'sess_r26_not_evaluator'],
        ),
      (error) => error?.code === '42501',
      'Evaluator role cannot invoke the candidate adapter function',
    );
    await assert.rejects(
      () =>
        candidateDirect.query(
          'SELECT count(*) FROM hirearchy.candidate_workspace_files',
        ),
      (error) => error?.code === '42501',
      'Candidate gateway cannot query workspace tables directly',
    );

    const main = await createFixture(admin, { label: 'main' });
    const concurrentActivation = await createFixture(admin, {
      label: 'activate-race',
    });
    const tenantB = await createFixture(admin, {
      label: 'tenant-b',
      organizationId: FIXTURE_IDS.orgB,
      issuerPrincipalId: FIXTURE_IDS.recruiterB.principalId,
    });
    await assert.rejects(
      () =>
        admin.query(
          `SELECT hirearchy.r26_candidate_command($1, $2, 'read', '{}'::pg_catalog.jsonb)`,
          [main.tokenHash, main.sessionId],
        ),
      (error) => error?.code === 'R2608',
      'SECURITY DEFINER entry point rejects non-candidate session users',
    );

    try {
      await admin.query('ALTER ROLE app_candidate_gateway BYPASSRLS');
      await expectCandidateError(
        adapter.command({
          tokenHash: main.tokenHash,
          sessionId: main.sessionId,
          action: 'read',
        }),
        'CANDIDATE_ROLE_DENIED',
        403,
      );
    } finally {
      await admin.query('ALTER ROLE app_candidate_gateway NOBYPASSRLS');
    }

    await expectCandidateError(
      adapter.command({
        tokenHash: '0'.repeat(64),
        sessionId: main.sessionId,
        action: 'read',
      }),
      'SESSION_NOT_FOUND',
      404,
    );
    await expectCandidateError(
      adapter.command({
        tokenHash: main.tokenHash,
        sessionId: tenantB.sessionId,
        action: 'read',
      }),
      'SESSION_NOT_FOUND',
      404,
    );
    await expectCandidateError(
      adapter.command({
        tokenHash: tenantB.tokenHash,
        sessionId: main.sessionId,
        action: 'read',
      }),
      'SESSION_NOT_FOUND',
      404,
    );
    await expectCandidateError(
      adapter.command({
        tokenHash: main.tokenHash,
        sessionId: 'sess_r26_does_not_exist',
        action: 'read',
      }),
      'SESSION_NOT_FOUND',
      404,
    );

    const created = await adapter.command({
      tokenHash: main.tokenHash,
      sessionId: main.sessionId,
      action: 'read',
    });
    assert.equal(created.status, 'CREATED');
    assert.equal(created.activatedAt, null);
    assert.equal(created.deadline, null);
    assert.deepEqual(created.files, []);
    assert.equal(created.workspaceDigest, null);
    assert.equal(created.scenario.id, SCENARIO_ID);
    assert.equal(created.scenario.title, SCENARIO_TITLE);
    assertNoCapabilitySecrets(created, main.tokenHash);

    const activated = await adapter.command({
      tokenHash: main.tokenHash,
      sessionId: main.sessionId,
      action: 'activate',
      input: {},
    });
    assert.equal(activated.status, 'ACTIVE');
    assert.ok(activated.activatedAt);
    assert.ok(activated.deadline);
    assert.equal(activated.events.length, 1);
    assert.equal(activated.events[0].type, 'SESSION_ACTIVATED');
    assert.equal(activated.events[0].sequence, '1');
    assert.deepEqual(
      activated.files.map((file) => [file.path, file.version]),
      [
        ['README.md', '0'],
        ['bookings/service.py', '0'],
        ['tests/test_bookings.py', '0'],
      ],
    );
    const activatedAgain = await adapter.command({
      tokenHash: main.tokenHash,
      sessionId: main.sessionId,
      action: 'activate',
      input: {},
    });
    assert.equal(activatedAgain.activatedAt, activated.activatedAt);
    assert.equal(activatedAgain.events.length, 1);

    const activations = await Promise.all([
      adapter.command({
        tokenHash: concurrentActivation.tokenHash,
        sessionId: concurrentActivation.sessionId,
        action: 'activate',
        input: {},
      }),
      adapter.command({
        tokenHash: concurrentActivation.tokenHash,
        sessionId: concurrentActivation.sessionId,
        action: 'activate',
        input: {},
      }),
    ]);
    assert.deepEqual(
      activations.map((view) => view.status),
      ['ACTIVE', 'ACTIVE'],
    );
    assert.equal(activations[0].activatedAt, activations[1].activatedAt);
    assert.equal(activations[0].events.length, 1);

    const saveInput = {
      requestId: `save_${randomBytes(12).toString('hex')}`,
      path: 'bookings/service.py',
      content: 'def confirm():\n    return "saved"\n',
      expectedVersion: '0',
    };
    const saved = await adapter.command({
      tokenHash: main.tokenHash,
      sessionId: main.sessionId,
      action: 'save',
      input: saveInput,
    });
    const savedFile = saved.files.find((file) => file.path === saveInput.path);
    assert.equal(savedFile.content, saveInput.content);
    assert.equal(savedFile.version, '1');
    assert.equal(saved.events.at(-1).type, 'WORKSPACE_CHANGED');
    assert.equal(saved.events.at(-1).sequence, '2');
    assert.equal(saved.events.at(-1).payload.requestId, saveInput.requestId);
    assert.deepEqual(saved.operation, {
      requestId: saveInput.requestId,
      replayed: false,
    });

    const replay = await adapter.command({
      tokenHash: main.tokenHash,
      sessionId: main.sessionId,
      action: 'save',
      input: saveInput,
    });
    assert.deepEqual(replay.operation, {
      requestId: saveInput.requestId,
      replayed: true,
    });
    assert.equal(
      replay.files.find((file) => file.path === saveInput.path).version,
      '1',
    );
    assert.equal(
      replay.events.length,
      2,
      'accepted save replay does not add a duplicate event',
    );
    await expectCandidateError(
      adapter.command({
        tokenHash: main.tokenHash,
        sessionId: main.sessionId,
        action: 'save',
        input: { ...saveInput, content: 'changed intent' },
      }),
      'REQUEST_CONFLICT',
      409,
    );
    await expectCandidateError(
      adapter.command({
        tokenHash: main.tokenHash,
        sessionId: main.sessionId,
        action: 'save',
        input: {
          ...saveInput,
          requestId: `stale_${randomBytes(10).toString('hex')}`,
        },
      }),
      'WORKSPACE_CONFLICT',
      409,
    );
    for (const path of [
      '../escape.py',
      '/absolute.py',
      'bookings\\escape.py',
    ]) {
      await expectCandidateError(
        adapter.command({
          tokenHash: main.tokenHash,
          sessionId: main.sessionId,
          action: 'save',
          input: {
            requestId: `path_${randomBytes(10).toString('hex')}`,
            path,
            content: 'x',
            expectedVersion: '0',
          },
        }),
        'INVALID_REQUEST',
        400,
      );
    }
    await expectCandidateError(
      adapter.command({
        tokenHash: main.tokenHash,
        sessionId: main.sessionId,
        action: 'save',
        input: {
          requestId: `unknown_${randomBytes(10).toString('hex')}`,
          path: 'bookings/not-issued.py',
          content: 'x',
          expectedVersion: '0',
        },
      }),
      'INVALID_REQUEST',
      400,
    );

    const normalized = await adapter.command({
      tokenHash: main.tokenHash,
      sessionId: main.sessionId,
      action: 'save',
      input: {
        requestId: `newline_${randomBytes(10).toString('hex')}`,
        path: 'bookings/service.py',
        content: 'one\r\ntwo\r',
        expectedVersion: '1',
      },
    });
    assert.equal(
      normalized.files.find((file) => file.path === 'bookings/service.py')
        .content,
      'one\ntwo\n',
    );

    const exactFileLimit = await adapter.command({
      tokenHash: main.tokenHash,
      sessionId: main.sessionId,
      action: 'save',
      input: {
        requestId: `exact_${randomBytes(10).toString('hex')}`,
        path: 'bookings/service.py',
        content: 'x'.repeat(100_000),
        expectedVersion: '2',
      },
    });
    assert.equal(
      Buffer.byteLength(
        exactFileLimit.files.find((file) => file.path === 'bookings/service.py')
          .content,
        'utf8',
      ),
      100_000,
    );
    await expectCandidateError(
      adapter.command({
        tokenHash: main.tokenHash,
        sessionId: main.sessionId,
        action: 'save',
        input: {
          requestId: `oversize_${randomBytes(10).toString('hex')}`,
          path: 'bookings/service.py',
          content: 'x'.repeat(100_001),
          expectedVersion: '3',
        },
      }),
      'PAYLOAD_TOO_LARGE',
      413,
    );

    const manyFiles = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `src/module_${String(index + 1).padStart(2, '0')}.py`,
        '',
      ]),
    );
    const sizeFixture = await createFixture(admin, {
      label: 'workspace-limit',
      workspaceFiles: manyFiles,
    });
    let sized = await adapter.command({
      tokenHash: sizeFixture.tokenHash,
      sessionId: sizeFixture.sessionId,
      action: 'activate',
      input: {},
    });
    for (let index = 0; index < 11; index++) {
      sized = await adapter.command({
        tokenHash: sizeFixture.tokenHash,
        sessionId: sizeFixture.sessionId,
        action: 'save',
        input: {
          requestId: `size_${index}_${randomBytes(8).toString('hex')}`,
          path: `src/module_${String(index + 1).padStart(2, '0')}.py`,
          content: 'x'.repeat(90_000),
          expectedVersion: '0',
        },
      });
    }
    await expectCandidateError(
      adapter.command({
        tokenHash: sizeFixture.tokenHash,
        sessionId: sizeFixture.sessionId,
        action: 'save',
        input: {
          requestId: `size_over_${randomBytes(8).toString('hex')}`,
          path: 'src/module_12.py',
          content: 'x'.repeat(90_000),
          expectedVersion: '0',
        },
      }),
      'PAYLOAD_TOO_LARGE',
      413,
    );
    assert.equal(sized.files.length, 12);
    assert.equal(
      sized.files.find((file) => file.path === 'src/module_12.py').version,
      '0',
    );

    const unsupported = await createFixture(admin, {
      label: 'unsupported-snapshot-type',
      workspaceFiles: { 'payload.bin': 'text in an unsupported file type' },
    });
    await expectCandidateError(
      adapter.command({
        tokenHash: unsupported.tokenHash,
        sessionId: unsupported.sessionId,
        action: 'read',
      }),
      'SCENARIO_UNAVAILABLE',
      503,
    );
    const missingSnapshot = await createFixture(admin, {
      label: 'missing-snapshot',
      snapshot: false,
    });
    await expectCandidateError(
      adapter.command({
        tokenHash: missingSnapshot.tokenHash,
        sessionId: missingSnapshot.sessionId,
        action: 'read',
      }),
      'SCENARIO_UNAVAILABLE',
      503,
    );

    const beforeSubmit = await adapter.command({
      tokenHash: main.tokenHash,
      sessionId: main.sessionId,
      action: 'read',
    });
    const submitInput = {
      requestId: `submit_${randomBytes(12).toString('hex')}`,
      expectedWorkspaceDigest: beforeSubmit.workspaceDigest,
    };
    const submitted = await adapter.command({
      tokenHash: main.tokenHash,
      sessionId: main.sessionId,
      action: 'submit',
      input: submitInput,
    });
    assert.equal(submitted.status, 'SUBMITTED');
    assert.equal(submitted.closureReason, 'candidate_submission');
    assert.equal(submitted.submission.closureReason, 'candidate_submission');
    assert.equal(submitted.events.at(-1).type, 'SESSION_SUBMITTED');
    assert.deepEqual(
      submitted.events.map((event) => event.sequence),
      ['1', '2', '3', '4', '5'],
    );
    assert.ok(
      submitted.events.every((event) =>
        [
          'SESSION_ACTIVATED',
          'WORKSPACE_CHANGED',
          'SESSION_SUBMITTED',
        ].includes(event.type),
      ),
    );
    const submittedAgain = await adapter.command({
      tokenHash: main.tokenHash,
      sessionId: main.sessionId,
      action: 'submit',
      input: submitInput,
    });
    assert.equal(submittedAgain.status, 'SUBMITTED');
    assert.equal(submittedAgain.events.length, submitted.events.length);
    assert.deepEqual(submittedAgain.operation, {
      requestId: submitInput.requestId,
      replayed: true,
    });
    await expectCandidateError(
      adapter.command({
        tokenHash: main.tokenHash,
        sessionId: main.sessionId,
        action: 'submit',
        input: { ...submitInput, expectedWorkspaceDigest: 'f'.repeat(64) },
      }),
      'REQUEST_CONFLICT',
      409,
    );
    await expectCandidateError(
      adapter.command({
        tokenHash: main.tokenHash,
        sessionId: main.sessionId,
        action: 'submit',
        input: {
          requestId: `submit_changed_${randomBytes(10).toString('hex')}`,
          expectedWorkspaceDigest: 'f'.repeat(64),
        },
      }),
      'WORKSPACE_CONFLICT',
      409,
    );
    await expectCandidateError(
      adapter.command({
        tokenHash: main.tokenHash,
        sessionId: main.sessionId,
        action: 'save',
        input: {
          requestId: `after_${randomBytes(10).toString('hex')}`,
          path: 'bookings/service.py',
          content: 'late edit',
          expectedVersion: '3',
        },
      }),
      'SESSION_CONFLICT',
      409,
    );

    const submitRace = await createFixture(admin, { label: 'submit-race' });
    const raceActive = await adapter.command({
      tokenHash: submitRace.tokenHash,
      sessionId: submitRace.sessionId,
      action: 'activate',
      input: {},
    });
    const raceSubmit = {
      requestId: `race_submit_${randomBytes(8).toString('hex')}`,
      expectedWorkspaceDigest: raceActive.workspaceDigest,
    };
    const raceSubmissions = await Promise.all([
      adapter.command({
        tokenHash: submitRace.tokenHash,
        sessionId: submitRace.sessionId,
        action: 'submit',
        input: raceSubmit,
      }),
      adapter.command({
        tokenHash: submitRace.tokenHash,
        sessionId: submitRace.sessionId,
        action: 'submit',
        input: raceSubmit,
      }),
    ]);
    assert.deepEqual(
      raceSubmissions.map((view) => view.status),
      ['SUBMITTED', 'SUBMITTED'],
    );
    assert.equal(
      raceSubmissions[0].closureReason,
      raceSubmissions[1].closureReason,
    );
    const raceEvents = await admin.query(
      `SELECT event_type FROM hirearchy.candidate_session_events
        WHERE session_id = $1 AND event_type = 'SESSION_SUBMITTED'`,
      [submitRace.sessionId],
    );
    assert.equal(
      raceEvents.rowCount,
      1,
      'concurrent submit creates one closure event',
    );

    const saveSubmitRace = await createFixture(admin, {
      label: 'save-submit-race',
    });
    const saveSubmitActive = await adapter.command({
      tokenHash: saveSubmitRace.tokenHash,
      sessionId: saveSubmitRace.sessionId,
      action: 'activate',
      input: {},
    });
    const raceSaveInput = {
      requestId: `race_save_${randomBytes(8).toString('hex')}`,
      path: 'bookings/service.py',
      content: 'race save\n',
      expectedVersion: '0',
    };
    const saveRacePromise = adapter.command({
      tokenHash: saveSubmitRace.tokenHash,
      sessionId: saveSubmitRace.sessionId,
      action: 'save',
      input: raceSaveInput,
    });
    const submitRacePromise = adapter.command({
      tokenHash: saveSubmitRace.tokenHash,
      sessionId: saveSubmitRace.sessionId,
      action: 'submit',
      input: {
        requestId: `race_final_${randomBytes(8).toString('hex')}`,
        expectedWorkspaceDigest: saveSubmitActive.workspaceDigest,
      },
    });
    const raceResults = await Promise.allSettled([
      saveRacePromise,
      submitRacePromise,
    ]);
    const finalRace = await adapter.command({
      tokenHash: saveSubmitRace.tokenHash,
      sessionId: saveSubmitRace.sessionId,
      action: 'read',
    });
    if (raceResults[0].status === 'fulfilled') {
      assert.equal(finalRace.status, 'ACTIVE');
      assert.equal(
        finalRace.files.find((file) => file.path === raceSaveInput.path)
          .version,
        '1',
      );
      assert.equal(raceResults[1].status, 'rejected');
      assert.equal(raceResults[1].reason.code, 'WORKSPACE_CONFLICT');
    } else {
      assert.equal(raceResults[0].status, 'rejected');
      assert.equal(raceResults[0].reason.code, 'SESSION_CONFLICT');
      assert.equal(raceResults[1].status, 'fulfilled');
      assert.equal(finalRace.status, 'SUBMITTED');
      assert.equal(
        finalRace.submission.files.find(
          (file) => file.path === raceSaveInput.path,
        ).version,
        '0',
      );
    }

    const failedFinality = await createFixture(admin, {
      label: 'rollback-finality',
    });
    await adapter.command({
      tokenHash: failedFinality.tokenHash,
      sessionId: failedFinality.sessionId,
      action: 'activate',
      input: {},
    });
    await admin.query(
      `ALTER TABLE hirearchy.candidate_session_submissions
       ADD CONSTRAINT r26_test_force_submission_rollback
       CHECK (closure_reason <> 'candidate_submission') NOT VALID`,
    );
    pendingConstraint = true;
    const failedView = await adapter.command({
      tokenHash: failedFinality.tokenHash,
      sessionId: failedFinality.sessionId,
      action: 'read',
    });
    await expectCandidateError(
      adapter.command({
        tokenHash: failedFinality.tokenHash,
        sessionId: failedFinality.sessionId,
        action: 'submit',
        input: {
          requestId: `rollback_${randomBytes(8).toString('hex')}`,
          expectedWorkspaceDigest: failedView.workspaceDigest,
        },
      }),
      'CANDIDATE_STORAGE_UNAVAILABLE',
      503,
    );
    await admin.query(
      'ALTER TABLE hirearchy.candidate_session_submissions DROP CONSTRAINT r26_test_force_submission_rollback',
    );
    pendingConstraint = false;
    const rollbackState = await adapter.command({
      tokenHash: failedFinality.tokenHash,
      sessionId: failedFinality.sessionId,
      action: 'read',
    });
    assert.equal(rollbackState.status, 'ACTIVE');
    assert.equal(rollbackState.submission, null);
    assert.equal(rollbackState.events.length, 1);

    const deadlineAdmission = await createFixture(admin, {
      label: 'deadline-admission',
      durationSeconds: 3,
    });
    const deadlineActive = await adapter.command({
      tokenHash: deadlineAdmission.tokenHash,
      sessionId: deadlineAdmission.sessionId,
      action: 'activate',
      input: {},
    });
    const adminParameters = admin.connectionParameters;
    if (typeof adminParameters?.password !== 'string') {
      throw new Error(
        'R2.6 deadline lock test requires an admin connection password',
      );
    }
    locker = new Client({
      ...connection,
      user: adminParameters.user,
      password: adminParameters.password,
    });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query(
      'SELECT id FROM hirearchy.assessment_sessions WHERE id = $1 FOR UPDATE',
      [deadlineAdmission.sessionId],
    );
    const deadlineSubmitPromise = adapter
      .command({
        tokenHash: deadlineAdmission.tokenHash,
        sessionId: deadlineAdmission.sessionId,
        action: 'submit',
        input: {
          requestId: `deadline_${randomBytes(8).toString('hex')}`,
          expectedWorkspaceDigest: deadlineActive.workspaceDigest,
        },
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    await waitForLockWait(admin);
    await waitUntilDeadline(admin, deadlineAdmission.sessionId);
    await locker.query('COMMIT');
    const deadlineOutcome = await deadlineSubmitPromise;
    if (deadlineOutcome.error) throw deadlineOutcome.error;
    const deadlineSubmitted = deadlineOutcome.value;
    assert.equal(deadlineSubmitted.status, 'SUBMITTED');
    assert.equal(deadlineSubmitted.closureReason, 'candidate_submission');
    await locker.end();
    locker = undefined;

    const timeoutFixture = await createFixture(admin, {
      label: 'timeout-read',
      durationSeconds: 1,
    });
    await adapter.command({
      tokenHash: timeoutFixture.tokenHash,
      sessionId: timeoutFixture.sessionId,
      action: 'activate',
      input: {},
    });
    await waitUntilDeadline(admin, timeoutFixture.sessionId, 3000);
    await expectCandidateError(
      adapter.command({
        tokenHash: timeoutFixture.tokenHash,
        sessionId: timeoutFixture.sessionId,
        action: 'save',
        input: {
          requestId: `after_deadline_${randomBytes(8).toString('hex')}`,
          path: 'bookings/service.py',
          content: 'late write',
          expectedVersion: '0',
        },
      }),
      'SESSION_DEADLINE_EXCEEDED',
      409,
    );
    const timedOut = await adapter.command({
      tokenHash: timeoutFixture.tokenHash,
      sessionId: timeoutFixture.sessionId,
      action: 'read',
    });
    assert.equal(timedOut.status, 'SUBMITTED');
    assert.equal(timedOut.closureReason, 'timeout');
    assert.equal(timedOut.submission.closureReason, 'timeout');
    assert.deepEqual(
      timedOut.events.map((event) => event.type),
      ['SESSION_ACTIVATED', 'SESSION_SUBMITTED'],
    );

    const immutable = await admin.query(
      'SELECT event_type, sequence FROM hirearchy.candidate_session_events WHERE session_id = $1 ORDER BY sequence',
      [main.sessionId],
    );
    assert.deepEqual(
      immutable.rows.map((event) => event.event_type),
      [
        'SESSION_ACTIVATED',
        'WORKSPACE_CHANGED',
        'WORKSPACE_CHANGED',
        'WORKSPACE_CHANGED',
        'SESSION_SUBMITTED',
      ],
    );
    await assert.rejects(
      () =>
        admin.query(
          `UPDATE hirearchy.candidate_session_events
              SET payload = '{}'::pg_catalog.jsonb WHERE session_id = $1 AND sequence = 1`,
          [main.sessionId],
        ),
      (error) => error?.code === '23514',
      'event evidence is immutable',
    );
    await assert.rejects(
      () =>
        admin.query(
          `UPDATE hirearchy.candidate_session_submissions
              SET manifest = '[]'::pg_catalog.jsonb WHERE session_id = $1`,
          [main.sessionId],
        ),
      (error) => error?.code === '23514',
      'submitted manifest is immutable',
    );
    await assert.rejects(
      () =>
        admin.query(
          `UPDATE hirearchy.assessment_sessions
              SET scenario_snapshot = '{}' WHERE id = $1`,
          [main.sessionId],
        ),
      (error) => error?.code === '23514',
      'issued scenario snapshot is immutable',
    );
    const operations = await admin.query(
      `SELECT request_id, action, result
         FROM hirearchy.candidate_session_operations
        WHERE session_id = $1 ORDER BY accepted_at, request_id`,
      [main.sessionId],
    );
    assert.equal(
      operations.rows.filter(
        (operation) => operation.request_id === saveInput.requestId,
      ).length,
      1,
      'accepted save request ID is durably recorded exactly once',
    );
    assert.equal(
      operations.rows.filter((operation) => operation.action === 'submit')
        .length,
      1,
    );
    assertNoCapabilitySecrets(submittedAgain, main.tokenHash);
  } finally {
    if (pendingConstraint) {
      await admin
        .query(
          'ALTER TABLE hirearchy.candidate_session_submissions DROP CONSTRAINT IF EXISTS r26_test_force_submission_rollback',
        )
        .catch(() => undefined);
    }
    if (locker) await locker.end().catch(() => undefined);
    await evaluator.end();
    await candidateDirect.end();
    await adapter.close();
  }
}
