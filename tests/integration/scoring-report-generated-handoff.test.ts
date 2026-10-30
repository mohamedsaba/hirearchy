import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getCookie } = vi.hoisted(() => ({ getCookie: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: getCookie }),
}));

import { POST } from '../../apps/web/app/api/evaluator/assessments/route';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';
import { supportedAssessmentSelection } from '../../apps/web/src/assessments/assessment-options';
import { createSubmittedDiff } from '../../apps/web/src/evidence/unified-diff';
import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import type { SandboxAdapter } from '../../apps/web/src/sandbox/sandbox';
import {
  validateAndPersistGeneratedAssessment,
  type GeneratedAssessment,
} from '../../apps/web/src/scenarios/generated-assessment';
import { SqliteTaskAssessmentScoreStore } from '../../apps/web/src/scoring/task-assessment-score-store';
import {
  TaskAssessmentScoringService,
  type TaskAssessmentScoringProvider,
  type TaskScoringPacket,
  type TaskScoringSource,
} from '../../apps/web/src/scoring/task-assessment-scoring';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

const starterGreeting = 'def greeting(name):\n    return f"Hello {name}"\n';
const fixedGreeting =
  'def greeting(name):\n    return f"Hello {name.strip()}"\n';

const generatedTask: GeneratedAssessment = {
  title: 'Correct greeting formatting',
  brief:
    'The greeting helper preserves unwanted surrounding whitespace in imported customer names. Update it to trim the outer whitespace while preserving the exact text inside the name.',
  durationSeconds: 1800,
  primaryFilePath: 'src/greeting.py',
  expectedBehavior: [
    'Trim leading and trailing whitespace from the customer name.',
  ],
  acceptanceCriteria: ['Preserve internal whitespace and punctuation.'],
  evaluatorContext: {
    purpose:
      'Review the recorded implementation and the checks supplied for it.',
    reviewQuestions: [
      'Do the submitted changes preserve the stated greeting format?',
    ],
  },
  rubric: [
    {
      id: 'problem-approach',
      label: 'Observable approach',
      description:
        'Inspect the recorded sequence of changes against the requested formatter behavior.',
      weight: 20,
      applicability: { kind: 'always', rule: 'Applies to this task.' },
    },
    {
      id: 'implementation-quality',
      label: 'Implementation quality',
      description:
        'Inspect the submitted formatter for clear handling of whitespace.',
      weight: 25,
      applicability: { kind: 'always', rule: 'Applies to this task.' },
    },
    {
      id: 'task-behavior',
      label: 'Task behavior',
      description:
        'Verify that outer whitespace is trimmed while internal text is preserved.',
      weight: 25,
      applicability: { kind: 'always', rule: 'Applies to this task.' },
    },
    {
      id: 'relevant-verification',
      label: 'Relevant verification',
      description:
        'Inspect recorded test results for assertions about trimmed greeting output.',
      weight: 20,
      applicability: { kind: 'always', rule: 'Applies to this task.' },
    },
    {
      id: 'recorded-integrated-ai-collaboration',
      label: 'Recorded integrated AI collaboration',
      description:
        'Inspect recorded integrated AI interactions for task context and verification.',
      weight: 10,
      applicability: {
        kind: 'recorded_integrated_ai_interaction',
        rule: 'Applies when an integrated-AI interaction is recorded.',
      },
    },
  ],
  starterFiles: [
    { path: 'src/greeting.py', content: starterGreeting },
    { path: 'tests/helper.py', content: 'EXPECTED = "Hello Ada"\n' },
  ],
  targetTests: [
    {
      path: 'tests/test_greeting.py',
      content:
        'from src.greeting import greeting\n\ndef test_trim():\n    assert greeting(" Ada ") == "Hello Ada"\n',
    },
  ],
  referenceFixFiles: [{ path: 'src/greeting.py', content: fixedGreeting }],
};

