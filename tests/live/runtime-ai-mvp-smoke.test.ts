import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DIAGNOSTICS_FILE =
  '/tmp/hirearchy-resume-20261006/generated-smoke-diagnostics.json';
const recordedDiagnostics: unknown[] = [];

vi.mock(
  '../../apps/web/src/scenarios/generated-assessment',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../apps/web/src/scenarios/generated-assessment')
      >();
    return {
      ...actual,
      validateAndPersistGeneratedAssessment: async (
        sandbox: unknown,
        privateDataDirectory: unknown,
        value: unknown,
      ) => {
        const result = await (
          actual.validateAndPersistGeneratedAssessment as (
            sb: unknown,
            dir: unknown,
            val: unknown,
          ) => Promise<unknown>
        )(sandbox, privateDataDirectory, value);
        if (
          result &&
          typeof result === 'object' &&
          (result as { status?: string }).status === 'UNAVAILABLE_DRAFT' &&
          recordedDiagnostics.length < 3
        ) {
          recordedDiagnostics.push({
            timestamp: new Date().toISOString(),
            status: (result as { status: string }).status,
            reason: (result as { reason?: string }).reason,
            validationFeedback: (result as { validationFeedback?: string })
              .validationFeedback,
            assessment: value,
          });
          try {
            writeFileSync(
              DIAGNOSTICS_FILE,
              JSON.stringify(recordedDiagnostics, null, 2) + '\n',
            );
          } catch {
            // Diagnostic write failure is non-fatal to the validator result
          }
        }
        return result;
      },
    };
  },
);

const { getCookie } = vi.hoisted(() => ({ getCookie: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: getCookie }),
}));

import { POST as generateAssessmentRoute } from '../../apps/web/app/api/evaluator/assessments/generate/route';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';
import { supportedAssessmentSelection } from '../../apps/web/src/assessments/assessment-options';
import { loadValidatedGeneratedAssessment } from '../../apps/web/src/scenarios/generated-assessment';
import { createScenario002TaskRubric } from '../../apps/web/src/assessments/task-rubric';
import {
  getNvidiaApiKey,
  getOpenRouterApiKey,
} from '../../apps/web/src/ai/server-ai-configuration';
import {
  NvidiaNimAiProvider,
  OpenRouterAiProvider,
} from '../../apps/web/src/ai/openrouter-ai-provider';
import type { NormalizedAiRequest } from '../../apps/web/src/ai/ai-provider';
import { buildChronologicalReconstruction } from '../../apps/web/src/evidence/chronological-reconstruction';
import { buildEvidenceReferenceCatalog } from '../../apps/web/src/reconstruction/evidence-reference-catalog';
import {
  NvidiaNimTaskAssessmentScoringProvider,
  OpenRouterTaskAssessmentScoringProvider,
} from '../../apps/web/src/scoring/openrouter-task-assessment-scoring-provider';
import {
  TaskAssessmentScoringService,
  type TaskScoringSource,
} from '../../apps/web/src/scoring/task-assessment-scoring';
import { SqliteTaskAssessmentScoreStore } from '../../apps/web/src/scoring/task-assessment-score-store';
import type { SessionEvent } from '../../apps/web/src/events/session-event';

const liveEnabled =
  process.env.HIREARCHY_LIVE_RUNTIME_SMOKE === '1' &&
  Boolean(getNvidiaApiKey() || getOpenRouterApiKey());

