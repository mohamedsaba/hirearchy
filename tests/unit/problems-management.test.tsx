// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AssessmentBuilderClient } from '../../apps/web/app/r23/organizations/[organizationId]/builder/assessment-builder-client';
import AssessmentBuilderPage from '../../apps/web/app/r23/organizations/[organizationId]/builder/page';
import { content as fixture } from '../staging/journey.mjs';

const { apiGet, problemApi, context } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  problemApi: vi.fn(),
  context: vi.fn(),
}));
vi.mock('../../apps/web/src/r23-auth/server', () => ({
  r211AssessmentDraftApiGet: apiGet,
  loadAuthenticatedOrganizationSessionList: context,
  r211ReusableProblemApi: problemApi,
  r25OrganizationReviewersApiGet: vi.fn(),
}));
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: routerPush }),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ cookie: '__Host-r23-csrf=token' }),
  cookies: async () => ({
    toString: () => '__Host-r23-csrf=token',
    get: () => ({ value: 'token' }),
  }),
}));
const organizationId = '10000000-0000-4000-8000-000000000001';
const problemId = '10000000-0000-4000-8000-000000000002';
const definitionId = '10000000-0000-4000-8000-000000000003';
const params = Promise.resolve({ organizationId, problemId });
const libraryPath = `/r23/organizations/${organizationId}/problems`;
const draft = {
  ...fixture,
  templateId: 'custom' as const,
  definitionId,
  organizationId,
  version: 1,
  authorPrincipalId: 'author',
  createdAt: '2026-11-19T12:00:00Z',
  updatedAt: '2026-11-19T12:00:00Z',
};
const problem = {
  id: problemId,
  organizationId,
  authorPrincipalId: draft.authorPrincipalId,
  createdAt: draft.createdAt,
  updatedAt: draft.updatedAt,
  version: 1,
  content: { ...fixture, templateId: 'custom' },
};
let root: Root;
let container: HTMLDivElement;
const button = (name: string) =>
  Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === name,
  );
const click = async (name: string) => {
  const b = button(name);
  expect(b, name).toBeDefined();
  await act(async () => b!.click());
};
const changeTitle = async (input: HTMLInputElement, title: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, title);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  context.mockResolvedValue({
    membership: { role: 'recruiter' },
    csrfToken: 'token',
    reviewers: [{ principalId: 'a', role: 'reviewer' }],
    draft: {
      ...draft,
      definitionId: problemId,
      title: 'Newer, unrelated draft',
    },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('saves the current in-memory authoring content as a new library entry', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(Response.json({ problem }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(
      <AssessmentBuilderClient
        organizationId={organizationId}
        csrfToken="token"
        initialDraft={draft}
      />,
    ),
  );
  await changeTitle(
    container.querySelector('#assessment-title')!,
    'Unsaved title',
  );
  await click('Save for reuse');
  expect(container.textContent).toContain('Problem saved for reuse');
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe(`/r23/api/organizations/${organizationId}/problems`);
  expect(init.method).toBe('POST');
  expect(new Headers(init.headers).get('x-csrf-token')).toBe('token');
  expect(JSON.parse(init.body)).toEqual({
    content: { ...problem.content, title: 'Unsaved title' },
  });
});

it('opens the reused definition even after another creation becomes latest', async () => {
  apiGet.mockImplementation(async (request: Request) =>
    Response.json({
      draft:
        new URL(request.url).searchParams.get('definitionId') === definitionId
          ? draft
          : null,
    }),
  );
  const page = await AssessmentBuilderPage({
    params,
    searchParams: Promise.resolve({ definitionId }),
  });
  await act(async () => root.render(page));
  expect(
    container.querySelector<HTMLInputElement>('#assessment-title')?.value,
  ).toBe(fixture.title);
});
it('returns a missing page for an unavailable requested draft', async () => {
  apiGet.mockResolvedValue(Response.json({ draft: null }));
  await expect(
    AssessmentBuilderPage({
      params,
      searchParams: Promise.resolve({ definitionId }),
    }),
  ).rejects.toThrow(/404/);
});

it('lists organization problems with links to management details and authoring', async () => {
  const { default: page } =
    await import('../../apps/web/app/r23/organizations/[organizationId]/problems/page');
  problemApi.mockResolvedValue(Response.json({ problems: [problem] }));
  const view = await page({ params });
  await act(async () => root.render(view));
  expect(container.querySelector('table a')?.getAttribute('href')).toBe(
    `${libraryPath}/${problemId}`,
  );
  expect(container.querySelector('table')?.textContent).toContain(
    fixture.title,
  );
  expect(
    container.querySelector(
      `a[href="/r23/organizations/${organizationId}/builder"]`,
    ),
  ).toBeTruthy();
});
it('honors recruiter-only access for both management pages', async () => {
  const { default: list } =
    await import('../../apps/web/app/r23/organizations/[organizationId]/problems/page');
  const { default: detail } =
    await import('../../apps/web/app/r23/organizations/[organizationId]/problems/[problemId]/page');
  problemApi.mockImplementation(async () =>
    Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }),
  );
  await expect(list({ params })).rejects.toThrow(/404/);
  await expect(detail({ params })).rejects.toThrow(/404/);
});
it('preserves unsaved detail edits on conflict and requires confirmation before deletion', async () => {
  const { default: detail } =
    await import('../../apps/web/app/r23/organizations/[organizationId]/problems/[problemId]/page');
  problemApi.mockResolvedValue(Response.json({ problem }));
  const view = await detail({ params });
  await act(async () => root.render(view));
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json(
        { error: { message: 'Problem changed concurrently' } },
        { status: 409 },
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  const title = container.querySelector<HTMLInputElement>(
    'input[name="title"]',
  )!;
  expect(title.value).toBe(fixture.title);
  await changeTitle(title, 'My changes');
  await click('Save changes');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    expectedVersion: 1,
    content: { ...problem.content, title: 'My changes' },
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
    /reload/i,
  );
  expect(title.value).toBe('My changes');
  await click('Delete problem');
  await click('Cancel');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await click('Delete problem');
  await click('Confirm deletion');
  expect(fetcher.mock.calls[1][1].method).toBe('DELETE');
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
    expectedVersion: 1,
  });
});

