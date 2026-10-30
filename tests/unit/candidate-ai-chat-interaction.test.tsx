// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CandidateAiPanel } from '../../apps/web/app/candidate/[token]/candidate-ai-panel';

it('sends chosen saved-file references, keeps a fresh follow-up composer, and blocks ambiguous resending', async () => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'COMPLETED',
          responseText:
            '**Inspect** the `boundary`.\n```python\nprint("<script>")\n```',
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'DISPATCH_STARTED',
          terminalReason: 'AMBIGUOUS_DISPATCH',
        }),
      ),
    );
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const input = () => container.querySelector('textarea')!;
  const type = (text: string) => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const send = () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  try {
    await act(async () =>
      root.render(
        <CandidateAiPanel
          token="synthetic-token"
          sessionStatus="ACTIVE"
          aiCapability={{ enabled: true, includesWorkspaceContext: true }}
          activeFilePath="src/main.py"
          workspaceFiles={[
            'src/main.py',
            'tests/test_main.py',
            'README.md',
            'other.py',
          ].map((path) => ({ path, isDirectory: false }))}
        />,
      ),
    );
    await act(async () => {
      (
        container.querySelector(
          'input[value="tests/test_main.py"]',
        ) as HTMLInputElement
      ).click();
      (
        container.querySelector('.weft-ai-terminal') as HTMLButtonElement
      ).click();
    });
    expect(input().value).toBe('@terminal ');
    await act(async () => {
      type('@terminal Explain the failing test');
    });
    await act(async () => {
      send();
    });
    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(first.candidateContext).toEqual([
      { filePath: 'src/main.py' },
      { filePath: 'tests/test_main.py' },
    ]);
    expect(first.candidatePromptText).toBe(
      '@terminal Explain the failing test',
    );
    expect(input().value).toBe('');
    expect(
      container.querySelector('.weft-ai-body--weft pre code')?.textContent,
    ).toBe('print("<script>")\n');
    expect(container.querySelector('script')).toBeNull();
    expect(
      container.querySelector('.weft-ai-body--weft strong')?.textContent,
    ).toBe('Inspect');
    expect(
      container.querySelector('.weft-ai-body--weft p code')?.textContent,
    ).toBe('boundary');
    await act(async () => {
      type('Explain a different approach');
    });
    await act(async () => {
      send();
    });
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(second.clientRequestId).not.toBe(first.clientRequestId);
    expect(second.candidatePromptText).toBe('Explain a different approach');
    expect(container.querySelectorAll('.weft-ai-exchange')).toHaveLength(2);
    expect(
      (container.querySelector('.weft-ai-send') as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      send();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('may already be in progress');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
