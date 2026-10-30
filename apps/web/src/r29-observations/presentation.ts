/**
 * Presentation and validation helpers for R2.9 structured evaluator observations.
 *
 * Enforces clear separation between objective candidate evidence and human
 * reviewer interpretation, strict input bounds, and safe string rendering.
 */

export type R29EvidenceSourceType = 'timeline_event' | 'file_revision';

export type R29ObservationVisibility = 'private';

export interface R29ObservationHistoryEntry {
  readonly historyId: string;
  readonly observationId: string;
  readonly version: number;
  readonly body: string;
  readonly evidenceSourceType: R29EvidenceSourceType;
  readonly eventSequence: string;
  readonly filePath: string | null;
  readonly fileVersion: string | null;
  readonly evidenceDigest: string;
  readonly visibility: R29ObservationVisibility;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly recordedAt: string;
}

export interface R29EvaluatorObservation {
  readonly id: string;
  readonly organizationId: string;
  readonly sessionId: string;
  readonly authorPrincipalId: string;
  readonly evidenceSourceType: R29EvidenceSourceType;
  readonly eventSequence: string;
  readonly filePath: string | null;
  readonly fileVersion: string | null;
  readonly evidenceDigest: string;
  readonly body: string;
  readonly version: number;
  readonly visibility: R29ObservationVisibility;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly history?: readonly R29ObservationHistoryEntry[];
}

export interface R29CreateObservationInput {
  readonly evidenceSourceType: R29EvidenceSourceType;
  readonly eventSequence: string;
  readonly filePath?: string | null;
  readonly fileVersion?: string | null;
  readonly evidenceDigest: string;
  readonly body: string;
}

export interface R29UpdateObservationInput {
  readonly expectedVersion: number;
  readonly body: string;
}

export const MIN_OBSERVATION_BODY_LENGTH = 1;
export const MAX_OBSERVATION_BODY_LENGTH = 10000;

export const OBJECTIVE_EVIDENCE_LABEL = 'Objective Candidate Evidence';
export const HUMAN_INTERPRETATION_LABEL = 'Human Evaluator Interpretation';
export const CONCURRENCY_CONFLICT_MESSAGE =
  'Edit conflict: this observation was updated concurrently. Please refresh.';
export const EVIDENCE_INTERPRETATION_NOTICE =
  'Human evaluator observations represent subjective reviewer notes anchored to immutable candidate evidence. Observations never alter or rewrite candidate records.';

