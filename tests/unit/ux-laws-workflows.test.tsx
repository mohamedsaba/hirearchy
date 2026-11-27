// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  hiringEnabled: true,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: () => mocks.notFoundMock(),
  redirect: (url: string) => mocks.redirectMock(url),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ toString: () => '' })),
}));

vi.mock('../../apps/web/src/runtime/profile', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../apps/web/src/runtime/profile')>();
  return {
    ...actual,
    isHiringPlatformEnabled: () => mocks.hiringEnabled,
    isAuthenticatedStaging: () => false,
  };
});

vi.mock('../../apps/web/src/staging/browser', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../apps/web/src/staging/browser')>();
  return {
    ...actual,
    loadHiringOrganizationWorkspaceFromCookie: vi.fn(async () => ({
      organizationId: '11111111-1111-1111-1111-111111111111',
      organizationName: 'Acme Craft',
      email: 'lead@acme.test',
      role: 'cto',
      csrfToken: 'csrf-token-1',
      plan: {
        planTier: 'ultra',
        planStatus: 'active',
        candidateCreditsPurchased: 0,
        candidateCreditsUsed: 0,
        candidateCreditsRemaining: null,
        creditedEmails: [],
      },
      orgContext: { principalId: 'principal-cto' },
      dispatch: vi.fn(async (op: string) => {
        if (op === 'hiring.library.list') return { problems: [] };
        if (op === 'organization.members.list') {
          return {
            members: [
              {
                principalId: 'principal-cto',
                displayName: 'Lead CTO',
                email: 'lead@acme.test',
                role: 'cto',
                status: 'active',
                isOwner: true,
              },
            ],
          };
        }
        return {};
      }),
    })),
  };
});

