// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HiringDecisionPanel } from '../../apps/web/app/evaluator/sessions/[sessionId]/hiring-decision-panel';
import type { SessionHiringReviewContext } from '../../apps/web/src/hiring/types';
import type { R27AiReviewReport } from '../../apps/web/src/r27-evidence/ai-review-contract';

function makeContext(
  overrides: Partial<SessionHiringReviewContext> = {},
): SessionHiringReviewContext {
  return {
    organizationId: '11111111-1111-1111-1111-111111111111',
    organizationName: 'Acme Craft',
    sessionId: 'sess_peer_ui_1',
    scenarioTitle: 'Reservation Moves',
    candidateEmail: 'nadia@candidate.test',
    candidateName: 'Nadia Hassan',
    candidateCode: 'CAND-1024',
    targetRole: 'Senior Backend Engineer',
    experienceLevel: 'senior',
    skills: ['Python', 'PostgreSQL'],
    currentPrincipalId: 'principal-lead',
    currentRole: 'reviewer',
    canPublishDecision: true,
    plan: {
      planTier: 'ultra',
      planStatus: 'active',
      candidateCreditsPurchased: 0,
      candidateCreditsUsed: 0,
      candidateCreditsRemaining: null,
      creditedEmails: [],
    },
    teamMembers: [
      {
        principalId: 'principal-recruiter',
        displayName: 'Sarah Chen',
        email: 'sarah@acme.test',
        role: 'recruiter',
        isOwner: true,
      },
      {
        principalId: 'principal-lead',
        displayName: 'Marcus Vance',
        email: 'marcus@acme.test',
        role: 'reviewer',
        isOwner: false,
      },
    ],
    decision: null,
    secondOpinions: [],
    ...overrides,
  };
}