const execResult = (exitCode: number, stdoutPreview = '') => ({
  commandId: 'generated-check',
  exitCode,
  timedOut: false,
  durationMs: 1,
  stdoutPreview,
  stdoutBytes: Buffer.byteLength(stdoutPreview),
  stdoutTruncated: false,
  stderrPreview: '',
  stderrBytes: 0,
  stderrTruncated: false,
});

const persistValidatedTask = async (privateDataDirectory: string) => {
  const results = [
    execResult(0),
    execResult(
      1,
      'FAILED tests/test_greeting.py::test_trim\n1 failed in 0.02s\n',
    ),
    execResult(0, '1 passed in 0.02s\n'),
  ];
  const sandbox = {
    createAndVerify: vi.fn(async () => undefined),
    exec: vi.fn(async () => results.shift()!),
    writeFile: vi.fn(async () => undefined),
    teardown: vi.fn(async () => undefined),
  } as unknown as SandboxAdapter;
  const result = await validateAndPersistGeneratedAssessment(
    sandbox,
    privateDataDirectory,
    generatedTask,
  );
  expect(result.status).toBe('VALIDATED');
  if (result.status !== 'VALIDATED')
    throw new Error('Fixture task was not validated.');
  return result.id;
};

const refOfKind = (packet: TaskScoringPacket, kind: string) => {
  const item = packet.evidence.evidenceItems.find(
    (entry) => entry.kind === kind,
  );
  expect(item).toBeDefined();
  return item!.evidenceRef;
};