it('starts a new draft from the selected problem and navigates to the returned ID', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ problems: [problem] }))
    .mockResolvedValueOnce(Response.json({ draft }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(
      <AssessmentBuilderClient
        organizationId={organizationId}
        csrfToken="token"
        initialDraft={{ ...draft, definitionId: problemId }}
      />,
    ),
  );
  await click('Start from saved problem');
  const picker = Array.from(container.querySelectorAll('select')).find((s) =>
    [...s.options].some((o) => o.value === problemId),
  )!;
  await act(async () => {
    picker.value = problemId;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Create draft');
  expect(fetcher.mock.calls[1][0]).toBe(
    `/r23/api/organizations/${organizationId}/problems/${problemId}/reuse`,
  );
  expect(routerPush).toHaveBeenCalledWith(
    `/r23/organizations/${organizationId}/builder?definitionId=${definitionId}`,
  );
});

it('uses the saved version for deletion and returns to the table', async () => {
  const { default: detail } =
    await import('../../apps/web/app/r23/organizations/[organizationId]/problems/[problemId]/page');
  problemApi.mockResolvedValue(Response.json({ problem }));
  const view = await detail({ params });
  await act(async () => root.render(view));
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        problem: {
          ...problem,
          version: 2,
          content: { ...problem.content, title: 'Updated title' },
        },
      }),
    )
    .mockResolvedValueOnce(Response.json({ deleted: true }));
  vi.stubGlobal('fetch', fetcher);
  const replace = vi
    .spyOn(window.location, 'replace')
    .mockImplementation(() => {});
  try {
    await changeTitle(
      container.querySelector('input[name="title"]')!,
      'Updated title',
    );
    await click('Save changes');
    expect(container.querySelector('h1')?.textContent).toBe('Updated title');
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Changes saved.',
    );
    await click('Delete problem');
    await click('Confirm deletion');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      expectedVersion: 2,
    });
    expect(replace).toHaveBeenCalledWith(libraryPath);
  } finally {
    replace.mockRestore();
  }
});