describe.skipIf(!liveEnabled)('Runtime AI MVP Live Smoke Suite', () => {
  let tempDir: string;
  let databasePath: string;
  let originalDbPath: string | undefined;
  let originalEvaluatorKey: string | undefined;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'hirearchy-live-smoke-'));
    databasePath = path.join(tempDir, 'smoke.sqlite');
    originalDbPath = process.env.HIREARCHY_DB_PATH;
    originalEvaluatorKey = process.env.HIREARCHY_EVALUATOR_KEY;

    process.env.HIREARCHY_DB_PATH = databasePath;
    process.env.HIREARCHY_EVALUATOR_KEY = 'live-smoke-evaluator-key';
    getCookie.mockReturnValue({
      value: createSignedEvaluatorToken('live-smoke-evaluator-key'),
    });
  });

  afterAll(() => {
    process.env.HIREARCHY_DB_PATH = originalDbPath;
    process.env.HIREARCHY_EVALUATOR_KEY = originalEvaluatorKey;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('1. Candidate Text-Only Assistant: returns grounded context reply', async () => {
    const provider = getNvidiaApiKey()
      ? new NvidiaNimAiProvider()
      : new OpenRouterAiProvider();

    const syntheticRequest: NormalizedAiRequest = {
      candidateInput:
        'How should the retry delay calculation be structured to avoid immediate duplicate attempts?',
      hirearchyContext: {
        assistantContext: {
          publishedBrief:
            'Implement exponential backoff retry logic for failed booking webhook notifications. The system must not retry immediately upon initial failure.',
          savedFiles: [
            {
              path: 'bookings/service.py',
              content:
                'def calculate_delay(attempt: int) -> int:\n    # TODO: implement backoff\n    return 0\n',
            },
          ],
          recordedChecks: [
            'FAILED tests/test_bookings.py::test_retry_backoff - AssertionError: 0 == 0, expected > 0 delay',
          ],
        },
      },
      candidateContext: [{ path: 'bookings/service.py' }],
    };

    const result = await provider.execute(syntheticRequest);

    expect(typeof result.responseText).toBe('string');
    expect(result.responseText.length).toBeGreaterThan(15);
    expect(result.responseText.toLowerCase()).toMatch(/delay|retry|backoff/);
  }, 45_000);

  it('2. Task-Scoring: parses criteria, checks authorized refs, and computes 0-100 score', async () => {
    const scoringProvider = getNvidiaApiKey()
      ? new NvidiaNimTaskAssessmentScoringProvider()
      : new OpenRouterTaskAssessmentScoringProvider();

    const store = new SqliteTaskAssessmentScoreStore(databasePath);
    const service = new TaskAssessmentScoringService(
      store,
      scoringProvider,
      () => [],
    );

    const sessionId = `live-smoke-session-${Date.now()}`;
    const rubric = createScenario002TaskRubric();

    const syntheticEvents: readonly SessionEvent[] = [
      {
        id: `evt_cmd_${Date.now()}`,
        sessionId,
        sequence: 1,
        type: 'COMMAND_STARTED',
        timestamp: '2026-10-06T10:05:00.000Z',
        source: 'sandbox',
        payload: { commandId: 'cmd-1', command: 'pytest', cwd: '/workspace' },
      },
      {
        id: `evt_cmdf_${Date.now()}`,
        sessionId,
        sequence: 2,
        type: 'COMMAND_FINISHED',
        timestamp: '2026-10-06T10:05:05.000Z',
        source: 'sandbox',
        payload: {
          commandId: 'cmd-1',
          exitCode: 0,
          timedOut: false,
          durationMs: 5000,
          stdoutBytes: 26,
          stdoutPreview: '=== 2 passed in 0.05s ===\n',
          stdoutTruncated: false,
          stderrBytes: 0,
          stderrPreview: '',
          stderrTruncated: false,
        },
      },
    ];

    const syntheticDiff = [
      'diff --git a/bookings/service.py b/bookings/service.py',
      '--- a/bookings/service.py',
      '+++ b/bookings/service.py',
      '@@ -1,2 +1,3 @@',
      ' def calculate_delay(attempt: int) -> int:',
      '-    return 0',
      '+    return 2 ** attempt',
    ].join('\n');

    const source: TaskScoringSource = {
      sessionId,
      scenario: {
        id: 'scenario-002-booking-notification-retry',
        version: '1.0.0',
        title: 'Booking Notification Retry',
        brief:
          'Ensure booking notifications retry with exponential backoff on transient errors.',
        acceptanceCriteria: [
          'Retry delay grows exponentially with attempt count.',
          'Tests verify non-zero retry delay.',
        ],
      },
      activatedAt: '2026-10-06T10:00:00.000Z',
      submittedAt: '2026-10-06T10:15:00.000Z',
      diff: syntheticDiff,
      events: syntheticEvents,
      rubric,
      aiCapabilitySnapshot: { enabled: false },
      aiInteractions: [],
    };

    const reconstruction = buildChronologicalReconstruction(
      {
        activatedAt: source.activatedAt,
        submittedAt: source.submittedAt,
        submittedDiff: source.diff,
      },
      source.events,
    );
    const catalog = buildEvidenceReferenceCatalog(sessionId, reconstruction);
    const authorizedRefs = new Set(catalog.entries.map((e) => e.evidenceRef));

    const report = await service.request(source);

    const failureDetails =
      report.status === 'failed'
        ? `status=${report.status}, provider=${report.providerId ?? 'none'}, model=${report.model ?? 'none'}, criteria=[${report.criteria.map((c) => `${c.criterionId}(status=${c.status}, refs=${c.evidenceRefs.join(',')}, reason=${c.reason})`).join('; ')}]`
        : '';

    expect(
      ['available', 'incomplete'],
      failureDetails ? `Scoring report failed: ${failureDetails}` : undefined,
    ).toContain(report.status);
    expect(report.criteria.length).toBeGreaterThan(0);

    for (const criterion of report.criteria) {
      expect(['scored', 'not_applicable', 'insufficient_evidence']).toContain(
        criterion.status,
      );
      if (criterion.status === 'scored') {
        expect(typeof criterion.score).toBe('number');
        expect(criterion.score).toBeGreaterThanOrEqual(0);
        expect(criterion.score).toBeLessThanOrEqual(100);
      }
      // Exact catalog membership assertion
      for (const ref of criterion.evidenceRefs) {
        expect(authorizedRefs.has(ref)).toBe(true);
      }
    }

    if (report.status === 'available') {
      expect(typeof report.totalScore).toBe('number');
      expect(report.totalScore).toBeGreaterThanOrEqual(0);
      expect(report.totalScore).toBeLessThanOrEqual(100);
    }
  }, 60_000);

  it('3. Incomplete Evidence: preserves un-scored state without fabricating reports', async () => {
    const scoringProvider = getNvidiaApiKey()
      ? new NvidiaNimTaskAssessmentScoringProvider()
      : new OpenRouterTaskAssessmentScoringProvider();

    const store = new SqliteTaskAssessmentScoreStore(databasePath);
    const service = new TaskAssessmentScoringService(
      store,
      scoringProvider,
      () => [],
    );

    const sessionId = `live-smoke-empty-${Date.now()}`;
    const rubric = createScenario002TaskRubric();

    const emptySource: TaskScoringSource = {
      sessionId,
      scenario: {
        id: 'scenario-002-booking-notification-retry',
        version: '1.0.0',
        title: 'Booking Notification Retry',
        brief: 'Empty session to test insufficient evidence handling.',
        acceptanceCriteria: ['Requires observable diff.'],
      },
      activatedAt: '2026-10-06T10:00:00.000Z',
      submittedAt: '2026-10-06T10:05:00.000Z',
      diff: '', // Empty diff, no edits
      events: [],
      rubric,
      aiCapabilitySnapshot: { enabled: false },
      aiInteractions: [],
    };

    const report = await service.request(emptySource);

    const emptyFailureDetails =
      report.status === 'failed'
        ? `status=${report.status}, provider=${report.providerId ?? 'none'}, model=${report.model ?? 'none'}, criteria=[${report.criteria.map((c) => `${c.criterionId}(status=${c.status}, refs=${c.evidenceRefs.join(',')}, reason=${c.reason})`).join('; ')}]`
        : '';

    expect(
      report.status,
      emptyFailureDetails
        ? `Incomplete evidence report failed: ${emptyFailureDetails}`
        : undefined,
    ).toBe('incomplete');
    expect(report.totalScore).toBeNull();

    const impQuality = report.criteria.find(
      (c) => c.criterionId === 'implementation-quality',
    );
    expect(impQuality?.status).toBe('insufficient_evidence');
    expect(impQuality?.score).toBeNull();
  }, 45_000);

  it('4. Real Assessment Generation & Docker Sandbox Solvability: expects VALIDATED', async () => {
    const request = new Request(
      'http://localhost/api/evaluator/assessments/generate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...supportedAssessmentSelection,
          durationMinutes: 45,
          integratedAi: false,
          terminalEnabled: true,
        }),
      },
    );

    const response = await generateAssessmentRoute(request);
    const body = (await response.json()) as {
      generatedAssessmentId?: string;
      scenario?: {
        id?: string;
        version?: string;
        title?: string;
        primaryFilePath?: string;
        durationSeconds?: number;
        brief?: string;
        acceptanceCriteria?: readonly string[];
      };
      taskRubric?: {
        version?: string;
        criteria?: readonly unknown[];
      };
      status?: string;
      reason?: string;
      error?: { code?: string; message?: string };
    };

    if (response.status !== 200) {
      throw new Error(
        `Generate route failed with HTTP ${response.status}: status=${body.status ?? 'unknown'}, reason=${body.reason ?? body.error?.message ?? 'unknown'}`,
      );
    }

    expect(response.status).toBe(200);
    expect(body.generatedAssessmentId).toMatch(/^generated-[a-f0-9]{64}$/);
    const artifact = await loadValidatedGeneratedAssessment(
      tempDir,
      body.generatedAssessmentId!,
    );
    if (process.env.HIREARCHY_STRUCTURE_ARTIFACT_DIRECTORY && artifact) {
      writeFileSync(
        path.join(
          process.env.HIREARCHY_STRUCTURE_ARTIFACT_DIRECTORY,
          'live-generated-assessment.json',
        ),
        JSON.stringify(artifact, null, 2) + '\n',
      );
    }
    expect(
      artifact?.assessment.starterFiles.some(
        (file) => file.path === 'README.md',
      ),
    ).toBe(true);
    expect(
      [
        artifact?.assessment.brief,
        ...artifact!.assessment.acceptanceCriteria,
      ].join('\n'),
    ).toMatch(/handoff|README/i);
    expect(body.scenario).toBeDefined();
    expect(body.scenario?.id).toBe(body.generatedAssessmentId);
    expect(typeof body.scenario?.title).toBe('string');
    expect(body.scenario?.title!.length).toBeGreaterThan(0);
    expect(typeof body.scenario?.primaryFilePath).toBe('string');
    expect(body.scenario?.durationSeconds).toBe(45 * 60);
    expect(typeof body.scenario?.brief).toBe('string');
    expect(body.taskRubric).toBeDefined();
    expect(body.taskRubric?.version).toBe(
      `${body.generatedAssessmentId}-rubric-v1`,
    );
    expect(Array.isArray(body.taskRubric?.criteria)).toBe(true);
    expect(body.taskRubric?.criteria!.length).toBeGreaterThan(0);
  }, 120_000);
});