describe('HiringDecisionPanel team peer review UX', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    document.cookie = '__Host-r23-csrf=test-csrf-token; path=/';
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('requires a human choice and restores notes from an older draft', async () => {
    const context = makeContext({ sessionId: 'sess_decision_choice' });
    const legacyKey = `hirearchy:eval:decision-draft:v1:${context.sessionId}`;
    const draftKey = `hirearchy:eval:decision-draft:v2:${context.sessionId}`;
    window.sessionStorage.setItem(
      legacyKey,
      JSON.stringify({
        decision: 'accepted',
        internalNotes: 'Review edge cases',
      }),
    );
    try {
      await act(async () =>
        root.render(<HiringDecisionPanel initialContext={context} />),
      );
      const choose = (label: string) =>
        Array.from(
          container.querySelectorAll<HTMLButtonElement>('button'),
        ).find((button) => button.textContent?.trim() === label)!;
      expect(choose('Advance candidate').getAttribute('aria-pressed')).toBe(
        'false',
      );
      expect(choose('Reject candidate').getAttribute('aria-pressed')).toBe(
        'false',
      );
      expect(choose('Publish decision').disabled).toBe(true);
      expect(
        container.querySelector<HTMLTextAreaElement>('#decision-internal-notes')
          ?.value,
      ).toBe('Review edge cases');
      await act(async () => choose('Advance candidate').click());
      expect(choose('Publish acceptance').disabled).toBe(false);
      expect(
        JSON.parse(window.sessionStorage.getItem(draftKey)!).decision,
      ).toBe('accepted');
    } finally {
      window.sessionStorage.removeItem(legacyKey);
      window.sessionStorage.removeItem(draftKey);
    }
  });

  it('surfaces an assigned peer review spotlight card with shared context and submits verdict without requiring final decision', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      expect(payload.action).toBe('respond_second_opinion');
      expect(payload.opinionId).toBe('op-pending-1');
      expect(payload.verdict).toBe('approve');
      expect(payload.responseNote).toBe('Concurrency lock looks solid.');

      return Response.json({
        reviewContext: makeContext({
          secondOpinions: [
            {
              id: 'op-pending-1',
              sessionId: 'sess_peer_ui_1',
              requestedByPrincipalId: 'principal-recruiter',
              requestedByName: 'Sarah Chen',
              requestedByEmail: 'sarah@acme.test',
              requestedReviewerPrincipalId: 'principal-lead',
              requestedReviewerName: 'Marcus Vance',
              requestedReviewerEmail: 'marcus@acme.test',
              status: 'completed',
              verdict: 'approve',
              requestNote: 'Check locking around concurrent retries.',
              responseNote: 'Concurrency lock looks solid.',
              createdAt: '2026-11-21T10:00:00Z',
              respondedAt: '2026-11-21T10:15:00Z',
            },
          ],
        }),
        emailDelivery: {
          status: 'sent',
          recipientEmail: 'sarah@acme.test',
          inboxUrl: '/r23/mail?email=sarah%40acme.test',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const onOpenEvidence = vi.fn();

    await act(async () => {
      root.render(
        <HiringDecisionPanel
          initialContext={makeContext({
            secondOpinions: [
              {
                id: 'op-pending-1',
                sessionId: 'sess_peer_ui_1',
                requestedByPrincipalId: 'principal-recruiter',
                requestedByName: 'Sarah Chen',
                requestedByEmail: 'sarah@acme.test',
                requestedReviewerPrincipalId: 'principal-lead',
                requestedReviewerName: 'Marcus Vance',
                requestedReviewerEmail: 'marcus@acme.test',
                status: 'pending',
                verdict: null,
                requestNote: 'Check locking around concurrent retries.',
                requestContext: {
                  evaluatorStrengths: ['Clean decomposition'],
                  aiAdvisory: {
                    headline: 'Solid implementation',
                    score: 86,
                    verdictLabel: 'Should Accept',
                    rationale: 'Tests cover main concurrency paths.',
                    providerLabel: 'Kimi K3.1 Pro',
                  },
                },
                responseNote: '',
                createdAt: '2026-11-21T10:00:00Z',
                respondedAt: null,
              },
            ],
          })}
          initialPeerReviewId="op-pending-1"
          onOpenEvidence={onOpenEvidence}
        />,
      );
    });

    const spotlight = container.querySelector(
      '[data-testid="peer-review-action-card"]',
    );
    expect(spotlight).not.toBeNull();
    expect(spotlight?.textContent).toContain(
      'Sarah Chen asked for your peer review',
    );
    expect(spotlight?.textContent).toContain('Advisory AI · Should Accept');

    const codeJumpBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Inspect code changes'),
    );
    await act(async () => {
      codeJumpBtn?.click();
    });
    expect(onOpenEvidence).toHaveBeenCalledWith('Code changes');

    const approveBtn = container.querySelector<HTMLButtonElement>(
      '.hiring-verdict-approve',
    );
    expect(approveBtn).not.toBeNull();
    await act(async () => {
      approveBtn?.click();
    });

    const textarea = container.querySelector<HTMLTextAreaElement>(
      '#peer-response-op-pending-1',
    );
    expect(textarea).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, 'Concurrency lock looks solid.');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submitBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Submit peer review'),
    );
    await act(async () => {
      submitBtn?.click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      'Peer review submitted and emailed back to sarah@acme.test',
    );
    expect(container.textContent).toContain('Approved');
    expect(
      container.querySelector('[data-testid="peer-review-action-card"]'),
    ).toBeNull();
  });

  it('attaches advisory AI review summary when requesting a peer review', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<
          string,
          unknown
        >;
        return Response.json({
          reviewContext: makeContext({
            currentPrincipalId: 'principal-recruiter',
            secondOpinions: [
              {
                id: 'op-created-1',
                sessionId: 'sess_peer_ui_1',
                requestedByPrincipalId: 'principal-recruiter',
                requestedByName: 'Sarah Chen',
                requestedByEmail: 'sarah@acme.test',
                requestedReviewerPrincipalId: 'principal-lead',
                requestedReviewerName: 'Marcus Vance',
                requestedReviewerEmail: 'marcus@acme.test',
                status: 'pending',
                verdict: null,
                requestNote: 'Second look on retries',
                responseNote: '',
                createdAt: '2026-11-21T10:00:00Z',
                respondedAt: null,
              },
            ],
          }),
          emailDelivery: {
            status: 'sent',
            recipientEmail: 'marcus@acme.test',
            inboxUrl: '/r23/mail?email=marcus%40acme.test',
          },
        });
      }),
    );

    const mockAiReport: R27AiReviewReport = {
      sessionId: 'sess_peer_ui_1',
      organizationId: '11111111-1111-1111-1111-111111111111',
      score: 88,
      verdict: 'accept',
      verdictLabel: 'Should Accept',
      confidenceLabel: 'High Confidence',
      headline: 'Clear concurrency handling',
      rationale: 'Clean diff with explicit regression tests.',
      strengths: ['Clean diff'],
      weaknesses: [],
      evidenceHighlights: [],
      metrics: {
        submittedFilesCount: 4,
        modifiedFilesCount: 2,
        linesAdded: 40,
        linesRemoved: 8,
        timelineEventsCount: 12,
        saveEventsCount: 5,
      },
      provider: {
        providerId: 'nvidia',
        modelId: 'moonshotai/kimi-k3.1-pro',
        label: 'NVIDIA NIM · Kimi K3.1 Pro',
        mode: 'live_ai',
      },
      generatedAt: '2026-11-21T09:55:00Z',
    };

    await act(async () => {
      root.render(
        <HiringDecisionPanel
          initialContext={makeContext({
            currentPrincipalId: 'principal-recruiter',
          })}
          aiReviewReport={mockAiReport}
        />,
      );
    });

    const form = container.querySelector(
      '[data-testid="team-peer-review-panel"] form',
    );
    expect(form).not.toBeNull();
    await act(async () => {
      form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody?.action).toBe('request_second_opinion');
    expect(capturedBody?.reviewerPrincipalId).toBe('principal-lead');
    expect(capturedBody?.requestContext).toMatchObject({
      aiAdvisory: {
        headline: 'Clear concurrency handling',
        score: 88,
        verdictLabel: 'Should Accept',
      },
    });
    expect(container.textContent).toContain('Open Local Inbox');
  });
});
