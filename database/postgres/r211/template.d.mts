import type { R211AssessmentDraftInput } from './contract.d.mts';

export function normalizeAssessmentTemplate(
  input: R211AssessmentDraftInput,
): R211AssessmentDraftInput;
export function reservationMovesBinding(): {
  templateId: 'reservation-moves-v3';
  recipe: { id: string; version: string; digest: string };
  starterWorkspaceDigest: string;
};
