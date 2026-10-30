// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvaluatorReviewWorkspace } from '../../apps/web/app/evaluator/sessions/[sessionId]/evaluator-review-workspace';
import type { AiInteraction } from '../../apps/web/src/ai/ai-interaction';
import { buildEvaluatorBriefing } from '../../apps/web/src/evaluator/build-evaluator-briefing';
import { buildEvaluatorAiConversations } from '../../apps/web/src/evaluator/evaluator-ai-conversations';
import { buildEvaluatorReviewPresentation } from '../../apps/web/src/evaluator/evaluator-review-presentation';
import {
  briefingDepthProfiles,
  projectBriefing,
} from '../../apps/web/src/evaluator/project-evaluator-briefing';
import type { SessionEvent } from '../../apps/web/src/events/session-event';
import type { EvidenceCatalogEntry } from '../../apps/web/src/reconstruction/evidence-reference-catalog';
import {
  commandEvents,
  noReconstruction,
  testEvidence,
} from '../support/briefing-test-evidence';

const sessionId = 'review-workspace-visual-session';
const events: SessionEvent[] = [
  {
    id: 'prompt-event',
    sessionId,
    sequence: 1,
    type: 'AI_REQUEST_STARTED',
    timestamp: '2026-09-17T00:00:10.000Z',
    source: 'server',
    payload: {
      interactionId: 'recorded-ai-interaction',
      clientRequestId: 'request-1',
      configuredProviderId: 'private-provider',
      configuredModelId: 'private-model',
      candidateInputExcerpt: 'excerpt',
      candidateInputBytes: 1200,
    },
  },
  {
    id: 'response-event',
    sessionId,
    sequence: 2,
    type: 'AI_RESPONSE_COMPLETED',
    timestamp: '2026-09-17T00:00:12.000Z',
    source: 'server',
    payload: {
      interactionId: 'recorded-ai-interaction',
      reportedModelId: 'private-model',
      responseExcerpt: 'response excerpt',
      responseBytes: 1400,
      durationMs: 2000,
    },
  },
  {
    id: 'workspace-event',
    sessionId,
    sequence: 3,
    type: 'WORKSPACE_CHANGED',
    timestamp: '2026-09-17T00:00:13.000Z',
    source: 'server',
    payload: {
      changeId: 'workspace-change-1',
      origin: 'browser_save',
      beforeTree: 'tree-before',
      afterTree: 'tree-after',
      files: [
        {
          path: 'src/cache.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          patchPreview: '+cache = true',
          patchPreviewBytes: 13,
          patchBytes: 13,
          patchTruncated: false,
        },
      ],
      totalAdditions: 1,
      totalDeletions: 0,
    },
  },
];
const sessionEvidence = {
  ...testEvidence(events),
  sessionId,
  closureReason: 'candidate_submission' as const,
  aiCapabilitySnapshot: {
    enabled: true,
    contractVersion: 'v1',
    configurationVersion: 'v1',
    configuredProviderId: 'private-provider',
    configuredModelId: 'private-model',
  },
};
const review = buildEvaluatorReviewPresentation(
  sessionEvidence,
  noReconstruction,
);
const briefing = buildEvaluatorBriefing(sessionEvidence, noReconstruction);
const interactions: AiInteraction[] = [
  {
    id: 'recorded-ai-interaction',
    sessionId,
    clientRequestId: 'request-1',
    status: 'COMPLETED',
    configuredProviderId: 'private-provider',
    configuredModelId: 'private-model',
    candidatePromptText:
      'Full prompt text with a code example:\n```python\nprint(1)\n```',
    capturedResponseText: 'Full assistant response with a suggested example.',
    createdAt: '2026-09-17T00:00:10.000Z',
  },
];
const aiConversations = buildEvaluatorAiConversations(
  review.chronology,
  review.evidenceEntries,
  interactions,
  sessionEvidence.activatedAt,
);

