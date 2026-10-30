import { describe, expect, it } from 'vitest';

import {
  createGeneratedTaskRubric,
  createScenario002TaskRubric,
  GeneratedRubricUnavailableError,
  sumTaskRubricWeights,
} from '../../apps/web/src/assessments/task-rubric';

describe('Scenario 002 task rubric', () => {
  it('freezes task-specific engineering dimensions and weights totaling 100', () => {
    const rubric = createScenario002TaskRubric();

    expect(rubric.version).toBe('scenario-002-rubric-v1');
    expect(rubric.criteria.map(({ id, weight }) => [id, weight])).toEqual([
      ['problem-approach', 20],
      ['implementation-quality', 25],
      ['task-behavior', 25],
      ['relevant-verification', 20],
      ['recorded-integrated-ai-collaboration', 10],
    ]);
    expect(sumTaskRubricWeights(rubric)).toBe(100);
  });

  it('makes AI-use applicability depend on trustworthy complete capture, not availability alone', () => {
    const criterion = createScenario002TaskRubric().criteria.at(-1)!;

    expect(criterion.applicability.kind).toBe(
      'recorded_integrated_ai_interaction',
    );
    expect(criterion.applicability.rule).toContain('trusted, complete capture');
    expect(criterion.applicability.rule).toContain('gap or truncation');
    expect(criterion.applicability.rule).toContain('External AI use');
  });
});

