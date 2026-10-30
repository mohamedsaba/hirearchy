import { describe, it, expect, afterEach } from 'vitest';
import { r210IsEnabled } from '../../apps/web/src/r210-review-packets/config';
import {
  escapeHtml,
  sanitizeReviewPacketText,
  formatReferenceLabel,
  formatDigestBadge,
  formatReviewPacketTimestamp,
  formatReviewPacketDisplayDate,
  validateReviewPacketSummary,
  validateStringArray,
  validateStrengths,
  validateConcerns,
  validateUnresolvedQuestions,
  validateReferencedEvidenceItem,
  validateReferencedObservationIds,
  validateSaveDraftInput,
  validateFinalizePacketInput,
  validatePacketReadinessForFinalization,
  OBJECTIVE_EVIDENCE_LABEL,
  HUMAN_INTERPRETATION_LABEL,
  REVIEW_PACKET_FINALIZED_NOTICE,
  CONCURRENCY_CONFLICT_MESSAGE,
  EVIDENCE_INTEGRITY_NOTICE,
  MIN_FINALIZED_SUMMARY_LENGTH,
  MAX_SUMMARY_LENGTH,
} from '../../apps/web/src/r210-review-packets/presentation';

describe('R2.10 Review Packet Config', () => {
  const originalEnv = process.env.R210_ENABLE_REVIEW_PACKETS;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.R210_ENABLE_REVIEW_PACKETS = originalEnv;
    } else {
      delete process.env.R210_ENABLE_REVIEW_PACKETS;
    }
  });

  it('r210IsEnabled returns true by default', () => {
    delete process.env.R210_ENABLE_REVIEW_PACKETS;
    expect(r210IsEnabled()).toBe(true);
  });

  it('r210IsEnabled returns false when set to "false"', () => {
    process.env.R210_ENABLE_REVIEW_PACKETS = 'false';
    expect(r210IsEnabled()).toBe(false);
  });

  it('r210IsEnabled returns true when set to "1" or "true"', () => {
    process.env.R210_ENABLE_REVIEW_PACKETS = '1';
    expect(r210IsEnabled()).toBe(true);
  });
});

describe('R2.10 Presentation and XSS Safety', () => {
  it('escapes dangerous HTML characters for safe inert rendering', () => {
    const raw = '<script>alert("xss & \'injection\'")</script>';
    const escaped = escapeHtml(raw);
    expect(escaped).toBe(
      '&lt;script&gt;alert(&quot;xss &amp; &#39;injection&#39;&quot;)&lt;/script&gt;',
    );
    expect(escaped).not.toContain('<script>');
  });

  it('strips control characters while preserving valid newlines and tabs', () => {
    const raw = 'Review\u0000Assessment\u0007\nParagraph 2\tIndented';
    const clean = sanitizeReviewPacketText(raw);
    expect(clean).toBe('ReviewAssessment\nParagraph 2\tIndented');
  });

  it('formats reference labels for timeline events and file revisions', () => {
    expect(
      formatReferenceLabel({
        evidenceSourceType: 'timeline_event',
        eventSequence: '12',
        filePath: null,
        fileVersion: null,
        evidenceDigest:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }),
    ).toBe('Event Sequence #12');

    expect(
      formatReferenceLabel({
        evidenceSourceType: 'file_revision',
        eventSequence: '15',
        filePath: 'src/order_service.py',
        fileVersion: '4',
        evidenceDigest:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }),
    ).toBe('File: src/order_service.py (Revision v4)');

    expect(
      formatReferenceLabel({
        evidenceSourceType: 'timeline_event',
        eventSequence: '12',
        filePath: null,
        fileVersion: null,
        evidenceDigest:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        label: 'Candidate implemented retry loop',
      }),
    ).toBe('Candidate implemented retry loop');
  });

  it('formats digest badges with truncation', () => {
    const longDigest =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(formatDigestBadge(longDigest)).toBe('sha256:e3b0c44298fc…');

    const prefixedDigest = `sha256:${longDigest}`;
    expect(formatDigestBadge(prefixedDigest)).toBe('sha256:e3b0c44298fc…');

    const shortDigest = 'abcd12';
    expect(formatDigestBadge(shortDigest)).toBe('sha256:abcd12');

    expect(formatDigestBadge('')).toBe('no-digest');
    expect(formatDigestBadge(null)).toBe('no-digest');
  });

  it('formats timestamps into strict UTC ISO strings and display dates', () => {
    const date = new Date('2026-10-27T14:30:00.000Z');
    expect(formatReviewPacketTimestamp(date)).toBe('2026-10-27T14:30:00.000Z');
    expect(formatReviewPacketTimestamp('2026-10-27T14:30:00.000Z')).toBe(
      '2026-10-27T14:30:00.000Z',
    );
    expect(formatReviewPacketTimestamp('invalid-date')).toBe('Invalid date');

    expect(formatReviewPacketDisplayDate('2026-10-27T14:30:00.000Z')).not.toBe(
      'Date unavailable',
    );
    expect(formatReviewPacketDisplayDate('invalid')).toBe('Date unavailable');
  });
});

