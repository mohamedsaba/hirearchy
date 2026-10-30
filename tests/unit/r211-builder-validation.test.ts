import { describe, it, expect } from 'vitest';
import type { R211AssessmentDraftInput } from '../../apps/web/src/r211-builder/contract';
import {
  validateAssessmentDraft,
  computeCanonicalContentDigest,
  buildScenarioSnapshotEnvelope,
  buildTaskRubricSnapshot,
  EXECUTION_VALIDATION_NOTICE,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  formatDigestBadge,
  formatFullDigest,
  groupValidationIssues,
  getIssueForField,
  escapeHtml,
  sanitizeBuilderText,
} from '../../apps/web/src/r211-builder/presentation';

const validDraftInput: R211AssessmentDraftInput = {
  title: 'Booking Notification Retry Logic',
  brief:
    'Implement retry logic with exponential backoff for the notification dispatch service.',
  expectedBehavior: [
    'Retries transient connection errors up to 3 times',
    'Logs retry attempt with sequence and delay',
  ],
  acceptanceCriteria: [
    'All tests in tests/test_booking.py pass cleanly',
    'No unhandled connection timeout exceptions raised',
  ],
  primaryFilePath: 'booking.py',
  starterFiles: [
    {
      path: 'booking.py',
      content: '# Primary booking implementation\ndef book():\n    pass\n',
    },
    {
      path: 'README.md',
      content: '# Challenge Instructions\nFollow candidate brief.\n',
    },
    {
      path: 'tests/test_booking.py',
      content:
        'import unittest\n\nclass TestBooking(unittest.TestCase):\n    pass\n',
    },
  ],
  durationMinutes: 45,
  terminalEnabled: true,
  integratedAi: false,
  rubric: [
    {
      id: 'correctness',
      label: 'Correctness',
      description: 'Handles retries and error conditions correctly.',
      weight: 60,
      applicability: {
        kind: 'always',
        rule: 'Applies to all candidate submissions',
      },
    },
    {
      id: 'code-quality',
      label: 'Code Quality',
      description: 'Clean, idiomatic code and error logging.',
      weight: 40,
      applicability: {
        kind: 'always',
        rule: 'Applies to all candidate submissions',
      },
    },
  ],
};

