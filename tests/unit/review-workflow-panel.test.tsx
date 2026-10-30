// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewWorkflowPanel } from '../../apps/web/app/evaluator/sessions/[sessionId]/review-workflow-panel';

describe('review workflow panel', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();
  const workflow = (
    body: string,
    version: number,
    overrides: {
      clarifications?: {
        id: string;
        prompt: string;
        requestedAt: string;
        reply: string | null;
        repliedAt: string | null;
        closedAt: string | null;
      }[];
      nextStep?: {
        action: string;
        note: string;
        updatedAt: string;
        version?: number;
      } | null;
    } = {},
  ) => ({
    sessionId: 's-1',
    note: body
      ? { body, version, updatedAt: '2026-10-05T10:00:00.000Z' }
      : null,
    clarifications: overrides.clarifications ?? [],
    nextStep: overrides.nextStep ? { version: 1, ...overrides.nextStep } : null,
  });

  const ok = (value: unknown) => ({ ok: true, json: async () => value });
  const failed = (status = 503) => ({
    ok: false,
    status,
    json: async () => ({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
      },
    }),
  });
  const flush = () =>
    act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const button = (label: string) =>
    Array.from(container.querySelectorAll('button')).find((item) =>
      item.textContent?.includes(label),
    ) ??
    (label === 'Request clarification'
      ? (openDetails('Request clarification'),
        Array.from(container.querySelectorAll('button')).find((item) =>
          item.textContent?.includes(label),
        ))
      : undefined);
  const retryButton = () =>
    container.querySelector<HTMLButtonElement>('#review-workflow-retry');
  const openDetails = (label: string) => {
    const summary = Array.from(container.querySelectorAll('summary')).find(
      (item) => item.textContent?.trim().startsWith(label),
    );
    if (summary?.parentElement instanceof HTMLDetailsElement)
      summary.parentElement.open = true;
  };
  const field = (selector: string) => {
    let input = container.querySelector<HTMLTextAreaElement>(selector);
    if (!input) {
      openDetails(
        selector.includes('clarification')
          ? 'Request clarification'
          : 'Human next step',
      );
      input = container.querySelector<HTMLTextAreaElement>(selector);
    }
    return input!;
  };
  const type = async (selector: string, value: string) => {
    const textarea = field(selector);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const callsWithMethod = (method: string) =>
    fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === method,
    );
  const clearDrafts = () => {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith('hirearchy-review-draft:')) {
        sessionStorage.removeItem(key);
      }
    }
  };

  beforeEach(() => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockReset();
    clearDrafts();
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    clearDrafts();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves a human draft through a 409 and makes replace or use-saved explicit', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method)
        return { ok: true, json: async () => workflow('Older saved note', 1) };
      if (init.body && JSON.parse(String(init.body)).action === 'save_note') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: { code: 'NOTE_CHANGED', message: 'This note changed.' },
          }),
        };
      }
      throw new Error('Unexpected workflow request.');
    });

    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));
    await flush();
    const textarea = field('#reviewer-note-body');
    await type('#reviewer-note-body', 'My unsaved reviewer draft');
    await act(async () => button('Save decision note')?.click());
    await flush();

    expect(container.textContent).toContain('My unsaved reviewer draft');
    expect(container.textContent).toContain(
      'The saved note changed while you were editing.',
    );
    expect(container.textContent).toContain('Older saved note');
    expect(container.textContent).toContain(
      'Keep my draft and replace saved version',
    );
    expect(textarea.value).toBe('My unsaved reviewer draft');
  });

  it('keeps optional follow-ups collapsed and shows the saved next-step state', async () => {
    fetchMock.mockImplementation(async () =>
      ok(
        workflow('Saved note', 1, {
          clarifications: [
            {
              id: 'clarification-1',
              prompt: 'What changed after the test run?',
              requestedAt: '2026-10-05T10:00:00.000Z',
              reply: null,
              repliedAt: null,
              closedAt: null,
            },
            {
              id: 'clarification-2',
              prompt: 'Was the later output also captured?',
              requestedAt: '2026-10-05T10:05:00.000Z',
              reply: 'Yes, it was saved in the same session.',
              repliedAt: '2026-10-05T10:10:00.000Z',
              closedAt: null,
            },
          ],
          nextStep: {
            action: 'technical_review',
            note: '',
            updatedAt: '2026-10-05T10:00:00.000Z',
          },
        }),
      ),
    );

    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));
    await flush();

    const disclosures = Array.from(
      container.querySelectorAll<HTMLDetailsElement>(
        'details.review-workflow-secondary',
      ),
    );
    expect(disclosures.map((details) => details.open)).toEqual([false, false]);
    expect(field('#reviewer-note-body')).not.toBeNull();
    expect(button('Check for candidate reply')).not.toBeUndefined();
    expect(disclosures[0]?.textContent).toContain('2 requests');
    expect(disclosures[0]?.textContent).toContain('1 awaiting reply');
    expect(disclosures[0]?.textContent).toContain('1 reply to close');
    expect(disclosures[1]?.textContent).toContain('Ask for a technical review');
  });

  it('preserves a next-step draft through a conflict and saves only after an explicit choice', async () => {
    let reads = 0;
    let saves = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method) {
        reads += 1;
        return ok(
          workflow('Saved note', 2, {
            nextStep:
              reads === 1
                ? {
                    action: 'continue_review',
                    note: 'Earlier choice',
                    updatedAt: '2026-10-05T10:00:00.000Z',
                    version: 1,
                  }
                : {
                    action: 'technical_review',
                    note: 'Saved by another evaluator',
                    updatedAt: '2026-10-05T10:05:00.000Z',
                    version: 2,
                  },
          }),
        );
      }

      saves += 1;
      if (saves === 1)
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: {
              code: 'NEXT_STEP_CHANGED',
              message: 'The saved next step changed.',
            },
          }),
        };
      const payload = JSON.parse(String(init.body)) as {
        step: string;
        note: string;
        expectedVersion: number;
      };
      return ok({
        nextStep: {
          action: payload.step,
          note: payload.note,
          updatedAt: '2026-10-05T10:10:00.000Z',
          version: 3,
        },
      });
    });

    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));
    await flush();
    await act(async () => {
      const select =
        container.querySelector<HTMLSelectElement>('#review-next-step')!;
      select.value = 'closeout';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await type('#review-next-step-note', 'My unsaved closeout draft');
    await act(async () => button('Save next step')?.click());
    await flush();

    expect(field('#review-next-step-note').value).toBe(
      'My unsaved closeout draft',
    );
    expect(container.textContent).toContain('Saved by another evaluator');
    expect(container.textContent).toContain(
      'The saved next step changed while you were editing.',
    );

    await act(async () =>
      button('Keep my draft and replace saved version')?.click(),
    );
    await act(async () => button('Save next step')?.click());
    await flush();

    const savesMade = callsWithMethod('POST');
    expect(savesMade).toHaveLength(2);
    expect(
      JSON.parse(String((savesMade[0]?.[1] as RequestInit).body)),
    ).toMatchObject({ expectedVersion: 1, step: 'closeout' });
    expect(JSON.parse(String((savesMade[1]?.[1] as RequestInit).body))).toEqual(
      {
        action: 'save_next_step',
        step: 'closeout',
        note: 'My unsaved closeout draft',
        expectedVersion: 2,
      },
    );
    expect(container.textContent).toContain('Human next step recorded.');
    expect(container.textContent).toContain('Record reviewer closeout');
  });

  it('shows a loading state instead of claiming no note exists before the read completes', async () => {
    let resolveRead:
      | ((value: { ok: boolean; json: () => Promise<unknown> }) => void)
      | undefined;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));
    expect(container.textContent).toContain('Loading saved note…');
    expect(container.textContent).not.toContain('No note saved yet.');

    await act(async () => {
      resolveRead?.({
        ok: true,
        json: async () => workflow('Saved review note', 2),
      });
    });
    expect(container.textContent).toContain('Saved review note');
    expect(container.textContent).not.toContain('Loading saved note…');
  });

  it('gates note, clarification and next-step editing until the first authoritative read succeeds', async () => {
    const firstRead = deferred<unknown>();
    fetchMock.mockReturnValueOnce(firstRead.promise);

    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));

    expect(field('#reviewer-note-body').disabled).toBe(true);
    expect(field('#clarification-prompt').disabled).toBe(true);
    expect(field('#review-next-step').disabled).toBe(true);
    expect(field('#review-next-step-note').disabled).toBe(true);
    expect(button('Save decision note')?.disabled).toBe(true);
    expect(button('Request clarification')?.disabled).toBe(true);
    expect(button('Save next step')?.disabled).toBe(true);
    expect(retryButton()).toBeNull();
    expect(container.textContent).toContain('Loading saved note…');
    expect(container.textContent).not.toContain('No note saved yet.');
    expect(container.textContent).not.toContain('No next step recorded.');
    expect(container.querySelector('ul.review-clarification-list')).toBeNull();

    await act(async () =>
      firstRead.resolve(ok(workflow('Server saved note', 4))),
    );
    await flush();

    expect(field('#reviewer-note-body').disabled).toBe(false);
    expect(field('#clarification-prompt').disabled).toBe(false);
    expect(field('#review-next-step').disabled).toBe(false);
    expect(field('#review-next-step-note').disabled).toBe(false);
    expect(field('#reviewer-note-body').value).toBe('Server saved note');
    expect(retryButton()).toBeNull();
    expect(container.textContent).not.toContain('Loading saved note…');
  });

  it('retries a failed initial read in place, hydrates the saved version and enables an ordinary save', async () => {
    const retryRead = deferred<unknown>();
    let reads = 0;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return Promise.resolve(
          ok({
            note: {
              body: 'Server saved note',
              version: 8,
              updatedAt: '2026-10-05T10:00:00.000Z',
            },
          }),
        );
      reads += 1;
      return reads === 1 ? Promise.resolve(failed()) : retryRead.promise;
    });

    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));
    await flush();

    expect(retryButton()).not.toBeNull();
    expect(retryButton()?.disabled).toBe(false);
    expect(retryButton()?.tagName).toBe('BUTTON');
    expect(retryButton()?.getAttribute('type')).toBe('button');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Review notes and follow-up could not be loaded.',
    );
    expect(container.textContent).not.toContain('Loading saved note…');
    expect(container.textContent).not.toContain('No note saved yet.');
    expect(container.textContent).not.toContain('No next step recorded.');
    expect(field('#reviewer-note-body').disabled).toBe(true);
    expect(field('#clarification-prompt').disabled).toBe(true);
    expect(field('#review-next-step').disabled).toBe(true);
    expect(field('#review-next-step-note').disabled).toBe(true);

    await act(async () => retryButton()?.click());

    await act(async () =>
      retryRead.resolve(
        ok(
          workflow('Server saved note', 8, {
            nextStep: {
              action: 'technical_review',
              note: 'Context kept',
              updatedAt: '2026-10-05T10:00:00.000Z',
            },
          }),
        ),
      ),
    );
    await flush();

    expect(field('#reviewer-note-body').value).toBe('Server saved note');
    expect(field('#review-next-step').value).toBe('technical_review');
    expect(field('#review-next-step-note').value).toBe('Context kept');
    expect(retryButton()).toBeNull();
    expect(container.textContent).not.toContain('could not be loaded');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(field('#reviewer-note-body').disabled).toBe(false);
    expect(field('#clarification-prompt').disabled).toBe(false);
    expect(field('#review-next-step').disabled).toBe(false);
    expect(field('#review-next-step-note').disabled).toBe(false);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/evaluator/sessions/s-1/review-workflow',
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual({ cache: 'no-store' });

    await act(async () => button('Save decision note')?.click());
    await flush();

    const saves = callsWithMethod('POST');
    expect(saves).toHaveLength(1);
    expect(JSON.parse(String((saves[0]?.[1] as RequestInit).body))).toEqual({
      action: 'save_note',
      body: 'Server saved note',
      expectedVersion: 8,
    });
    expect(container.textContent).toContain('Note saved for this review.');
  });

  it('disables the retry control during its own in-flight request and stays recoverable after repeated read failure without mutating anything', async () => {
    const secondRead = deferred<unknown>();
    let reads = 0;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method) throw new Error('Unexpected workflow request.');
      reads += 1;
      return reads === 1 ? Promise.resolve(failed()) : secondRead.promise;
    });

    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));
    await flush();
    expect(retryButton()?.disabled).toBe(false);

    await act(async () => retryButton()?.click());

    expect(retryButton()).not.toBeNull();
    expect(retryButton()?.disabled).toBe(true);
    expect(retryButton()?.getAttribute('aria-busy')).toBe('true');
    expect(field('#reviewer-note-body').disabled).toBe(true);
    expect(field('#clarification-prompt').disabled).toBe(true);
    expect(field('#review-next-step').disabled).toBe(true);
    expect(field('#review-next-step-note').disabled).toBe(true);

    await act(async () => secondRead.resolve(failed()));
    await flush();

    expect(retryButton()).not.toBeNull();
    expect(retryButton()?.disabled).toBe(false);
    expect(retryButton()?.getAttribute('aria-busy')).toBe('false');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Review notes and follow-up could not be loaded.',
    );
    expect(field('#reviewer-note-body').disabled).toBe(true);
    expect(field('#clarification-prompt').disabled).toBe(true);
    expect(field('#review-next-step').disabled).toBe(true);
    expect(field('#review-next-step-note').disabled).toBe(true);
    expect(
      fetchMock.mock.calls.every(
        ([, init]) => !(init as RequestInit | undefined)?.method,
      ),
    ).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('keeps a loaded human draft through an action refresh and records the clarification', async () => {
    const cryptoSpy = vi.spyOn(globalThis.crypto, 'randomUUID');
    const clarification = {
      id: 'c-1',
      prompt: 'Why did you choose that retry?',
      requestedAt: '2026-10-05T10:00:00.000Z',
      reply: null,
      repliedAt: null,
      closedAt: null,
    };
    let reads = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method) {
        reads += 1;
        return reads === 1
          ? ok(workflow('Server saved note', 3))
          : ok(
              workflow('Server saved note', 3, {
                clarifications: [clarification],
              }),
            );
      }
      if (JSON.parse(String(init.body)).action === 'request_clarification')
        return ok({ clarification });
      throw new Error('Unexpected workflow request.');
    });

    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));
    await flush();
    await type('#reviewer-note-body', 'Draft that must survive');
    await type('#clarification-prompt', 'Why did you choose that retry?');
    await act(async () => button('Request clarification')?.click());
    await flush();

    expect(field('#reviewer-note-body').value).toBe('Draft that must survive');
    expect(container.textContent).toContain('Why did you choose that retry?');
    expect(container.textContent).toContain(
      'Clarification request recorded on the candidate session. No email was sent.',
    );
    expect(retryButton()).toBeNull();
    expect(
      container.querySelector('ul.review-clarification-list'),
    ).not.toBeNull();
    expect(callsWithMethod('POST')).toHaveLength(1);
    // `crypto.randomUUID` is already a spy here: if happy-dom did not provide it
    // the component would have thrown before the request reached the mock.
    expect(cryptoSpy).toHaveBeenCalled();
  });

  it('refreshes a candidate reply without replacing evaluator drafts', async () => {
    const clarification = {
      id: 'c-1',
      prompt: 'What did the duplicate-event guard do?',
      requestedAt: '2026-10-05T10:00:00.000Z',
      reply: null,
      repliedAt: null,
      closedAt: null,
    };
    let reads = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method) throw new Error('Unexpected workflow request.');
      reads += 1;
      return ok(
        workflow('Saved note', 2, {
          clarifications: [
            reads === 1
              ? clarification
              : {
                  ...clarification,
                  reply: 'It prevents a duplicate notification.',
                  repliedAt: '2026-10-05T10:04:00.000Z',
                },
          ],
          nextStep: {
            action: 'continue_review',
            note: 'Draft next step',
            updatedAt: '2026-10-05T10:00:00.000Z',
          },
        }),
      );
    });

    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));
    await flush();
    await type('#reviewer-note-body', 'Unsaved evaluator note');
    await type('#review-next-step-note', 'Unsaved next-step context');
    await act(async () => button('Check for candidate reply')?.click());
    await flush();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/evaluator/sessions/s-1/review-workflow',
      '/api/evaluator/sessions/s-1/review-workflow',
    ]);
    expect(container.textContent).toContain(
      'Candidate reply · not independently verified',
    );
    expect(container.textContent).toContain(
      'It prevents a duplicate notification.',
    );
    expect(field('#reviewer-note-body').value).toBe('Unsaved evaluator note');
    expect(field('#review-next-step-note').value).toBe(
      'Unsaved next-step context',
    );
    expect(container.textContent).toContain('Review follow-up refreshed.');
  });

  it('keeps refresh keyboard focus available while a read is pending', async () => {
    const pending = deferred<ReturnType<typeof ok>>();
    fetchMock
      .mockResolvedValueOnce(ok(workflow('Saved note', 2)))
      .mockReturnValueOnce(pending.promise);

    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));
    await flush();
    await act(async () => button('Check for candidate reply')?.click());

    const checking = button('Checking…');
    expect(checking?.disabled).toBe(false);
    expect(checking?.getAttribute('aria-busy')).toBe('true');

    await act(async () => checking?.click());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => pending.resolve(ok(workflow('Saved note', 2))));
    await flush();
  });

  it('reports refresh errors while preserving evaluator drafts', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(workflow('Saved note', 2)))
      .mockResolvedValueOnce(failed());

    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));
    await flush();
    await type('#reviewer-note-body', 'Unsaved evaluator note');
    await act(async () => button('Check for candidate reply')?.click());
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Review follow-up could not be refreshed.',
    );
    expect(field('#reviewer-note-body').value).toBe('Unsaved evaluator note');
  });

  it('ignores a stale read and never exposes or saves the previous session workflow under a new sessionId', async () => {
    const sessionOne = deferred<unknown>();
    const sessionTwo = deferred<unknown>();
    const sessionThree = deferred<unknown>();
    let reads = 0;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method) throw new Error('Unexpected workflow request.');
      reads += 1;
      return [sessionOne, sessionTwo, sessionThree][reads - 1]?.promise;
    });

    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));
    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-2" />));

    // Part B: nothing from s-1 may be visible or savable while s-2 is loading.
    expect(field('#reviewer-note-body').value).toBe('');
    expect(field('#reviewer-note-body').disabled).toBe(true);
    expect(button('Save decision note')?.disabled).toBe(true);
    expect(button('Request clarification')?.disabled).toBe(true);
    expect(button('Save next step')?.disabled).toBe(true);
    expect(container.textContent).not.toContain('Session one note');
    expect(container.textContent).not.toContain('Session one question');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/evaluator/sessions/s-1/review-workflow',
      '/api/evaluator/sessions/s-2/review-workflow',
    ]);

    await act(async () =>
      sessionTwo.resolve(
        ok(
          workflow('Session two note', 1, {
            clarifications: [
              {
                id: 'c-2',
                prompt: 'Session two question',
                requestedAt: '2026-10-05T10:00:00.000Z',
                reply: null,
                repliedAt: null,
                closedAt: null,
              },
            ],
          }),
        ),
      ),
    );
    await flush();
    expect(field('#reviewer-note-body').value).toBe('Session two note');
    expect(container.textContent).toContain('Session two question');

    // Part A: the superseded s-1 read must be ignored once s-2 has settled.
    await act(async () =>
      sessionOne.resolve(ok(workflow('Session one note', 9))),
    );
    await flush();
    expect(field('#reviewer-note-body').value).toBe('Session two note');
    expect(container.textContent).not.toContain('Session one note');
    expect(
      container.querySelector('ul.review-clarification-list')?.textContent,
    ).not.toContain('Session one question');

    // A loaded session must not bleed into the next session either.
    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-3" />));
    expect(field('#reviewer-note-body').value).toBe('');
    expect(field('#reviewer-note-body').disabled).toBe(true);
    expect(button('Save decision note')?.disabled).toBe(true);
    expect(container.textContent).not.toContain('Session two note');
    expect(container.textContent).not.toContain('Session two question');
    expect(callsWithMethod('POST')).toHaveLength(0);

    await act(async () =>
      sessionThree.resolve(ok(workflow('Session three note', 2))),
    );
    await flush();
    expect(field('#reviewer-note-body').value).toBe('Session three note');
    expect(field('#reviewer-note-body').disabled).toBe(false);
    expect(callsWithMethod('POST')).toHaveLength(0);
  });

  it('drops in-flight retry responses when unmounted or when sessionId changes', async () => {
    const s1Initial = deferred<unknown>();
    const s1Retry = deferred<unknown>();
    let s1Reads = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method) throw new Error('Unexpected workflow request.');
      if (url.includes('s-1')) {
        s1Reads += 1;
        return s1Reads === 1 ? s1Initial.promise : s1Retry.promise;
      }
      return Promise.resolve(ok(workflow('Session two note', 5)));
    });

    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));
    await act(async () => s1Initial.resolve(failed()));
    await flush();

    expect(retryButton()).not.toBeNull();
    await act(async () => retryButton()?.click());
    expect(retryButton()?.disabled).toBe(true);

    // Switch to s-2 while s-1 retry is still pending
    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-2" />));
    await flush();

    expect(field('#reviewer-note-body').value).toBe('Session two note');
    expect(retryButton()).toBeNull();

    // Now let the delayed s-1 retry resolve
    await act(async () => s1Retry.resolve(ok(workflow('Late s-1 note', 10))));
    await flush();

    // Ensure late s-1 response didn't overwrite s-2 state
    expect(field('#reviewer-note-body').value).toBe('Session two note');
    expect(container.textContent).not.toContain('Late s-1 note');
  });

  it('resets typed clarification question and request key when switching from loaded session A to session B', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('session-a')) {
        return ok(workflow('Session A note', 1));
      }
      return ok(workflow('Session B note', 2));
    });

    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId="session-a" />),
    );
    await flush();

    expect(field('#clarification-prompt').value).toBe('');
    await type('#clarification-prompt', 'Session A specific question?');
    expect(field('#clarification-prompt').value).toBe(
      'Session A specific question?',
    );

    // Switch to session-b
    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId="session-b" />),
    );
    await flush();

    expect(field('#clarification-prompt').value).toBe('');
    expect(field('#reviewer-note-body').value).toBe('Session B note');
    expect(container.textContent).not.toContain('Session A specific question?');
  });

  it('drops delayed session A save completion when session B has loaded', async () => {
    let finishSaveA!: (value: unknown) => void;
    const saveAPromise = new Promise((resolve) => {
      finishSaveA = resolve;
    });

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (url.includes('session-a')) return saveAPromise;
        return Promise.resolve(
          ok({
            note: {
              body: 'Session B saved note',
              version: 4,
              updatedAt: '2026-10-05T10:00:00.000Z',
            },
          }),
        );
      }
      if (url.includes('session-a'))
        return Promise.resolve(ok(workflow('Session A note', 1)));
      return Promise.resolve(ok(workflow('Session B note', 3)));
    });

    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId="session-a" />),
    );
    await flush();

    await type('#reviewer-note-body', 'Session A edited note');
    await act(async () => button('Save decision note')?.click());

    // Switch to session-b before A save finishes
    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId="session-b" />),
    );
    await flush();

    expect(field('#reviewer-note-body').value).toBe('Session B note');

    // Finish A save late
    await act(async () =>
      finishSaveA(
        ok({
          note: {
            body: 'Session A late saved body',
            version: 99,
            updatedAt: '2026-10-05T10:00:00.000Z',
          },
        }),
      ),
    );
    await flush();

    // Verify session B state was not corrupted by late A save completion
    expect(field('#reviewer-note-body').value).toBe('Session B note');
    expect(container.textContent).not.toContain('Note saved for this review.');
    expect(container.textContent).not.toContain('Session A late saved body');

    // Save on session B should submit version 3 (B's version), not 99
    await act(async () => button('Save decision note')?.click());
    await flush();

    const postCalls = callsWithMethod('POST');
    expect(postCalls).toHaveLength(2);
    expect(JSON.parse(String(postCalls[1][1]!.body)).expectedVersion).toBe(3);
  });

  it('ignores stale session A save failure or 409 conflict after switching to session B', async () => {
    let failSaveA!: (value: unknown) => void;
    const saveAFailure = new Promise((resolve) => {
      failSaveA = resolve;
    });

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return saveAFailure;
      }
      if (url.includes('session-a'))
        return Promise.resolve(ok(workflow('Session A note', 1)));
      return Promise.resolve(ok(workflow('Session B note', 2)));
    });

    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId="session-a" />),
    );
    await flush();

    await type('#reviewer-note-body', 'Session A edited note');
    await act(async () => button('Save decision note')?.click());

    // Switch to session-b
    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId="session-b" />),
    );
    await flush();

    // Trigger 409 conflict on late session A save
    await act(async () =>
      failSaveA({
        ok: false,
        status: 409,
        json: async () => ({
          error: { code: 'NOTE_CHANGED', message: 'Stale note changed' },
        }),
      }),
    );
    await flush();

    // Session B should have no error, no conflict banner, and no follow-up conflict reads for session A
    expect(container.querySelector('.review-workflow-error')).toBeNull();
    expect(container.querySelector('.review-note-conflict')).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('session-a')),
    ).toHaveLength(2); // 1 initial read + 1 post
  });

  it('keeps retry-finally isolated so stale session retry settling does not affect active session', async () => {
    const s1Retry = deferred<unknown>();
    let reads = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('s-1')) {
        reads += 1;
        return reads === 1 ? Promise.resolve(failed()) : s1Retry.promise;
      }
      return Promise.resolve(failed(500));
    });

    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-1" />));
    await flush();

    expect(retryButton()).not.toBeNull();
    await act(async () => retryButton()?.click());
    expect(retryButton()?.disabled).toBe(true);

    // Switch to s-2 while s-1 retry is pending
    await act(async () => root.render(<ReviewWorkflowPanel sessionId="s-2" />));
    await flush();

    expect(retryButton()?.disabled).toBe(false);

    // Let s-1 retry resolve
    await act(async () => s1Retry.resolve(failed()));
    await flush();

    // s-2 retry button remains enabled and uncorrupted
    expect(retryButton()?.disabled).toBe(false);
  });

  it('prevents stale session A save continuation from mutating state after A -> B -> A cycle', async () => {
    let finishSaveA1!: (value: unknown) => void;
    const saveA1Promise = new Promise((resolve) => {
      finishSaveA1 = resolve;
    });

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return saveA1Promise;
      }
      if (url.includes('session-a')) {
        return Promise.resolve(ok(workflow('Session A initial note', 1)));
      }
      return Promise.resolve(ok(workflow('Session B note', 2)));
    });

    // 1. Initial mount on session-a
    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId="session-a" />),
    );
    await flush();
    expect(field('#reviewer-note-body').value).toBe('Session A initial note');

    // 2. Start save on session-a
    await type('#reviewer-note-body', 'Draft from first visit');
    await act(async () => button('Save decision note')?.click());
    expect(button('Save decision note')?.disabled).toBe(true);

    // 3. Switch to session-b
    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId="session-b" />),
    );
    await flush();
    expect(field('#reviewer-note-body').value).toBe('Session B note');

    // 4. Switch back to session-a (A -> B -> A)
    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId="session-a" />),
    );
    await flush();
    expect(field('#reviewer-note-body').value).toBe('Draft from first visit');

    // 5. Late completion of the first visit's save
    await act(async () =>
      finishSaveA1(
        ok({
          note: {
            body: 'Late response from first visit',
            version: 99,
            updatedAt: '2026-10-05T10:00:00.000Z',
          },
        }),
      ),
    );
    await flush();

    // Verify session-a state is NOT overwritten by the stale generation's completion
    expect(field('#reviewer-note-body').value).toBe('Draft from first visit');
    expect(container.textContent).not.toContain('Note saved for this review.');
    expect(container.textContent).not.toContain(
      'Late response from first visit',
    );
  });

  it('prevents stale retry1 finalizer from clearing retry2 busy state after A -> B -> A cycle', async () => {
    const retry1 = deferred<unknown>();
    const retry2 = deferred<unknown>();
    let aReadCount = 0;

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('session-a')) {
        aReadCount += 1;
        if (aReadCount === 1) return Promise.resolve(failed()); // Initial read on visit 1
        if (aReadCount === 2) return retry1.promise; // retry 1 on visit 1
        if (aReadCount === 3) return Promise.resolve(failed()); // Initial read on visit 2
        return retry2.promise; // retry 2 on visit 2
      }
      return Promise.resolve(ok(workflow('Session B note', 1)));
    });

    // 1. Visit 1: mount session-a (fails initial read)
    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId="session-a" />),
    );
    await flush();
    expect(retryButton()).not.toBeNull();
    expect(retryButton()?.disabled).toBe(false);

    // 2. Start retry1 on visit 1
    await act(async () => retryButton()?.click());
    expect(retryButton()?.disabled).toBe(true);

    // 3. Switch to session-b
    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId="session-b" />),
    );
    await flush();

    // 4. Switch back to session-a (A -> B -> A)
    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId="session-a" />),
    );
    await flush();
    expect(retryButton()).not.toBeNull();
    expect(retryButton()?.disabled).toBe(false);

    // 5. Start retry2 on visit 2
    await act(async () => retryButton()?.click());
    expect(retryButton()?.disabled).toBe(true);

    // 6. Settle retry1 from visit 1 late
    await act(async () => retry1.resolve(failed()));
    await flush();

    // 7. retry2 should still be active and busy (disabled = true)
    expect(retryButton()?.disabled).toBe(true);

    // 8. Settle retry2
    await act(async () =>
      retry2.resolve(ok(workflow('Hydrated from retry 2', 5))),
    );
    await flush();

    // 9. Now ready
    expect(field('#reviewer-note-body').value).toBe('Hydrated from retry 2');
    expect(retryButton()).toBeNull();
  });

  it('restores unsaved reviewer drafts after the panel is remounted', async () => {
    const sessionId = 'draft-restore-session';
    fetchMock.mockResolvedValue(ok(workflow('Saved note', 2)));

    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId={sessionId} />),
    );
    await flush();
    await type('#reviewer-note-body', 'Unsaved review note');
    await type('#clarification-prompt', 'Unsaved clarification question');
    await act(async () => {
      const select =
        container.querySelector<HTMLSelectElement>('#review-next-step')!;
      select.value = 'technical_review';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await type('#review-next-step-note', 'Unsaved next-step context');
    await flush();

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(<ReviewWorkflowPanel sessionId={sessionId} />),
    );
    await flush();

    expect(field('#reviewer-note-body').value).toBe('Unsaved review note');
    expect(field('#clarification-prompt').value).toBe(
      'Unsaved clarification question',
    );
    expect(
      container.querySelector<HTMLSelectElement>('#review-next-step')?.value,
    ).toBe('technical_review');
    expect(field('#review-next-step-note').value).toBe(
      'Unsaved next-step context',
    );
    sessionStorage.removeItem(`hirearchy-review-draft:${sessionId}`);
  });
});
