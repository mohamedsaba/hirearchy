import { z } from 'zod';

import {
  assessmentDepths,
  assessmentDomains,
  assessmentDurations,
  assessmentFields,
  assessmentStacks,
  assessmentWorkKinds,
  type AssessmentSelection,
} from './assessment-options';

const memberOf = (values: readonly { id: string }[]) =>
  z.string().refine((value) => values.some((item) => item.id === value));

export const assessmentSelectionSchema = z
  .object({
    field: memberOf(assessmentFields),
    workKind: memberOf(assessmentWorkKinds),
    domain: memberOf(assessmentDomains),
    stack: memberOf(assessmentStacks),
    depth: memberOf(assessmentDepths),
    durationMinutes: z
      .number()
      .int()
      .refine((value) =>
        assessmentDurations.includes(
          value as (typeof assessmentDurations)[number],
        ),
      ),
    integratedAi: z.boolean(),
    terminalEnabled: z.boolean().optional(),
  })
  .strict();

export const assessmentDraftSchema = z
  .object({
    field: memberOf(assessmentFields).optional(),
    workKind: memberOf(assessmentWorkKinds).optional(),
    domain: memberOf(assessmentDomains).optional(),
    stack: memberOf(assessmentStacks).optional(),
    depth: memberOf(assessmentDepths).optional(),
    durationMinutes: z
      .number()
      .int()
      .refine((value) =>
        assessmentDurations.includes(
          value as (typeof assessmentDurations)[number],
        ),
      )
      .optional(),
    integratedAi: z.boolean().optional(),
    terminalEnabled: z.boolean().optional(),
  })
  .strict();

export const parseAssessmentSelection = (
  value: unknown,
): AssessmentSelection | null => {
  const parsed = assessmentSelectionSchema.safeParse(value);
  return parsed.success ? (parsed.data as AssessmentSelection) : null;
};

export const parseAssessmentDraft = (
  value: unknown,
): Partial<AssessmentSelection> | null => {
  const parsed = assessmentDraftSchema.safeParse(value);
  return parsed.success ? (parsed.data as Partial<AssessmentSelection>) : null;
};
