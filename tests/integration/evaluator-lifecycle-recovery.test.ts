import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getCookie } = vi.hoisted(() => ({ getCookie: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: getCookie }),
}));

import {
  GET as getAssessments,
  POST as createAssessment,
} from '../../apps/web/app/api/evaluator/assessments/route';
import { POST as generateAssessment } from '../../apps/web/app/api/evaluator/assessments/generate/route';
import { GET as getCandidateSession } from '../../apps/web/app/api/candidate/sessions/[token]/route';
import { GET as getCandidateTiming } from '../../apps/web/app/api/candidate/sessions/[token]/timing/route';
import { GET as getCandidateWorkspaceTree } from '../../apps/web/app/api/candidate/sessions/[token]/workspace/tree/route';
import { GET as getCandidateWorkspaceFile } from '../../apps/web/app/api/candidate/sessions/[token]/workspace/file/route';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';
import { supportedAssessmentSelection } from '../../apps/web/src/assessments/assessment-options';
import { getReviewerWorkflowStore } from '../../apps/web/src/review-workflow/reviewer-workflow-store';
import { SessionError } from '../../apps/web/src/sessions/session';
import {
  getSessionService,
  SessionService,
} from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';
import Database from 'better-sqlite3';
import { migrateLegacyCandidateTokens } from '../../apps/web/src/sessions/candidate-token-storage.mjs';

