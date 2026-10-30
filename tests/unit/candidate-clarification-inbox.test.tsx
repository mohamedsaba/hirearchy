// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClarificationInbox } from '../../apps/web/app/candidate/[token]/clarification-inbox';

const request = {
  id: 'clarification-1',
  prompt: 'What does the duplicate-event check protect?',
  requestedAt: '2026-10-01T10:00:00Z',
  reply: null,
  repliedAt: null,
  closedAt: null,
};
const response = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

describe('candidate clarification inbox', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
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

  it('records candidate communication separately and acknowledges only confirmed saves', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ clarifications: [request] }))
      .mockResolvedValueOnce(
        response({
          clarification: {
            ...request,
            reply: 'It prevents duplicate booking emails.',
            repliedAt: '2026-10-01T10:04:00Z',
          },
        }),
      );
    await act(async () =>
      root.render(<ClarificationInbox token="candidate-token" />),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      'These questions and your replies are a separate conversation.',
    );
    expect(container.textContent).toContain(request.prompt);
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      );
      descriptor?.set?.call(textarea, 'It prevents duplicate booking emails.');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Record reply',
    );
    await act(async () => {
      submit?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/candidate/sessions/candidate-token/clarifications',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          id: request.id,
          reply: 'It prevents duplicate booking emails.',
        }),
      }),
    );
    expect(container.textContent).toContain(
      'Reply recorded. Your submitted workspace remains closed and unchanged.',
    );
    expect(container.textContent).toContain(
      'It prevents duplicate booking emails.',
    );
  });

  it('retains a reply draft when the server does not confirm it', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ clarifications: [request] }))
      .mockResolvedValueOnce(
        response(
          { error: { message: 'The request could not be completed.' } },
          503,
        ),
      );
    await act(async () =>
      root.render(<ClarificationInbox token="candidate-token" />),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const textarea = container.querySelector('textarea');
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      );
      descriptor?.set?.call(textarea, 'I checked the source after submitting.');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Record reply',
    );
    await act(async () => {
      submit?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('textarea')?.value).toBe(
      'I checked the source after submitting.',
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'The request could not be completed.',
    );
  });
});