import AssessmentBuilderPage from '../../apps/web/app/r23/organizations/[organizationId]/builder/page';
import { CandidatesPipelineClient } from '../../apps/web/app/r23/organizations/[organizationId]/candidates/candidates-client';
import { groupCandidateSessions } from '../../apps/web/src/hiring/candidates-view';
import { HiringAssessmentBuilderClient } from '../../apps/web/app/r23/organizations/[organizationId]/builder/hiring-assessment-builder-client';
import { CandidateAuthClient } from '../../apps/web/app/candidate/login/candidate-auth-client';
import { CandidatePortalClient } from '../../apps/web/app/candidate/candidate-portal-client';
import { FounderUatMailInbox } from '../../apps/web/app/r23/mail/mail-inbox';
import { R26CandidateClient } from '../../apps/web/app/r26/candidate/[sessionId]/candidate-client';
import { EvaluatorReviewWorkspace } from '../../apps/web/app/evaluator/sessions/[sessionId]/evaluator-review-workspace';
import { stagingRecoverGet } from '../../apps/web/src/staging/browser';
import { serializePlatformTemplates } from '../../apps/web/src/hiring/templates';
import { renderSoftwareDocument } from '../../apps/web/src/ui/software-document';
import type { SafePortalAssessmentView } from '../../apps/web/src/hiring/types';
import type { R27Evidence } from '../../database/postgres/r27/contract.mjs';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('UX Laws critical workflow regressions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.hiringEnabled = true;
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
    window.sessionStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('separates personal settings, organization management, and upgrade links by role and tier', () => {
    const settings = {
      organizationId: '11111111-1111-1111-1111-111111111111',
      organizationName: 'Acme Craft',
      email: 'reviewer@acme.test',
      csrf: 'csrf-token',
      active: 'account' as const,
    };
    const reviewer = renderSoftwareDocument('My account', '', {
      ...settings,
      role: 'reviewer',
      planTier: 'pro',
    });
    expect(reviewer).toContain(
      'href="/r23/account" title="My account" aria-current="page"',
    );
    expect(reviewer).not.toContain('data-testid="org-settings-link"');
    expect(reviewer).toContain('/upgrade"');

    const owner = renderSoftwareDocument('Organization', '', {
      ...settings,
      role: 'cto',
      planTier: 'ultra',
      active: 'settings',
    });
    expect(owner).toContain(
      'title="Organization" data-testid="org-settings-link" aria-current="page"',
    );
    expect(owner).not.toContain('/upgrade"');
    expect(owner).toContain('/r23/account');
  });

  it('builder server page accepts template/ai/library/new modes and stage params, rejecting unknown modes', async () => {
    const orgId = '11111111-1111-1111-1111-111111111111';
    for (const [mode, stage] of [
      ['templates', 'source'],
      ['ai', 'preview'],
      ['library', 'invite'],
      ['new', 'source'],
    ] as const) {
      const result = await AssessmentBuilderPage({
        params: Promise.resolve({ organizationId: orgId }),
        searchParams: Promise.resolve({ mode, stage }),
      });
      expect(result).toBeTruthy();
    }

    await expect(
      AssessmentBuilderPage({
        params: Promise.resolve({ organizationId: orgId }),
        searchParams: Promise.resolve({ mode: 'invalid-mode' }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('builder gates Preview/Invite before problem selection, unifies AI default off, and restores step + invite draft across reload', async () => {
    const orgId = '11111111-1111-1111-1111-111111111111';
    const templates = serializePlatformTemplates();
    const props = {
      organizationId: orgId,
      currentPrincipalId: 'principal-cto',
      initialPlan: {
        planTier: 'ultra' as const,
        planStatus: 'active' as const,
        candidateCreditsPurchased: 0,
        candidateCreditsUsed: 0,
        candidateCreditsRemaining: null,
        creditedEmails: [],
      },
      initialLibrary: [],
      initialTemplates: templates,
      teamMembers: [
        {
          principalId: 'principal-cto',
          displayName: 'Lead CTO',
          email: 'lead@acme.test',
          role: 'cto' as const,
          isOwner: true,
        },
      ],
    };

    window.history.replaceState(
      null,
      '',
      `/r23/organizations/${orgId}/builder`,
    );

    await act(async () =>
      root.render(<HiringAssessmentBuilderClient {...props} />),
    );
    await flush();

    const previewBtn = container.querySelector(
      '#builder-stage-preview',
    ) as HTMLButtonElement;
    const inviteBtn = container.querySelector(
      '#builder-stage-invite',
    ) as HTMLButtonElement;
    expect(previewBtn.disabled).toBe(true);
    expect(inviteBtn.disabled).toBe(true);

    // Check Generate mode AI toggle defaults to false (matching Templates)
    const generateTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((b) => b.textContent?.includes('Generate'))!;
    await act(async () => generateTab.click());
    const customizeInputs = container.querySelectorAll<HTMLInputElement>(
      '.hiring-switch-input',
    );
    expect(customizeInputs[0].checked).toBe(false);

    // Select first template, continue to Invite, fill candidate email & note
    const templatesTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((b) => b.textContent?.includes('Templates'))!;
    await act(async () => templatesTab.click());

    const selectTplBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.includes('Preview template'))!;
    await act(async () => selectTplBtn.click());
    expect(previewBtn.disabled).toBe(false);
    expect(inviteBtn.disabled).toBe(false);

    await act(async () => inviteBtn.click());
    const emailInput = container.querySelector(
      '#issue-candidate-email',
    ) as HTMLInputElement;
    const noteInput = container.querySelector(
      '#issue-note',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(emailInput, 'nadia@candidate.test');
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter?.call(noteInput, 'Concurrency round');
      noteInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const draftId = new URLSearchParams(window.location.search).get('draft')!;
    expect(draftId).toBeTruthy();

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(<HiringAssessmentBuilderClient {...props} fresh />),
    );
    expect(
      container
        .querySelector('#builder-stage-source')
        ?.getAttribute('aria-current'),
    ).toBe('step');
    expect(
      container.querySelector('.hiring-disclosure a')?.getAttribute('href'),
    ).toContain(`draft=${draftId}`);

    // Follow the explicit resume link before remounting the builder.
    window.history.replaceState(null, '', `/?draft=${draftId}`);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(
        <HiringAssessmentBuilderClient
          {...props}
          initialMode="templates"
          draftId={draftId}
        />,
      ),
    );
    await flush();

    expect(
      container
        .querySelector('#builder-stage-invite')
        ?.getAttribute('aria-current'),
    ).toBe('step');
    expect(
      (container.querySelector('#issue-candidate-email') as HTMLInputElement)
        ?.value,
    ).toBe('nadia@candidate.test');
    expect(
      (container.querySelector('#issue-note') as HTMLInputElement)?.value,
    ).toBe('Concurrency round');

    const requests = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/issue')) {
        return Response.json({
          ok: true,
          sessionId: 'sess_invited',
          candidateLink: '/r26/candidate/sess_invited',
          expiresAt: '2026-12-01T10:00:00Z',
        });
      }
      return Response.json(
        init?.method === 'POST'
          ? { definitionId: 'def-1', validatedVersionId: 'version-1' }
          : { problems: [] },
      );
    });
    vi.stubGlobal('fetch', requests);
    await act(async () => {
      container
        .querySelector('.hiring-issue-form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    expect(container.querySelector('.hiring-issue-form')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Assessment issued');
    expect(
      container.querySelector('.hiring-issued-box')?.textContent,
    ).toContain('nadia@candidate.test');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    try {
      const copyButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('Copy email message'),
      )!;
      await act(async () => copyButton.click());
      expect(
        container.querySelector('.hiring-issued-box [role="alert"]')
          ?.textContent,
      ).toContain('Clipboard unavailable');
      expect(
        container.querySelector<HTMLTextAreaElement>('#issued-email-message')
          ?.value,
      ).toContain('/r26/candidate/sess_invited');
      expect(copyButton.textContent).toContain('Copy email message');
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }

    const newInvite = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Invite another candidate',
    )!;
    await act(async () => newInvite.click());
    expect(
      container.querySelector<HTMLInputElement>('#issue-candidate-email')
        ?.value,
    ).toBe('');
    expect(
      requests.mock.calls.filter(([url]) => url.endsWith('/issue')),
    ).toHaveLength(1);
  });

  it('shows ready submissions ahead of other invitations for the same candidate', async () => {
    const common = {
      candidateEmail: 'candidate@example.test',
      targetRole: 'Backend Engineer',
      issuerPrincipalId: 'actor',
    };
    const initialCandidates = groupCandidateSessions([
      {
        ...common,
        sessionId: 'pending',
        scenarioTitle: 'Pending task',
        lifecycleStatus: 'CREATED',
        createdAt: '2026-11-25T10:00:00Z',
      },
      {
        ...common,
        sessionId: 'ready',
        scenarioTitle: 'Ready task',
        lifecycleStatus: 'SUBMITTED',
        createdAt: '2026-11-24T10:00:00Z',
        submittedAt: '2026-11-24T11:00:00Z',
      },
    ]);
    await act(async () =>
      root.render(
        <CandidatesPipelineClient
          organizationId="example-org"
          initialCandidates={initialCandidates}
          currentRole="cto"
          plan={{
            planTier: 'ultra',
            planStatus: 'active',
            creditedEmails: [],
            candidateCreditsPurchased: 0,
            candidateCreditsUsed: 0,
            candidateCreditsRemaining: null,
          }}
        />,
      ),
    );
    const header = container.querySelector('.hiring-candidate-header');
    expect(header?.textContent).toContain('1 ready to review');
    expect(
      container.querySelector('.hiring-session-subrow strong')?.textContent,
    ).toBe('Ready task');
    const reviewFilter = container.querySelector<HTMLButtonElement>(
      '.team-review-filter',
    )!;
    expect(reviewFilter.getAttribute('aria-pressed')).toBe('false');
    await act(async () => reviewFilter.click());
    expect(reviewFilter.getAttribute('aria-pressed')).toBe('true');
    expect(new URLSearchParams(window.location.search).get('status')).toBe(
      'ready_for_review',
    );
    expect(header?.textContent).toContain('1 ready for review');
    expect(header?.textContent).not.toContain('Invited');
    expect(
      container.querySelector('.hiring-session-subrow a')?.textContent,
    ).toContain('Review submission');
    const others = container.querySelector<HTMLDetailsElement>(
      '.hiring-other-assessments',
    );
    expect(others?.open).toBe(false);
    expect(others?.textContent).toContain('Pending task');
  });

  it('preserves candidate audience through recovery, local inbox, and empty-context switch CTA', async () => {
    const req = new Request(
      'https://app.test/r23/recover?audience=candidate&next=%2Fr26%2Fcandidate%2Fsess_cand_1',
    );
    const recoverHtml = await stagingRecoverGet(req).text();
    expect(recoverHtml).toContain('name="audience" value="candidate"');
    expect(recoverHtml).toContain(
      'name="next" value="/r26/candidate/sess_cand_1"',
    );
    expect(recoverHtml).toContain(
      'href="/candidate/login?next=%2Fr26%2Fcandidate%2Fsess_cand_1"',
    );
    expect(recoverHtml).toContain('Return to candidate sign in');
    expect(recoverHtml).toContain(
      '<a class="software-document-wordmark" href="/candidate/login?next=%2Fr26%2Fcandidate%2Fsess_cand_1"',
    );

    // Candidate local inbox shows both confirmation & recovery emails
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          messages: [
            {
              id: 'rec-1',
              recipient: 'cand@test.example',
              subject: 'Reset your password',
              receivedAt: '2026-11-25T10:00:00.000Z',
              kind: 'recovery',
            },
          ],
        }),
      ),
    );
    await act(async () =>
      root.render(
        <FounderUatMailInbox
          email="cand@test.example"
          candidate={true}
          next="/r26/candidate/sess_cand_1"
        />,
      ),
    );
    await flush();
    expect(container.textContent).toContain('Reset your password');

    // Candidate sign-in without candidate profile/invitations makes Switch to invited email primary
    await act(async () =>
      root.render(
        <CandidateAuthClient
          mode="login"
          nextPath="/candidate"
          activeAccount={{
            email: 'team@acme.test',
            csrfToken: 'csrf-1',
            hasCandidateContext: false,
            hasTeamWorkspace: true,
          }}
        />,
      ),
    );
    const primaryBtn = container.querySelector('.hiring-btn-primary');
    expect(primaryBtn?.textContent).toContain('Switch to your invited email');
    expect(container.textContent).not.toContain('Continue with this account');
    expect(container.textContent).toContain('Back to team workspace');
  });

  it('prioritizes actionable assessments above submitted ones on candidate portal load', async () => {
    const baseItem = {
      organizationId: 'org-1',
      organizationName: 'Acme Craft',
      targetRole: 'Backend Engineer',
      experienceLevel: 'mid',
      skills: ['Python'],
      durationSeconds: 3600,
      createdAt: '2026-11-20T10:00:00.000Z',
      activatedAt: null,
      submittedAt: null,
      invitationExpiresAt: '2026-12-01T10:00:00.000Z',
      invitationRevokedAt: null,
      invitationActive: true,
      publishedOutcome: null,
    };

    const assessments: SafePortalAssessmentView[] = [
      {
        ...baseItem,
        sessionId: 'sess_submitted_newest',
        scenarioTitle: 'Completed Screening',
        status: 'SUBMITTED',
        pipelineStatus: 'ready_for_review',
        createdAt: '2026-11-24T10:00:00.000Z',
        submittedAt: '2026-11-24T11:00:00.000Z',
        canLaunch: false,
      },
      {
        ...baseItem,
        sessionId: 'sess_pending_open',
        scenarioTitle: 'Pending Screening Task',
        status: 'CREATED',
        pipelineStatus: 'invited',
        createdAt: '2026-11-21T10:00:00.000Z',
        canLaunch: true,
      },
      {
        ...baseItem,
        sessionId: 'sess_active_resume',
        scenarioTitle: 'Active Coding Session',
        status: 'ACTIVE',
        pipelineStatus: 'in_progress',
        activatedAt: '2026-11-23T10:00:00.000Z',
        canLaunch: true,
      },
    ];

    await act(async () =>
      root.render(
        <CandidatePortalClient
          email="cand@test.example"
          initialProfile={null}
          initialAssessments={assessments}
          setupMode={false}
          nextPath={null}
        />,
      ),
    );

    const titles = Array.from(
      container.querySelectorAll('.hiring-portal-card-title'),
    ).map((el) => el.textContent);
    expect(titles).toEqual([
      'Active Coding Session',
      'Pending Screening Task',
      'Completed Screening',
    ]);
    expect(container.textContent).toContain('Continue assessment');
    expect(container.textContent).toContain('Open assessment');
  });

  it('opens Task first with Goal checklist & Open editor, persists checkedCriteria on reload, and puts submission receipt on top', async () => {
    const activeView = {
      sessionId: 'sess_cand_live_1',
      status: 'ACTIVE',
      scenario: {
        title: 'Reservation Moves',
        brief:
          'Implement atomic `move`.\n\n## Public contract\n\nPreserve the API.',
        acceptanceCriteria: ['Criterion A', 'Criterion B'],
      },
      scenarioDigest: 'sha256:abc',
      activatedAt: '2026-11-25T10:00:00.000Z',
      deadline: '2026-11-25T12:00:00.000Z',
      durationSeconds: 3600,
      submittedAt: null,
      closureReason: null,
      serverNow: '2026-11-25T10:05:00.000Z',
      files: [
        {
          path: 'src/service.py',
          content: 'def move():\n  pass\n',
          version: 1,
          digest: 'sha256:file1',
          readOnly: false,
        },
      ],
      workspaceDigest: 'sha256:ws1',
      events: [],
      submission: null,
      invitationExpiresAt: '2026-12-01T10:00:00.000Z',
      capabilities: { ai: false, execution: false },
      dataNotice: null,
    };

    window.sessionStorage.setItem(
      'hirearchy:r26:candidate-token:v1:sess_cand_live_1',
      'valid_candidate_bearer_token_032',
    );

    let currentView = activeView;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(currentView, { status: 200 })),
    );

    await act(async () =>
      root.render(
        <R26CandidateClient
          sessionId="sess_cand_live_1"
          accountGate={{
            state: 'ready',
            email: 'cand@test.example',
            profile: null,
          }}
        />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const workspaceEl = container.querySelector('.r26-workspace');
    expect(workspaceEl?.getAttribute('data-mobile-tab')).toBe('task');
    expect(container.querySelector('.r26-open-editor-btn')?.textContent).toBe(
      'Open editor',
    );
    const goalCard = container.querySelector('.r26-task-goal-card');
    const intro = container.querySelector('#candidate-brief-content p');
    const rest = container.querySelector('#candidate-brief-content h3');
    expect(
      intro!.compareDocumentPosition(goalCard!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      goalCard!.compareDocumentPosition(rest!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const firstCheckbox = container.querySelector(
      '.r26-task-goal-card input[type="checkbox"]',
    ) as HTMLInputElement;
    await act(async () => firstCheckbox.click());
    await flush();

    // Reload candidate client cleanly — checked criterion must remain checked!
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(
        <R26CandidateClient
          sessionId="sess_cand_live_1"
          accountGate={{
            state: 'ready',
            email: 'cand@test.example',
            profile: null,
          }}
        />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const reloadedCheckbox = container.querySelector(
      '.r26-task-goal-card input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(reloadedCheckbox.checked).toBe(true);

    // Submitted receipt renders ABOVE .r26-workspace with truthful test-disabled copy
    currentView = {
      ...activeView,
      status: 'SUBMITTED',
      submittedAt: '2026-11-25T10:20:00.000Z',
      closureReason: 'candidate_submission',
    } as typeof activeView;

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(
        <R26CandidateClient
          sessionId="sess_cand_live_1"
          accountGate={{
            state: 'ready',
            email: 'cand@test.example',
            profile: null,
          }}
        />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const receipt = container.querySelector('.r26-submission-receipt-top')!;
    const ws = container.querySelector('.r26-workspace')!;
    expect(receipt).not.toBeNull();
    expect(
      receipt.compareDocumentPosition(ws) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(receipt.textContent).toContain('test runner disabled');
    expect(receipt.textContent).toContain('Return to My assessments');
    expect(receipt.textContent).toContain('View submitted work');
  });

  it('hides stale code diff when R27 Tests filter has 0 runs and keeps private review notes clean', async () => {
    const r27Evidence: R27Evidence = {
      permission: 'assigned_reviewer',
      reviewer: { subjectId: 'rev-1', principalId: 'p-1' },
      organizationId: 'org-1',
      sessionId: 'sess_eval_r27',
      status: 'SUBMITTED',
      createdAt: '2026-11-25T09:00:00.000Z',
      activatedAt: '2026-11-25T09:05:00.000Z',
      submittedAt: '2026-11-25T09:40:00.000Z',
      closureReason: 'candidate_submission',
      assignment: {
        id: 'assign-1',
        version: 'v1',
        assignedAt: '2026-11-25T09:00:00.000Z',
      },
      scenario: {
        id: 'reservation-moves',
        version: 'v3',
        title: 'Reservation Moves',
        snapshotText: 'def move():\n  pass',
        snapshotDigest: 'sha256:snap',
        starterFiles: {
          'src/service.py': 'def move():\n  pass\n',
        },
      },
      events: [],
      submission: {
        submittedAt: '2026-11-25T09:40:00.000Z',
        closureReason: 'candidate_submission',
        workspaceDigest: 'sha256:ws',
        manifestDigest: 'sha256:mf',
        files: [
          {
            path: 'src/service.py',
            content: 'def move():\n  return True\n',
            digest: 'sha256:sub',
            version: '2',
          },
        ],
      },
      revisions: [],
      availability: {
        terminal: 'available',
        ai: 'unavailable',
        verification: 'unavailable',
        history: 'metadata_only',
        limitations: [],
      },
      pagination: { nextAfterSequence: null },
    };

    await act(async () =>
      root.render(
        <EvaluatorReviewWorkspace
          sessionId="sess_eval_r27"
          readOnly={true}
          r27Evidence={r27Evidence}
          hiringReviewContext={{
            organizationId: 'org-1',
            organizationName: 'Acme Craft',
            sessionId: 'sess_eval_r27',
            scenarioTitle: 'Reservation Moves',
            currentPrincipalId: 'p-1',
            currentRole: 'cto',
            isOwner: true,
            canPublishDecision: true,
            plan: {
              planTier: 'ultra',
              planStatus: 'active',
              candidateCreditsPurchased: 0,
              candidateCreditsUsed: 0,
              candidateCreditsRemaining: null,
              creditedEmails: [],
            },
            targetRole: 'Backend Engineer',
            experienceLevel: 'mid',
            skills: ['Python'],
            candidateEmail: 'cand@test.example',
            candidateName: 'Candidate One',
            candidateCode: 'CAND-1',
            decision: null,
            secondOpinions: [],
            teamMembers: [],
          }}
        />,
      ),
    );
    await flush();

    const codeTestsTab = container.querySelector(
      '#workbench-mode-evidence',
    ) as HTMLButtonElement;
    await act(async () => codeTestsTab.click());

    // Scratchpad shows Private review notes without duplicate Advance/Reject outcome buttons
    const scratchpad = container.querySelector('.evaluator-scratchpad-card');
    expect(scratchpad?.textContent).toContain('Private review notes');
    expect(scratchpad?.textContent).not.toContain('Advance');
    expect(scratchpad?.textContent).not.toContain('Reject');

    const starter = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === 'Starter')!;
    const fileEvidence = container.querySelector<HTMLButtonElement>(
      '.review-desk-file-trigger',
    )!;
    const details = container.querySelector<HTMLElement>(
      '.review-desk-file-evidence',
    )!;
    await act(async () => starter.click());
    await act(async () => fileEvidence.click());
    expect(fileEvidence.getAttribute('aria-expanded')).toBe('true');
    expect(starter.getAttribute('aria-pressed')).toBe('true');
    expect(details.hasAttribute('inert')).toBe(false);
    await act(async () =>
      details.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(fileEvidence.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(fileEvidence);
    expect(starter.getAttribute('aria-pressed')).toBe('true');

    // Switch to Tests filter (0 runs)
    const testsTab = container.querySelector(
      '#evidence-filter-execution-runs',
    ) as HTMLButtonElement;
    await act(async () => testsTab.click());

    expect(container.textContent).not.toContain('Selected outside this filter');
    expect(container.textContent).toContain('No test runs recorded');
    expect(container.textContent).toContain(
      'does not establish whether the test runner was available',
    );
    const backBtn = container.querySelector(
      '.evaluator-empty-inspector-card button',
    ) as HTMLButtonElement;
    expect(backBtn.textContent).toContain('Return to Files');
    await act(async () => backBtn.click());

    expect(
      container
        .querySelector('#evidence-filter-code-changes')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });
});
