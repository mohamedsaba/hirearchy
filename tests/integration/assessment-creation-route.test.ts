import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getCookie } = vi.hoisted(() => ({ getCookie: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: getCookie }),
}));

import { POST } from '../../apps/web/app/api/evaluator/assessments/route';
import { POST as previewAssessment } from '../../apps/web/app/api/evaluator/assessments/preview/route';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';
import { supportedAssessmentSelection } from '../../apps/web/src/assessments/assessment-options';
import {
  createGeneratedTaskRubric,
  createScenario002TaskRubric,
} from '../../apps/web/src/assessments/task-rubric';
import type { SandboxAdapter } from '../../apps/web/src/sandbox/sandbox';
import {
  validateAndPersistGeneratedAssessment,
  loadValidatedGeneratedAssessment,
  type GeneratedAssessment,
} from '../../apps/web/src/scenarios/generated-assessment';
import { toCandidateSessionView } from '../../apps/web/src/sessions/candidate-session-view';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

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
      'Review the recorded implementation and the checks supplied for this behavior.',
    reviewQuestions: [
      'Do the submitted changes preserve the stated greeting format?',
    ],
  },
  rubric: [
    {
      id: 'greeting-formatting',
      label: 'Greeting formatting',
      description:
        'Inspect the submitted formatter and its whitespace behavior.',
      weight: 60,
      applicability: { kind: 'always', rule: 'Applies to this task.' },
    },
    {
      id: 'recorded-verification',
      label: 'Recorded verification',
      description:
        'Inspect whether target tests cover trimmed and internal whitespace.',
      weight: 40,
      applicability: { kind: 'always', rule: 'Applies to this task.' },
    },
  ],
  starterFiles: [
    {
      path: 'src/greeting.py',
      content: 'def greeting(name):\n    return f"Hello {name}"\n',
    },
    { path: 'tests/helper.py', content: 'EXPECTED = "Hello Ada"\n' },
  ],
  targetTests: [
    {
      path: 'tests/test_greeting.py',
      content:
        'from src.greeting import greeting\n\ndef test_trim():\n    assert greeting(" Ada ") == "Hello Ada"\n',
    },
  ],
  referenceFixFiles: [
    {
      path: 'src/greeting.py',
      content: 'def greeting(name):\n    return f"Hello {name.strip()}"\n',
    },
  ],
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

const generatedRubric = (
  generatedAssessmentId: string,
  integratedAi: boolean,
  criterionWeights?: Readonly<Record<string, number>>,
) =>
  createGeneratedTaskRubric({
    artifactId: generatedAssessmentId,
    title: generatedTask.title,
    brief: generatedTask.brief,
    acceptanceCriteria: generatedTask.acceptanceCriteria,
    rubric: generatedTask.rubric,
    integratedAi,
    criterionWeights,
  });