describe('R2.11 Assessment Builder Draft Validation', () => {
  it('validates a complete, conformant assessment draft successfully', () => {
    const result = validateAssessmentDraft(validDraftInput);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.executionValidationAvailable).toBe(false);
    expect(result.executionValidationNotice).toBe(EXECUTION_VALIDATION_NOTICE);
  });

  it('rejects missing, too short, or too long title', () => {
    // Missing title
    const missing = validateAssessmentDraft({
      ...validDraftInput,
      title: '',
    });
    expect(missing.valid).toBe(false);
    expect(getIssueForField(missing.issues, 'title')).toMatch(
      /title is required/i,
    );

    // Too short title (< 8 chars)
    const tooShort = validateAssessmentDraft({
      ...validDraftInput,
      title: 'Tiny',
    });
    expect(tooShort.valid).toBe(false);
    expect(getIssueForField(tooShort.issues, 'title')).toMatch(
      /between 8 and 120 characters/i,
    );

    // Too long title (> 120 chars)
    const tooLong = validateAssessmentDraft({
      ...validDraftInput,
      title: 'A'.repeat(125),
    });
    expect(tooLong.valid).toBe(false);
    expect(getIssueForField(tooLong.issues, 'title')).toMatch(
      /between 8 and 120 characters/i,
    );
  });

  it('rejects missing or out-of-range candidate instructions/brief', () => {
    const missing = validateAssessmentDraft({
      ...validDraftInput,
      brief: '',
    });
    expect(missing.valid).toBe(false);
    expect(getIssueForField(missing.issues, 'brief')).toMatch(
      /instructions \/ brief are required/i,
    );

    const tooShort = validateAssessmentDraft({
      ...validDraftInput,
      brief: 'Too brief.',
    });
    expect(tooShort.valid).toBe(false);
    expect(getIssueForField(tooShort.issues, 'brief')).toMatch(
      /between 20 and 5000 characters/i,
    );

    const tooLong = validateAssessmentDraft({
      ...validDraftInput,
      brief: 'x'.repeat(5001),
    });
    expect(tooLong.valid).toBe(false);
    expect(getIssueForField(tooLong.issues, 'brief')).toMatch(
      /between 20 and 5000 characters/i,
    );
  });

  it('rejects unsupported durations outside [30, 45, 60, 90]', () => {
    const invalidDuration = validateAssessmentDraft({
      ...validDraftInput,
      durationMinutes: 25,
    });
    expect(invalidDuration.valid).toBe(false);
    expect(getIssueForField(invalidDuration.issues, 'durationMinutes')).toMatch(
      /must be 30, 45, 60, or 90/i,
    );
  });

  it('enforces mandatory terminal capability and allows integrated AI in R2.12 test lane', () => {
    const noTerminal = validateAssessmentDraft({
      ...validDraftInput,
      terminalEnabled: false,
    });
    expect(noTerminal.valid).toBe(false);
    expect(getIssueForField(noTerminal.issues, 'terminalEnabled')).toMatch(
      /terminal capability must be enabled/i,
    );

    const withAi = validateAssessmentDraft({
      ...validDraftInput,
      integratedAi: true,
    });
    expect(withAi.valid).toBe(true);
    expect(getIssueForField(withAi.issues, 'integratedAi')).toBeUndefined();
  });

  it('validates expected behavior and acceptance criteria non-emptiness and bounds', () => {
    const emptyBehavior = validateAssessmentDraft({
      ...validDraftInput,
      expectedBehavior: [],
    });
    expect(emptyBehavior.valid).toBe(false);
    expect(getIssueForField(emptyBehavior.issues, 'expectedBehavior')).toMatch(
      /at least one expected behavior/i,
    );

    const emptyCriteria = validateAssessmentDraft({
      ...validDraftInput,
      acceptanceCriteria: [],
    });
    expect(emptyCriteria.valid).toBe(false);
    expect(
      getIssueForField(emptyCriteria.issues, 'acceptanceCriteria'),
    ).toMatch(/at least one acceptance criterion/i);
  });

  it('rejects unsafe, non-conforming, or duplicate starter workspace file paths', () => {
    // Path traversal
    const traversal = validateAssessmentDraft({
      ...validDraftInput,
      starterFiles: [
        { path: '../secret.py', content: 'x' },
        ...validDraftInput.starterFiles,
      ],
    });
    expect(traversal.valid).toBe(false);
    expect(
      traversal.issues.some((i) => i.message.includes('Invalid or unsafe')),
    ).toBe(true);

    // Unsupported extension
    const badExt = validateAssessmentDraft({
      ...validDraftInput,
      starterFiles: [
        { path: 'script.sh', content: '#!/bin/bash' },
        ...validDraftInput.starterFiles,
      ],
    });
    expect(badExt.valid).toBe(false);

    // Forbidden test harness file
    const forbidden = validateAssessmentDraft({
      ...validDraftInput,
      starterFiles: [
        { path: 'conftest.py', content: '# hook' },
        ...validDraftInput.starterFiles,
      ],
    });
    expect(forbidden.valid).toBe(false);

    // Duplicate path
    const duplicate = validateAssessmentDraft({
      ...validDraftInput,
      starterFiles: [
        ...validDraftInput.starterFiles,
        { path: 'booking.py', content: '# dupe' },
      ],
    });
    expect(duplicate.valid).toBe(false);
    expect(
      duplicate.issues.some((i) => i.message.includes('Duplicate file path')),
    ).toBe(true);
  });

  it('enforces single-file and total workspace size limits', () => {
    // Single file > 64KB
    const oversizedFile = validateAssessmentDraft({
      ...validDraftInput,
      starterFiles: [
        {
          path: 'booking.py',
          content: 'x'.repeat(MAX_FILE_BYTES + 10),
        },
      ],
    });
    expect(oversizedFile.valid).toBe(false);
    expect(
      oversizedFile.issues.some((i) => i.message.includes('exceeds max size')),
    ).toBe(true);

    // Total size > 128KB
    const chunk = 'a'.repeat(50 * 1024);
    expect(chunk.length * 3).toBeGreaterThan(MAX_TOTAL_BYTES);
    const oversizedTotal = validateAssessmentDraft({
      ...validDraftInput,
      starterFiles: [
        { path: 'booking.py', content: chunk },
        { path: 'file1.txt', content: chunk },
        { path: 'file2.txt', content: chunk },
      ],
    });
    expect(oversizedTotal.valid).toBe(false);
    expect(
      oversizedTotal.issues.some((i) => i.message.includes('Total workspace')),
    ).toBe(true);
  });

  it('validates primary file path constraints', () => {
    // Not ending in .py
    const notPy = validateAssessmentDraft({
      ...validDraftInput,
      primaryFilePath: 'README.md',
    });
    expect(notPy.valid).toBe(false);
    expect(getIssueForField(notPy.issues, 'primaryFilePath')).toMatch(
      /must be a python \(\.py\) file/i,
    );

    // Not present in starter files
    const notIncluded = validateAssessmentDraft({
      ...validDraftInput,
      primaryFilePath: 'missing_service.py',
    });
    expect(notIncluded.valid).toBe(false);
    expect(getIssueForField(notIncluded.issues, 'primaryFilePath')).toMatch(
      /must be included in starter workspace files/i,
    );
  });

  it('requires rubric criteria weights to sum to exactly 100%', () => {
    const invalidSum = validateAssessmentDraft({
      ...validDraftInput,
      rubric: [
        {
          id: 'c1',
          label: 'C1',
          description: 'Desc 1',
          weight: 50,
          applicability: { kind: 'always', rule: 'rule' },
        },
        {
          id: 'c2',
          label: 'C2',
          description: 'Desc 2',
          weight: 40,
          applicability: { kind: 'always', rule: 'rule' },
        },
      ],
    });
    expect(invalidSum.valid).toBe(false);
    expect(getIssueForField(invalidSum.issues, 'rubric')).toMatch(
      /must sum to exactly 100% \(currently 90%\)/i,
    );

    // Non-positive weight
    const nonPositive = validateAssessmentDraft({
      ...validDraftInput,
      rubric: [
        {
          id: 'c1',
          label: 'C1',
          description: 'Desc 1',
          weight: -10,
          applicability: { kind: 'always', rule: 'rule' },
        },
        {
          id: 'c2',
          label: 'C2',
          description: 'Desc 2',
          weight: 110,
          applicability: { kind: 'always', rule: 'rule' },
        },
      ],
    });
    expect(nonPositive.valid).toBe(false);
    expect(
      nonPositive.issues.some((i) => i.message.includes('positive integer')),
    ).toBe(true);
  });
});

