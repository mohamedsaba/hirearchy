/**
 * Presentation and validation helpers for R2.10 structured human review packets.
 *
 * Enforces clear separation between objective candidate evidence and human
 * reviewer assessment, strict input bounds, and safe string rendering.
 */

import type {
  R210PacketStatus,
  R210ReferencedEvidence,
  R210ReviewPacketHistoryEntry,
  R210ReviewPacket,
  R210SaveDraftInput,
  R210FinalizePacketInput,
} from '../../../../database/postgres/r210/contract.d.mts';

export type {
  R210PacketStatus,
  R210ReferencedEvidence,
  R210ReviewPacketHistoryEntry,
  R210ReviewPacket,
  R210SaveDraftInput,
  R210FinalizePacketInput,
};

export const MIN_FINALIZED_SUMMARY_LENGTH = 10;
export const MAX_SUMMARY_LENGTH = 50000;
export const MAX_STRING_ITEM_LENGTH = 5000;
export const MAX_LIST_ITEMS = 50;

export const OBJECTIVE_EVIDENCE_LABEL = 'Objective Candidate Evidence';
export const HUMAN_INTERPRETATION_LABEL = 'Subjective Reviewer Assessment';
export const REVIEW_PACKET_FINALIZED_NOTICE =
  'This review packet is finalized and immutable.';
export const CONCURRENCY_CONFLICT_MESSAGE =
  'Edit conflict: this review packet was updated concurrently. Please refresh to load the latest changes.';
export const EVIDENCE_INTEGRITY_NOTICE =
  'Human reviewer packets represent subjective reviewer assessment anchored to immutable candidate evidence. Review packets never alter or rewrite candidate records.';

const EVENT_SEQUENCE_REGEX = /^(0|[1-9][0-9]{0,18})$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
 * Strips or cleans dangerous control characters while preserving valid newlines/tabs.
 */
export function sanitizeReviewPacketText(raw: string): string {
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * Formats anchoring labels for evidence references.
 * E.g., "Event Sequence #4" or "File: src/index.ts (Revision v2)".
 */
export function formatReferenceLabel(ref: R210ReferencedEvidence): string {
  if (ref.label) return ref.label;
  if (ref.evidenceSourceType === 'file_revision') {
    const path = ref.filePath || 'Unknown file';
    const version = ref.fileVersion ? `v${ref.fileVersion}` : 'unversioned';
    return `File: ${path} (Revision ${version})`;
  }
  return `Event Sequence #${ref.eventSequence}`;
}

/**
 * Formats a SHA-256 digest into an abbreviated badge string (e.g. "sha256:abcd1234...").
 */
export function formatDigestBadge(digest: string | null | undefined): string {
  if (!digest) return 'no-digest';
  const clean = digest.replace(/^sha256:/i, '');
  if (clean.length <= 12) return `sha256:${clean}`;
  return `sha256:${clean.slice(0, 12)}…`;
}

/**
 * Normalizes timestamps to formatted UTC ISO string representation.
 */
export function formatReviewPacketTimestamp(
  dateOrString: Date | string,
): string {
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

/**
 * Formats timestamps for display in UI.
 */
export function formatReviewPacketDisplayDate(
  dateOrString: Date | string,
): string {
  try {
    const date =
      typeof dateOrString === 'string' ? new Date(dateOrString) : dateOrString;
    if (Number.isNaN(date.getTime())) {
      return 'Date unavailable';
    }
    return date.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return 'Date unavailable';
  }
}

/**
 * Validates review packet summary text.
 */
export function validateReviewPacketSummary(
  summary: unknown,
  isFinalizing = false,
): { valid: boolean; value?: string; error?: string } {
  if (typeof summary !== 'string') {
    return { valid: false, error: 'Review packet summary must be a string.' };
  }
  const sanitized = sanitizeReviewPacketText(summary).trim();
  if (isFinalizing && sanitized.length < MIN_FINALIZED_SUMMARY_LENGTH) {
    return {
      valid: false,
      error: `Finalized summary must be at least ${MIN_FINALIZED_SUMMARY_LENGTH} characters.`,
    };
  }
  if (sanitized.length > MAX_SUMMARY_LENGTH) {
    return {
      valid: false,
      error: `Summary exceeds maximum allowed length of ${MAX_SUMMARY_LENGTH} characters.`,
    };
  }
  return { valid: true, value: sanitized };
}

/**
 * Validates a list of string items (strengths, concerns, unresolved questions).
 */
export function validateStringArray(
  items: unknown,
  fieldName: string,
): { valid: boolean; value?: string[]; error?: string } {
  if (!Array.isArray(items)) {
    return { valid: false, error: `${fieldName} must be an array of strings.` };
  }
  if (items.length > MAX_LIST_ITEMS) {
    return {
      valid: false,
      error: `${fieldName} exceeds maximum allowed limit of ${MAX_LIST_ITEMS} items.`,
    };
  }
  const result: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item !== 'string') {
      return {
        valid: false,
        error: `Item at index ${i} in ${fieldName} must be a string.`,
      };
    }
    const clean = sanitizeReviewPacketText(item).trim();
    if (clean.length > MAX_STRING_ITEM_LENGTH) {
      return {
        valid: false,
        error: `Item at index ${i} in ${fieldName} exceeds maximum length of ${MAX_STRING_ITEM_LENGTH} characters.`,
      };
    }
    if (clean.length > 0) {
      result.push(clean);
    }
  }
  return { valid: true, value: result };
}

