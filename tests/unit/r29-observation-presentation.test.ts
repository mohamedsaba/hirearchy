import { describe, it, expect } from 'vitest';
import { r29IsEnabled } from '../../apps/web/src/r29-observations/config';
import {
  escapeHtml,
  sanitizeObservationText,
  formatAnchorLabel,
  formatDigestBadge,
  validateObservationBody,
  validateCreateObservationInput,
  validateUpdateObservationInput,
  formatObservationTimestamp,
  formatObservationDisplayDate,
  OBJECTIVE_EVIDENCE_LABEL,
  HUMAN_INTERPRETATION_LABEL,
  CONCURRENCY_CONFLICT_MESSAGE,
  EVIDENCE_INTERPRETATION_NOTICE,
  MIN_OBSERVATION_BODY_LENGTH,
  MAX_OBSERVATION_BODY_LENGTH,
} from '../../apps/web/src/r29-observations/presentation';

describe('R2.9 Observation Config', () => {
  it('r29IsEnabled returns true in test environment', () => {
    expect(r29IsEnabled()).toBe(true);
  });
});

describe('R2.9 Presentation and XSS Safety', () => {
  it('escapes dangerous HTML characters for safe inert rendering', () => {
    const raw = '<script>alert("xss & \'injection\'")</script>';
    const escaped = escapeHtml(raw);
    expect(escaped).toBe(
      '&lt;script&gt;alert(&quot;xss &amp; &#39;injection&#39;&quot;)&lt;/script&gt;',
    );
    expect(escaped).not.toContain('<script>');
  });

  it('strips control characters while preserving newlines and tabs', () => {
    const rawWithControl = 'Hello\u0000World\u0007\nLine 2\tIndented';
    const sanitized = sanitizeObservationText(rawWithControl);
    expect(sanitized).toBe('HelloWorld\nLine 2\tIndented');
  });

  it('formats anchor labels for timeline events and file revisions', () => {
    expect(
      formatAnchorLabel({
        evidenceSourceType: 'timeline_event',
        eventSequence: '42',
      }),
    ).toBe('Event Sequence #42');

    expect(
      formatAnchorLabel({
        evidenceSourceType: 'file_revision',
        eventSequence: '7',
        filePath: 'src/bookings/service.py',
        fileVersion: '3',
      }),
    ).toBe('File: src/bookings/service.py (Revision v3)');
  });

  it('formats digest badges with truncation', () => {
    const longDigest =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(formatDigestBadge(longDigest)).toBe('sha256:e3b0c44298fc…');

    const shortDigest = 'abcd12';
    expect(formatDigestBadge(shortDigest)).toBe('sha256:abcd12');

    expect(formatDigestBadge('')).toBe('no-digest');
  });

  it('formats timestamps into strict UTC ISO strings', () => {
    const date = new Date('2026-10-27T12:34:56.789Z');
    expect(formatObservationTimestamp(date)).toBe('2026-10-27T12:34:56.789Z');
    expect(formatObservationTimestamp('2026-10-27T12:34:56.789Z')).toBe(
      '2026-10-27T12:34:56.789Z',
    );
    expect(formatObservationTimestamp('invalid')).toBe('Invalid date');
  });

  it('provides human-readable display dates with fallback', () => {
    expect(formatObservationDisplayDate('2026-10-27T12:34:56.789Z')).not.toBe(
      'Date unavailable',
    );
    expect(formatObservationDisplayDate('invalid')).toBe('Date unavailable');
  });
});

describe('R2.9 Evidence vs Interpretation Distinction', () => {
  it('defines distinct labels and clear notice for objective evidence vs human interpretation', () => {
    expect(OBJECTIVE_EVIDENCE_LABEL).toBe('Objective Candidate Evidence');
    expect(HUMAN_INTERPRETATION_LABEL).toBe('Human Evaluator Interpretation');
    expect(EVIDENCE_INTERPRETATION_NOTICE).toContain(
      'Human evaluator observations represent subjective reviewer notes',
    );
    expect(EVIDENCE_INTERPRETATION_NOTICE).toContain(
      'Observations never alter or rewrite candidate records',
    );
  });

  it('defines the required optimistic concurrency conflict message', () => {
    expect(CONCURRENCY_CONFLICT_MESSAGE).toBe(
      'Edit conflict: this observation was updated concurrently. Please refresh.',
    );
  });
});

