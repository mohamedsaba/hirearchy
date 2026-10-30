import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getCookie } = vi.hoisted(() => ({ getCookie: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: getCookie }),
}));

import {
  GET as listAssessments,
  POST as createAssessment,
} from '../../apps/web/app/api/evaluator/assessments/route';
import { POST as createLegacySession } from '../../apps/web/app/api/sessions/route';
import { GET as getCandidateSession } from '../../apps/web/app/api/candidate/sessions/[token]/route';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';
import { supportedAssessmentSelection } from '../../apps/web/src/assessments/assessment-options';
import { createScenario002TaskRubric } from '../../apps/web/src/assessments/task-rubric';
import { migrateLegacyCandidateTokens } from '../../apps/web/src/sessions/candidate-token-storage.mjs';
import * as issuableScenarios from '../../apps/web/src/scenarios/issuable-scenarios';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

describe('assessment issuance idempotency integration', () => {
  let directory: string;
  let databasePath: string;
  let originalDbPath: string | undefined;
  let originalEvaluatorKey: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(
      path.join(tmpdir(), 'hirearchy-issuance-idempotency-'),
    );
    databasePath = path.join(directory, 'sessions.sqlite');
    originalDbPath = process.env.HIREARCHY_DB_PATH;
    originalEvaluatorKey = process.env.HIREARCHY_EVALUATOR_KEY;
    process.env.HIREARCHY_DB_PATH = databasePath;
    process.env.HIREARCHY_EVALUATOR_KEY = 'issuance-test-evaluator-key';
    getCookie.mockReturnValue({
      value: createSignedEvaluatorToken('issuance-test-evaluator-key'),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDbPath === undefined) delete process.env.HIREARCHY_DB_PATH;
    else process.env.HIREARCHY_DB_PATH = originalDbPath;
    if (originalEvaluatorKey === undefined)
      delete process.env.HIREARCHY_EVALUATOR_KEY;
    else process.env.HIREARCHY_EVALUATOR_KEY = originalEvaluatorKey;
    rmSync(directory, { recursive: true, force: true });
  });

  const body = () => ({
    ...supportedAssessmentSelection,
    integratedAi: false,
    useCuratedBlueprint: true,
  });

  const request = (
    payload: unknown,
    key: string,
    headers: Record<string, string> = {},
  ) =>
    new Request('http://localhost/api/evaluator/assessments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        ...headers,
      },
      body: JSON.stringify(payload),
    });

  const persistedRows = () => {
    if (!existsSync(databasePath)) return [];
    const database = new Database(databasePath, { readonly: true });
    try {
      return database
        .prepare(
          `SELECT id, candidate_token, candidate_token_ciphertext,
                  candidate_token_hash, issuance_key,
                  issuance_request_hash, issuance_payload_hash
           FROM assessment_sessions ORDER BY id`,
        )
        .all() as Array<{
        id: string;
        candidate_token: string | null;
        candidate_token_ciphertext: string | null;
        candidate_token_hash: string;
        issuance_key: string | null;
        issuance_request_hash: string | null;
        issuance_payload_hash: string | null;
      }>;
    } finally {
      database.close();
    }
  };

  it('recovers a committed lost-response request without storing plaintext or changing the session', async () => {
    const key = 'lost-response-key';
    const firstResponse = await createAssessment(request(body(), key));
    expect(firstResponse.status).toBe(201);
    const first = (await firstResponse.json()) as {
      sessionId: string;
      candidatePath: string;
    };

    // Model the browser losing the successful response: the next call is the
    // same header and exact payload, with no knowledge of the first response.
    const replayResponse = await createAssessment(request(body(), key));
    expect(replayResponse.status).toBe(200);
    const replay = (await replayResponse.json()) as typeof first;
    expect(replay.sessionId).toBe(first.sessionId);
    expect(replay.candidatePath).toBe(first.candidatePath);

    const lifecycleResponse = await listAssessments();
    expect(lifecycleResponse.status).toBe(200);
    expect(lifecycleResponse.headers.get('Cache-Control')).toContain(
      'no-store',
    );
    const lifecycle = (await lifecycleResponse.json()) as {
      assessments: Array<{ sessionId: string; candidatePath: string | null }>;
    };
    expect(
      lifecycle.assessments.find((entry) => entry.sessionId === first.sessionId)
        ?.candidatePath,
    ).toBe(first.candidatePath);

    const rows = persistedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].candidate_token).toBeNull();
    expect(rows[0].candidate_token_ciphertext).toMatch(/^v1\./);
    expect(rows[0].issuance_key).toBe(key);
    expect(rows[0].issuance_request_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0].issuance_payload_hash).toMatch(/^[a-f0-9]{64}$/);

    const store = new SqliteSessionStore(databasePath);
    expect(store.findById(first.sessionId)?.candidateToken).toBeNull();
    const recoveredToken = store.recoverCandidateTokenForAssessment(
      first.sessionId,
    );
    const suppliedToken = first.candidatePath.slice('/candidate/'.length);
    expect(recoveredToken).toBe(suppliedToken);
    expect(
      store.findByCandidateTokenHash(
        createHash('sha256').update(suppliedToken).digest('hex'),
      )?.id,
    ).toBe(first.sessionId);
  });

  it('keeps legitimate legacy requests unkeyed while persisting their links only as ciphertext', async () => {
    const legacyRequest = new Request(
      'http://localhost/api/evaluator/assessments',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      },
    );
    const legacyResponse = await createAssessment(legacyRequest);
    expect(legacyResponse.status).toBe(201);
    const legacy = (await legacyResponse.json()) as { sessionId: string };
    const legacyRow = persistedRows().find(
      (row) => row.id === legacy.sessionId,
    );
    expect(legacyRow?.issuance_key).toBeNull();
    expect(legacyRow?.candidate_token).toBeNull();
    expect(legacyRow?.candidate_token_ciphertext).toMatch(/^v1\./);

    const keyedResponse = await createAssessment(
      request(body(), 'new-key-next-to-legacy-session'),
    );
    expect(keyedResponse.status).toBe(201);
    expect((await keyedResponse.json()).sessionId).not.toBe(legacy.sessionId);
    expect(persistedRows()).toHaveLength(2);
  });

  it('serializes concurrent same-key requests and permits an explicit second key', async () => {
    const key = 'concurrent-request-key';
    const responses = await Promise.all([
      createAssessment(request(body(), key)),
      createAssessment(request(body(), key)),
    ]);
    const payloads = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 201,
    ]);
    expect(
      new Set(payloads.map((item) => (item as { sessionId: string }).sessionId))
        .size,
    ).toBe(1);

    const secondResponse = await createAssessment(
      request(body(), 'intentional-second-assessment'),
    );
    expect(secondResponse.status).toBe(201);
    expect(persistedRows()).toHaveLength(2);
  });

  it('sanitizes runtime database open failures on both issuance routes', async () => {
    process.env.HIREARCHY_DB_PATH = directory;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const assessmentResponse = await createAssessment(
      request(body(), 'runtime-database-failure'),
    );
    const sessionResponse = await createLegacySession(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'scenario-001-cache-staleness' }),
      }),
    );
    const assessmentBody = await assessmentResponse.text();
    const sessionBody = await sessionResponse.text();

    expect(assessmentResponse.status).toBe(500);
    expect(sessionResponse.status).toBe(500);
    expect(assessmentBody).not.toContain(directory);
    expect(sessionBody).not.toContain(directory);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain(directory);
    expect(log.mock.calls).toEqual([
      ['Unexpected request failure [INTERNAL_ERROR]'],
      ['Unexpected request failure [INTERNAL_ERROR]'],
    ]);
  });

  it('serializes the same key across independent SQLite connections', async () => {
    const database = new Database(databasePath);
    try {
      SqliteSessionStore.ensureSchema(database, { allowNewDatabase: true });
    } finally {
      database.close();
    }

    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const sharedBarrier = new Int32Array(barrier);
    const workers = Array.from(
      { length: 2 },
      () =>
        new Worker(
          new URL(
            '../fixtures/assessment-issuance-concurrency-worker.mjs',
            import.meta.url,
          ),
          {
            workerData: {
              databasePath,
              key: 'independent-connection-key',
              barrier,
            },
          },
        ),
    );
    const outcomes = workers.map((worker) => {
      let resolveReady!: () => void;
      let resolveDone!: (value: { created: boolean; id: string }) => void;
      let rejectDone!: (reason: Error) => void;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const done = new Promise<{ created: boolean; id: string }>(
        (resolve, reject) => {
          resolveDone = resolve;
          rejectDone = reject;
        },
      );
      worker.on('message', (message: Record<string, unknown>) => {
        if (message.type === 'ready') resolveReady();
        if (message.type === 'done')
          resolveDone(message.result as { created: boolean; id: string });
        if (message.type === 'error')
          rejectDone(new Error(String(message.error)));
      });
      worker.once('error', rejectDone);
      return { ready, done };
    });

    try {
      await Promise.all(outcomes.map((outcome) => outcome.ready));
      Atomics.store(sharedBarrier, 0, 1);
      Atomics.notify(sharedBarrier, 0, workers.length);
      const results = await Promise.all(
        outcomes.map((outcome) => outcome.done),
      );

      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      const verify = new Database(databasePath, { readonly: true });
      try {
        expect(
          verify
            .prepare(
              'SELECT COUNT(*) AS count FROM assessment_sessions WHERE issuance_key = ?',
            )
            .get('independent-connection-key'),
        ).toEqual({ count: 1 });
      } finally {
        verify.close();
      }
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  });

  it('conflicts on changed intent but canonicalizes field order and the default terminal value', async () => {
    const key = 'canonical-request-key';
    const original = body();
    const firstResponse = await createAssessment(request(original, key));
    expect(firstResponse.status).toBe(201);

    const reordered = {
      useCuratedBlueprint: true,
      integratedAi: false,
      durationMinutes: supportedAssessmentSelection.durationMinutes,
      depth: supportedAssessmentSelection.depth,
      stack: supportedAssessmentSelection.stack,
      domain: supportedAssessmentSelection.domain,
      workKind: supportedAssessmentSelection.workKind,
      field: supportedAssessmentSelection.field,
      terminalEnabled: true,
    };
    const equivalentResponse = await createAssessment(request(reordered, key));
    expect(equivalentResponse.status).toBe(200);

    const changedResponse = await createAssessment(
      request({ ...original, field: 'frontend' }, key),
    );
    expect(changedResponse.status).toBe(409);
    expect(await changedResponse.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_CONFLICT' },
    });
    expect(persistedRows()).toHaveLength(1);
  });

  it('conflicts when any accepted assessment selection field changes under the same key', async () => {
    const key = 'selection-fields-request-key';
    const original = body();
    const accepted = await createAssessment(request(original, key));
    expect(accepted.status).toBe(201);

    const changedSelections = [
      { field: 'frontend' },
      { workKind: 'feature' },
      { domain: 'fintech' },
      { stack: 'typescript-react' },
      { depth: 'contained' },
    ];
    for (const changedSelection of changedSelections) {
      const response = await createAssessment(
        request({ ...original, ...changedSelection }, key),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: 'IDEMPOTENCY_KEY_CONFLICT' },
      });
    }
    expect(persistedRows()).toHaveLength(1);
  });

  it('canonicalizes rubric map order while treating omitted and explicit weights as distinct intents', async () => {
    const key = 'rubric-request-key';
    const criteria = createScenario002TaskRubric().criteria;
    const rubricWeights = Object.fromEntries(
      criteria.map(({ id, weight }) => [id, weight]),
    );
    const explicitResponse = await createAssessment(
      request({ ...body(), rubricWeights }, key),
    );
    expect(explicitResponse.status).toBe(201);

    const reorderedWeights = Object.fromEntries(
      Object.entries(rubricWeights).reverse(),
    );
    const mapReplay = await createAssessment(
      request({ ...body(), rubricWeights: reorderedWeights }, key),
    );
    expect(mapReplay.status).toBe(200);

    const omittedWeights = await createAssessment(request(body(), key));
    expect(omittedWeights.status).toBe(409);
    expect(persistedRows()).toHaveLength(1);
  });

  it('rejects a body request-key alias instead of choosing between key locations', async () => {
    const response = await createAssessment(
      request({ ...body(), idempotencyKey: 'body-key' }, 'header-key'),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_IDEMPOTENCY_KEY' },
    });
    expect(persistedRows()).toHaveLength(0);
  });

  it('does not recover an existing candidate link before evaluator authorization', async () => {
    const key = 'unauthorized-recovery-key';
    const accepted = await createAssessment(request(body(), key));
    expect(accepted.status).toBe(201);

    getCookie.mockReturnValue(null);
    const replay = await createAssessment(request(body(), key));
    expect(replay.status).toBe(401);
    const responseBody = await replay.text();
    expect(responseBody).not.toContain('/candidate/');
    expect(responseBody).not.toContain('candidatePath');
    expect(persistedRows()).toHaveLength(1);
  });

  it('replays before re-resolving a scenario that became unavailable', async () => {
    const key = 'scenario-drift-replay-key';
    const accepted = await createAssessment(request(body(), key));
    expect(accepted.status).toBe(201);
    const original = (await accepted.json()) as {
      sessionId: string;
      candidatePath: string;
    };

    vi.spyOn(issuableScenarios, 'getIssuableScenario').mockReturnValue(null);
    const freshRequest = await createAssessment(
      request(body(), 'new-key-after-scenario-removal'),
    );
    expect(freshRequest.status).toBe(503);

    const replay = await createAssessment(request(body(), key));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject(original);
    expect(persistedRows()).toHaveLength(1);
  });

  it('migrates an existing link without breaking hash-based candidate access', async () => {
    const accepted = await createAssessment(
      request(body(), 'legacy-link-migration-key'),
    );
    expect(accepted.status).toBe(201);
    const issued = (await accepted.json()) as {
      sessionId: string;
      candidatePath: string;
    };
    const token = issued.candidatePath.slice('/candidate/'.length);

    const database = new Database(databasePath);
    try {
      database
        .prepare(
          `UPDATE assessment_sessions
           SET candidate_token = ?, candidate_token_ciphertext = NULL
           WHERE id = ?`,
        )
        .run(token, issued.sessionId);
      expect(
        migrateLegacyCandidateTokens(database, { adoptExisting: true }),
      ).toEqual({
        converted: 1,
        rotated: 0,
      });
      const row = database
        .prepare(
          `SELECT candidate_token, candidate_token_hash,
                  candidate_token_ciphertext
           FROM assessment_sessions WHERE id = ?`,
        )
        .get(issued.sessionId) as {
        candidate_token: string | null;
        candidate_token_hash: string;
        candidate_token_ciphertext: string;
      };
      expect(row.candidate_token).toBeNull();
      expect(row.candidate_token_ciphertext).toMatch(/^v1\./);
      expect(row.candidate_token_hash).toBe(
        createHash('sha256').update(token).digest('hex'),
      );
    } finally {
      database.close();
    }

    const candidateResponse = await getCandidateSession(
      new Request('http://localhost/api/candidate/sessions'),
      { params: Promise.resolve({ token }) },
    );
    expect(candidateResponse.status).toBe(200);
    expect(await candidateResponse.json()).toMatchObject({
      id: issued.sessionId,
      status: 'CREATED',
    });
  });
});