describe('generated task scoring handoff', () => {
  let directory: string;
  let databasePath: string;
  let scorePath: string;
  let originalDbPath: string | undefined;
  let originalKey: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(
      path.join(tmpdir(), 'hirearchy-generated-handoff-'),
    );
    databasePath = path.join(directory, 'sessions.sqlite');
    scorePath = path.join(directory, 'scores.sqlite');
    originalDbPath = process.env.HIREARCHY_DB_PATH;
    originalKey = process.env.HIREARCHY_EVALUATOR_KEY;
    process.env.HIREARCHY_DB_PATH = databasePath;
    process.env.HIREARCHY_EVALUATOR_KEY = 'handoff-test-key';
    getCookie.mockReturnValue({
      value: createSignedEvaluatorToken('handoff-test-key'),
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

  const issueAndFinalize = async () => {
    const generatedAssessmentId = await persistValidatedTask(directory);
    const response = await POST(
      new Request('http://localhost/api/evaluator/assessments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...supportedAssessmentSelection,
          integratedAi: false,
          generatedAssessmentId,
        }),
      }),
    );
    expect(response.status).toBe(201);
    const created = await response.json();

    const candidateToken = created.candidatePath.split('/').pop()!;
    const tokenHash = createHash('sha256').update(candidateToken).digest('hex');
    const store = new SqliteSessionStore(databasePath);
    store.activate(tokenHash, '2026-10-06T09:00:00.000Z');
    store.save(tokenHash, fixedGreeting);

    const eventStore = new SqliteEventStore(databasePath);
    eventStore.append({
      id: 'event-command-started',
      sessionId: created.sessionId,
      type: 'COMMAND_STARTED',
      timestamp: '2026-10-06T09:10:00.000Z',
      source: 'server',
      payload: {
        commandId: 'cmd-1',
        command: 'python -m pytest tests/test_greeting.py',
        cwd: '/workspace',
      },
    });
    const stdoutPreview = '.F..F..\n1 passed in 0.02s\n';
    eventStore.append({
      id: 'event-command-finished',
      sessionId: created.sessionId,
      type: 'COMMAND_FINISHED',
      timestamp: '2026-10-06T09:10:05.000Z',
      source: 'server',
      payload: {
        commandId: 'cmd-1',
        exitCode: 0,
        timedOut: false,
        durationMs: 820,
        stdoutPreview,
        stdoutBytes: Buffer.byteLength(stdoutPreview),
        stdoutTruncated: false,
        stderrPreview: '',
        stderrBytes: 0,
        stderrTruncated: false,
      },
    });

    const submitted = store.submit(
      tokenHash,
      '2026-10-06T10:00:00.000Z',
      createSubmittedDiff('src/greeting.py', starterGreeting, fixedGreeting),
    );
    const source: TaskScoringSource = {
      sessionId: submitted.id,
      scenario: {
        id: submitted.scenario.id,
        version: submitted.scenario.version,
        title: submitted.scenario.title,
        brief: submitted.scenario.brief,
        acceptanceCriteria: submitted.scenario.acceptanceCriteria,
      },
      activatedAt: submitted.activatedAt,
      submittedAt: submitted.submittedAt,
      diff: submitted.submittedDiff ?? '',
      events: eventStore.getEvents(submitted.id),
      rubric: submitted.taskRubricSnapshot ?? null,
      aiCapabilitySnapshot: submitted.aiCapabilitySnapshot ?? null,
      aiInteractions: [],
    };
    return { generatedAssessmentId, source };
  };

  const service = (provider: TaskAssessmentScoringProvider) =>
    new TaskAssessmentScoringService(
      new SqliteTaskAssessmentScoreStore(scorePath),
      provider,
      () => [],
    );

  it('reports only authorized evidence references and a server total', async () => {
    const { generatedAssessmentId, source } = await issueAndFinalize();
    expect(source.rubric?.version).toBe(`${generatedAssessmentId}-rubric-v1`);

    const scores: Record<string, number> = {
      'problem-approach': 80,
      'implementation-quality': 60,
      'task-behavior': 100,
      'relevant-verification': 40,
    };
    let expectedRefs: readonly string[] = [];
    const provider: TaskAssessmentScoringProvider = {
      providerId: 'handoff-stub',
      modelId: 'handoff-stub-v1',
      analyze: async (packet) => {
        expectedRefs = [
          refOfKind(packet, 'command_execution'),
          packet.evidence.finalDiff.evidenceRef,
        ];
        return {
          criteria: packet.applicableCriteria.map((criterion) => ({
            criterionId: criterion.id,
            status: 'scored',
            score: scores[criterion.id],
            reason:
              'Observed in the recorded command output and submitted diff.',
            evidenceRefs: expectedRefs,
          })),
        };
      },
    };

    const report = await service(provider).request(source);

    expect(expectedRefs[0]).toBe(`command:${source.sessionId}:cmd-1`);
    expect(expectedRefs[1]).toBe(`session:${source.sessionId}:final-diff`);
    expect(report).toMatchObject({
      status: 'available',
      providerId: 'handoff-stub',
      model: 'handoff-stub-v1',
      applicableWeight: 90,
      scoredWeight: 90,
      totalScore: 71.1,
    });
    for (const criterion of report.criteria) {
      if (criterion.status === 'not_applicable') continue;
      expect(criterion.evidenceRefs).toEqual(expectedRefs);
      expect(criterion.score).toBe(scores[criterion.criterionId]);
    }
  });

  it('withholds the total while an applicable criterion has no evidence', async () => {
    const { source } = await issueAndFinalize();
    const provider: TaskAssessmentScoringProvider = {
      providerId: 'handoff-stub',
      modelId: 'handoff-stub-v1',
      analyze: async (packet) => ({
        criteria: packet.applicableCriteria.map((criterion) =>
          criterion.id === 'relevant-verification'
            ? {
                criterionId: criterion.id,
                status: 'insufficient_evidence',
                score: null,
                reason:
                  'The record contains no check of the requested behavior.',
                evidenceRefs: [],
              }
            : {
                criterionId: criterion.id,
                status: 'scored',
                score: 70,
                reason: 'Observed in the submitted diff.',
                evidenceRefs: [packet.evidence.finalDiff.evidenceRef],
              },
        ),
      }),
    };

    const report = await service(provider).request(source);

    expect(report.status).toBe('incomplete');
    expect(report.totalScore).toBeNull();
    expect(report.applicableWeight).toBe(90);
    expect(report.scoredWeight).toBe(70);
    expect(report.criteria).toContainEqual({
      criterionId: 'relevant-verification',
      status: 'insufficient_evidence',
      score: null,
      reason: 'The record contains no check of the requested behavior.',
      evidenceRefs: [],
    });
  });
});
