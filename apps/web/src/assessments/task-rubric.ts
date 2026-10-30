import { createHash } from 'node:crypto';

export type TaskRubricApplicability = Readonly<{
  kind: 'always' | 'recorded_integrated_ai_interaction';
  rule: string;
}>;

export type TaskRubricCriterion = Readonly<{
  id: string;
  label: string;
  description: string;
  weight: number;
  applicability: TaskRubricApplicability;
}>;

export type TaskRubricSnapshot = Readonly<{
  version: string;
  criteria: readonly TaskRubricCriterion[];
}>;

const integratedAiRule =
  'Applies when an integrated-AI interaction is recorded. It is not applicable only when the tool is disabled or trusted, complete capture proves no interaction occurred; that weight is excluded from the denominator. If capture has a gap or truncation and absence cannot be established, evidence is insufficient. External AI use and code origin are not inferred.';

export const scenario002TaskRubricVersion = 'scenario-002-rubric-v1';

export const createScenario002TaskRubric = (): TaskRubricSnapshot => ({
  version: scenario002TaskRubricVersion,
  criteria: [
    {
      id: 'problem-approach',
      label: 'Problem-solving approach',
      description:
        'The observable solution sequence and submitted work address the retry failure at the provider boundary while preserving distinct checkout handling. This criterion does not infer private reasoning.',
      weight: 20,
      applicability: { kind: 'always', rule: 'Applies to this task.' },
    },
    {
      id: 'implementation-quality',
      label: 'Implementation quality',
      description:
        'Task-relevant clarity, maintainability, and design fit in the submitted implementation. General principles such as SOLID are considered only when the task gives them an observable basis.',
      weight: 25,
      applicability: { kind: 'always', rule: 'Applies to this task.' },
    },
    {
      id: 'task-behavior',
      label: 'Task behavior',
      description:
        'Repeated delivery for one checkout does not duplicate a booking; distinct checkouts remain separate; invalid confirmation input creates no booking.',
      weight: 25,
      applicability: { kind: 'always', rule: 'Applies to this task.' },
    },
    {
      id: 'relevant-verification',
      label: 'Relevant verification',
      description:
        'Recorded checks meaningfully cover repeated delivery, distinct checkouts, and invalid input.',
      weight: 20,
      applicability: { kind: 'always', rule: 'Applies to this task.' },
    },
    {
      id: 'recorded-integrated-ai-collaboration',
      label: 'Recorded integrated-AI collaboration',
      description:
        'When an integrated interaction is recorded, assess whether it is grounded in task context and checked against submitted work or verification. No recorded use is neutral only when complete capture proves its absence.',
      weight: 10,
      applicability: {
        kind: 'recorded_integrated_ai_interaction',
        rule: integratedAiRule,
      },
    },
  ],
});

export type GeneratedTaskRubricCriterionInput = Readonly<{
  id: string;
  label: string;
  description: string;
  weight: number;
  applicability: TaskRubricApplicability;
}>;

const isTaskRubricCriterion = (
  item: unknown,
): item is GeneratedTaskRubricCriterionInput =>
  Boolean(
    item &&
    typeof item === 'object' &&
    'id' in item &&
    typeof (item as { id: unknown }).id === 'string' &&
    (item as { id: string }).id.trim().length > 0 &&
    'label' in item &&
    typeof (item as { label: unknown }).label === 'string' &&
    (item as { label: string }).label.trim().length > 0 &&
    'description' in item &&
    typeof (item as { description: unknown }).description === 'string' &&
    (item as { description: string }).description.trim().length > 0 &&
    'weight' in item &&
    typeof (item as { weight: unknown }).weight === 'number' &&
    Number.isInteger((item as { weight: number }).weight) &&
    (item as { weight: number }).weight > 0 &&
    'applicability' in item &&
    typeof (item as { applicability: unknown }).applicability === 'object' &&
    (item as { applicability: unknown }).applicability !== null &&
    ((item as { applicability: { kind?: unknown } }).applicability.kind ===
      'always' ||
      (item as { applicability: { kind?: unknown } }).applicability.kind ===
        'recorded_integrated_ai_interaction') &&
    typeof (item as { applicability: { rule?: unknown } }).applicability
      .rule === 'string',
  );

export class GeneratedRubricUnavailableError extends Error {
  readonly code = 'GENERATED_RUBRIC_UNAVAILABLE';
  constructor(
    message = 'A fully authored task rubric is required. Legacy drafts lacking a validated rubric cannot be issued; regenerate the assessment.',
  ) {
    super(message);
    this.name = 'GeneratedRubricUnavailableError';
  }
}

export const createGeneratedTaskRubric = (
  input: Readonly<{
    artifactId: string;
    title: string;
    brief: string;
    acceptanceCriteria: readonly string[];
    rubric?: readonly unknown[];
    criterionWeights?: Readonly<Record<string, number>>;
    integratedAi: boolean;
  }>,
): TaskRubricSnapshot => {
  if (
    Array.isArray(input.rubric) &&
    input.rubric.length > 0 &&
    input.rubric.every(isTaskRubricCriterion)
  ) {
    const totalWeight = input.rubric.reduce(
      (sum, criterion) => sum + criterion.weight,
      0,
    );
    if (totalWeight !== 100) {
      throw new GeneratedRubricUnavailableError(
        `Task rubric criterion weights must sum to exactly 100 (got ${totalWeight}). Regenerate the assessment draft.`,
      );
    }
    const authoredRubric = input.rubric;
    const criterionWeights = input.criterionWeights;
    if (
      criterionWeights &&
      (Object.keys(criterionWeights).length !== authoredRubric.length ||
        authoredRubric.some(
          (criterion) =>
            !Object.hasOwn(criterionWeights, criterion.id) ||
            !Number.isInteger(criterionWeights[criterion.id]) ||
            criterionWeights[criterion.id]! < 1 ||
            criterionWeights[criterion.id]! > 100,
        ) ||
        Object.values(criterionWeights).reduce(
          (sum, weight) => sum + weight,
          0,
        ) !== 100)
    ) {
      throw new GeneratedRubricUnavailableError(
        'Rubric weights must provide one positive integer weight for every authored criterion and sum to exactly 100.',
      );
    }
    const criteria = authoredRubric.map((criterion) => ({
      id: criterion.id,
      label: criterion.label,
      description: criterion.description,
      weight: criterionWeights?.[criterion.id] ?? criterion.weight,
      applicability: {
        kind: criterion.applicability.kind,
        rule: criterion.applicability.rule,
      },
    }));
    const weightsDiffer = authoredRubric.some(
      (criterion) =>
        criterionWeights?.[criterion.id] !== undefined &&
        criterionWeights[criterion.id] !== criterion.weight,
    );
    return {
      version: weightsDiffer
        ? `${input.artifactId}-rubric-v1-${createHash('sha256')
            .update(
              JSON.stringify(criteria.map(({ id, weight }) => [id, weight])),
            )
            .digest('hex')}`
        : `${input.artifactId}-rubric-v1`,
      criteria,
    };
  }

  throw new GeneratedRubricUnavailableError();
};

export const cloneTaskRubric = (
  rubric: TaskRubricSnapshot | null | undefined,
): TaskRubricSnapshot | null =>
  rubric
    ? {
        version: rubric.version,
        criteria: rubric.criteria.map((criterion) => ({
          ...criterion,
          applicability: { ...criterion.applicability },
        })),
      }
    : null;

export const sumTaskRubricWeights = (rubric: TaskRubricSnapshot) =>
  rubric.criteria.reduce((total, criterion) => total + criterion.weight, 0);