const EVENT_SEQUENCE_REGEX = /^(0|[1-9][0-9]{0,18})$/;

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
export function sanitizeObservationText(raw: string): string {
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * Formats anchoring labels for evidence references.
 * E.g., "Event Sequence #4" or "File: src/index.ts (Revision v2)".
 */
export function formatAnchorLabel(anchor: {
  readonly evidenceSourceType: R29EvidenceSourceType;
  readonly eventSequence: string;
  readonly filePath?: string | null;
  readonly fileVersion?: string | null;
}): string {
  if (anchor.evidenceSourceType === 'file_revision') {
    const path = anchor.filePath || 'Unknown file';
    const version = anchor.fileVersion
      ? `v${anchor.fileVersion}`
      : 'unversioned';
    return `File: ${path} (Revision ${version})`;
  }
  return `Event Sequence #${anchor.eventSequence}`;
}

/**
 * Formats a SHA-256 digest into an abbreviated badge string (e.g. "sha256:abcd1234...").
 */
export function formatDigestBadge(digest: string): string {
  if (!digest) return 'no-digest';
  const clean = digest.replace(/^sha256:/i, '');
  if (clean.length <= 12) return `sha256:${clean}`;
  return `sha256:${clean.slice(0, 12)}…`;
}

/**
 * Validates observation body text.
 */
export function validateObservationBody(body: unknown): {
  valid: boolean;
  value?: string;
  error?: string;
} {
  if (typeof body !== 'string') {
    return { valid: false, error: 'Observation body must be a string.' };
  }
  const trimmed = sanitizeObservationText(body).trim();
  if (trimmed.length < MIN_OBSERVATION_BODY_LENGTH) {
    return {
      valid: false,
      error: `Observation body cannot be empty (minimum ${MIN_OBSERVATION_BODY_LENGTH} character).`,
    };
  }
  if (trimmed.length > MAX_OBSERVATION_BODY_LENGTH) {
    return {
      valid: false,
      error: `Observation body exceeds maximum allowed length of ${MAX_OBSERVATION_BODY_LENGTH} characters.`,
    };
  }
  return { valid: true, value: trimmed };
}

/**
 * Validates full creation input for structured observations.
 */
export function validateCreateObservationInput(input: unknown): {
  valid: boolean;
  value?: R29CreateObservationInput;
  errors?: string[];
} {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['Input must be a non-null object.'] };
  }

  const raw = input as Record<string, unknown>;

  // Validate evidenceSourceType
  const sourceType = raw.evidenceSourceType;
  if (sourceType !== 'timeline_event' && sourceType !== 'file_revision') {
    errors.push(
      "evidenceSourceType must be either 'timeline_event' or 'file_revision'.",
    );
  }

  // Validate eventSequence
  const seq =
    typeof raw.eventSequence === 'string' ? raw.eventSequence.trim() : '';
  if (!seq || !EVENT_SEQUENCE_REGEX.test(seq)) {
    errors.push('eventSequence must be a non-empty numeric string.');
  }

  // Validate evidenceDigest
  const rawDigest =
    typeof raw.evidenceDigest === 'string' ? raw.evidenceDigest.trim() : '';
  const digest = rawDigest.replace(/^sha256:/i, '').toLowerCase();
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)) {
    errors.push(
      'evidenceDigest must be a valid 64-character SHA-256 hex digest.',
    );
  }

  // Validate file fields if file_revision
  let filePath: string | null = null;
  let fileVersion: string | null = null;
  if (sourceType === 'file_revision') {
    if (typeof raw.filePath !== 'string' || !raw.filePath.trim()) {
      errors.push('filePath is required for file_revision observations.');
    } else {
      filePath = raw.filePath.trim();
    }
    if (
      typeof raw.fileVersion !== 'string' ||
      !raw.fileVersion.trim() ||
      !EVENT_SEQUENCE_REGEX.test(raw.fileVersion.trim())
    ) {
      errors.push(
        'fileVersion must be a numeric string for file_revision observations.',
      );
    } else {
      fileVersion = raw.fileVersion.trim();
    }
  } else {
    filePath = null;
    fileVersion = null;
  }

  // Validate body
  const bodyResult = validateObservationBody(raw.body);
  if (!bodyResult.valid || !bodyResult.value) {
    errors.push(bodyResult.error || 'Invalid observation body.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      evidenceSourceType: sourceType as R29EvidenceSourceType,
      eventSequence: seq,
      filePath,
      fileVersion,
      evidenceDigest: digest,
      body: bodyResult.value!,
    },
  };
}

/**
 * Validates optimistic update input for observations.
 */
export function validateUpdateObservationInput(input: unknown): {
  valid: boolean;
  value?: R29UpdateObservationInput;
  errors?: string[];
} {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['Input must be a non-null object.'] };
  }

  const raw = input as Record<string, unknown>;

  const expectedVersion = Number(raw.expectedVersion);
  if (
    typeof raw.expectedVersion !== 'number' ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    errors.push('expectedVersion must be an integer >= 1.');
  }

  const bodyResult = validateObservationBody(raw.body);
  if (!bodyResult.valid || !bodyResult.value) {
    errors.push(bodyResult.error || 'Invalid observation body.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      expectedVersion,
      body: bodyResult.value!,
    },
  };
}

/**
 * Normalizes timestamps to formatted UTC ISO string representation.
 */
export function formatObservationTimestamp(
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
export function formatObservationDisplayDate(
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