describe('evaluator assessment creation route', () => {
  let directory: string;
  let databasePath: string;
  let originalDbPath: string | undefined;
  let originalKey: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-assessment-route-'));
    databasePath = path.join(directory, 'sessions.sqlite');
    originalDbPath = process.env.HIREARCHY_DB_PATH;
    originalKey = process.env.HIREARCHY_EVALUATOR_KEY;
    process.env.HIREARCHY_DB_PATH = databasePath;
    process.env.HIREARCHY_EVALUATOR_KEY = 'route-test-key';
    getCookie.mockReturnValue({
      value: createSignedEvaluatorToken('route-test-key'),
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

  const request = (body: unknown) =>
    new Request('http://localhost/api/evaluator/assessments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('issues the validated generated task and snapshots its runtime', async () => {
    const generatedAssessmentId = await persistValidatedTask(directory);

    const response = await POST(
      request({
        ...supportedAssessmentSelection,
        integratedAi: false,
        generatedAssessmentId,
      }),
    );
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({
      candidatePath: expect.stringMatching(/^\/candidate\//),
      scenario: {
        id: generatedAssessmentId,
        version: '1.0.0',
        title: generatedTask.title,
        durationSeconds: 3600,
      },
      terminalEnabled: true,
      taskRubric: generatedRubric(generatedAssessmentId, false),
    });
    const stored = new SqliteSessionStore(databasePath).findById(
      created.sessionId,
    );
    expect(stored?.scenario.imageName).toBe('hirearchy-scenario-002:v1.0.0');
    expect(stored?.scenario.filePath).toBe('src/greeting.py');
    expect(stored?.aiCapabilitySnapshot?.enabled).toBe(false);
    expect(stored?.taskRubricSnapshot).toEqual(
      generatedRubric(generatedAssessmentId, false),
    );
    expect(stored?.durationSeconds).toBe(3600);
    expect(stored?.terminalEnabled).toBe(true);
    expect(toCandidateSessionView(stored!).taskRubric).toEqual(
      generatedRubric(generatedAssessmentId, false),
    );
    expect(toCandidateSessionView(stored!).terminalEnabled).toBe(true);
  });

  it('snapshots each listed duration and terminal choice on issuance', async () => {
    const generatedAssessmentId = await persistValidatedTask(directory);
    for (const durationMinutes of [30, 45, 60, 90]) {
      const response = await POST(
        request({
          ...supportedAssessmentSelection,
          durationMinutes,
          integratedAi: false,
          terminalEnabled: true,
          generatedAssessmentId,
        }),
      );
      expect(response.status).toBe(201);
      const created = await response.json();
      expect(created.scenario.durationSeconds).toBe(durationMinutes * 60);
      expect(created.terminalEnabled).toBe(true);
      const stored = new SqliteSessionStore(databasePath).findById(
        created.sessionId,
      );
      expect(stored?.durationSeconds).toBe(durationMinutes * 60);
      expect(stored?.scenario.durationSeconds).toBe(durationMinutes * 60);
      expect(stored?.terminalEnabled).toBe(true);
      expect(toCandidateSessionView(stored!).terminalEnabled).toBe(true);
    }
  });

  it('issues custom rubric weights with Terminal disabled and freezes both choices', async () => {
    const generatedAssessmentId = await persistValidatedTask(directory);
    const response = await POST(
      request({
        ...supportedAssessmentSelection,
        integratedAi: false,
        terminalEnabled: false,
        generatedAssessmentId,
        rubricWeights: {
          'greeting-formatting': 45,
          'recorded-verification': 55,
        },
      }),
    );

    expect(response.status).toBe(201);
    const created = await response.json();
    const expectedRubric = generatedRubric(generatedAssessmentId, false, {
      'greeting-formatting': 45,
      'recorded-verification': 55,
    });
    expect(created.taskRubric).toEqual(expectedRubric);
    expect(created.terminalEnabled).toBe(false);

    const stored = new SqliteSessionStore(databasePath).findById(
      created.sessionId,
    );
    expect(stored?.terminalEnabled).toBe(false);
    expect(stored?.taskRubricSnapshot).toEqual(expectedRubric);
    expect(toCandidateSessionView(stored!).terminalEnabled).toBe(false);
    expect(
      (await loadValidatedGeneratedAssessment(directory, generatedAssessmentId))
        ?.assessment.rubric,
    ).toEqual(generatedTask.rubric);
  });

  it.each([
    ['missing authored criterion', { 'greeting-formatting': 100 }],
    [
      'extra criterion',
      {
        'greeting-formatting': 40,
        'recorded-verification': 50,
        unexpected: 10,
      },
    ],
    [
      'non-integer weight',
      { 'greeting-formatting': 40.5, 'recorded-verification': 59.5 },
    ],
    [
      'weights not totaling 100',
      { 'greeting-formatting': 45, 'recorded-verification': 50 },
    ],
  ])('rejects %s before creating a session', async (_name, weights) => {
    const generatedAssessmentId = await persistValidatedTask(directory);
    const response = await POST(
      request({
        ...supportedAssessmentSelection,
        integratedAi: false,
        generatedAssessmentId,
        rubricWeights: weights,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_RUBRIC_WEIGHTS' },
    });
    expect(existsSync(databasePath)).toBe(false);
  });

  it('returns a structured unavailable-rubric error for a legacy artifact without issuing a session', async () => {
    const generatedAssessmentId = await persistValidatedTask(directory);
    const artifactPath = path.join(
      directory,
      'generated-assessments',
      `${generatedAssessmentId}.json`,
    );
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    artifact.assessment.rubric = [
      {
        focus: 'Correct behavior',
        observableEvidence: 'The submitted change preserves expected behavior.',
      },
    ];
    const digest = createHash('sha256')
      .update(JSON.stringify(artifact.assessment))
      .digest('hex');
    artifact.id = `generated-${digest}`;
    artifact.assessmentSha256 = digest;
    const legacyArtifactPath = path.join(
      directory,
      'generated-assessments',
      `${artifact.id}.json`,
    );
    writeFileSync(legacyArtifactPath, JSON.stringify(artifact), {
      mode: 0o600,
    });

    const response = await POST(
      request({
        ...supportedAssessmentSelection,
        integratedAi: false,
        generatedAssessmentId: artifact.id,
      }),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: {
        code: 'GENERATED_RUBRIC_UNAVAILABLE',
        message:
          'The task rubric is unavailable. Regenerate the assessment before creating a link.',
      },
    });
    expect(existsSync(databasePath)).toBe(false);
    expect(readFileSync(legacyArtifactPath, 'utf8')).toBe(
      JSON.stringify(artifact),
    );
  });

  it('refuses to issue a link until a sandbox-validated task is prepared', async () => {
    const unprepared = await POST(
      request({ ...supportedAssessmentSelection, integratedAi: false }),
    );

    expect(unprepared.status).toBe(409);
    expect(await unprepared.json()).toEqual({
      error: {
        code: 'ASSESSMENT_NOT_PREPARED',
        message:
          'Prepare and validate a task before creating a candidate link.',
      },
    });

    const unknownDraft = await POST(
      request({
        ...supportedAssessmentSelection,
        integratedAi: false,
        generatedAssessmentId: `generated-${'0'.repeat(64)}`,
      }),
    );

    expect(unknownDraft.status).toBe(409);
    expect(await unknownDraft.json()).toEqual({
      error: {
        code: 'GENERATED_ASSESSMENT_UNAVAILABLE',
        message:
          'The validated task draft is unavailable. Prepare it again before creating a link.',
      },
    });
    expect(existsSync(databasePath)).toBe(false);
  });

  it('previews the supported blueprint and exact rubric without issuing a session', async () => {
    const response = await previewAssessment(
      request({ ...supportedAssessmentSelection, integratedAi: true }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      scenario: {
        id: 'scenario-002-booking-notification-retry',
        version: '1.0.0',
        title: 'The second confirmation',
      },
      taskRubric: createScenario002TaskRubric(),
      // Honest preview: no runtime AI provider is configured in tests, so
      // integrated AI is issued disabled rather than claiming availability.
      aiCapability: { enabled: false },
      terminalEnabled: true,
    });
    expect(new SqliteSessionStore(databasePath).findById('missing')).toBeNull();
  });

  it('refuses to preview the pytest-required blueprint without Terminal', async () => {
    const response = await previewAssessment(
      request({
        ...supportedAssessmentSelection,
        durationMinutes: 30,
        integratedAi: false,
        terminalEnabled: false,
      }),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: {
        code: 'ASSESSMENT_CAPABILITY_UNSUPPORTED',
        message:
          'Terminal must be enabled for this blueprint because candidates are required to run pytest and record the required verification.',
      },
    });
    expect(existsSync(databasePath)).toBe(false);
  });

  it('serves the generated task rubric when previewing with generatedAssessmentId', async () => {
    const generatedAssessmentId = await persistValidatedTask(directory);
    const response = await previewAssessment(
      request({
        ...supportedAssessmentSelection,
        durationMinutes: 30,
        integratedAi: false,
        generatedAssessmentId,
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.scenario.title).toBe(generatedTask.title);
    expect(body.scenario.brief).toBe(generatedTask.brief);
    expect(body.taskRubric).toEqual(
      generatedRubric(generatedAssessmentId, false),
    );
  });

  it('rejects a supplied generated assessment ID when its artifact is unavailable', async () => {
    const response = await previewAssessment(
      request({
        ...supportedAssessmentSelection,
        integratedAi: false,
        generatedAssessmentId: `generated-${'0'.repeat(64)}`,
      }),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: {
        code: 'GENERATED_ASSESSMENT_UNAVAILABLE',
        message:
          'The validated task draft is unavailable. Prepare it again before previewing.',
      },
    });
  });

  it('rejects a generated artifact that no longer passes stored validation', async () => {
    const generatedAssessmentId = await persistValidatedTask(directory);
    const artifactPath = path.join(
      directory,
      'generated-assessments',
      `${generatedAssessmentId}.json`,
    );
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    artifact.assessment.title = 'invalid';
    writeFileSync(artifactPath, JSON.stringify(artifact));

    const response = await previewAssessment(
      request({
        ...supportedAssessmentSelection,
        integratedAi: false,
        generatedAssessmentId,
      }),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: {
        code: 'GENERATED_ASSESSMENT_UNAVAILABLE',
        message:
          'The validated task draft is unavailable. Prepare it again before previewing.',
      },
    });
  });

  it('requires evaluator authorization before exposing a blueprint or rubric preview', async () => {
    getCookie.mockReturnValue(undefined);
    const response = await previewAssessment(
      request({ ...supportedAssessmentSelection, integratedAi: false }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'EVALUATOR_ACCESS_REQUIRED' },
    });
  });

  it('requires evaluator authorization before creating a session', async () => {
    getCookie.mockReturnValue(undefined);
    const response = await POST(
      request({ ...supportedAssessmentSelection, integratedAi: false }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'EVALUATOR_ACCESS_REQUIRED' },
    });
  });

  it('does not substitute or issue a valid unsupported configuration', async () => {
    const response = await POST(
      request({
        ...supportedAssessmentSelection,
        field: 'flutter',
        stack: 'flutter-dart',
        integratedAi: false,
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'ASSESSMENT_NOT_READY' },
    });
    expect(new SqliteSessionStore(databasePath).findById('missing')).toBeNull();
  });

  it('rejects scenario override fields from the client', async () => {
    const response = await POST(
      request({
        ...supportedAssessmentSelection,
        integratedAi: false,
        scenarioId: 'scenario-001-cache-staleness',
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_ASSESSMENT_SELECTION' },
    });
  });
});