describe('R2.10 Evidence vs Assessment Distinction & Constants', () => {
  it('defines distinct labels and notices', () => {
    expect(OBJECTIVE_EVIDENCE_LABEL).toBe('Objective Candidate Evidence');
    expect(HUMAN_INTERPRETATION_LABEL).toBe('Subjective Reviewer Assessment');
    expect(REVIEW_PACKET_FINALIZED_NOTICE).toBe(
      'This review packet is finalized and immutable.',
    );
    expect(CONCURRENCY_CONFLICT_MESSAGE).toBe(
      'Edit conflict: this review packet was updated concurrently. Please refresh to load the latest changes.',
    );
    expect(EVIDENCE_INTEGRITY_NOTICE).toContain(
      'subjective reviewer assessment anchored to immutable candidate evidence',
    );
  });
});

describe('R2.10 Input Validation for Draft vs Finalization', () => {
  it('validates summary bounds for draft vs finalization', () => {
    // Draft allows empty summary
    const emptyDraft = validateReviewPacketSummary('', false);
    expect(emptyDraft.valid).toBe(true);
    expect(emptyDraft.value).toBe('');

    // Finalization rejects empty or short summary (< 10 chars)
    const emptyFinal = validateReviewPacketSummary('', true);
    expect(emptyFinal.valid).toBe(false);
    expect(emptyFinal.error).toContain(
      `at least ${MIN_FINALIZED_SUMMARY_LENGTH} characters`,
    );

    const shortFinal = validateReviewPacketSummary('Too short', true);
    expect(shortFinal.valid).toBe(false);
    expect(shortFinal.error).toContain(
      `at least ${MIN_FINALIZED_SUMMARY_LENGTH} characters`,
    );

    const validFinal = validateReviewPacketSummary(
      'Candidate demonstrated thorough error handling and clean architecture.',
      true,
    );
    expect(validFinal.valid).toBe(true);
    expect(validFinal.value).toBe(
      'Candidate demonstrated thorough error handling and clean architecture.',
    );

    const oversized = validateReviewPacketSummary(
      'a'.repeat(MAX_SUMMARY_LENGTH + 1),
      false,
    );
    expect(oversized.valid).toBe(false);
    expect(oversized.error).toContain('maximum allowed length');
  });

  it('validates strengths, concerns, and unresolved questions', () => {
    const rawArray = validateStringArray(['Point 1', 'Point 2'], 'Items');
    expect(rawArray.valid).toBe(true);
    expect(rawArray.value).toEqual(['Point 1', 'Point 2']);

    const validStrengths = validateStrengths([
      'Strong test coverage',
      'Clean modularization',
    ]);
    expect(validStrengths.valid).toBe(true);
    expect(validStrengths.value).toEqual([
      'Strong test coverage',
      'Clean modularization',
    ]);

    const nonArray = validateConcerns('Not an array');
    expect(nonArray.valid).toBe(false);
    expect(nonArray.error).toContain('must be an array of strings');

    const withNonString = validateUnresolvedQuestions(['Valid', 123]);
    expect(withNonString.valid).toBe(false);
    expect(withNonString.error).toContain('must be a string');
  });

  it('validates referenced evidence items', () => {
    const validEvent = validateReferencedEvidenceItem({
      evidenceSourceType: 'timeline_event',
      eventSequence: '5',
      evidenceDigest:
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    expect(validEvent.valid).toBe(true);
    expect(validEvent.value?.eventSequence).toBe('5');

    const missingFilePath = validateReferencedEvidenceItem({
      evidenceSourceType: 'file_revision',
      eventSequence: '6',
      evidenceDigest:
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      fileVersion: '1',
    });
    expect(missingFilePath.valid).toBe(false);
    expect(missingFilePath.error).toContain('filePath is required');

    const invalidDigest = validateReferencedEvidenceItem({
      evidenceSourceType: 'timeline_event',
      eventSequence: '1',
      evidenceDigest: 'invalid-digest',
    });
    expect(invalidDigest.valid).toBe(false);
    expect(invalidDigest.error).toContain('64-character SHA-256');
  });

  it('validates referenced observation UUIDs', () => {
    const validIds = validateReferencedObservationIds([
      'c8b1a329-873b-4c4d-9653-6b74457e51c2',
      'C8B1A329-873B-4C4D-9653-6B74457E51C2', // duplicate case insensitive
    ]);
    expect(validIds.valid).toBe(true);
    expect(validIds.value?.length).toBe(1);

    const invalidIds = validateReferencedObservationIds(['not-a-uuid']);
    expect(invalidIds.valid).toBe(false);
    expect(invalidIds.errors?.[0]).toContain('must be a valid UUID');
  });

  it('validates save draft input with optimistic version', () => {
    const validDraft = validateSaveDraftInput({
      summary: 'Draft in progress',
      strengths: ['Good start'],
      concerns: [],
      unresolvedQuestions: [],
      referencedObservationIds: [],
      referencedEvidence: [],
      expectedVersion: 1,
    });
    expect(validDraft.valid).toBe(true);
    expect(validDraft.value?.expectedVersion).toBe(1);

    const invalidVersion = validateSaveDraftInput({
      summary: '',
      expectedVersion: 0,
    });
    expect(invalidVersion.valid).toBe(false);
    expect(invalidVersion.errors?.[0]).toContain('expectedVersion');
  });

  it('validates finalize input requires expectedVersion >= 1', () => {
    expect(validateFinalizePacketInput({ expectedVersion: 3 }).valid).toBe(
      true,
    );
    expect(validateFinalizePacketInput({ expectedVersion: 0 }).valid).toBe(
      false,
    );
    expect(validateFinalizePacketInput({}).valid).toBe(false);
  });

  it('validates packet readiness for finalization requires >= 10 char summary and >= 1 citation', () => {
    // Fails on empty summary
    const noSummary = validatePacketReadinessForFinalization({
      summary: '',
      referencedObservationIds: ['c8b1a329-873b-4c4d-9653-6b74457e51c2'],
    });
    expect(noSummary.valid).toBe(false);

    // Fails on 0 citations
    const noCitations = validatePacketReadinessForFinalization({
      summary: 'A very detailed summary that is well over ten characters long.',
      referencedObservationIds: [],
      referencedEvidence: [],
    });
    expect(noCitations.valid).toBe(false);
    expect(noCitations.errors?.[0]).toContain('grounded citation');

    // Passes with summary and at least 1 observation
    const withObs = validatePacketReadinessForFinalization({
      summary: 'A very detailed summary that is well over ten characters long.',
      referencedObservationIds: ['c8b1a329-873b-4c4d-9653-6b74457e51c2'],
      referencedEvidence: [],
    });
    expect(withObs.valid).toBe(true);

    // Passes with summary and at least 1 evidence reference
    const withEv = validatePacketReadinessForFinalization({
      summary: 'A very detailed summary that is well over ten characters long.',
      referencedObservationIds: [],
      referencedEvidence: [
        {
          evidenceSourceType: 'timeline_event',
          eventSequence: '1',
          filePath: null,
          fileVersion: null,
          evidenceDigest:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      ],
    });
    expect(withEv.valid).toBe(true);
  });
});