export function validateStrengths(strengths: unknown): {
  valid: boolean;
  value?: string[];
  error?: string;
} {
  return validateStringArray(strengths, 'Strengths');
}

export function validateConcerns(concerns: unknown): {
  valid: boolean;
  value?: string[];
  error?: string;
} {
  return validateStringArray(concerns, 'Concerns');
}

export function validateUnresolvedQuestions(questions: unknown): {
  valid: boolean;
  value?: string[];
  error?: string;
} {
  return validateStringArray(questions, 'Unresolved questions');
}

/**
 * Validates a single referenced evidence item.
 */
export function validateReferencedEvidenceItem(item: unknown): {
  valid: boolean;
  value?: R210ReferencedEvidence;
  error?: string;
} {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return {
      valid: false,
      error: 'Referenced evidence item must be an object.',
    };
  }
  const raw = item as Record<string, unknown>;
  const sourceType = raw.evidenceSourceType;
  if (sourceType !== 'timeline_event' && sourceType !== 'file_revision') {
    return {
      valid: false,
      error: "evidenceSourceType must be 'timeline_event' or 'file_revision'.",
    };
  }

  const seq =
    typeof raw.eventSequence === 'string' ? raw.eventSequence.trim() : '';
  if (!seq || !EVENT_SEQUENCE_REGEX.test(seq)) {
    return {
      valid: false,
      error: 'eventSequence must be a non-empty numeric string.',
    };
  }

  const rawDigest =
    typeof raw.evidenceDigest === 'string' ? raw.evidenceDigest.trim() : '';
  const cleanDigest = rawDigest.replace(/^sha256:/i, '').toLowerCase();
  if (!cleanDigest || !/^[0-9a-f]{64}$/.test(cleanDigest)) {
    return {
      valid: false,
      error: 'evidenceDigest must be a valid 64-character SHA-256 hex digest.',
    };
  }

  let filePath: string | null = null;
  let fileVersion: string | null = null;
  if (sourceType === 'file_revision') {
    if (typeof raw.filePath !== 'string' || !raw.filePath.trim()) {
      return { valid: false, error: 'filePath is required for file_revision.' };
    }
    filePath = raw.filePath.trim();
    if (
      typeof raw.fileVersion !== 'string' ||
      !raw.fileVersion.trim() ||
      !EVENT_SEQUENCE_REGEX.test(raw.fileVersion.trim())
    ) {
      return {
        valid: false,
        error: 'fileVersion must be a numeric string for file_revision.',
      };
    }
    fileVersion = raw.fileVersion.trim();
  }

  const label =
    typeof raw.label === 'string'
      ? sanitizeReviewPacketText(raw.label).trim()
      : undefined;

  return {
    valid: true,
    value: {
      evidenceSourceType: sourceType,
      eventSequence: seq,
      filePath,
      fileVersion,
      evidenceDigest: cleanDigest,
      ...(label ? { label } : {}),
    },
  };
}

/**
 * Validates a list of referenced observation IDs.
 */
export function validateReferencedObservationIds(ids: unknown): {
  valid: boolean;
  value?: string[];
  errors?: string[];
} {
  if (!Array.isArray(ids)) {
    return {
      valid: false,
      errors: ['referencedObservationIds must be an array of UUIDs.'],
    };
  }
  const errors: string[] = [];
  const result: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (typeof id !== 'string' || !UUID_REGEX.test(id.trim())) {
      errors.push(
        `Item at index ${i} in referencedObservationIds must be a valid UUID.`,
      );
    } else {
      result.push(id.trim().toLowerCase());
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: Array.from(new Set(result)) };
}

/**
 * Validates save draft input for review packets.
 */
