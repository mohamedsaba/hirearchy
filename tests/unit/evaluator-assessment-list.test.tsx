// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cookies } from 'next/headers';

import EvaluatorAssessmentsPage from '../../apps/web/app/evaluator/assessments/page';
import {
  EvaluatorAssessmentList,
  type AssessmentLifecycleItem,
} from '../../apps/web/app/evaluator/assessments/evaluator-assessment-list';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';

vi.mock('next/headers', () => ({ cookies: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe('evaluator assessment lifecycle page', () => {
  let originalCredential: string | undefined;

  beforeEach(() => {
    originalCredential = process.env.HIREARCHY_EVALUATOR_KEY;
    process.env.HIREARCHY_EVALUATOR_KEY = 'test-lifecycle-key';
  });

  afterEach(() => {
    if (originalCredential === undefined) {
      delete process.env.HIREARCHY_EVALUATOR_KEY;
    } else {
      process.env.HIREARCHY_EVALUATOR_KEY = originalCredential;
    }
  });

  it('shows sign-in when unauthenticated and gates the lifecycle view', async () => {
    vi.mocked(cookies).mockResolvedValue({ get: () => undefined } as never);

    const publicPage = renderToStaticMarkup(await EvaluatorAssessmentsPage());
    expect(publicPage).toContain('Evaluator access');
    expect(publicPage).toContain('Assessment lifecycle.');
    expect(publicPage).toContain('Evaluator credential');
    expect(publicPage).not.toContain('Create assessment');
  });

  it('renders the authenticated lifecycle header with action links', async () => {
    vi.mocked(cookies).mockResolvedValue({
      get: () => ({ value: createSignedEvaluatorToken('test-lifecycle-key') }),
    } as never);

    const page = renderToStaticMarkup(await EvaluatorAssessmentsPage());
    expect(page).toContain('Assessment lifecycle');
    expect(page).toContain('href="/evaluator/assessments/new"');
    expect(page).toContain('Create assessment');
    expect(page).toContain('href="/evaluator"');
    expect(page).toContain('Submitted reviews');
  });
});

describe('evaluator assessment lifecycle list', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  const items: readonly AssessmentLifecycleItem[] = [
    {
      sessionId: 'legacy-zero-budget',
      candidatePath: '/candidate/legacy-token',
      scenarioTitle: 'Legacy assessment with no recorded time budget',
      status: 'CREATED',
      createdAt: '2026-10-20T10:00:00.000Z',
      activatedAt: null,
      submittedAt: null,
      durationSeconds: null,
      closureReason: null,
      reviewProcessStatus: null,
    },
    {
      sessionId: 'active-session',
      candidatePath: '/candidate/active-token',
      scenarioTitle: 'Active assessment',
      status: 'ACTIVE',
      createdAt: '2026-10-20T11:00:00.000Z',
      activatedAt: '2026-10-20T11:05:00.000Z',
      submittedAt: null,
      durationSeconds: 2700,
      closureReason: null,
      reviewProcessStatus: null,
    },
    {
      sessionId: 'submitted-timeout',
      candidatePath: '/candidate/timeout-token',
      scenarioTitle: 'Submitted after timeout',
      status: 'SUBMITTED',
      createdAt: '2026-10-20T12:00:00.000Z',
      activatedAt: '2026-10-20T12:05:00.000Z',
      submittedAt: '2026-10-20T12:50:00.000Z',
      durationSeconds: 2700,
      closureReason: 'timeout',
      reviewProcessStatus: 'waiting_for_response',
    },
    {
      sessionId: 'submitted-next-step',
      candidatePath: '/candidate/next-step-token',
      scenarioTitle: 'Submitted with a next step',
      status: 'SUBMITTED',
      createdAt: '2026-10-20T13:00:00.000Z',
      activatedAt: '2026-10-20T13:05:00.000Z',
      submittedAt: '2026-10-20T13:50:00.000Z',
      durationSeconds: 2700,
      closureReason: 'candidate_submission',
      reviewProcessStatus: 'next_step_recorded',
    },
    {
      sessionId: 'submitted-no-review-status',
      candidatePath: null,
      scenarioTitle: 'Submitted with unavailable review status',
      status: 'SUBMITTED',
      createdAt: '2026-10-20T14:00:00.000Z',
      activatedAt: '2026-10-20T14:05:00.000Z',
      submittedAt: '2026-10-20T14:50:00.000Z',
      durationSeconds: 2700,
      closureReason: 'candidate_submission',
      reviewProcessStatus: null,
    },
    {
      sessionId: 'submitted-not-started',
      candidatePath: '/candidate/not-started-token',
      scenarioTitle: 'Submitted and review not started',
      status: 'SUBMITTED',
      createdAt: '2026-10-20T15:00:00.000Z',
      activatedAt: '2026-10-20T15:05:00.000Z',
      submittedAt: '2026-10-20T15:50:00.000Z',
      durationSeconds: 2700,
      closureReason: 'candidate_submission',
      reviewProcessStatus: 'not_started',
    },
  ];

  const flush = () =>
    act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  const buttonContaining = (text: string) =>
    Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(text),
    ) as HTMLButtonElement | undefined;

  const selectValue = async (label: string, value: string) => {
    const select = Array.from(container.querySelectorAll('select')).find(
      (element) => element.parentElement?.textContent?.includes(label),
    ) as HTMLSelectElement | undefined;
    if (!select) throw new Error(`Missing ${label} filter`);
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ assessments: items }),
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderList = async () => {
    await act(async () => root.render(<EvaluatorAssessmentList />));
    await flush();
  };

  it('separates session lifecycle from review progress and keeps next steps open', async () => {
    await renderList();

    expect(container.textContent).toContain('Untimed (legacy)');
    expect(container.textContent).toContain('Timed out');
    expect(container.textContent).toContain('Next step recorded');
    expect(container.textContent).not.toContain('Review complete');
    expect(container.textContent).toContain('Submitted (4)');
    expect(container.textContent).toContain('Timed out submissions (1)');
    expect(container.textContent).toContain('All review progress (6)');

    const defaultAssessment = container.querySelector(
      '.lifecycle-row-assessment',
    );
    expect(defaultAssessment?.textContent).toContain('legacy-z');
    expect(defaultAssessment?.textContent).not.toContain('legacy-zero-budget');
    expect(
      container.querySelector('.lifecycle-row-state')?.querySelectorAll('time'),
    ).toHaveLength(1);

    await selectValue('Review progress', 'next_step_recorded');

    expect(container.textContent).toContain('Submitted with a next step');
    expect(container.textContent).not.toContain('Submitted after timeout');

    const details = container.querySelector('details summary') as HTMLElement;
    await act(async () => details.click());
    expect(container.textContent).toContain('Open submitted candidate session');
    expect(container.textContent).toContain(
      'This candidate submission is frozen.',
    );
    expect(container.textContent).toContain('Full session reference');
    expect(container.textContent).toContain('submitted-next-step');
  });

  it('distinguishes a legacy untimed session from a recorded zero minute budget', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        assessments: [
          items[0],
          {
            ...items[0],
            sessionId: 'explicit-zero-budget',
            scenarioTitle: 'Explicit zero minute budget',
            durationSeconds: 0,
          },
        ],
      }),
    });
    await renderList();

    const budgets = Array.from(
      container.querySelectorAll('.lifecycle-row-budget'),
    );
    expect(budgets[0]?.textContent).toContain('Untimed (legacy)');
    expect(budgets[1]?.textContent).toContain('0 min');
  });

  it('combines lifecycle filters with title and session reference search', async () => {
    await renderList();

    await selectValue('Session lifecycle', 'timed_out');
    expect(container.textContent).toContain('Submitted after timeout');
    expect(container.textContent).not.toContain('Submitted with a next step');

    await selectValue('Session lifecycle', 'all');
    const search = container.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(search, 'legacy-zero-budget');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.textContent).toContain('Legacy assessment');
    expect(container.textContent).not.toContain('Active assessment');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(search, 'no matching session');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('No sessions match these filters');
    await act(async () => buttonContaining('Clear filters')?.click());
    expect(container.textContent).toContain('Showing 6 of 6 sessions');
  });

  it('shows loading and recovers from an unavailable assessment service', async () => {
    let resolveResponse!: (response: {
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    );

    await act(async () => root.render(<EvaluatorAssessmentList />));
    expect(container.textContent).toContain('Loading sessions…');

    resolveResponse({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    await flush();
    expect(container.textContent).toContain(
      'Assessments could not be loaded. Try again.',
    );

    await act(async () => buttonContaining('Refresh')?.click());
    await flush();
    expect(container.textContent).toContain('Legacy assessment');
  });

  it('keeps Refresh focused while a manual refresh is in flight', async () => {
    await renderList();

    const refresh = container.querySelector(
      '.lifecycle-refresh-button',
    ) as HTMLButtonElement;
    refresh.focus();
    expect(document.activeElement).toBe(refresh);

    let resolveResponse!: (response: {
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    );

    await act(async () => refresh.click());
    expect(container.querySelector('.lifecycle-refresh-button')).toBe(refresh);
    expect(document.activeElement).toBe(refresh);
    expect(refresh.getAttribute('aria-disabled')).toBe('true');
    expect(refresh.disabled).toBe(false);

    resolveResponse({
      ok: true,
      status: 200,
      json: async () => ({ assessments: items }),
    });
    await flush();

    expect(document.activeElement).toBe(refresh);
    expect(refresh.getAttribute('aria-disabled')).toBe('false');
  });
});

describe('tenant-scoped evaluator assessment list', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  const flush = () =>
    act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders tenant scope banner and truthful blocked empty state for admin role', async () => {
    await act(async () =>
      root.render(
        <EvaluatorAssessmentList
          readOnlyMode={true}
          membershipRole="admin"
          initialItems={[]}
        />,
      ),
    );
    await flush();

    expect(container.textContent).toContain(
      'Organization admin scope: session access blocked pending P2 ratification',
    );
    expect(container.textContent).toContain(
      'No authorized sessions in this organization',
    );
    expect(container.textContent).toContain(
      'Organization admin session access remains blocked until P2 access policies are ratified.',
    );
    expect(container.textContent).not.toContain('Create assessment');
  });

  it('renders role-appropriate guidance in empty state for recruiter and reviewer roles', async () => {
    await act(async () =>
      root.render(
        <EvaluatorAssessmentList
          readOnlyMode={true}
          membershipRole="recruiter"
          initialItems={[]}
        />,
      ),
    );
    await flush();

    expect(container.textContent).toContain(
      'Recruiter scope: sessions issued by your account',
    );
    expect(container.textContent).toContain(
      'No assessment sessions issued by your recruiter account were found in this organization.',
    );
    expect(container.textContent).not.toContain('Create assessment');

    await act(async () =>
      root.render(
        <EvaluatorAssessmentList
          readOnlyMode={true}
          membershipRole="reviewer"
          initialItems={[]}
        />,
      ),
    );
    await flush();

    expect(container.textContent).toContain(
      'Reviewer scope: submitted sessions actively assigned to you',
    );
    expect(container.textContent).toContain(
      'No submitted assessment sessions are currently assigned to your reviewer account in this organization.',
    );
  });

  it('renders tenant-scoped sessions with authorized summary action link and no candidate token leakage', async () => {
    const tenantItem: AssessmentLifecycleItem = {
      sessionId: 'tenant-session-12345678',
      candidatePath: null,
      scenarioTitle: 'Tenant Scoped Security Assessment',
      scenarioId: 'scenario-002-tenant',
      scenarioVersion: '1.0.0',
      status: 'SUBMITTED',
      createdAt: '2026-10-25T10:00:00.000Z',
      activatedAt: '2026-10-25T10:05:00.000Z',
      submittedAt: '2026-10-25T10:50:00.000Z',
      durationSeconds: 2700,
      closureReason: 'candidate_submission',
      reviewProcessStatus: 'waiting_for_response',
      visibilityScope: 'issued_by_recruiter',
    };

    await act(async () =>
      root.render(
        <EvaluatorAssessmentList
          initialItems={[tenantItem]}
          initialTotalCount={1}
          sessionSummaryHrefPrefix="/r23/organizations/org-test/sessions"
          readOnlyMode={true}
          membershipRole="recruiter"
        />,
      ),
    );
    await flush();

    expect(container.textContent).toContain(
      'Tenant Scoped Security Assessment',
    );
    expect(container.textContent).toContain('45 min');
    expect(container.textContent).toContain('Waiting for response');

    const actionLink = container.querySelector(
      '.lifecycle-primary-action',
    ) as HTMLAnchorElement;
    expect(actionLink?.getAttribute('href')).toBe(
      '/r23/organizations/org-test/sessions/tenant-session-12345678',
    );
    expect(actionLink?.textContent).toContain(
      'Inspect authorized session summary',
    );

    const details = container.querySelector('details summary') as HTMLElement;
    await act(async () => details.click());

    expect(container.textContent).not.toContain('Candidate link copied.');
    expect(container.textContent).not.toContain('Copy candidate link');

    const detailLinks = Array.from(
      container.querySelectorAll('.lifecycle-detail-link'),
    );
    expect(
      detailLinks.some((a) =>
        a
          .getAttribute('href')
          ?.includes(
            '/r23/organizations/org-test/sessions/tenant-session-12345678',
          ),
      ),
    ).toBe(true);
  });

  it('supports cursor-based pagination and loading more sessions', async () => {
    const item1: AssessmentLifecycleItem = {
      sessionId: 'sess-page-1',
      candidatePath: null,
      scenarioTitle: 'Session Page 1',
      status: 'SUBMITTED',
      createdAt: '2026-10-25T10:00:00.000Z',
      activatedAt: '2026-10-25T10:05:00.000Z',
      submittedAt: '2026-10-25T10:50:00.000Z',
      durationSeconds: 2700,
      closureReason: 'candidate_submission',
      reviewProcessStatus: 'not_started',
    };
    const item2: AssessmentLifecycleItem = {
      sessionId: 'sess-page-2',
      candidatePath: null,
      scenarioTitle: 'Session Page 2',
      status: 'SUBMITTED',
      createdAt: '2026-10-25T11:00:00.000Z',
      activatedAt: '2026-10-25T11:05:00.000Z',
      submittedAt: '2026-10-25T11:50:00.000Z',
      durationSeconds: 2700,
      closureReason: 'candidate_submission',
      reviewProcessStatus: 'next_step_recorded',
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        assessments: [item2],
        nextCursor: null,
      }),
    });

    await act(async () =>
      root.render(
        <EvaluatorAssessmentList
          endpoint="/r23/api/organizations/org-test/sessions"
          initialItems={[item1]}
          initialTotalCount={2}
          initialNextCursor="next-cursor-token"
          sessionSummaryHrefPrefix="/r23/organizations/org-test/sessions"
          readOnlyMode={true}
        />,
      ),
    );
    await flush();

    expect(container.textContent).toContain('Session Page 1');
    expect(container.textContent).not.toContain('Session Page 2');

    const loadMoreButton = container.querySelector(
      '.lifecycle-load-more-button',
    ) as HTMLButtonElement;
    expect(loadMoreButton).not.toBeNull();
    expect(loadMoreButton.textContent).toContain('Load more sessions');

    await act(async () => loadMoreButton.click());
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      '/r23/api/organizations/org-test/sessions?cursor=next-cursor-token',
      { cache: 'no-store' },
    );

    expect(container.textContent).toContain('Session Page 1');
    expect(container.textContent).toContain('Session Page 2');
    expect(container.querySelector('.lifecycle-load-more-button')).toBeNull();
  });

  it('renders truthful status for unmigrated candidate bearer availability', async () => {
    const unmigratedItem: AssessmentLifecycleItem = {
      sessionId: 'sess-unmigrated',
      candidatePath: null,
      candidateBearerAvailabilityStatus: 'runtime_not_activated',
      scenarioTitle: 'Unmigrated Runtime Session',
      status: 'CREATED',
      createdAt: '2026-10-25T12:00:00.000Z',
      activatedAt: null,
      submittedAt: null,
      durationSeconds: 3600,
      closureReason: null,
      reviewProcessStatus: null,
    };

    await act(async () =>
      root.render(
        <EvaluatorAssessmentList
          endpoint="/r23/api/organizations/org-test/sessions"
          initialItems={[unmigratedItem]}
          sessionSummaryHrefPrefix="/r23/organizations/org-test/sessions"
          readOnlyMode={true}
        />,
      ),
    );
    await flush();

    expect(container.textContent).toContain('Unmigrated Runtime Session');
    expect(container.textContent).toContain('Runtime not activated');
    expect(container.textContent).toContain('Candidate runtime not activated');
  });

  it('responds to external refreshTrigger and invokes onRefresh callback', async () => {
    const onRefreshMock = vi.fn();
    const itemA: AssessmentLifecycleItem = {
      sessionId: 'sess-a',
      candidatePath: null,
      scenarioTitle: 'Initial Session',
      status: 'CREATED',
      createdAt: '2026-10-25T10:00:00.000Z',
      activatedAt: null,
      submittedAt: null,
      durationSeconds: 3600,
      closureReason: null,
      reviewProcessStatus: null,
    };
    const itemB: AssessmentLifecycleItem = {
      sessionId: 'sess-b',
      candidatePath: null,
      scenarioTitle: 'Refreshed Session',
      status: 'CREATED',
      createdAt: '2026-10-25T11:00:00.000Z',
      activatedAt: null,
      submittedAt: null,
      durationSeconds: 3600,
      closureReason: null,
      reviewProcessStatus: null,
    };

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        assessments: [itemB],
        nextCursor: null,
      }),
    });

    await act(async () =>
      root.render(
        <EvaluatorAssessmentList
          endpoint="/r23/api/organizations/org-test/sessions"
          initialItems={[itemA]}
          refreshTrigger={1}
          onRefresh={onRefreshMock}
        />,
      ),
    );
    await flush();

    expect(container.textContent).toContain('Initial Session');
    expect(onRefreshMock).not.toHaveBeenCalled();

    // Now trigger external refresh by changing refreshTrigger prop
    await act(async () =>
      root.render(
        <EvaluatorAssessmentList
          endpoint="/r23/api/organizations/org-test/sessions"
          initialItems={[itemA]}
          refreshTrigger={2}
          onRefresh={onRefreshMock}
        />,
      ),
    );
    await flush();

    expect(onRefreshMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/r23/api/organizations/org-test/sessions',
      { cache: 'no-store' },
    );
    expect(container.textContent).toContain('Refreshed Session');
  });
});