describe('evaluator evidence workbench', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith('/review-workflow')
          ? { sessionId, note: null, clarifications: [], nextStep: null }
          : {
              status: 'pending',
              rubric: null,
              totalScore: null,
              applicableWeight: null,
              scoredWeight: null,
              providerId: null,
              model: null,
              analyzedAt: null,
              criteria: [],
            },
    }));
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    sessionStorage.removeItem(`hirearchy-review-draft:${sessionId}`);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.removeItem(`hirearchy-review-draft:${sessionId}`);
    vi.unstubAllGlobals();
  });

  const flush = () =>
    act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  const renderWorkspace = async (
    profile: (typeof briefingDepthProfiles)[number] = 'GENERALIST_RECRUITER',
    reviewEvidence = sessionEvidence,
    reviewPresentation = review,
    projectedBriefing = projectBriefing(briefing, profile),
    conversations = aiConversations,
  ) => {
    await act(async () =>
      root.render(
        <EvaluatorReviewWorkspace
          sessionId={sessionId}
          evidence={reviewEvidence}
          review={reviewPresentation}
          projection={projectedBriefing}
          activeRole={profile}
          aiConversations={conversations}
        />,
      ),
    );
    await flush();
  };

  it.each(briefingDepthProfiles)(
    '%s keeps full recorded AI text and unsaved notes across workspace modes',
    async (profile) => {
      await renderWorkspace(profile);
      expect(
        container
          .querySelector('.evaluator-workbench')
          ?.getAttribute('data-workbench-mode'),
      ).toBe('summary');
      expect(container.querySelector('#evaluator-tab-overview')).toBeNull();

      const note = container.querySelector<HTMLTextAreaElement>(
        '#reviewer-note-body',
      )!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )?.set;
        setter?.call(note, 'Draft retained across views');
        note.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('#workbench-mode-evidence')
          ?.click();
      });
      expect(
        container.querySelector('[data-note-state="draft"]')?.textContent,
      ).toContain('Draft · unsaved');
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('#evidence-filter-ai-conversations')
          ?.click();
      });

      expect(container.textContent).toContain(
        'Full prompt text with a code example',
      );
      expect(container.textContent).toContain(
        'Full assistant response with a suggested example.',
      );
      expect(container.textContent).toContain('Draft retained across views');
      expect(
        container.querySelector('.evaluator-ai-message-list')?.textContent,
      ).not.toContain('private-provider');
      expect(
        container.querySelector('.evaluator-ai-message-list')?.textContent,
      ).not.toContain('private-model');

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('#workbench-mode-review')
          ?.click();
      });
      expect(
        container.querySelector<HTMLTextAreaElement>('#reviewer-note-body')
          ?.value,
      ).toBe('Draft retained across views');
      expect(
        container.querySelector('[data-note-state="draft"]')?.textContent,
      ).toContain('Draft · unsaved');
      expect(container.querySelectorAll('#review-context-title')).toHaveLength(
        1,
      );
      expect(container.textContent).toContain(
        'Review notes are session-level and are not linked to this source.',
      );
    },
  );

  it('filters the chronological source model and preserves the selected record', async () => {
    await renderWorkspace();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#workbench-mode-evidence')
        ?.click();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#evidence-filter-code-changes')
        ?.click();
    });
    const workspaceRow = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.evaluator-source-row'),
    ).find((row) => row.textContent?.includes('src/cache.ts'));
    expect(workspaceRow).not.toBeNull();
    await act(async () => workspaceRow?.click());
    const selectedRef = workspaceRow?.dataset.sourceRef;
    expect(
      container
        .querySelector('.evaluator-source-inspector')
        ?.getAttribute('data-source-ref'),
    ).toBe(selectedRef);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#evidence-filter-terminal')
        ?.click();
    });
    expect(container.textContent).toContain(
      'No terminal records are available',
    );
    expect(container.textContent).toContain('Selected outside this filter');
    expect(
      container
        .querySelector('.evaluator-source-inspector')
        ?.getAttribute('data-source-ref'),
    ).toBe(selectedRef);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#evidence-filter-chronology')
        ?.click();
    });
    expect(
      container
        .querySelector('.evaluator-source-inspector')
        ?.getAttribute('data-source-ref'),
    ).toBe(selectedRef);
    expect(
      container.querySelector(
        `.evaluator-source-row[data-source-ref="${selectedRef}"]`,
      ),
    ).not.toBeNull();
  });

  it('keeps an authorized source unavailable when its linked item is missing while other records stay selectable', async () => {
    const missingReference = `event:${sessionId}:missing-linked-source`;
    const missingEntry: EvidenceCatalogEntry = {
      evidenceRef: missingReference,
      sessionId,
      role: 'chronology',
      kind: 'workspace_change',
      chronologyOrder: 10,
      firstSequence: 10,
      lastSequence: 10,
      rawEventIds: ['missing-linked-source-event'],
      item: null,
    };
    const reviewWithMissingEntry = {
      ...review,
      evidenceEntries: [...review.evidenceEntries, missingEntry],
    };

    await renderWorkspace('ENGINEER', sessionEvidence, reviewWithMissingEntry);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#workbench-mode-evidence')
        ?.click();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#evidence-filter-code-changes')
        ?.click();
    });

    const missingRow = container.querySelector<HTMLButtonElement>(
      `.evaluator-source-row[data-source-ref="${missingReference}"]`,
    );
    expect(missingRow).not.toBeNull();
    await act(async () => missingRow?.click());
    const output = container.querySelector(
      '.evaluator-source-inspector-output',
    );
    expect(output?.textContent).toContain(
      'The source record is unavailable in the authorized evidence provided for this session.',
    );
    expect(output?.querySelector('.activity-card')).toBeNull();

    const validRow = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '.evaluator-source-row[data-source-ref^="event:"]',
      ),
    ).find((row) => row.dataset.sourceRef !== missingReference);
    expect(validRow).not.toBeNull();
    await act(async () => validRow?.click());
    expect(
      container
        .querySelector('[data-source-inspector="true"]')
        ?.getAttribute('data-source-ref'),
    ).toBe(validRow?.dataset.sourceRef);
    expect(
      container.querySelector('.evaluator-source-inspector-output')
        ?.textContent,
    ).toContain('Workspace change');
    expect(
      container.querySelector(
        '.evaluator-source-inspector-output .activity-card',
      ),
    ).not.toBeNull();
  });

  it.each([
    {
      label: 'unknown capability',
      evidence: {
        ...testEvidence([]),
        sessionId,
        closureReason: 'candidate_submission' as const,
      },
      expected: 'AI capture was not available for this session version.',
    },
    {
      label: 'disabled capability',
      evidence: {
        ...testEvidence([]),
        sessionId,
        closureReason: 'candidate_submission' as const,
        aiCapabilitySnapshot: {
          enabled: false,
          contractVersion: 'v1',
          configurationVersion: 'v1',
          configuredProviderId: null,
          configuredModelId: null,
        },
      },
      expected: 'Integrated AI capability was disabled for this assessment.',
    },
  ])(
    'keeps $label distinct from an empty AI conversation list',
    async ({ evidence: value, expected }) => {
      const presentation = buildEvaluatorReviewPresentation(
        value,
        noReconstruction,
      );
      const projected = projectBriefing(
        buildEvaluatorBriefing(value, noReconstruction),
        'GENERALIST_RECRUITER',
      );
      await renderWorkspace(
        'GENERALIST_RECRUITER',
        value,
        presentation,
        projected,
        [],
      );
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('#workbench-mode-evidence')
          ?.click();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('#evidence-filter-ai-conversations')
          ?.click();
      });
      expect(container.textContent).toContain(expected);
      expect(container.textContent).toContain(
        'This does not establish that no external AI occurred.',
      );
      expect(
        container.querySelector(
          '.evaluator-source-list[aria-label="AI conversations evidence"]',
        ),
      ).toBeNull();
    },
  );

  it('puts recorded output first and keeps capture status separate from test and command outcomes', async () => {
    const terminalEvents = commandEvents('pytest', {
      exitCode: 1,
      stdoutPreview: 'short output',
      stdoutBytes: 400,
      stdoutTruncated: true,
    }).map((event) => ({ ...event, sessionId }));
    const terminalEvidence = {
      ...testEvidence(terminalEvents),
      sessionId,
      closureReason: 'candidate_submission' as const,
    };
    const terminalReview = buildEvaluatorReviewPresentation(
      terminalEvidence,
      noReconstruction,
    );
    const terminalBriefing = buildEvaluatorBriefing(
      terminalEvidence,
      noReconstruction,
    );
    await renderWorkspace(
      'GENERALIST_RECRUITER',
      terminalEvidence,
      terminalReview,
      projectBriefing(terminalBriefing, 'GENERALIST_RECRUITER'),
      [],
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#workbench-mode-evidence')
        ?.click();
      container
        .querySelector<HTMLButtonElement>('#evidence-filter-terminal')
        ?.click();
    });
    expect(container.textContent).toContain('short output');
    const inspector = container.querySelector('.evaluator-source-inspector');
    const status = inspector?.querySelector('.evaluator-source-status');
    expect(status?.textContent).toContain('Truncated');
    expect(status?.getAttribute('aria-label')).toBe(
      'Capture status: Truncated',
    );
    expect(inspector?.textContent).toContain('Test result');
    expect(inspector?.textContent).toContain('Command outcome · Exit status 1');
    expect(
      inspector
        ?.querySelector('.evaluator-source-inspector-output')
        ?.compareDocumentPosition(
          inspector.querySelector('.evaluator-source-details')!,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('provides copy feedback for the selected engineer evidence reference', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      clipboard: { writeText },
    });
    await renderWorkspace('ENGINEER');
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#workbench-mode-evidence')
        ?.click();
    });
    const details = container.querySelector<HTMLDetailsElement>(
      '.evaluator-source-details',
    );
    expect(details).not.toBeNull();
    if (details) details.open = true;
    const reference = details?.querySelector('dd code')?.textContent;
    expect(reference).toBeTruthy();
    await act(async () => {
      details
        ?.querySelector<HTMLButtonElement>(
          '[aria-label="Copy evidence reference"]',
        )
        ?.click();
    });
    expect(writeText).toHaveBeenCalledWith(reference);
    expect(details?.querySelector('[role="status"]')?.textContent).toBe(
      'Evidence reference copied.',
    );

    vi.stubGlobal('navigator', {});
    await act(async () => {
      details
        ?.querySelector<HTMLButtonElement>(
          '[aria-label="Copy evidence reference"]',
        )
        ?.click();
    });
    expect(details?.querySelector('[role="status"]')?.textContent).toContain(
      'Select the reference above to copy it.',
    );

    const unavailable = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', {
      clipboard: { writeText: unavailable },
    });
    await act(async () => {
      details
        ?.querySelector<HTMLButtonElement>(
          '[aria-label="Copy evidence reference"]',
        )
        ?.click();
    });
    expect(details?.querySelector('[role="status"]')?.textContent).toContain(
      'Select the reference above to copy it.',
    );
  });

  it('routes narrower quick-note requests to Review and focuses the note field', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, media: '(max-width: 1199px)' })),
    );
    await renderWorkspace();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('#open-quick-note')?.click();
    });
    await flush();
    expect(
      container
        .querySelector('.evaluator-workbench')
        ?.getAttribute('data-workbench-mode'),
    ).toBe('review');
    expect(document.activeElement).toBe(
      container.querySelector('#reviewer-note-body'),
    );
  });

  it('focuses a full-screen source, navigates in the active filter, and restores row focus', async () => {
    const mql = {
      matches: true,
      media: '(max-width: 767px)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => mql),
    );
    await renderWorkspace('ENGINEER');
    const summarySource = container.querySelector<HTMLButtonElement>(
      '.workbench-progression-list .evaluator-text-link',
    );
    expect(summarySource).not.toBeNull();
    await act(async () => summarySource?.click());
    expect(
      container.querySelector('[role="dialog"][aria-modal="true"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('.evaluator-workbench')
        ?.getAttribute('data-workbench-mode'),
    ).toBe('evidence');
    const summarySourceRef = container
      .querySelector('[data-source-inspector="true"]')
      ?.getAttribute('data-source-ref');
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#mobile-inspector-back')
        ?.click();
    });
    await flush();
    const summarySourceRow = container.querySelector<HTMLButtonElement>(
      `.evaluator-source-row[data-source-ref="${summarySourceRef}"]`,
    );
    expect(document.activeElement).toBe(summarySourceRow);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#workbench-mode-review')
        ?.click();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#review-context-open-source')
        ?.click();
    });
    const reviewOpenedInspector = container.querySelector(
      '[data-source-inspector="true"]',
    );
    expect(reviewOpenedInspector).not.toBeNull();
    expect(reviewOpenedInspector?.getAttribute('data-source-ref')).toBe(
      summarySourceRef,
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#mobile-inspector-back')
        ?.click();
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#evidence-filter-code-changes')
        ?.click();
    });
    const rows = container.querySelectorAll<HTMLButtonElement>(
      '.evaluator-evidence-list-panel > .evaluator-source-list > li > .evaluator-source-row',
    );
    expect(rows.length).toBeGreaterThan(1);
    await act(async () => rows[0].click());
    expect(
      container.querySelector('[role="dialog"][aria-modal="true"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('.evaluator-workbench-shell')
        ?.hasAttribute('inert'),
    ).toBe(true);
    const initialRef = container
      .querySelector('[data-source-inspector="true"]')
      ?.getAttribute('data-source-ref');
    expect(initialRef).toBe(rows[0].dataset.sourceRef);

    const completeRecordSummary = Array.from(
      container.querySelectorAll<HTMLElement>(
        '.evaluator-mobile-inspector details > summary',
      ),
    ).find((summary) =>
      summary.textContent?.includes('Open complete technical record'),
    );
    expect(completeRecordSummary).toBeDefined();
    completeRecordSummary?.focus();
    const tabFromSummary = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => window.dispatchEvent(tabFromSummary));
    expect(tabFromSummary.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(
      container.querySelector('#mobile-inspector-back'),
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#mobile-inspector-next')
        ?.click();
    });
    const nextRef = container
      .querySelector('[data-source-inspector="true"]')
      ?.getAttribute('data-source-ref');
    expect(nextRef).not.toBe(initialRef);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('#mobile-inspector-back')
        ?.click();
    });
    await flush();
    const selectedRow = container.querySelector<HTMLButtonElement>(
      `.evaluator-source-row[data-source-ref="${nextRef}"]`,
    );
    expect(document.activeElement).toBe(selectedRow);

    await act(async () => selectedRow?.click());
    await act(async () => {
      container
        .querySelector('[role="dialog"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
