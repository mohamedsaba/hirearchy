export interface R211StarterFile {
  readonly path: string;
  readonly content: string;
}

export interface R211RubricCriterion {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly weight: number;
  readonly applicability: {
    readonly kind: 'always' | 'recorded_integrated_ai_interaction';
    readonly rule: string;
  };
}

export interface R211AssessmentDraftInput {
  readonly templateId?: 'custom' | 'reservation-moves-v3';
  readonly definitionId?: string;
  readonly title: string;
  readonly brief: string;
  readonly expectedBehavior: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly primaryFilePath: string;
  readonly starterFiles: readonly R211StarterFile[];
  readonly durationMinutes: number;
  readonly terminalEnabled: boolean;
  readonly integratedAi: boolean;
  readonly rubric: readonly R211RubricCriterion[];
  readonly expectedVersion?: number;
}

export interface R211AssessmentDraft {
  readonly templateId: 'custom' | 'reservation-moves-v3';
  readonly definitionId: string;
  readonly organizationId: string;
  readonly authorPrincipalId: string;
  readonly version: number;
  readonly title: string;
  readonly brief: string;
  readonly expectedBehavior: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly primaryFilePath: string;
  readonly starterFiles: readonly R211StarterFile[];
  readonly durationMinutes: number;
  readonly terminalEnabled: boolean;
  readonly integratedAi: boolean;
  readonly rubric: readonly R211RubricCriterion[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface R211ValidationIssue {
  readonly field: string;
  readonly message: string;
}

export interface R211ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly R211ValidationIssue[];
  readonly executionValidationAvailable: boolean;
  readonly executionValidationNotice: string;
}

export interface R211ValidatedVersion {
  readonly id: string;
  readonly definitionId: string;
  readonly organizationId: string;
  readonly authorPrincipalId: string;
  readonly versionNumber: number;
  readonly contentDigest: string;
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly scenarioTitle: string;
  readonly scenarioSnapshot: {
    readonly scenario: Record<string, unknown>;
    readonly workspaceFiles: Record<string, string>;
  };
  readonly taskRubricSnapshot: Record<string, unknown>;
  readonly durationSeconds: number;
  readonly terminalEnabled: boolean;
  readonly integratedAi: boolean;
  readonly validationReceipt: {
    readonly validatedAt: string;
    readonly checks: readonly string[];
    readonly executionValidationAvailable: boolean;
  };
  readonly createdAt: string;
}
