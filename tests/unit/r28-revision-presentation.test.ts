import { describe, expect, it } from 'vitest';

import type { R28CandidateRevision } from '../../database/postgres/r28/contract.mjs';
import { r28IsEnabled } from '../../apps/web/src/r28-revisions/config';
import {
  buildR28RevisionPresentation,
  diffWithPrevious,
  diffWithStarter,
  diffWithSubmitted,
  escapeHtml,
  normalizeLineEndings,
} from '../../apps/web/src/r28-revisions/presentation';

const createRevision = (
  overrides: Partial<R28CandidateRevision> = {},
): R28CandidateRevision => ({
  organizationId: '11111111-1111-4111-8111-111111111111',
  sessionId: 'sess_123e4567-e89b-42d3-a456-426614174000',
  filePath: 'bookings/service.py',
  version: '2',
  requestId: 'req-save-2',
  eventSequence: '9007199254740995',
  acceptedAt: '2026-10-26T10:05:00.000Z',
  contentEncoding: 'utf-8',
  content: 'def send_notification():\n    return send_retry(attempts=2)\n',
  contentLength: 60,
  contentDigest: 'digest-v2',
  previousVersion: '1',
  previousDigest: 'digest-v1',
  previousContent:
    'def send_notification():\n    return send_retry(attempts=1)\n',
  starterContent: 'def send_notification():\n    return send_immediate()\n',
  submittedContent:
    'def send_notification():\n    return send_retry(attempts=3)\n',
  isSubmitted: false,
  availability: 'available',
  provenance: 'hirearchy.candidate_file_revisions',
  ...overrides,
});

