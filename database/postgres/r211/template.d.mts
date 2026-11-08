import type { R211AssessmentDraftInput } from './contract.d.mts';

export interface ApprovedTemplateSummary {
  readonly templateId: 'reservation-moves-v3';
  readonly scenarioId: 'reservation-moves';
  readonly scenarioVersion: 'v3';
  readonly title: string;
  readonly description: string;
  readonly primaryFilePath: string;
  readonly recipeId: string;
  readonly recipeVersion: string;
  readonly recipeDigest: string;
  readonly starterWorkspaceDigest: string;
  readonly starterFilePaths: readonly string[];
}

export const APPROVED_ASSESSMENT_TEMPLATES: readonly ApprovedTemplateSummary[];
export function listApprovedTemplates(): readonly ApprovedTemplateSummary[];
export function getApprovedTemplate(
  templateId: string,
): ApprovedTemplateSummary | null;

export const expectedWorkspaceDigest: string;
export const expectedBriefDigest: string;

export function normalizeAssessmentTemplate(
  input: R211AssessmentDraftInput,
): R211AssessmentDraftInput;
export function reservationMovesBinding(): {
  templateId: 'reservation-moves-v3';
  recipe: { id: string; version: string; digest: string };
  starterWorkspaceDigest: string;
};