describe('R2.11 Content-Integrity Digest and Envelopes', () => {
  it('computes stable, canonical SHA-256 digest regardless of file or rubric order', () => {
    const digestA = computeCanonicalContentDigest(validDraftInput);
    expect(digestA).toMatch(/^[a-f0-9]{64}$/);

    // Reorder starterFiles and rubric
    const reversedDraft: R211AssessmentDraftInput = {
      ...validDraftInput,
      starterFiles: [...validDraftInput.starterFiles].reverse(),
      rubric: [...validDraftInput.rubric].reverse(),
    };
    const digestB = computeCanonicalContentDigest(reversedDraft);
    expect(digestB).toBe(digestA);

    // Any content change changes the digest
    const alteredDraft: R211AssessmentDraftInput = {
      ...validDraftInput,
      title: 'Booking Notification Retry Logic (Updated)',
    };
    const digestC = computeCanonicalContentDigest(alteredDraft);
    expect(digestC).not.toBe(digestA);
  });

  it('builds valid scenario snapshot and rubric envelopes', () => {
    const envelope = buildScenarioSnapshotEnvelope(
      'scenario-custom-001',
      '1.0.0',
      validDraftInput,
    );
    expect(envelope.scenario.id).toBe('scenario-custom-001');
    expect(envelope.scenario.title).toBe(validDraftInput.title);
    expect(envelope.scenario.filePath).toBe('booking.py');
    expect(envelope.workspaceFiles['booking.py']).toBe(
      validDraftInput.starterFiles[0].content,
    );
    expect(envelope.scenario.durationSeconds).toBe(45 * 60);

    const rubricSnapshot = buildTaskRubricSnapshot(validDraftInput);
    expect(rubricSnapshot.version).toBe('r211-rubric-v1');
    expect(rubricSnapshot.criteria).toHaveLength(2);
    expect(rubricSnapshot.criteria[0].weight).toBe(60);
  });
});

describe('R2.11 Presentation Helpers', () => {
  it('formats digest badges correctly', () => {
    expect(formatDigestBadge(null)).toBe('no-digest');
    expect(
      formatDigestBadge(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ),
    ).toBe('sha256:e3b0c44298fc1c14…');
    expect(formatFullDigest('e3b0c442')).toBe('sha256:e3b0c442');
  });

  it('groups issues and extracts field-level messages', () => {
    const issues = [
      { field: 'title', message: 'Title is too short.' },
      { field: 'title', message: 'Title has invalid chars.' },
      { field: 'brief', message: 'Brief is required.' },
    ];
    const grouped = groupValidationIssues(issues);
    expect(grouped['title']).toHaveLength(2);
    expect(grouped['brief']).toHaveLength(1);
    expect(getIssueForField(issues, 'title')).toBe('Title is too short.');
    expect(getIssueForField(issues, 'nonexistent')).toBeUndefined();
  });

  it('escapes HTML and sanitizes builder text', () => {
    expect(escapeHtml('<b class="alert">hello & world</b>')).toBe(
      '&lt;b class=&quot;alert&quot;&gt;hello &amp; world&lt;/b&gt;',
    );
    expect(sanitizeBuilderText('Safe\u0000text\u0007\nNewline\tTab')).toBe(
      'Safetext\nNewline\tTab',
    );
  });
});