describe('R2.8 Candidate Revision Presentation', () => {
  describe('Diff generation', () => {
    it('generates accurate diff with previous revision (v[n-1] -> v[n])', () => {
      const revision = createRevision();
      const diff = diffWithPrevious(revision);

      expect(diff).not.toBeNull();
      expect(diff).toContain('--- a/bookings/service.py\tversion 1');
      expect(diff).toContain('+++ b/bookings/service.py\tversion 2');
      expect(diff).toContain('-    return send_retry(attempts=1)');
      expect(diff).toContain('+    return send_retry(attempts=2)');
    });

    it('generates accurate diff with starter baseline (starter -> v[n])', () => {
      const revision = createRevision();
      const diff = diffWithStarter(revision);

      expect(diff).not.toBeNull();
      expect(diff).toContain('--- a/bookings/service.py\tstarter baseline');
      expect(diff).toContain('+++ b/bookings/service.py\tversion 2');
      expect(diff).toContain('-    return send_immediate()');
      expect(diff).toContain('+    return send_retry(attempts=2)');
    });

    it('generates accurate diff with submitted code (v[n] -> submitted)', () => {
      const revision = createRevision();
      const diff = diffWithSubmitted(revision);

      expect(diff).not.toBeNull();
      expect(diff).toContain('--- a/bookings/service.py\tversion 2');
      expect(diff).toContain('+++ b/bookings/service.py\tsubmitted');
      expect(diff).toContain('-    return send_retry(attempts=2)');
      expect(diff).toContain('+    return send_retry(attempts=3)');
    });

    it('builds full presentation model for intermediate save', () => {
      const revision = createRevision({ isSubmitted: false, version: '2' });
      const presentation = buildR28RevisionPresentation(revision);

      expect(presentation.statusBadge).toBe('Intermediate save v2');
      expect(presentation.availability).toBe('available');
      expect(presentation.content).toBe(revision.content);
      expect(presentation.notice).toBeNull();
      expect(presentation.hasPrevious).toBe(true);
      expect(presentation.hasStarter).toBe(true);
      expect(presentation.hasSubmitted).toBe(true);
      expect(presentation.diffWithPrevious).toContain(
        '+    return send_retry(attempts=2)',
      );
    });

    it('distinguishes final submitted version badge', () => {
      const revision = createRevision({ isSubmitted: true, version: '3' });
      const presentation = buildR28RevisionPresentation(revision);

      expect(presentation.statusBadge).toBe('Final submitted version');
      expect(presentation.isSubmitted).toBe(true);
    });
  });

  describe('Unavailable historical content presentation', () => {
    it('handles availability: unavailable gracefully with honest notice', () => {
      const unavailableRev = createRevision({
        availability: 'unavailable',
        content: null,
        previousContent: null,
        starterContent: null,
        submittedContent: null,
        provenance: 'hirearchy.candidate_session_events',
      });

      const presentation = buildR28RevisionPresentation(unavailableRev);

      expect(presentation.availability).toBe('unavailable');
      expect(presentation.content).toBeNull();
      expect(presentation.diffWithPrevious).toBeNull();
      expect(presentation.diffWithStarter).toBeNull();
      expect(presentation.diffWithSubmitted).toBeNull();
      expect(presentation.hasPrevious).toBe(false);
      expect(presentation.hasStarter).toBe(false);
      expect(presentation.hasSubmitted).toBe(false);
      expect(presentation.notice).toBe(
        'This save is retained as sequence and digest metadata. Intermediate file content is unavailable.',
      );
      expect(presentation.statusBadge).toBe('Intermediate save v2');
    });

    it('returns null diffs when individual comparison baselines are missing', () => {
      const noPreviousRev = createRevision({ previousContent: null });
      expect(diffWithPrevious(noPreviousRev)).toBeNull();

      const noStarterRev = createRevision({ starterContent: null });
      expect(diffWithStarter(noStarterRev)).toBeNull();

      const noSubmittedRev = createRevision({ submittedContent: null });
      expect(diffWithSubmitted(noSubmittedRev)).toBeNull();
    });

    it('treats content: null as unavailable even if availability flag was available', () => {
      const corruptRev = createRevision({
        availability: 'available',
        content: null,
      });

      const presentation = buildR28RevisionPresentation(corruptRev);
      expect(presentation.availability).toBe('unavailable');
      expect(presentation.content).toBeNull();
      expect(presentation.notice).toContain(
        'Intermediate file content is unavailable',
      );
    });
  });

  describe('Single-file and multi-file scenarios', () => {
    it('presents sequential revisions on a single file cleanly', () => {
      const rev1 = createRevision({
        version: '1',
        previousVersion: '0',
        previousContent: null,
        content: 'line 1\n',
      });
      const rev2 = createRevision({
        version: '2',
        previousVersion: '1',
        previousContent: 'line 1\n',
        content: 'line 1\nline 2\n',
      });
      const rev3 = createRevision({
        version: '3',
        previousVersion: '2',
        previousContent: 'line 1\nline 2\n',
        content: 'line 1\nline 2\nline 3\n',
      });

      const pres1 = buildR28RevisionPresentation(rev1);
      const pres2 = buildR28RevisionPresentation(rev2);
      const pres3 = buildR28RevisionPresentation(rev3);

      expect(pres1.hasPrevious).toBe(false);
      expect(pres1.diffWithPrevious).toBeNull();

      expect(pres2.hasPrevious).toBe(true);
      expect(pres2.diffWithPrevious).toContain('+line 2');

      expect(pres3.hasPrevious).toBe(true);
      expect(pres3.diffWithPrevious).toContain('+line 3');
      expect(pres3.diffWithPrevious).not.toContain('+line 1');
    });

    it('isolates multi-file revision presentation without cross-file leakage', () => {
      const revA = createRevision({
        filePath: 'src/moduleA.ts',
        version: '1',
        content: 'export const a = 1;\n',
        previousContent: null,
      });
      const revB = createRevision({
        filePath: 'src/moduleB.ts',
        version: '1',
        content: 'export const b = 2;\n',
        previousContent: null,
      });

      const presA = buildR28RevisionPresentation(revA);
      const presB = buildR28RevisionPresentation(revB);

      expect(presA.filePath).toBe('src/moduleA.ts');
      expect(presA.content).toContain('a = 1');
      expect(presA.content).not.toContain('b = 2');

      expect(presB.filePath).toBe('src/moduleB.ts');
      expect(presB.content).toContain('b = 2');
      expect(presB.content).not.toContain('a = 1');
    });
  });

  describe('Inert text and boundary edge cases', () => {
    it('escapes HTML special characters for safe untrusted rendering', () => {
      const unsafe = '<script>alert("xss") & \'eval\'</script>';
      const safe = escapeHtml(unsafe);

      expect(safe).toBe(
        '&lt;script&gt;alert(&quot;xss&quot;) &amp; &#39;eval&#39;&lt;/script&gt;',
      );
      expect(safe).not.toContain('<');
      expect(safe).not.toContain('>');
      expect(safe).not.toContain('"');
    });

    it('normalizes CRLF and CR line endings before computing patches', () => {
      const crlfContent = 'line 1\r\nline 2\r\n';
      const lfContent = 'line 1\nline 2\n';
      expect(normalizeLineEndings(crlfContent)).toBe(lfContent);
      expect(normalizeLineEndings('line 1\rline 2\r')).toBe(lfContent);

      const revision = createRevision({
        previousContent: 'line 1\r\nline 2\r\n',
        content: 'line 1\nline 2\nline 3\n',
      });
      const diff = diffWithPrevious(revision);
      expect(diff).not.toBeNull();
      expect(diff).toContain('+line 3');
      // Should not see line 1 or line 2 modified solely due to CRLF difference
      expect(diff).not.toContain('-line 1');
      expect(diff).not.toContain('-line 2');
    });

    it('handles empty content gracefully', () => {
      const emptyRevision = createRevision({
        content: '',
        contentLength: 0,
        previousContent: 'old code\n',
      });
      const presentation = buildR28RevisionPresentation(emptyRevision);

      expect(presentation.availability).toBe('available');
      expect(presentation.content).toBe('');
      expect(presentation.diffWithPrevious).toContain('-old code');
    });

    it('handles identical content without throwing', () => {
      const same = 'const unchanged = true;\n';
      const identicalRev = createRevision({
        previousContent: same,
        content: same,
      });
      const diff = diffWithPrevious(identicalRev);
      expect(diff).not.toBeNull();
      expect(diff).not.toContain('+const unchanged');
      expect(diff).not.toContain('-const unchanged');
    });

    it('handles file paths with spaces and special characters', () => {
      const specialRev = createRevision({
        filePath: 'src/nested dir/[id]/route with spaces.ts',
      });
      const diff = diffWithPrevious(specialRev);
      expect(diff).not.toBeNull();
      expect(diff).toContain('route with spaces.ts');
    });
  });

  describe('Configuration helper', () => {
    it('returns true when HIREARCHY_R28_DISPOSABLE is 1', () => {
      const orig28 = process.env.HIREARCHY_R28_DISPOSABLE;
      const orig27 = process.env.HIREARCHY_R27_DISPOSABLE;
      try {
        process.env.HIREARCHY_R28_DISPOSABLE = '1';
        delete process.env.HIREARCHY_R27_DISPOSABLE;
        expect(r28IsEnabled()).toBe(true);

        delete process.env.HIREARCHY_R28_DISPOSABLE;
        process.env.HIREARCHY_R27_DISPOSABLE = '1';
        expect(r28IsEnabled()).toBe(true);

        delete process.env.HIREARCHY_R28_DISPOSABLE;
        delete process.env.HIREARCHY_R27_DISPOSABLE;
        expect(r28IsEnabled()).toBe(false);
      } finally {
        if (orig28 !== undefined) process.env.HIREARCHY_R28_DISPOSABLE = orig28;
        else delete process.env.HIREARCHY_R28_DISPOSABLE;
        if (orig27 !== undefined) process.env.HIREARCHY_R27_DISPOSABLE = orig27;
        else delete process.env.HIREARCHY_R27_DISPOSABLE;
      }
    });
  });
});
