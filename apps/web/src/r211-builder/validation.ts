import { createHash } from 'node:crypto';
import type {
  R211AssessmentDraftInput,
  R211ValidationIssue,
  R211ValidationResult,
} from './contract';

export const MAX_FILE_COUNT = 20;
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 128 * 1024;
export const MAX_PATH_LENGTH = 160;

export const SAFE_PATH_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*(?:^|\/)\.)(?!.*(?:^|\/)(?:conftest|setup|sitecustomize|usercustomize)\.py$)[A-Za-z0-9_./-]+\.(?:py|md|json|txt)$/;

export const ALLOWED_DURATIONS = [30, 45, 60, 90] as const;

export const EXECUTION_VALIDATION_NOTICE =
  'Static scenario structure validated. Live code execution and sandbox container test verification are unavailable in this lane.';

export function validateAssessmentDraft(
  draft: R211AssessmentDraftInput,
): R211ValidationResult {
  const issues: R211ValidationIssue[] = [];

  // Required title
  if (!draft.title || typeof draft.title !== 'string') {
    issues.push({ field: 'title', message: 'Assessment title is required.' });
  } else {
    const trimmedTitle = draft.title.trim();
    if (trimmedTitle.length < 8 || trimmedTitle.length > 120) {
      issues.push({
        field: 'title',
        message: 'Assessment title must be between 8 and 120 characters.',
      });
    }
  }

  // Required brief / candidate instructions
  if (!draft.brief || typeof draft.brief !== 'string') {
    issues.push({
      field: 'brief',
      message: 'Candidate instructions / brief are required.',
    });
  } else {
    const trimmedBrief = draft.brief.trim();
    if (trimmedBrief.length < 20 || trimmedBrief.length > 5000) {
      issues.push({
        field: 'brief',
        message:
          'Candidate instructions / brief must be between 20 and 5000 characters.',
      });
    }
  }

  // Duration
  if (
    typeof draft.durationMinutes !== 'number' ||
    !ALLOWED_DURATIONS.includes(
      draft.durationMinutes as (typeof ALLOWED_DURATIONS)[number],
    )
  ) {
    issues.push({
      field: 'durationMinutes',
      message: 'Duration must be 30, 45, 60, or 90 minutes.',
    });
  }

  // Supported capabilities
  if (draft.terminalEnabled !== true) {
    issues.push({
      field: 'terminalEnabled',
      message:
        'Terminal capability must be enabled for candidate verification checks.',
    });
  }

  // Expected behavior
  if (
    !Array.isArray(draft.expectedBehavior) ||
    draft.expectedBehavior.length === 0
  ) {
    issues.push({
      field: 'expectedBehavior',
      message: 'At least one expected behavior item is required.',
    });
  } else if (draft.expectedBehavior.length > 8) {
    issues.push({
      field: 'expectedBehavior',
      message: 'Expected behavior items cannot exceed 8.',
    });
  } else {
    draft.expectedBehavior.forEach((item, idx) => {
      if (
        typeof item !== 'string' ||
        item.trim().length < 8 ||
        item.trim().length > 400
      ) {
        issues.push({
          field: `expectedBehavior[${idx}]`,
          message:
            'Each expected behavior item must be between 8 and 400 characters.',
        });
      }
    });
  }

  // Acceptance criteria
  if (
    !Array.isArray(draft.acceptanceCriteria) ||
    draft.acceptanceCriteria.length === 0
  ) {
    issues.push({
      field: 'acceptanceCriteria',
      message: 'At least one acceptance criterion is required.',
    });
  } else if (draft.acceptanceCriteria.length > 10) {
    issues.push({
      field: 'acceptanceCriteria',
      message: 'Acceptance criteria cannot exceed 10 items.',
    });
  } else {
    draft.acceptanceCriteria.forEach((item, idx) => {
      if (
        typeof item !== 'string' ||
        item.trim().length < 8 ||
        item.trim().length > 300
      ) {
        issues.push({
          field: `acceptanceCriteria[${idx}]`,
          message:
            'Each acceptance criterion must be between 8 and 300 characters.',
        });
      }
    });
  }

  // Starter workspace files
  const starterPaths = new Set<string>();
  let totalBytes = 0;

  if (!Array.isArray(draft.starterFiles) || draft.starterFiles.length === 0) {
    issues.push({
      field: 'starterFiles',
      message: 'At least one starter workspace file is required.',
    });
  } else if (draft.starterFiles.length > MAX_FILE_COUNT) {
    issues.push({
      field: 'starterFiles',
      message: `Starter files cannot exceed ${MAX_FILE_COUNT} files.`,
    });
  } else {
    draft.starterFiles.forEach((file, idx) => {
      if (
        !file ||
        typeof file.path !== 'string' ||
        typeof file.content !== 'string'
      ) {
        issues.push({
          field: `starterFiles[${idx}]`,
          message: 'Starter file must have valid path and content string.',
        });
        return;
      }
      const trimmedPath = file.path.trim();
      if (!SAFE_PATH_PATTERN.test(trimmedPath)) {
        issues.push({
          field: `starterFiles[${idx}].path`,
          message: `Invalid or unsafe file path "${trimmedPath}". Use relative .py, .md, .json, or .txt path.`,
        });
      }
      if (starterPaths.has(trimmedPath)) {
        issues.push({
          field: `starterFiles[${idx}].path`,
          message: `Duplicate file path "${trimmedPath}".`,
        });
      }
      starterPaths.add(trimmedPath);

      const fileBytes = Buffer.byteLength(file.content, 'utf8');
      if (fileBytes > MAX_FILE_BYTES) {
        issues.push({
          field: `starterFiles[${idx}].content`,
          message: `File "${trimmedPath}" exceeds max size of ${MAX_FILE_BYTES} bytes.`,
        });
      }
      totalBytes += fileBytes;
    });

    if (totalBytes > MAX_TOTAL_BYTES) {
      issues.push({
        field: 'starterFiles',
        message: `Total workspace files size (${totalBytes} bytes) exceeds limit of ${MAX_TOTAL_BYTES} bytes.`,
      });
    }
  }

  // Primary file path
  if (!draft.primaryFilePath || typeof draft.primaryFilePath !== 'string') {
    issues.push({
      field: 'primaryFilePath',
      message: 'Primary file path is required.',
    });
  } else {
    const trimmedPrimary = draft.primaryFilePath.trim();
    if (!trimmedPrimary.endsWith('.py')) {
      issues.push({
        field: 'primaryFilePath',
        message: 'Primary file path must be a Python (.py) file.',
      });
    }
    if (!starterPaths.has(trimmedPrimary)) {
      issues.push({
        field: 'primaryFilePath',
        message: `Primary file "${trimmedPrimary}" must be included in starter workspace files.`,
      });
    }
  }

  // Rubric
  if (!Array.isArray(draft.rubric) || draft.rubric.length === 0) {
    issues.push({
      field: 'rubric',
      message: 'At least one rubric criterion is required.',
    });
  } else if (draft.rubric.length > 8) {
    issues.push({
      field: 'rubric',
      message: 'Rubric criteria cannot exceed 8 items.',
    });
  } else {
    const criterionIds = new Set<string>();
    let totalWeight = 0;

    draft.rubric.forEach((crit, idx) => {
      if (
        !crit ||
        typeof crit.id !== 'string' ||
        typeof crit.label !== 'string'
      ) {
        issues.push({
          field: `rubric[${idx}]`,
          message: 'Invalid rubric criterion structure.',
        });
        return;
      }
      if (criterionIds.has(crit.id)) {
        issues.push({
          field: `rubric[${idx}].id`,
          message: `Duplicate rubric criterion ID "${crit.id}".`,
        });
      }
      criterionIds.add(crit.id);

      if (
        typeof crit.weight !== 'number' ||
        !Number.isInteger(crit.weight) ||
        crit.weight <= 0
      ) {
        issues.push({
          field: `rubric[${idx}].weight`,
          message: 'Criterion weight must be a positive integer.',
        });
      } else {
        totalWeight += crit.weight;
      }
    });

    if (totalWeight !== 100) {
      issues.push({
        field: 'rubric',
        message: `Rubric criterion weights must sum to exactly 100% (currently ${totalWeight}%).`,
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    executionValidationAvailable: false,
    executionValidationNotice: EXECUTION_VALIDATION_NOTICE,
  };
}

export function computeCanonicalContentDigest(
  draft: R211AssessmentDraftInput,
  templateBinding?: Readonly<Record<string, unknown>>,
): string {
  // Canonical sort of starter files by path
  const sortedFiles = [...draft.starterFiles].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const sortedRubric = [...draft.rubric].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const canonicalPayload = {
    contract: 'hirearchy-r211-validated-v1',
    ...(templateBinding ? { templateBinding } : {}),
    title: draft.title.trim(),
    brief: draft.brief.trim(),
    expectedBehavior: [...draft.expectedBehavior],
    acceptanceCriteria: [...draft.acceptanceCriteria],
    primaryFilePath: draft.primaryFilePath.trim(),
    starterFiles: sortedFiles.map((f) => ({
      path: f.path.trim(),
      content: f.content,
    })),
    durationSeconds: draft.durationMinutes * 60,
    terminalEnabled: draft.terminalEnabled,
    integratedAi: draft.integratedAi,
    rubric: sortedRubric.map((r) => ({
      id: r.id.trim(),
      label: r.label.trim(),
      description: r.description.trim(),
      weight: r.weight,
      applicability: r.applicability,
    })),
  };

  return createHash('sha256')
    .update(JSON.stringify(canonicalPayload))
    .digest('hex');
}

export function buildScenarioSnapshotEnvelope(
  scenarioId: string,
  scenarioVersion: string,
  draft: R211AssessmentDraftInput,
) {
  const primaryFile = draft.starterFiles.find(
    (f) => f.path.trim() === draft.primaryFilePath.trim(),
  );
  const workspaceFiles: Record<string, string> = {};
  for (const file of draft.starterFiles) {
    workspaceFiles[file.path.trim()] = file.content;
  }

  const evaluationContext = {
    schemaVersion: 1,
    version: 'r211-authored-assessment-v1',
    purpose: `Authored evaluation for ${draft.title.trim()}`,
    evidenceAreas: [
      {
        id: 'workspace-evidence',
        title: 'Workspace changes',
        description: 'Changes made by the candidate in the workspace.',
        selectors: [
          {
            kind: 'workspace_path_prefix',
            prefixes: draft.starterFiles.map((f) => f.path.trim()),
          },
          {
            kind: 'submitted_path_prefix',
            prefixes: draft.starterFiles.map((f) => f.path.trim()),
          },
        ],
      },
      {
        id: 'verification-evidence',
        title: 'Recorded verification',
        description:
          'Terminal tests and checks recorded during candidate work.',
        selectors: [{ kind: 'verification_result' }],
      },
    ],
    systemInvariants: [
      'The evaluator owns all interpretation and hiring decisions.',
      'Recorded activity does not establish competence or intent.',
    ],
    verificationTargets: [...draft.expectedBehavior],
    interpretationWarnings: [
      'A passing or failing automated check is evidence about recorded task behavior, not a hiring decision.',
      'Do not infer candidate intent, competence, or the origin of code from recorded activity.',
    ],
    reviewPolicy: [
      'Human evaluator review is required; automated checks do not issue a verdict.',
    ],
  };

  const scenario = {
    id: scenarioId,
    version: scenarioVersion,
    title: draft.title.trim(),
    brief: draft.brief.trim(),
    acceptanceCriteria: [...draft.acceptanceCriteria],
    filePath: draft.primaryFilePath.trim(),
    originalContent: primaryFile?.content ?? '',
    durationSeconds: draft.durationMinutes * 60,
    type: 'multi_file',
    evaluationContext,
  };

  return {
    scenario,
    workspaceFiles,
  };
}

export function buildTaskRubricSnapshot(draft: R211AssessmentDraftInput) {
  return {
    version: 'r211-rubric-v1',
    criteria: draft.rubric.map((item) => ({
      id: item.id.trim(),
      label: item.label.trim(),
      description: item.description.trim(),
      weight: item.weight,
      applicability: item.applicability ?? {
        kind: 'always',
        rule: 'Applies to all candidate submissions',
      },
    })),
  };
}
