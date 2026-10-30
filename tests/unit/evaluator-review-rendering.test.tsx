import type { CommandExecutionItem } from '../../apps/web/src/evidence/chronological-reconstruction';
import { EvidenceItemCard } from '../../apps/web/app/evaluator/sessions/[sessionId]/evidence-item-card';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  SubmittedDiff,
  submittedChangesAnchor,
} from '../../apps/web/app/evaluator/sessions/[sessionId]/submitted-diff';
import { SubmittedWork } from '../../apps/web/app/evaluator/sessions/[sessionId]/submitted-work';
import { TechnicalRecord } from '../../apps/web/app/evaluator/sessions/[sessionId]/technical-record';
import type { EvaluatorReviewPresentation } from '../../apps/web/src/evaluator/evaluator-review-presentation';
import type { EvidenceCatalogEntry } from '../../apps/web/src/reconstruction/evidence-reference-catalog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const activationEntry: EvidenceCatalogEntry = {
  evidenceRef: 'session:one:activated',
  sessionId: 'one',
  role: 'chronology',
  kind: 'activation',
  chronologyOrder: 0,
  firstSequence: null,
  lastSequence: null,
  rawEventIds: [],
  item: {
    kind: 'SESSION_ACTIVATED',
    timestamp: '2026-09-16T10:00:00.000Z',
  },
};

const review: EvaluatorReviewPresentation = {
  session: {
    id: 'one',
    assessment: 'scenario · v1',
    scenarioTitle: 'Scenario',
    scenarioVersion: '1',
    status: 'Submitted',
    duration: '2m',
    submittedAt: '2026-09-16T10:02:00.000Z',
    closureReason: 'candidate_submission',
  },
  scenario: {
    context: {
      schemaVersion: 1,
      version: '1',
      purpose: 'Organize the recorded evidence for review.',
      evidenceAreas: [
        {
          id: 'area',
          title: 'Relevant activity',
          description: 'Recorded activity related to the scenario.',
          selectors: [],
        },
      ],
      systemInvariants: ['The submitted state is authoritative.'],
      verificationTargets: ['Review recorded verification where available.'],
      interpretationWarnings: ['Related evidence is not a candidate verdict.'],
      reviewPolicy: [
        'Final automated verification alone is not a hiring decision.',
      ],
    },
    relatedEvidence: [
      {
        id: 'area',
        title: 'Relevant activity',
        description: 'Recorded activity related to the scenario.',
        evidenceRefs: ['session:one:activated'],
      },
    ],
  },
  notices: [],
  summary: {
    status: 'available',
    retryAllowed: false,
    milestones: [
      {
        id: 'statement',
        kind: 'recorded_activity',
        label: 'Recorded activity',
        text: 'The session was activated.',
        elapsedLabel: '+0s',
        evidenceRefs: ['session:one:activated'],
      },
    ],
  },
  chronology: [activationEntry.item!],
  evidenceEntries: [activationEntry],
  submittedDiff: '',
};