describe('R2.9 Observation Input Validation', () => {
  it('validates observation body bounds (1..10000 characters, trimmed)', () => {
    // Empty / whitespace
    expect(validateObservationBody('')).toEqual({
      valid: false,
      error: `Observation body cannot be empty (minimum ${MIN_OBSERVATION_BODY_LENGTH} character).`,
    });
    expect(validateObservationBody('   \n\t  ')).toEqual({
      valid: false,
      error: `Observation body cannot be empty (minimum ${MIN_OBSERVATION_BODY_LENGTH} character).`,
    });
    expect(validateObservationBody(123)).toEqual({
      valid: false,
      error: 'Observation body must be a string.',
    });

    // Valid body
    const valid = validateObservationBody(
      '  Candidate properly handled idempotency.  ',
    );
    expect(valid.valid).toBe(true);
    expect(valid.value).toBe('Candidate properly handled idempotency.');

    // Exceeds max length
    const tooLong = 'a'.repeat(MAX_OBSERVATION_BODY_LENGTH + 1);
    expect(validateObservationBody(tooLong)).toEqual({
      valid: false,
      error: `Observation body exceeds maximum allowed length of ${MAX_OBSERVATION_BODY_LENGTH} characters.`,
    });

    // Exactly max length
    const exactlyMax = 'a'.repeat(MAX_OBSERVATION_BODY_LENGTH);
    const maxValid = validateObservationBody(exactlyMax);
    expect(maxValid.valid).toBe(true);
    expect(maxValid.value?.length).toBe(MAX_OBSERVATION_BODY_LENGTH);
  });

  it('validates create observation inputs for timeline events', () => {
    const validEvent = {
      evidenceSourceType: 'timeline_event',
      eventSequence: '5',
      evidenceDigest:
        'sha256:a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      body: 'Noticed candidate started test suite here.',
    };
    const result = validateCreateObservationInput(validEvent);
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({
      evidenceSourceType: 'timeline_event',
      eventSequence: '5',
      filePath: null,
      fileVersion: null,
      evidenceDigest:
        'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      body: 'Noticed candidate started test suite here.',
    });
  });

  it('validates create observation inputs for file revisions', () => {
    const validRevision = {
      evidenceSourceType: 'file_revision',
      eventSequence: '12',
      filePath: 'src/bookings/service.py',
      fileVersion: '2',
      evidenceDigest:
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      body: 'Refactored notification dispatch method to handle retry count.',
    };
    const result = validateCreateObservationInput(validRevision);
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({
      evidenceSourceType: 'file_revision',
      eventSequence: '12',
      filePath: 'src/bookings/service.py',
      fileVersion: '2',
      evidenceDigest:
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      body: 'Refactored notification dispatch method to handle retry count.',
    });
  });

  it('rejects create observation inputs with invalid types or missing revision fields', () => {
    const missingFileFields = {
      evidenceSourceType: 'file_revision',
      eventSequence: '12',
      evidenceDigest: 'digest123',
      body: 'Missing file info.',
    };
    const result1 = validateCreateObservationInput(missingFileFields);
    expect(result1.valid).toBe(false);
    expect(result1.errors).toContain(
      'filePath is required for file_revision observations.',
    );
    expect(result1.errors).toContain(
      'fileVersion must be a numeric string for file_revision observations.',
    );

    const invalidSourceType = {
      evidenceSourceType: 'unknown_source',
      eventSequence: '12',
      evidenceDigest: 'digest123',
      body: 'Invalid source type.',
    };
    const result2 = validateCreateObservationInput(invalidSourceType);
    expect(result2.valid).toBe(false);
    expect(result2.errors).toContain(
      "evidenceSourceType must be either 'timeline_event' or 'file_revision'.",
    );
  });

  it('validates update observation inputs with optimistic version check', () => {
    const validUpdate = {
      expectedVersion: 1,
      body: 'Updated observation content.',
    };
    const res1 = validateUpdateObservationInput(validUpdate);
    expect(res1.valid).toBe(true);
    expect(res1.value).toEqual({
      expectedVersion: 1,
      body: 'Updated observation content.',
    });

    // Invalid version
    const invalidVer = {
      expectedVersion: 0,
      body: 'Valid body.',
    };
    const res2 = validateUpdateObservationInput(invalidVer);
    expect(res2.valid).toBe(false);
    expect(res2.errors).toContain('expectedVersion must be an integer >= 1.');

    const nonIntVer = {
      expectedVersion: 1.5,
      body: 'Valid body.',
    };
    const res3 = validateUpdateObservationInput(nonIntVer);
    expect(res3.valid).toBe(false);
    expect(res3.errors).toContain('expectedVersion must be an integer >= 1.');
  });
});