describe('evaluator lifecycle recovery integration', () => {
  let directory: string;
  let databasePath: string;
  let originalDbPath: string | undefined;
  let originalKey: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(
      path.join(tmpdir(), 'hirearchy-lifecycle-recovery-'),
    );
    databasePath = path.join(directory, 'sessions.sqlite');
    originalDbPath = process.env.HIREARCHY_DB_PATH;
    originalKey = process.env.HIREARCHY_EVALUATOR_KEY;
    process.env.HIREARCHY_DB_PATH = databasePath;
    process.env.HIREARCHY_EVALUATOR_KEY = 'lifecycle-test-key';
    getCookie.mockReturnValue({
      value: createSignedEvaluatorToken('lifecycle-test-key'),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDbPath === undefined) delete process.env.HIREARCHY_DB_PATH;
    else process.env.HIREARCHY_DB_PATH = originalDbPath;
    if (originalKey === undefined) delete process.env.HIREARCHY_EVALUATOR_KEY;
    else process.env.HIREARCHY_EVALUATOR_KEY = originalKey;
    rmSync(directory, { recursive: true, force: true });
  });

  const postRequest = (url: string, body: unknown) =>
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('issues a curated assessment without AI generation and recovers its encrypted candidate token', async () => {
    const response = await createAssessment(
      postRequest('http://localhost/api/evaluator/assessments', {
        ...supportedAssessmentSelection,
        integratedAi: false,
        useCuratedBlueprint: true,
      }),
    );

    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      sessionId: string;
      candidatePath: string;
      scenario: { title: string; id: string; durationSeconds: number };
      terminalEnabled: boolean;
      taskRubric: { criteria: readonly { id: string; weight: number }[] };
    };

    expect(created.sessionId).toBeDefined();
    expect(created.candidatePath).toMatch(/^\/candidate\/.+$/);
    expect(created.scenario.title).toBe('The second confirmation');
    expect(created.terminalEnabled).toBe(true);
    expect(created.taskRubric.criteria).toHaveLength(5);

    // Verify token and session are persisted in SQLite store
    const store = new SqliteSessionStore(databasePath);
    const stored = store.findById(created.sessionId);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('CREATED');
    expect(stored?.candidateToken).toBeNull();
    const recoveredToken = store.recoverCandidateTokenForAssessment(
      created.sessionId,
    );
    expect(created.candidatePath).toBe(`/candidate/${recoveredToken}`);
  });

  it('serves full assessment lifecycle via GET /api/evaluator/assessments with recoverable candidate paths', async () => {
    // Issue a curated assessment
    const createRes = await createAssessment(
      postRequest('http://localhost/api/evaluator/assessments', {
        ...supportedAssessmentSelection,
        integratedAi: false,
        useCuratedBlueprint: true,
      }),
    );
    expect(createRes.status).toBe(201);
    const { sessionId, candidatePath } = (await createRes.json()) as {
      sessionId: string;
      candidatePath: string;
    };

    // Query lifecycle listing
    const listRes = await getAssessments();
    expect(listRes.status).toBe(200);
    const data = (await listRes.json()) as {
      assessments: readonly {
        sessionId: string;
        candidatePath: string | null;
        status: string;
        scenarioTitle: string;
        closureReason: string | null;
        reviewProcessStatus: string | null;
      }[];
    };

    expect(data.assessments).toHaveLength(1);
    const item = data.assessments[0];
    expect(item.sessionId).toBe(sessionId);
    expect(item.candidatePath).toBe(candidatePath);
    expect(item.status).toBe('CREATED');
    expect(item.scenarioTitle).toBe('The second confirmation');
    expect(item.closureReason).toBeNull();
    expect(item.reviewProcessStatus).toBeNull();
  });

  it('tracks progression from CREATED -> ACTIVE -> SUBMITTED with review workflow status', async () => {
    // 1. Issue curated assessment
    const createRes = await createAssessment(
      postRequest('http://localhost/api/evaluator/assessments', {
        ...supportedAssessmentSelection,
        integratedAi: false,
        useCuratedBlueprint: true,
      }),
    );
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const store = new SqliteSessionStore(databasePath);
    const session = store.findById(sessionId)!;

    // 2. Candidate starts session -> ACTIVE
    store.activate(session.candidateTokenHash, '2026-10-19T12:00:00.000Z');

    let listRes = await getAssessments();
    let data = (await listRes.json()) as {
      assessments: readonly {
        sessionId: string;
        status: string;
        activatedAt: string | null;
        submittedAt: string | null;
        closureReason: string | null;
        reviewProcessStatus: string | null;
      }[];
    };
    expect(data.assessments[0].status).toBe('ACTIVE');
    expect(data.assessments[0].activatedAt).toBe('2026-10-19T12:00:00.000Z');

    // 3. Candidate submits session -> SUBMITTED (completed)
    store.submit(
      session.candidateTokenHash,
      '2026-10-19T12:45:00.000Z',
      null,
      'candidate_submission',
    );

    listRes = await getAssessments();
    data = (await listRes.json()) as {
      assessments: typeof data.assessments;
    };
    expect(data.assessments[0].status).toBe('SUBMITTED');
    expect(data.assessments[0].submittedAt).toBe('2026-10-19T12:45:00.000Z');
    expect(data.assessments[0].closureReason).toBe('candidate_submission');
    expect(data.assessments[0].reviewProcessStatus).toBe('not_started');

    // 4. Evaluator adds review notes -> in_progress
    const workflowStore = getReviewerWorkflowStore();
    workflowStore.saveNote(
      sessionId,
      'Candidate addressed idempotency well.',
      0,
    );

    listRes = await getAssessments();
    data = (await listRes.json()) as {
      assessments: typeof data.assessments;
    };
    expect(data.assessments[0].reviewProcessStatus).toBe('in_progress');
  });

  it('tracks timeout finality as SUBMITTED with timeout closure reason', async () => {
    const createRes = await createAssessment(
      postRequest('http://localhost/api/evaluator/assessments', {
        ...supportedAssessmentSelection,
        integratedAi: false,
        useCuratedBlueprint: true,
      }),
    );
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const store = new SqliteSessionStore(databasePath);
    const session = store.findById(sessionId)!;
    store.activate(session.candidateTokenHash, '2026-10-19T12:00:00.000Z');
    store.submit(
      session.candidateTokenHash,
      '2026-10-19T13:00:00.000Z',
      null,
      'timeout',
    );

    const listRes = await getAssessments();
    const data = (await listRes.json()) as {
      assessments: readonly {
        sessionId: string;
        status: string;
        closureReason: string | null;
      }[];
    };
    expect(data.assessments[0].status).toBe('SUBMITTED');
    expect(data.assessments[0].closureReason).toBe('timeout');
  });

  it('allows custom rubric weights for curated blueprint when weights total 100', async () => {
    const response = await createAssessment(
      postRequest('http://localhost/api/evaluator/assessments', {
        ...supportedAssessmentSelection,
        integratedAi: false,
        useCuratedBlueprint: true,
        rubricWeights: {
          'problem-approach': 25,
          'implementation-quality': 25,
          'task-behavior': 25,
          'relevant-verification': 15,
          'recorded-integrated-ai-collaboration': 10,
        },
      }),
    );

    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      taskRubric: { criteria: readonly { id: string; weight: number }[] };
    };
    const approachCriterion = created.taskRubric.criteria.find(
      (c) => c.id === 'problem-approach',
    );
    expect(approachCriterion?.weight).toBe(25);
  });

  it('rejects invalid rubric weights for curated blueprint', async () => {
    const response = await createAssessment(
      postRequest('http://localhost/api/evaluator/assessments', {
        ...supportedAssessmentSelection,
        integratedAi: false,
        useCuratedBlueprint: true,
        rubricWeights: {
          'problem-approach': 50,
          // Missing other criteria
        },
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_RUBRIC_WEIGHTS');
  });

  it('preserves optional AI generation endpoint with honest 503 when provider is not configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const response = await generateAssessment(
      postRequest('http://localhost/api/evaluator/assessments/generate', {
        ...supportedAssessmentSelection,
        integratedAi: false,
      }),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      status: string;
      reason: string;
    };
    expect(body.status).toBe('UNAVAILABLE_DRAFT');
    expect(body.reason).toContain('configured AI provider is required');
  });

  it('enforces evaluator authentication on lifecycle endpoint', async () => {
    getCookie.mockReturnValue(undefined);

    const response = await getAssessments();
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('EVALUATOR_ACCESS_REQUIRED');
  });

  it('does not expose invitation or session data to unauthorized evaluators', async () => {
    const createRes = await createAssessment(
      postRequest('http://localhost/api/evaluator/assessments', {
        ...supportedAssessmentSelection,
        integratedAi: false,
        useCuratedBlueprint: true,
      }),
    );
    const { sessionId, candidatePath } = (await createRes.json()) as {
      sessionId: string;
      candidatePath: string;
    };
    const candidateToken = candidatePath.split('/').at(-1)!;
    getCookie.mockReturnValue(undefined);

    const response = await getAssessments();
    const body = await response.text();
    expect(response.status).toBe(401);
    expect(body).not.toContain(candidateToken);
    expect(body).not.toContain(sessionId);
    expect(body).not.toContain('The second confirmation');
    expect(body).not.toContain('candidateToken');
  });

  it('protects candidate resources through HTTP routes and serves a valid invitation', async () => {
    const createRes = await createAssessment(
      postRequest('http://localhost/api/evaluator/assessments', {
        ...supportedAssessmentSelection,
        integratedAi: false,
        useCuratedBlueprint: true,
      }),
    );
    const { candidatePath } = (await createRes.json()) as {
      candidatePath: string;
    };
    const validToken = candidatePath.split('/').at(-1)!;
    const unknownToken = 'unknown-candidate-token';
    const context = (token: string) => ({ params: Promise.resolve({ token }) });

    const valid = await getCandidateSession(
      new Request('http://localhost/api/candidate/sessions'),
      context(validToken),
    );
    expect(valid.status).toBe(200);
    expect((await valid.json()).scenario.title).toBe('The second confirmation');

    const requests = await Promise.all([
      getCandidateSession(
        new Request('http://localhost'),
        context(unknownToken),
      ),
      getCandidateTiming(
        new Request('http://localhost'),
        context(unknownToken),
      ),
      getCandidateWorkspaceTree(
        new Request('http://localhost'),
        context(unknownToken),
      ),
      getCandidateWorkspaceFile(
        new Request(
          'http://localhost/api/candidate/workspace/file?path=README.md',
        ),
        context(unknownToken),
      ),
    ]);
    for (const response of requests) {
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(body).not.toContain(unknownToken);
      expect(body).not.toContain(validToken);
      expect(body).not.toContain('The second confirmation');
      expect(body).not.toContain('candidateToken');
    }
  });

  it('safely migrates legacy SQLite tables without candidate_token column and preserves session records', async () => {
    // 1. Manually initialize legacy table schema without candidate_token column
    const rawDb = new Database(databasePath);
    rawDb.exec(`
      CREATE TABLE assessment_sessions (
        id TEXT PRIMARY KEY,
        candidate_token_hash TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        scenario_version TEXT NOT NULL,
        scenario_title TEXT NOT NULL,
        scenario_brief TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        file_path TEXT NOT NULL,
        original_content TEXT NOT NULL,
        status TEXT NOT NULL,
        working_content TEXT NOT NULL,
        submitted_content TEXT,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        submitted_at TEXT,
        duration_seconds INTEGER,
        closure_reason TEXT
      );
    `);

    // Insert a legacy session row
    rawDb
      .prepare(
        `INSERT INTO assessment_sessions (
          id, candidate_token_hash, scenario_id, scenario_version, scenario_title,
          scenario_brief, acceptance_criteria, file_path, original_content,
          status, working_content, created_at, duration_seconds
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-session-001',
        createHash('sha256')
          .update('legacy-token-without-recovery')
          .digest('hex'),
        'scenario-001',
        '1.0.0',
        'Legacy Scenario Title',
        'Legacy brief',
        JSON.stringify(['Criterion 1']),
        'src/solution.ts',
        'const x = 1;',
        'CREATED',
        'const x = 1;',
        '2026-09-01T10:00:00.000Z',
        1800,
      );
    rawDb.close();
    const adoption = new Database(databasePath);
    try {
      migrateLegacyCandidateTokens(adoption, { adoptExisting: true });
    } finally {
      adoption.close();
    }

    // 2. Explicitly adopted token storage is safe for additive session-schema upgrades.
    const store = new SqliteSessionStore(databasePath);
    const retrieved = store.findById('legacy-session-001');

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe('legacy-session-001');
    expect(retrieved?.candidateToken).toBeNull();
    expect(retrieved?.scenario.title).toBe('Legacy Scenario Title');

    // 3. Verify lifecycle endpoint serves legacy record with candidatePath = null
    const listRes = await getAssessments();
    expect(listRes.status).toBe(200);
    const data = (await listRes.json()) as {
      assessments: readonly {
        sessionId: string;
        candidateToken: string | null;
        candidatePath: string | null;
      }[];
    };
    const legacyItem = data.assessments.find(
      (a) => a.sessionId === 'legacy-session-001',
    );
    expect(legacyItem).toBeDefined();
    expect(legacyItem?.candidateToken).toBeNull();
    expect(legacyItem?.candidatePath).toBeNull();
  });

  it('enforces terminal state immutability after submission or timeout', async () => {
    const service = new SessionService(new SqliteSessionStore(databasePath));
    const { candidateToken } = service.createSession({
      scenario: {
        id: 'immutable-test',
        version: '1.0.0',
        title: 'Immutable Test',
        brief: 'Test brief',
        acceptanceCriteria: ['pass'],
        filePath: 'test.py',
        originalContent: 'original',
        durationSeconds: 1800,
      },
    });

    await service.activate(candidateToken);
    await service.save(candidateToken, 'modified content');
    const firstSubmission = await service.submit(candidateToken);

    expect(firstSubmission.status).toBe('SUBMITTED');
    expect(firstSubmission.submittedContent).toBe('modified content');

    // Repeated submit is idempotent
    const secondSubmission = await service.submit(candidateToken);
    expect(secondSubmission.submittedAt).toBe(firstSubmission.submittedAt);

    // Save after submit is rejected
    await expect(
      service.save(candidateToken, 'further edit'),
    ).rejects.toThrowError(SessionError);

    // Verify session remains immutable in store
    const sessionAfter = service.getCandidateSession(candidateToken);
    expect(sessionAfter.status).toBe('SUBMITTED');
    expect(sessionAfter.workingContent).toBe('modified content');
  });

  it('keeps a timed-out assessment final across edits, repeated submission, reload, and resume', async () => {
    let now = '2026-10-19T12:00:00.000Z';
    const store = new SqliteSessionStore(databasePath);
    const service = new SessionService(store, { now: () => now });
    const { candidateToken } = service.createSession({
      scenario: {
        id: 'timeout-finality',
        version: '1.0.0',
        title: 'Timeout Finality',
        brief: 'Test brief',
        acceptanceCriteria: ['pass'],
        filePath: 'test.py',
        originalContent: 'original',
        durationSeconds: 60,
      },
    });

    await service.activate(candidateToken);
    await service.save(candidateToken, 'before timeout');
    now = '2026-10-19T12:01:01.000Z';
    const timedOut = await service.submit(candidateToken);
    expect(timedOut.status).toBe('SUBMITTED');
    expect(timedOut.closureReason).toBe('timeout');
    expect(timedOut.submittedContent).toBe('before timeout');

    await expect(service.save(candidateToken, 'after timeout')).rejects.toThrow(
      SessionError,
    );
    const repeated = await service.submit(candidateToken);
    expect(repeated.submittedAt).toBe(timedOut.submittedAt);
    expect(repeated.submittedContent).toBe(timedOut.submittedContent);

    const reloaded = new SessionService(new SqliteSessionStore(databasePath), {
      now: () => now,
    });
    expect(reloaded.getCandidateSession(candidateToken).closureReason).toBe(
      'timeout',
    );
    await expect(reloaded.activate(candidateToken)).rejects.toThrow(
      SessionError,
    );
    expect(reloaded.getCandidateSession(candidateToken).status).toBe(
      'SUBMITTED',
    );
  });

  it('rejects unauthorized candidate access with invalid token', () => {
    const service = getSessionService();
    expect(() =>
      service.getCandidateSession('completely-invalid-token-xyz'),
    ).toThrowError(SessionError);
  });
});
