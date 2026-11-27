// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OrgActivationChecklist,
  markOrgActivationFlag,
} from '../../apps/web/app/r23/_components/org-activation-checklist';
import { OrgBenchmarksStrip } from '../../apps/web/app/r23/_components/org-benchmarks-strip';
import { OrgNudgeBanner } from '../../apps/web/app/r23/_components/org-nudge-banner';
import { OrgWebhooksPanel } from '../../apps/web/app/r23/_components/org-webhooks-panel';
import { CandidatesPipelineClient } from '../../apps/web/app/r23/organizations/[organizationId]/candidates/candidates-client';
import { HiringAssessmentBuilderClient } from '../../apps/web/app/r23/organizations/[organizationId]/builder/hiring-assessment-builder-client';
import { serializePlatformTemplates } from '../../apps/web/src/hiring/templates';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Org activation UX, nudges, benchmarks, and candidate respect invite copy', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('auto-ticks OrgActivationChecklist steps from real pipeline counts + local flags and works cleanly on planTier=none', async () => {
    const orgId = '11111111-1111-1111-1111-111111111111';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ problems: [], benchmarks: [] })),
    );

    await act(async () =>
      root.render(
        <OrgActivationChecklist
          organizationId={orgId}
          planTier="none"
          currentRole="cto"
          candidatesCount={0}
          decisionsCount={0}
          savedProblemsCount={0}
        />,
      ),
    );
    await flush();

    expect(
      container.querySelector('[data-testid="org-checklist-progress-pill"]')
        ?.textContent,
    ).toContain('0/5 complete');
    expect(
      container
        .querySelector('[data-step-id="sample"]')
        ?.getAttribute('data-completed'),
    ).toBe('false');
    expect(
      container.querySelector('[data-step-id="invite"]')?.textContent,
    ).toContain('Choose plan to invite');

    // Mark org-scoped sample + preview flags and pass pipeline counts
    markOrgActivationFlag(orgId, 'sampleVisited');
    markOrgActivationFlag(orgId, 'previewVisited');

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(
        <OrgActivationChecklist
          organizationId={orgId}
          planTier="pro"
          currentRole="cto"
          candidatesCount={2}
          decisionsCount={1}
          savedProblemsCount={1}
        />,
      ),
    );
    await flush();

    expect(
      container.querySelector('[data-testid="org-checklist-progress-pill"]')
        ?.textContent,
    ).toContain('5/5 complete');
    for (const stepId of [
      'sample',
      'preview',
      'problem',
      'invite',
      'verdict',
    ]) {
      expect(
        container
          .querySelector(`[data-step-id="${stepId}"]`)
          ?.getAttribute('data-completed'),
      ).toBe('true');
    }

    // Collapsible toggle hides step list while keeping progress pill
    const collapseBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.includes('Collapse'))!;
    await act(async () => collapseBtn.click());
    expect(container.querySelector('.org-checklist-steps')).toBeNull();
    expect(
      container.querySelector('[data-testid="org-checklist-progress-pill"]')
        ?.textContent,
    ).toContain('5/5 complete');
  });

  it('renders Sample Evaluated Candidate (Maya Lin) card and Preview as Candidate in empty candidates state', async () => {
    const orgId = '11111111-1111-1111-1111-111111111111';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/nudges')) return Response.json({ nudges: [] });
        if (url.includes('/health')) {
          return Response.json({ problems: [], benchmarks: [] });
        }
        return Response.json({});
      }),
    );

    await act(async () =>
      root.render(
        <CandidatesPipelineClient
          organizationId={orgId}
          initialCandidates={[]}
          currentRole="cto"
          plan={{
            planTier: 'none',
            candidateCreditsPurchased: 0,
            candidateCreditsUsed: 0,
            candidateCreditsRemaining: null,
            creditedEmails: [],
            updatedAt: null,
          }}
        />,
      ),
    );
    await flush();

    const emptySampleCard = container.querySelector(
      '[data-testid="empty-state-sample-candidate"]',
    );
    expect(emptySampleCard).not.toBeNull();
    expect(emptySampleCard?.textContent).toContain('Maya Lin');
    const links = Array.from(emptySampleCard?.querySelectorAll('a') ?? []).map(
      (a) => ({ text: a.textContent, href: a.getAttribute('href') }),
    );
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Explore sample candidate',
          href: `/r23/organizations/${orgId}/sample-review`,
        }),
        expect.objectContaining({
          text: 'Preview as Candidate',
          href: `/r23/organizations/${orgId}/builder/candidate-preview`,
        }),
      ]),
    );
  });

  it('upgrades builder invitationEmail copy with Candidate Respect details and includes Preview as Candidate CTA', async () => {
    const orgId = '11111111-1111-1111-1111-111111111111';
    const templates = serializePlatformTemplates();

    await act(async () =>
      root.render(
        <HiringAssessmentBuilderClient
          organizationId={orgId}
          currentPrincipalId="principal-cto"
          initialPlan={{
            planTier: 'ultra',
            candidateCreditsPurchased: 0,
            candidateCreditsUsed: 0,
            candidateCreditsRemaining: null,
            creditedEmails: [],
            updatedAt: null,
          }}
          initialLibrary={[]}
          initialTemplates={templates}
          teamMembers={[
            {
              principalId: 'principal-cto',
              displayName: 'Lead CTO',
              email: 'lead@acme.test',
              role: 'cto',
              isOwner: true,
            },
          ]}
        />,
      ),
    );
    await flush();

    const selectTplBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.includes('Preview template'))!;
    await act(async () => selectTplBtn.click());

    const previewCandidateLink = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a'),
    ).find((a) => a.textContent?.includes('Preview as Candidate'));
    expect(previewCandidateLink?.getAttribute('href')).toContain(
      `/r23/organizations/${orgId}/builder/candidate-preview`,
    );

    const inviteStageBtn = container.querySelector(
      '#builder-stage-invite',
    ) as HTMLButtonElement;
    await act(async () => inviteStageBtn.click());

    const emailInput = container.querySelector(
      '#issue-candidate-email',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(emailInput, 'maya@candidate.test');
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/issue')) {
          return Response.json({
            ok: true,
            sessionId: 'sess_respect_1',
            candidateLink: '/r26/candidate/sess_respect_1',
            expiresAt: '2026-12-01T10:00:00Z',
          });
        }
        return Response.json({
          definitionId: 'def-1',
          validatedVersionId: 'ver-1',
        });
      }),
    );

    await act(async () => {
      container
        .querySelector('.hiring-issue-form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    await flush();

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    try {
      const copyEmailBtn = Array.from(
        container.querySelectorAll('button'),
      ).find((b) => b.textContent?.includes('Copy email message'))!;
      await act(async () => copyEmailBtn.click());

      const emailBody = container.querySelector<HTMLTextAreaElement>(
        '#issued-email-message',
      )?.value;
      expect(emailBody).toContain('Time budget:');
      expect(emailBody).toContain('timer starts only after clicking Start');
      expect(emailBody).toContain(
        'zero webcam, microphone, or desktop spyware',
      );
      expect(emailBody).toContain('AI rules are shown upfront');
      expect(emailBody).toContain('Permanent read-only receipt');
      expect(emailBody).toContain('/r26/candidate/sess_respect_1');
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('shows only highest-priority nudge in OrgNudgeBanner and sends x-csrf-token on Snooze', async () => {
    const orgId = '11111111-1111-1111-1111-111111111111';
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(
      '__Host-r23-csrf=csrf_secret_abc',
    );

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Response.json({ ok: true });
      }
      return Response.json({
        nudges: [
          {
            nudgeKey: 'connect_slack_webhook',
            targetRef: '',
            priority: 5,
            title: 'Connect Slack alerts',
            detail: 'Get notified on submissions.',
            ctaLabel: 'Connect Slack',
            ctaHref: `/r23/organizations/${orgId}/settings#webhooks`,
            count: 0,
          },
          {
            nudgeKey: 'unreviewed_submission_48h',
            targetRef: '',
            priority: 1,
            title: '2 submissions waiting >48h',
            detail: 'Fast human feedback improves candidate fairness.',
            ctaLabel: 'Review submissions',
            ctaHref: `/r23/organizations/${orgId}/candidates`,
            count: 2,
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () =>
      root.render(<OrgNudgeBanner organizationId={orgId} />),
    );
    await flush();

    const banner = container.querySelector('[data-testid="org-nudge-banner"]');
    expect(banner?.getAttribute('data-nudge-key')).toBe(
      'unreviewed_submission_48h',
    );
    expect(banner?.textContent).toContain('2 submissions waiting >48h');
    expect(banner?.textContent).not.toContain('Connect Slack alerts');

    const snoozeBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.includes('Snooze 7d'))!;
    await act(async () => snoozeBtn.click());
    await flush();

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    );
    expect(postCall).toBeTruthy();
    expect(
      (postCall?.[1]?.headers as Record<string, string>)['x-csrf-token'],
    ).toBe('csrf_secret_abc');
  });

  it('renders neutral pending benchmark state when platform medians are null in OrgBenchmarksStrip', async () => {
    const orgId = '11111111-1111-1111-1111-111111111111';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          problems: [
            {
              definitionId: 'def-1',
              title: 'Webhook Dedup',
              sourceKind: 'template',
              targetRole: 'Backend Engineer',
              experienceLevel: 'mid',
              durationMinutes: 60,
              issued: 4,
              started: 4,
              submitted: 2,
              completionRatePct: 50,
              medianMinutes: 56,
              executionErrorRatePct: 0,
              avgCandidateRating: 4.5,
              healthFlag: 'time_pressure',
              diagnosticHint:
                'Median time (56m) is near the 60m cap — consider extending to 90m.',
            },
          ],
          benchmarks: [
            {
              targetRole: 'Backend Engineer',
              experienceLevel: 'mid',
              benchmarkScope: 'role_level',
              orgCompletionRatePct: 50,
              orgMedianMinutes: 56,
              platformMedianCompletionRatePct: null,
              platformMedianMinutes: null,
              platformAcceptanceRatePct: null,
              sampleSessions: 4,
            },
          ],
        }),
      ),
    );

    await act(async () =>
      root.render(<OrgBenchmarksStrip organizationId={orgId} />),
    );
    await flush();

    expect(
      container.querySelector('[data-testid="benchmark-pending-note"]')
        ?.textContent,
    ).toContain('Platform benchmark unlocks');
    expect(container.textContent).toContain('Time pressure');
    expect(container.textContent).toContain('Webhook Dedup');
  });

  it('creates a webhook in OrgWebhooksPanel with x-csrf-token and reveals signing secret once', async () => {
    const orgId = '11111111-1111-1111-1111-111111111111';
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(
      '__Host-r23-csrf=csrf_hook_xyz',
    );
    let webhooksState: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const created = {
          id: 'wh-1',
          label: 'Slack Alerts',
          targetUrl: 'https://hooks.slack.com/services/T/B/X',
          payloadMode: 'slack_block_kit',
          eventTypes: ['candidate.submitted', 'verdict.published'],
          signingSecretPrefix: 'whsec_1234',
          isActive: true,
          consecutiveFailures: 0,
          disabledReason: '',
          lastDeliveredAt: null,
          createdAt: '2026-11-27T12:00:00Z',
        };
        webhooksState = [created];
        return Response.json({
          webhook: created,
          signingSecret: 'whsec_1234567890abcdef',
        });
      }
      return Response.json({ webhooks: webhooksState, deliveries: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () =>
      root.render(<OrgWebhooksPanel organizationId={orgId} />),
    );
    await flush();

    const labelInput = container.querySelector(
      '#webhook-label',
    ) as HTMLInputElement;
    const urlInput = container.querySelector(
      '#webhook-url',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(labelInput, 'Slack Alerts');
      labelInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter?.call(urlInput, 'https://hooks.slack.com/services/T/B/X');
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('.org-webhook-create-form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    await flush();

    expect(
      container.querySelector('.org-webhook-secret-value')?.textContent,
    ).toBe('whsec_1234567890abcdef');
    expect(container.textContent).toContain('Slack Alerts');
    const postCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    );
    expect(
      (postCall?.[1]?.headers as Record<string, string>)['x-csrf-token'],
    ).toBe('csrf_hook_xyz');
  });
});