export function validateSaveDraftInput(input: unknown): {
  valid: boolean;
  value?: R210SaveDraftInput;
  errors?: string[];
} {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['Input must be a non-null object.'] };
  }

  const raw = input as Record<string, unknown>;

  // summary (draft allows empty string)
  let summary = '';
  if (raw.summary !== undefined && raw.summary !== null) {
    const summaryVal = validateReviewPacketSummary(raw.summary, false);
    if (!summaryVal.valid || summaryVal.value === undefined) {
      errors.push(summaryVal.error ?? 'Invalid summary.');
    } else {
      summary = summaryVal.value;
    }
  }

  // strengths
  let strengths: string[] = [];
  if (raw.strengths !== undefined && raw.strengths !== null) {
    const strengthsVal = validateStrengths(raw.strengths);
    if (!strengthsVal.valid || !strengthsVal.value) {
      errors.push(strengthsVal.error ?? 'Invalid strengths.');
    } else {
      strengths = strengthsVal.value;
    }
  }

  // concerns
  let concerns: string[] = [];
  if (raw.concerns !== undefined && raw.concerns !== null) {
    const concernsVal = validateConcerns(raw.concerns);
    if (!concernsVal.valid || !concernsVal.value) {
      errors.push(concernsVal.error ?? 'Invalid concerns.');
    } else {
      concerns = concernsVal.value;
    }
  }

  // unresolvedQuestions
  let unresolvedQuestions: string[] = [];
  if (
    raw.unresolvedQuestions !== undefined &&
    raw.unresolvedQuestions !== null
  ) {
    const questionsVal = validateUnresolvedQuestions(raw.unresolvedQuestions);
    if (!questionsVal.valid || !questionsVal.value) {
      errors.push(questionsVal.error ?? 'Invalid unresolved questions.');
    } else {
      unresolvedQuestions = questionsVal.value;
    }
  }

  // referencedObservationIds
  let referencedObservationIds: string[] = [];
  if (
    raw.referencedObservationIds !== undefined &&
    raw.referencedObservationIds !== null
  ) {
    const obsVal = validateReferencedObservationIds(
      raw.referencedObservationIds,
    );
    if (!obsVal.valid || !obsVal.value) {
      errors.push(
        ...(obsVal.errors ?? ['Invalid referenced observation IDs.']),
      );
    } else {
      referencedObservationIds = obsVal.value;
    }
  }

  // referencedEvidence
  const referencedEvidence: R210ReferencedEvidence[] = [];
  if (raw.referencedEvidence !== undefined && raw.referencedEvidence !== null) {
    if (!Array.isArray(raw.referencedEvidence)) {
      errors.push('referencedEvidence must be an array.');
    } else {
      for (let i = 0; i < raw.referencedEvidence.length; i++) {
        const itemVal = validateReferencedEvidenceItem(
          raw.referencedEvidence[i],
        );
        if (!itemVal.valid || !itemVal.value) {
          errors.push(
            `referencedEvidence item at index ${i}: ${itemVal.error ?? 'invalid'}`,
          );
        } else {
          referencedEvidence.push(itemVal.value);
        }
      }
    }
  }

  // expectedVersion
  let expectedVersion: number | undefined = undefined;
  if (raw.expectedVersion !== undefined && raw.expectedVersion !== null) {
    const num = Number(raw.expectedVersion);
    if (!Number.isInteger(num) || num < 1) {
      errors.push('expectedVersion must be an integer >= 1.');
    } else {
      expectedVersion = num;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      summary,
      strengths,
      concerns,
      unresolvedQuestions,
      referencedObservationIds,
      referencedEvidence,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    },
  };
}

/**
 * Validates finalize input for review packets.
 */
export function validateFinalizePacketInput(input: unknown): {
  valid: boolean;
  value?: R210FinalizePacketInput;
  errors?: string[];
} {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['Input must be a non-null object.'] };
  }

  const raw = input as Record<string, unknown>;
  const expectedVersion = Number(raw.expectedVersion);
  if (
    raw.expectedVersion === undefined ||
    raw.expectedVersion === null ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    errors.push('expectedVersion must be an integer >= 1.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      expectedVersion,
    },
  };
}

/**
 * Validates that a review packet meets the strict prerequisites for finalization.
 * Finalization requires:
 * 1. Non-empty summary of at least 10 characters.
 * 2. At least one grounded citation (either observation or evidence).
 */
export function validatePacketReadinessForFinalization(packet: {
  summary: string;
  referencedObservationIds?: readonly string[];
  referencedEvidence?: readonly R210ReferencedEvidence[];
}): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];
  const summaryVal = validateReviewPacketSummary(packet.summary, true);
  if (!summaryVal.valid) {
    errors.push(summaryVal.error ?? 'Summary is required for finalization.');
  }

  const obsCount = packet.referencedObservationIds?.length ?? 0;
  const evCount = packet.referencedEvidence?.length ?? 0;
  if (obsCount + evCount < 1) {
    errors.push(
      'At least one grounded citation (observation or evidence reference) is required to finalize the review packet.',
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}
