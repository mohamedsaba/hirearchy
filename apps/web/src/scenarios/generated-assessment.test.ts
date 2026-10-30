import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxAdapter } from '../sandbox/sandbox';
import {
  loadValidatedGeneratedAssessment,
  parseNewGeneratedAssessmentDraft,
  parseGeneratedAssessment,
  validateAndPersistGeneratedAssessment,
  type GeneratedAssessment,
} from './generated-assessment';

const assessment: GeneratedAssessment = {
  title: 'Correct greeting formatting',
  brief:
    'The greeting helper preserves unwanted surrounding whitespace in imported customer names. Update it to trim the outer whitespace while preserving the exact text inside the name.',
  durationSeconds: 1800,
  recommendations: {
    durationMinutes: 30,
    terminalEnabled: false,
    integratedAi: false,
  },
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

const fakeSandbox = (results: ReturnType<typeof execResult>[]) => {
  const sandbox = {
    createAndVerify: vi.fn(async () => undefined),
    exec: vi.fn(async () => results.shift()!),
    writeFile: vi.fn(async () => undefined),
    teardown: vi.fn(async () => undefined),
  } as unknown as SandboxAdapter;
  return sandbox;
};

describe('generated assessment boundary', () => {
  let dataDirectory: string | undefined;

  afterEach(async () => {
    if (dataDirectory)
      await rm(dataDirectory, { recursive: true, force: true });
    dataDirectory = undefined;
  });

  it('rejects unsafe paths, leading slashes, and reference edits to test helpers', () => {
    expect(() =>
      parseGeneratedAssessment({
        ...assessment,
        starterFiles: [{ path: '../escape.py', content: 'pass\n' }],
      }),
    ).toThrow();

    expect(() =>
      parseGeneratedAssessment({
        ...assessment,
        starterFiles: [{ path: '/src/greeting.py', content: 'pass\n' }],
      }),
    ).toThrow();

    expect(() =>
      parseGeneratedAssessment({
        ...assessment,
        primaryFilePath: '/src/greeting.py',
      }),
    ).toThrow();

    expect(() =>
      parseGeneratedAssessment({
        ...assessment,
        referenceFixFiles: [
          { path: 'tests/helper.py', content: 'EXPECTED = "changed"\n' },
        ],
      }),
    ).toThrow();
  });

  it('validates task-authored rubric criterion uniqueness and weights summing to 100', () => {
    const validTaskCriteria = [
      {
        id: 'formatting-logic',
        label: 'Formatting logic',
        description:
          'Check greeting whitespace trimming logic and boundary cases.',
        weight: 60,
        applicability: {
          kind: 'always' as const,
          rule: 'Applies to this task.',
        },
      },
      {
        id: 'test-verification',
        label: 'Test verification',
        description: 'Verify recorded pytest test execution and coverage.',
        weight: 40,
        applicability: {
          kind: 'always' as const,
          rule: 'Applies to this task.',
        },
      },
    ];

    expect(
      parseGeneratedAssessment({
        ...assessment,
        rubric: validTaskCriteria,
      }).rubric,
    ).toEqual(validTaskCriteria);

    // Duplicate criterion id
    expect(() =>
      parseGeneratedAssessment({
        ...assessment,
        rubric: [
          { ...validTaskCriteria[0]!, id: 'duplicate-id', weight: 50 },
          { ...validTaskCriteria[1]!, id: 'duplicate-id', weight: 50 },
        ],
      }),
    ).toThrow(/unique/i);

    // Weights not summing to 100
    expect(() =>
      parseGeneratedAssessment({
        ...assessment,
        rubric: [
          { ...validTaskCriteria[0]!, weight: 60 },
          { ...validTaskCriteria[1]!, weight: 30 },
        ],
      }),
    ).toThrow(/sum to exactly 100/i);

    // Mixing criteria with legacy rubric guidance
    expect(() =>
      parseGeneratedAssessment({
        ...assessment,
        rubric: [
          validTaskCriteria[0]!,
          {
            focus: 'Legacy',
            observableEvidence: 'Legacy evidence description.',
          },
        ],
      }),
    ).toThrow(/unrecognized[_ ]keys?/i);
  });

  it('rejects legacy rubric guidance in a new draft before sandbox persistence', async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), 'generated-assessment-'));
    const legacyDraft = {
      ...assessment,
      rubric: [
        {
          focus: 'Behavior',
          observableEvidence:
            'Inspect the submitted formatter and recorded target test results.',
        },
      ],
    };
    const sandbox = fakeSandbox([]);

    expect(() => parseNewGeneratedAssessmentDraft(legacyDraft)).toThrow();
    await expect(
      validateAndPersistGeneratedAssessment(
        sandbox,
        dataDirectory,
        legacyDraft,
      ),
    ).rejects.toThrow();
    expect(sandbox.createAndVerify).not.toHaveBeenCalled();
  });

  it('accepts optional stored recommendations only when their duration matches', () => {
    expect(
      parseNewGeneratedAssessmentDraft(assessment).recommendations,
    ).toEqual(assessment.recommendations);
    expect(() =>
      parseNewGeneratedAssessmentDraft({
        ...assessment,
        recommendations: { ...assessment.recommendations, durationMinutes: 45 },
      }),
    ).toThrow(/duration must match/i);
    expect(
      parseGeneratedAssessment({
        ...assessment,
        recommendations: undefined,
      }).recommendations,
    ).toBeUndefined();
  });

  it('refuses setup failures and reference tests that do not pass', async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), 'generated-assessment-'));
    const compileFailure = fakeSandbox([
      execResult(1, `SyntaxError: invalid syntax\n${'x'.repeat(7_000)}`),
    ]);
    const compileResult = await validateAndPersistGeneratedAssessment(
      compileFailure,
      dataDirectory,
      assessment,
    );
    expect(compileResult).toMatchObject({
      status: 'UNAVAILABLE_DRAFT',
      reason: 'STARTER_SETUP_FAILED',
    });
    expect(
      compileResult.status === 'UNAVAILABLE_DRAFT'
        ? compileResult.validationFeedback
        : undefined,
    ).toHaveLength(6_000);
    expect(
      compileResult.status === 'UNAVAILABLE_DRAFT' &&
        compileResult.validationFeedback?.endsWith('x'),
    ).toBe(true);

    const referenceFailure = fakeSandbox([
      execResult(0),
      execResult(
        1,
        'FAILED tests/test_greeting.py::test_trim\n1 failed in 0.02s\n',
      ),
      execResult(
        1,
        'FAILED tests/test_greeting.py::test_trim\n1 failed in 0.02s\n',
      ),
    ]);
    const referenceResult = await validateAndPersistGeneratedAssessment(
      referenceFailure,
      dataDirectory,
      assessment,
    );
    expect(referenceResult).toMatchObject({
      status: 'UNAVAILABLE_DRAFT',
      reason: 'REFERENCE_TESTS_FAILED',
    });
    expect(
      referenceResult.status === 'UNAVAILABLE_DRAFT'
        ? referenceResult.validationFeedback
        : undefined,
    ).toContain('test_trim');
    expect(referenceFailure.writeFile).toHaveBeenCalledTimes(1);
  });

  it('persists only a validated artifact and rejects digest tampering on load', async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), 'generated-assessment-'));
    const sandbox = fakeSandbox([
      execResult(0),
      execResult(
        1,
        'FAILED tests/test_greeting.py::test_trim\n1 failed in 0.02s\n',
      ),
      execResult(0, '1 passed in 0.02s\n'),
    ]);
    const result = await validateAndPersistGeneratedAssessment(
      sandbox,
      dataDirectory,
      assessment,
    );
    expect(result.status).toBe('VALIDATED');
    if (result.status !== 'VALIDATED') return;

    const stored = await loadValidatedGeneratedAssessment(
      dataDirectory,
      result.id,
    );
    expect(stored?.assessment.referenceFixFiles).toEqual(
      assessment.referenceFixFiles,
    );

    const artifactPath = path.join(
      dataDirectory,
      'generated-assessments',
      `${result.id}.json`,
    );
    const envelope = JSON.parse(await readFile(artifactPath, 'utf8')) as {
      assessment: GeneratedAssessment;
    };
    envelope.assessment.title = 'Tampered greeting assessment';
    await writeFile(artifactPath, JSON.stringify(envelope));
    await expect(
      loadValidatedGeneratedAssessment(dataDirectory, result.id),
    ).rejects.toThrow('integrity check failed');
  });

  it('freezes task-authored rubric criteria into the validated artifact and recovers them on load', async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), 'generated-assessment-'));
    const taskSpecificCriteria = [
      {
        id: 'whitespace-trimming',
        label: 'Whitespace trimming',
        description: 'Verify outer whitespace is stripped cleanly.',
        weight: 60,
        applicability: {
          kind: 'always' as const,
          rule: 'Applies to this task.',
        },
      },
      {
        id: 'inner-space-preservation',
        label: 'Inner space preservation',
        description: 'Verify inner spaces and punctuation remain unchanged.',
        weight: 40,
        applicability: {
          kind: 'always' as const,
          rule: 'Applies to this task.',
        },
      },
    ];
    const taskWithCriteria = {
      ...assessment,
      rubric: taskSpecificCriteria,
    };
    const sandbox = fakeSandbox([
      execResult(0),
      execResult(
        1,
        'FAILED tests/test_greeting.py::test_trim\n1 failed in 0.02s\n',
      ),
      execResult(0, '1 passed in 0.02s\n'),
    ]);
    const result = await validateAndPersistGeneratedAssessment(
      sandbox,
      dataDirectory,
      taskWithCriteria,
    );
    expect(result.status).toBe('VALIDATED');
    if (result.status !== 'VALIDATED') return;

    const stored = await loadValidatedGeneratedAssessment(
      dataDirectory,
      result.id,
    );
    expect(stored?.assessment.rubric).toEqual(taskSpecificCriteria);
  });
});
