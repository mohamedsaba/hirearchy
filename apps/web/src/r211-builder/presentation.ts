/**
 * Presentation, formatting, and validation helpers for R2.11 Assessment Builder.
 *
 * Provides safe string rendering, canonical digest badges, status banners,
 * error grouping, and empty state definitions for Define -> Validate -> Issue stages.
 */

import type {
  R211StarterFile,
  R211RubricCriterion,
  R211AssessmentDraftInput,
  R211AssessmentDraft,
  R211ValidationIssue,
  R211ValidationResult,
  R211ValidatedVersion,
} from './contract';

import {
  ALLOWED_DURATIONS,
  EXECUTION_VALIDATION_NOTICE,
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  MAX_PATH_LENGTH,
  MAX_TOTAL_BYTES,
  SAFE_PATH_PATTERN,
  validateAssessmentDraft,
  computeCanonicalContentDigest,
  buildScenarioSnapshotEnvelope,
  buildTaskRubricSnapshot,
} from './validation';

export type {
  R211StarterFile,
  R211RubricCriterion,
  R211AssessmentDraftInput,
  R211AssessmentDraft,
  R211ValidationIssue,
  R211ValidationResult,
  R211ValidatedVersion,
};

export {
  ALLOWED_DURATIONS,
  EXECUTION_VALIDATION_NOTICE,
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  MAX_PATH_LENGTH,
  MAX_TOTAL_BYTES,
  SAFE_PATH_PATTERN,
  validateAssessmentDraft,
  computeCanonicalContentDigest,
  buildScenarioSnapshotEnvelope,
  buildTaskRubricSnapshot,
};

// UI Notification and Banner Constants
export const CONCURRENCY_CONFLICT_BANNER =
  'This draft was modified concurrently by another session. Please refresh to load the latest changes.';
export const DRAFT_SAVED_MESSAGE = 'Draft saved successfully.';
export const VALIDATION_FAILED_MESSAGE =
  'Assessment definition has validation issues that must be corrected before validation.';
export const IMMUTABLE_VERSION_NOTICE =
  'Once validated, this version snapshot is permanently immutable. Any subsequent draft edits will create a new version and will not affect previously issued sessions.';
export const EMPTY_STARTER_FILES_NOTICE =
  'At least one starter workspace file is required. The primary file path must match one of the starter files.';
export const EMPTY_RUBRIC_NOTICE =
  'Rubric criteria must be defined and weights must sum to exactly 100%.';

/**
 * Escapes characters that are dangerous in inert HTML contexts.
 */
export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strips dangerous control characters while preserving valid newlines and tabs.
 */
export function sanitizeBuilderText(raw: string): string {
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * Formats a SHA-256 digest into an abbreviated badge string (e.g. "sha256:abcd1234...").
 */
export function formatDigestBadge(digest: string | null | undefined): string {
  if (!digest) return 'no-digest';
  const clean = digest.replace(/^sha256:/i, '');
  if (clean.length <= 16) return `sha256:${clean}`;
  return `sha256:${clean.slice(0, 16)}…`;
}

/**
 * Formats full canonical digest with sha256 prefix.
 */
export function formatFullDigest(digest: string | null | undefined): string {
  if (!digest) return 'no-digest';
  const clean = digest.replace(/^sha256:/i, '');
  return `sha256:${clean}`;
}

/**
 * Formats duration in minutes to user-facing label.
 */
export function formatDurationLabel(minutes: number): string {
  return `${minutes} minutes`;
}

/**
 * Groups validation issues by field name.
 */
export function groupValidationIssues(
  issues: readonly R211ValidationIssue[] | undefined,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!issues) return result;
  for (const issue of issues) {
    if (!result[issue.field]) {
      result[issue.field] = [];
    }
    result[issue.field].push(issue.message);
  }
  return result;
}

/**
 * Gets the first validation issue message for a specific field name.
 */
export function getIssueForField(
  issues: readonly R211ValidationIssue[] | undefined,
  field: string,
): string | undefined {
  if (!issues) return undefined;
  return issues.find((issue) => issue.field === field)?.message;
}

/**
 * Normalizes ISO date string representation.
 */
export function formatBuilderTimestamp(dateOrString: Date | string): string {
  try {
    const date =
      typeof dateOrString === 'string' ? new Date(dateOrString) : dateOrString;
    if (Number.isNaN(date.getTime())) {
      return 'Invalid date';
    }
    return date.toISOString();
  } catch {
    return 'Invalid date';
  }
}