describe('evaluator review rendering', () => {
  it.each([
    [true, false],
    [false, true],
    [true, true],
    [false, false],
  ])(
    'discloses stdout=%s and stderr=%s preview truncation separately',
    (stdoutTruncated, stderrTruncated) => {
      const item: CommandExecutionItem = {
        kind: 'COMMAND_EXECUTION',
        commandId: 'cmd',
        command: 'cat file',
        cwd: '/workspace',
        startedAt: '2026-09-16T10:00:00Z',
        finishedAt: '2026-09-16T10:00:01Z',
        durationMs: 1000,
        exitCode: 0,
        timedOut: false,
        stdoutPreview: 'output',
        stderrPreview: 'diagnostic',
        rawStartedEventId: 'start',
        rawFinishedEventId: 'finish',
        sequence: 1,
        rawFinishedEvent: {
          id: 'finish',
          sessionId: 'one',
          sequence: 2,
          type: 'COMMAND_FINISHED',
          timestamp: '2026-09-16T10:00:01Z',
          source: 'server',
          payload: {
            commandId: 'cmd',
            exitCode: 0,
            timedOut: false,
            durationMs: 1000,
            stdoutPreview: 'output',
            stdoutBytes: 100,
            stdoutTruncated,
            stderrPreview: 'diagnostic',
            stderrBytes: 100,
            stderrTruncated,
          },
        },
      };
      const html = renderToStaticMarkup(<EvidenceItemCard item={item} />);
      expect(
        html.includes(
          'Standard output is a captured preview. Additional output was omitted.',
        ),
      ).toBe(stdoutTruncated);
      expect(
        html.includes(
          'Standard error is a captured preview. Additional output was omitted.',
        ),
      ).toBe(stderrTruncated);
      expect(html).not.toMatch(/stdoutTruncated|stderrTruncated|role="alert"/);
      expect(html).toContain('Exit status 0');
    },
  );

  it('links a truncated compact diff to the stable submitted-changes anchor with exactly one rendered target', () => {
    const longDiff = Array.from(
      { length: 90 },
      (_, index) => `+line ${index}`,
    ).join('\n');
    const compactHtml = renderToStaticMarkup(
      <SubmittedDiff compact diff={longDiff} />,
    );

    expect(compactHtml).toContain(`href="#${submittedChangesAnchor}"`);
    expect(compactHtml).toContain('View full submitted changes →');
    expect(compactHtml).not.toContain('additional lines');

    const surfaceHtml = renderToStaticMarkup(
      <div className="evaluator-review-surface">
        <SubmittedWork
          diff={longDiff}
          submittedState={{
            status: 'available',
            changedPaths: ['src/index.ts'],
            fileCount: 1,
            additions: 90,
            deletions: 0,
            text: 'The submission includes changes to 1 file.',
            source: {
              authority: 'final_diff',
              fieldRef: 'session:one:diff',
              sha256: 'a'.repeat(64),
              bytes: 1000,
            },
          }}
        />
      </div>,
    );

    expect(surfaceHtml).toMatch(
      new RegExp(`<section[^>]*\\bid=["']${submittedChangesAnchor}["']`),
    );
    const anchorMatches =
      surfaceHtml.match(
        new RegExp(`\\bid=["']${submittedChangesAnchor}["']`, 'g'),
      ) ?? [];
    expect(anchorMatches).toHaveLength(1);
  });

  it('renders diff semantics in text as well as color', () => {
    const html = renderToStaticMarkup(
      <SubmittedDiff diff={'--- a/file.ts\n+++ b/file.ts\n-old\n+new'} />,
    );

    expect(html).toContain('aria-label="Submitted code changes"');
    expect(html).toContain('Deleted line:');
    expect(html).toContain('Added line:');
    expect(html).toContain('-old');
    expect(html).toContain('+new');
    expect(html).toContain('tabindex="0"');
  });

  it('renders explicit affordances for technical and raw-record disclosures', () => {
    const html = renderToStaticMarkup(
      <TechnicalRecord
        activatedAt="2026-09-16T10:00:00.000Z"
        review={review}
      />,
    );

    expect(html).toContain('Open technical chronology');
    expect(html).toContain('Inspect raw records');
    expect(html.match(/class="disclosure-chevron"/g)).toHaveLength(2);
    expect(html.match(/<details/g)).toHaveLength(2);
  });

  it('verifies accessibility contracts for disclosures, scrollable code regions, and stylesheets', () => {
    // 1. Semantic focusable disclosure markup and classes
    const disclosureHtml = renderToStaticMarkup(
      <TechnicalRecord
        activatedAt="2026-09-16T10:00:00.000Z"
        review={review}
      />,
    );
    expect(disclosureHtml).toMatch(
      /<details[^>]*class="[^"]*review-disclosure/,
    );
    expect(disclosureHtml).toMatch(/<summary[^>]*>/);
    expect(disclosureHtml).toContain('class="disclosure-chevron"');
    expect(disclosureHtml).toContain('aria-hidden="true"');

    // 2. Scrollable diff regions provide keyboard accessibility
    const diffHtml = renderToStaticMarkup(
      <SubmittedDiff diff={'--- a/file.ts\n+++ b/file.ts\n-old\n+new'} />,
    );
    expect(diffHtml).toContain('tabindex="0"');
    expect(diffHtml).toContain('aria-label="Submitted code changes"');

    // 3. Stylesheet contracts: responsive breakpoints and reduced-motion declarations
    const styles = readFileSync(
      path.join(process.cwd(), 'apps/web/app/workspace.css'),
      'utf8',
    );
    const globalStyles = readFileSync(
      path.join(process.cwd(), 'apps/web/app/styles.css'),
      'utf8',
    );

    expect(styles).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(styles).toContain('@media (max-width: 900px)');
    expect(styles).toContain('@media (max-width: 620px)');
    expect(styles).toContain('overflow-x: auto');
    expect(styles).toMatch(
      /details\[open\]\s*>\s*summary\s*>\s*\.disclosure-chevron/,
    );
    expect(globalStyles).toMatch(/:focus-visible\s*\{[^}]*outline:/);
    expect(styles).toMatch(
      /@media \(min-width: 70rem\)[\s\S]*max-height: calc\(100dvh - 2rem\);[\s\S]*overflow-y: auto;/,
    );
    expect(styles).toMatch(
      /\.engineer-evidence-workspace[\s\S]*grid-template-columns: minmax\(0, 1.25fr\) minmax\(20rem, 0.75fr\)/,
    );
    expect(styles).toMatch(
      /\.evidence-toggle-button\s*\{[^}]*min-height: 2.5rem;/,
    );
  });

  it('keeps reconciled evaluator styles canonical and Candidate-safe', () => {
    const styles = readFileSync(
      path.join(process.cwd(), 'apps/web/app/workspace.css'),
      'utf8',
    );

    expect(styles).not.toContain('/* E6 — evaluator visual polish');
    expect(styles).toMatch(
      /\.evaluator-v2-container\s*\{[^}]*gap: clamp\(2.5rem, 5vw, 4.5rem\);/,
    );
    expect(styles).not.toContain('.lens-tab');
    expect(styles).toMatch(
      /\.evaluator-v2-container \.activity-excerpt\s*\{[^}]*scrollbar-color:/,
    );
    expect(styles).toMatch(
      /\.evaluator-v2-container \.activity-excerpt\.error-excerpt\s*\{[^}]*background: var\(--notice-bg\);/,
    );
  });
});
