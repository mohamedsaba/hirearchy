import { createHash } from 'node:crypto';

import type { AssessmentSelection } from '../assessments/assessment-options';
import type { TaskRubricSnapshot } from '../assessments/task-rubric';
import type { AssessmentSession } from './session';

export type AssessmentIssuanceIntent = Readonly<{
  selection: AssessmentSelection;
  mode: 'curated' | 'generated';
  generatedAssessmentId?: string;
  rubricWeights: Readonly<Record<string, number>> | null;
}>;

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const compareKeys = (left: string, right: string) =>
      left < right ? -1 : left > right ? 1 : 0;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
};

export const hashCanonicalPayload = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex');

const normalizeIntent = (intent: AssessmentIssuanceIntent) => ({
  mode: intent.mode,
  ...(intent.mode === 'generated'
    ? { generatedAssessmentId: intent.generatedAssessmentId }
    : {}),
  selection: {
    field: intent.selection.field,
    workKind: intent.selection.workKind,
    domain: intent.selection.domain,
    stack: intent.selection.stack,
    depth: intent.selection.depth,
    durationMinutes: intent.selection.durationMinutes,
    integratedAi: intent.selection.integratedAi,
    terminalEnabled: intent.selection.terminalEnabled ?? true,
  },
  rubricWeights: intent.rubricWeights
    ? Object.fromEntries(
        Object.entries(intent.rubricWeights).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      )
    : null,
});

export const hashAssessmentIssuanceIntent = (
  intent: AssessmentIssuanceIntent,
) => hashCanonicalPayload(normalizeIntent(intent));

export const assessmentIssuanceIntentMatches = (
  storedHash: string,
  intent: AssessmentIssuanceIntent,
): boolean => hashAssessmentIssuanceIntent(intent) === storedHash;

export const rubricWeightMap = (
  rubric: TaskRubricSnapshot | null | undefined,
) =>
  rubric
    ? Object.fromEntries(rubric.criteria.map(({ id, weight }) => [id, weight]))
    : null;

export const hashPersistedAssessmentIdentity = (session: AssessmentSession) =>
  hashCanonicalPayload({
    scenario: session.scenario,
    scenarioType:
      session.scenarioType ?? session.scenario.type ?? 'single_file',
    aiCapabilitySnapshot: session.aiCapabilitySnapshot ?? null,
    taskRubricSnapshot: session.taskRubricSnapshot ?? null,
    durationSeconds: session.durationSeconds,
    terminalEnabled: session.terminalEnabled ?? true,
  });