describe('createGeneratedTaskRubric', () => {
  it('freezes task-specific criterion ids, labels, descriptions, weights, and applicability', () => {
    const rubric = createGeneratedTaskRubric({
      artifactId: 'generated-custom-123',
      title: 'Fix greeting whitespace',
      brief: 'Trim outer whitespace from greetings.',
      acceptanceCriteria: ['Preserve internal whitespace.'],
      rubric: [
        {
          id: 'trimming-correctness',
          label: 'Trimming correctness',
          description:
            'Assess boundary whitespace removal while preserving inner spacing.',
          weight: 45,
          applicability: { kind: 'always', rule: 'Applies to this task.' },
        },
        {
          id: 'test-coverage',
          label: 'Test coverage',
          description: 'Assess test assertions for whitespace edge cases.',
          weight: 40,
          applicability: { kind: 'always', rule: 'Applies to this task.' },
        },
        {
          id: 'recorded-integrated-ai-collaboration',
          label: 'Recorded integrated-AI collaboration',
          description: 'Assess recorded AI interaction when present.',
          weight: 15,
          applicability: {
            kind: 'recorded_integrated_ai_interaction',
            rule: 'Applies when AI interactions are recorded.',
          },
        },
      ],
      integratedAi: true,
    });

    expect(rubric.version).toBe('generated-custom-123-rubric-v1');
    expect(rubric.criteria.map(({ id, weight }) => [id, weight])).toEqual([
      ['trimming-correctness', 45],
      ['test-coverage', 40],
      ['recorded-integrated-ai-collaboration', 15],
    ]);
    expect(rubric.criteria[0]?.label).toBe('Trimming correctness');
    expect(rubric.criteria[0]?.description).toContain('boundary whitespace');
    expect(rubric.criteria[0]?.applicability.kind).toBe('always');
    expect(rubric.criteria[2]?.applicability.kind).toBe(
      'recorded_integrated_ai_interaction',
    );
    expect(sumTaskRubricWeights(rubric)).toBe(100);
  });

  it('throws GeneratedRubricUnavailableError for legacy drafts lacking validated rubric', () => {
    expect(() =>
      createGeneratedTaskRubric({
        artifactId: 'generated-legacy-456',
        title: 'Legacy task',
        brief: 'Legacy brief text.',
        acceptanceCriteria: ['Must work'],
        rubric: [
          {
            focus: 'Behavior',
            observableEvidence: 'Inspect target test results.',
          },
        ],
        integratedAi: false,
      }),
    ).toThrow(GeneratedRubricUnavailableError);
  });

  it('throws GeneratedRubricUnavailableError if criteria weights do not sum to 100', () => {
    expect(() =>
      createGeneratedTaskRubric({
        artifactId: 'generated-bad-weights',
        title: 'Invalid weights task',
        brief: 'Brief text.',
        acceptanceCriteria: ['Must work'],
        rubric: [
          {
            id: 'criterion-1',
            label: 'Criterion 1',
            description: 'Description 1',
            weight: 50,
            applicability: { kind: 'always', rule: 'Always applicable' },
          },
        ],
        integratedAi: false,
      }),
    ).toThrow(GeneratedRubricUnavailableError);
  });

  it('applies valid weight overrides without changing authored criterion details', () => {
    const rubric = [
      {
        id: 'behavior',
        label: 'Behavior fidelity',
        description:
          'Compare implementation behavior to the task requirements.',
        weight: 60,
        applicability: {
          kind: 'always' as const,
          rule: 'Applies to this task.',
        },
      },
      {
        id: 'verification',
        label: 'Recorded verification',
        description: 'Inspect checks recorded for the requested behavior.',
        weight: 40,
        applicability: {
          kind: 'recorded_integrated_ai_interaction' as const,
          rule: 'Applies when an interaction is recorded.',
        },
      },
    ];
    const input = {
      artifactId: 'generated-custom-weights',
      title: 'Weighted task',
      brief: 'A task brief.',
      acceptanceCriteria: ['Expected behavior is preserved.'],
      rubric,
      integratedAi: true,
    };
    const defaultSnapshot = createGeneratedTaskRubric(input);
    const overridden = createGeneratedTaskRubric({
      ...input,
      criterionWeights: { behavior: 45, verification: 55 },
    });

    expect(overridden.version).not.toBe(defaultSnapshot.version);
    expect(overridden.criteria.map(({ id, weight }) => [id, weight])).toEqual([
      ['behavior', 45],
      ['verification', 55],
    ]);
    expect(
      overridden.criteria.map(({ label, description, applicability }) => [
        label,
        description,
        applicability,
      ]),
    ).toEqual(
      defaultSnapshot.criteria.map(({ label, description, applicability }) => [
        label,
        description,
        applicability,
      ]),
    );
    expect(
      createGeneratedTaskRubric({
        ...input,
        criterionWeights: { behavior: 45, verification: 55 },
      }).version,
    ).toBe(overridden.version);
    expect(
      createGeneratedTaskRubric({
        ...input,
        criterionWeights: { behavior: 60, verification: 40 },
      }).version,
    ).toBe(defaultSnapshot.version);
    expect(rubric.map(({ weight }) => weight)).toEqual([60, 40]);
  });

  it.each([
    { behavior: 50 },
    { behavior: 50, verification: 40, extra: 10 },
    { behavior: 0, verification: 100 },
    { behavior: 45.5, verification: 54.5 },
    { behavior: 50, verification: 40 },
  ])('rejects invalid custom weights %#', (criterionWeights) => {
    expect(() =>
      createGeneratedTaskRubric({
        artifactId: 'generated-invalid-weights',
        title: 'Weighted task',
        brief: 'A task brief.',
        acceptanceCriteria: ['Expected behavior is preserved.'],
        rubric: [
          {
            id: 'behavior',
            label: 'Behavior fidelity',
            description: 'Compare implementation behavior to requirements.',
            weight: 60,
            applicability: { kind: 'always', rule: 'Applies to this task.' },
          },
          {
            id: 'verification',
            label: 'Recorded verification',
            description: 'Inspect checks recorded for the requested behavior.',
            weight: 40,
            applicability: { kind: 'always', rule: 'Applies to this task.' },
          },
        ],
        criterionWeights,
        integratedAi: false,
      }),
    ).toThrow(GeneratedRubricUnavailableError);
  });
});
