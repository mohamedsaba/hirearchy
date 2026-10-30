// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CandidateWorkspace } from '../../apps/web/app/candidate/[token]/candidate-workspace';
import type { CommandHistoryEntry } from '../../apps/web/app/candidate/[token]/candidate-command-state';
import type { CandidateSessionView } from '../../apps/web/src/sessions/candidate-session-view';

const activeSessionFixture: CandidateSessionView = {
  id: 'session-candidate-ui-test',
  scenario: {
    id: 'scenario-001',
    title: 'Distributed Inventory Cache',
    version: '1.0.0',
    type: 'single_file',
    brief: 'Correct stale inventory reads.',
    acceptanceCriteria: ['Keep cache entries current.'],
    filePath: 'inventory/service.py',
  },
  status: 'ACTIVE',
  workingContent: 'def get_inventory():\n    return []\n',
  createdAt: '2026-09-22T10:00:00.000Z',
  activatedAt: '2026-09-22T10:01:00.000Z',
  submittedAt: null,
  durationSeconds: 3600,
  deadline: '2026-09-23T10:01:00.000Z',
  serverTime: '2026-09-22T10:01:00.000Z',
  closureReason: null,
  scenarioType: 'single_file',
  terminalEnabled: true,
  aiCapability: { enabled: true },
};

const setInputValue = (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) => {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('Candidate workspace presentation interactions', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ files: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  const renderWorkspace = async (
    session: CandidateSessionView = activeSessionFixture,
    initialCommands?: readonly CommandHistoryEntry[],
  ) => {
    await act(async () => {
      root?.render(
        <CandidateWorkspace
          initialSession={session}
          token="candidate-token"
          initialCommands={initialCommands}
        />,
      );
    });
  };

  it('switches the right panel between task context and the integrated AI tool', async () => {
    await renderWorkspace();
    const tabs = container?.querySelectorAll<HTMLButtonElement>(
      '.candidate-side-tabs button',
    );
    expect(tabs).toHaveLength(2);
    const [taskTab, aiTab] = Array.from(tabs!).slice(0, 2);
    expect(taskTab.textContent).toBe('Task');
    expect(taskTab.getAttribute('aria-controls')).toBe('workspace-scenario');
    expect(taskTab.getAttribute('aria-pressed')).toBe('true');
    expect(aiTab.textContent).toBe('Weft');
    expect(aiTab.getAttribute('aria-controls')).toBe('workspace-ai');
    expect(aiTab.getAttribute('aria-pressed')).toBe('false');
    expect(container?.querySelector('#scenario-title')?.textContent).toBe(
      'Distributed Inventory Cache',
    );

    await act(async () => aiTab.click());
    expect(
      container?.querySelector('.candidate-workbench')?.className,
    ).toContain('workspace-view-ai');
    expect(aiTab.getAttribute('aria-pressed')).toBe('true');
    expect(container?.querySelector('#candidate-ai-prompt')).not.toBeNull();

    await act(async () => taskTab.click());
    expect(
      container?.querySelector('.candidate-workbench')?.className,
    ).toContain('workspace-view-scenario');
    expect(taskTab.getAttribute('aria-pressed')).toBe('true');
    expect(container?.querySelector('#candidate-ai-prompt')).not.toBeNull();
  });

  it('keeps the editor, command input, and AI prompt mounted while switching context', async () => {
    await renderWorkspace();
    const editor = container?.querySelector<HTMLDivElement>(
      '.candidate-editor-buffer',
    );
    const codeContent = container?.querySelector<HTMLElement>(
      '.candidate-code-editor .cm-content',
    );
    const editorWrapper = container?.querySelector<HTMLElement>(
      '.candidate-code-editor',
    );
    const scenarioPanel = container?.querySelector<HTMLElement>('.brief-panel');
    const command =
      container?.querySelector<HTMLInputElement>('.terminal-input');
    const prompt = container?.querySelector<HTMLTextAreaElement>(
      '#candidate-ai-prompt',
    );
    expect(editor).not.toBeNull();
    expect(command).not.toBeNull();
    expect(prompt).not.toBeNull();
    expect(editorWrapper?.hasAttribute('aria-label')).toBe(false);
    expect(scenarioPanel?.tabIndex).toBe(0);
    expect(codeContent?.getAttribute('aria-label')).toBe(
      'Edit inventory/service.py',
    );
    expect(codeContent?.getAttribute('contenteditable')).toBe('true');
    expect(codeContent?.getAttribute('tabindex')).toBe('0');
    expect(codeContent?.textContent).toContain('def get_inventory()');
    await act(async () => {
      setInputValue(command!, 'npm test');
      setInputValue(prompt!, 'What should I verify?');
    });

    const aiTab = container?.querySelector<HTMLButtonElement>(
      '.candidate-side-tabs button:nth-child(2)',
    );
    await act(async () => aiTab?.click());
    expect(container?.querySelector('.candidate-editor-buffer')).toBe(editor);
    expect(container?.querySelector('.terminal-input')).toBe(command);
    expect(container?.querySelector('#candidate-ai-prompt')).toBe(prompt);
    expect(container?.querySelector('.candidate-editor-buffer')).toBe(editor);
    expect(
      container?.querySelector('.candidate-code-editor .cm-content')
        ?.textContent,
    ).toContain('def get_inventory()');
    expect(command?.value).toBe('npm test');
    expect(prompt?.value).toBe('What should I verify?');
  });

  it('restores editor preferences while leaving the server-provided code buffer intact', async () => {
    await renderWorkspace();
    const settings = container?.querySelector<HTMLDetailsElement>(
      '.candidate-editor-settings',
    );
    const editor = container?.querySelector<HTMLDivElement>(
      '.candidate-editor-buffer',
    );
    const codeContent = container?.querySelector<HTMLElement>(
      '.candidate-code-editor .cm-content',
    );
    const size = container?.querySelector<HTMLInputElement>(
      'input[name="candidate-editor-font-size"][value="18"]',
    );
    const darkTheme = container?.querySelector<HTMLInputElement>(
      'input[name="candidate-editor-theme"][value="dark"]',
    );
    const wrap = container?.querySelector<HTMLInputElement>(
      '.candidate-editor-wrap-setting input',
    );
    expect(settings?.querySelector('summary')?.textContent).toBe(
      'Editor settings',
    );
    expect(size).not.toBeNull();
    expect(darkTheme).not.toBeNull();
    expect(wrap).not.toBeNull();

    await act(async () => {
      size!.click();
      darkTheme!.click();
      wrap!.click();
    });
    expect(editor?.dataset.fontSize).toBe('18');
    expect(editor?.dataset.theme).toBe('dark');
    expect(editor?.dataset.wordWrap).toBe('off');
    expect(codeContent?.textContent).toContain('def get_inventory()');
    expect(codeContent?.textContent).toContain('return []');
    expect(
      window.localStorage.getItem('hirearchy:candidate-editor-preferences:v1'),
    ).toBe('{"fontSize":18,"theme":"dark","wordWrap":false}');
  });

  it('runs the authored scenario verification command through the command endpoint', async () => {
    const scenario002Session: CandidateSessionView = {
      ...activeSessionFixture,
      scenario: {
        ...activeSessionFixture.scenario,
        id: 'scenario-002-booking-notification-retry',
        type: 'single_file',
      },
      scenarioType: 'single_file',
    };
    await renderWorkspace(scenario002Session);

    const runChecks = container?.querySelector<HTMLButtonElement>(
      '.candidate-run-checks',
    );
    expect(runChecks?.textContent).toBe('Run checks');
    await act(async () => runChecks?.click());

    const commandCall = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).endsWith('/terminal/exec'));
    expect(commandCall).toBeDefined();
    expect(JSON.parse(String(commandCall?.[1]?.body))).toEqual({
      command: 'pytest',
    });
    expect(
      container?.querySelector<HTMLDetailsElement>('.terminal-details')?.open,
    ).toBe(true);
  });

  it('keeps terminal controls unavailable when the session disables commands', async () => {
    const disabledTerminalSession: CandidateSessionView = {
      ...activeSessionFixture,
      scenario: {
        ...activeSessionFixture.scenario,
        id: 'scenario-002-booking-notification-retry',
        type: 'multi_file',
      },
      scenarioType: 'multi_file',
      terminalEnabled: false,
    };
    await renderWorkspace(disabledTerminalSession);

    expect(
      container?.querySelector('.candidate-terminal-status')?.textContent,
    ).toBe('Disabled');
    expect(
      container
        ?.querySelector('.candidate-terminal-status')
        ?.getAttribute('aria-label'),
    ).toBe('Terminal disabled for this assessment');
    expect(
      container?.querySelector<HTMLInputElement>('.terminal-input')?.disabled,
    ).toBe(true);
    expect(container?.querySelector('.candidate-run-checks')).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/terminal/exec') && init?.method === 'POST',
        ),
    ).toBe(false);
  });

  it('keeps a multi-file editor read-only until its initial workspace file loads, including valid empty files', async () => {
    let resolveTree!: (response: Response) => void;
    let resolveFile!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspace/tree')) {
        return new Promise<Response>((resolve) => {
          resolveTree = resolve;
        });
      }
      if (url.includes('/workspace/file?path=')) {
        return new Promise<Response>((resolve) => {
          resolveFile = resolve;
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ files: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const multiFileSession: CandidateSessionView = {
      ...activeSessionFixture,
      scenario: {
        ...activeSessionFixture.scenario,
        type: 'multi_file',
      },
      scenarioType: 'multi_file',
      workingContent: '',
    };

    await renderWorkspace(multiFileSession);
    const content = container?.querySelector<HTMLElement>(
      '.candidate-code-editor .cm-content',
    );
    const save = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((button) => button.textContent?.trim() === 'Save');
    expect(content?.getAttribute('contenteditable')).toBe('false');
    expect(
      container?.querySelector('.candidate-file-load-status')?.textContent,
    ).toContain('Loading workspace file');
    expect(container?.querySelector('[role="status"]')?.textContent).toBe(
      'Loading workspace…',
    );
    expect(save?.disabled).toBe(true);
    expect(
      container?.querySelector<HTMLButtonElement>(
        '.workspace-session-actions button',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      resolveTree(
        new Response(
          JSON.stringify({
            files: [
              { path: 'bookings/service.py', size: 0, isDirectory: false },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await Promise.resolve();
    });
    expect(content?.getAttribute('contenteditable')).toBe('false');

    await act(async () => {
      resolveFile(
        new Response(
          JSON.stringify({ path: 'bookings/service.py', content: '' }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
      await Promise.resolve();
    });
    expect(content?.getAttribute('contenteditable')).toBe('true');
    expect(content?.textContent).toBe('');
    expect(
      container?.querySelector('.candidate-save-indicator')?.textContent,
    ).toBe('Saved');
    expect(container?.querySelector('.candidate-file-load-status')).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/working-copy') && init?.method === 'PUT',
      ),
    ).toBe(false);
  });

  it('opens submission review accessibly and restores focus without changing session state', async () => {
    await renderWorkspace();
    const reviewButton = container?.querySelector<HTMLButtonElement>(
      '.workspace-session-actions button',
    );
    expect(reviewButton?.textContent?.trim()).toBe('Review submission');

    await act(async () => reviewButton?.click());
    const reviewHeading = container?.querySelector<HTMLHeadingElement>(
      '#submission-review-title',
    );
    expect(reviewHeading).not.toBeNull();
    expect(document.activeElement).toBe(reviewHeading);
    expect(
      container?.querySelector('div[inert]')?.getAttribute('aria-hidden'),
    ).toBe('true');

    const backButton = container?.querySelector<HTMLButtonElement>(
      '.submission-review .button-secondary',
    );
    await act(async () => backButton?.click());
    expect(container?.querySelector('div[inert]')).toBeNull();
    const restoredReviewButton = container?.querySelector<HTMLButtonElement>(
      '.workspace-session-actions button',
    );
    expect(restoredReviewButton).not.toBeNull();
    expect(document.activeElement).toBe(restoredReviewButton);
    expect(
      container
        ?.querySelector('[data-workspace-state]')
        ?.getAttribute('data-workspace-state'),
    ).toBe('ACTIVE_WORKSPACE');
  });

  it('switches mobile workspace views while preserving editor, terminal, and AI state in memory', async () => {
    await renderWorkspace();
    const workbench = container?.querySelector<HTMLDivElement>(
      '.candidate-workbench',
    );
    const mobileNavButtons = container?.querySelectorAll<HTMLButtonElement>(
      '.candidate-mobile-nav button',
    );
    expect(mobileNavButtons).toHaveLength(4);
    const [codeBtn, taskBtn, runBtn, aiBtn] = Array.from(mobileNavButtons!);
    expect(codeBtn.textContent?.trim()).toBe('Code');
    expect(taskBtn.textContent?.trim()).toBe('Task');
    expect(runBtn.textContent?.trim()).toBe('Run');
    expect(aiBtn.textContent?.trim()).toBe('Weft');

    const editor = container?.querySelector<HTMLDivElement>(
      '.candidate-editor-buffer',
    );
    const command =
      container?.querySelector<HTMLInputElement>('.terminal-input');
    const prompt = container?.querySelector<HTMLTextAreaElement>(
      '#candidate-ai-prompt',
    );
    const terminalDetails =
      container?.querySelector<HTMLDetailsElement>('.terminal-details');

    expect(editor).not.toBeNull();
    expect(command).not.toBeNull();
    expect(prompt).not.toBeNull();
    expect(terminalDetails).not.toBeNull();
    expect(workbench?.getAttribute('data-mobile-view')).toBe('code');
    expect(codeBtn.getAttribute('aria-current')).toBe('page');
    expect(taskBtn.getAttribute('aria-current')).toBeNull();
    expect(runBtn.getAttribute('aria-current')).toBeNull();
    expect(aiBtn.getAttribute('aria-current')).toBeNull();
    expect(terminalDetails?.open).toBeFalsy();

    await act(async () => {
      setInputValue(command!, 'python -m unittest');
      setInputValue(prompt!, 'Explain cache invalidation');
    });

    // code -> task
    await act(async () => taskBtn.click());
    expect(workbench?.getAttribute('data-mobile-view')).toBe('task');
    expect(taskBtn.getAttribute('aria-current')).toBe('page');
    expect(codeBtn.getAttribute('aria-current')).toBeNull();

    // task -> run (should open terminal details)
    await act(async () => runBtn.click());
    expect(workbench?.getAttribute('data-mobile-view')).toBe('run');
    expect(runBtn.getAttribute('aria-current')).toBe('page');
    expect(taskBtn.getAttribute('aria-current')).toBeNull();
    expect(terminalDetails?.open).toBe(true);

    // run -> ai
    await act(async () => aiBtn.click());
    expect(workbench?.getAttribute('data-mobile-view')).toBe('ai');
    expect(aiBtn.getAttribute('aria-current')).toBe('page');
    expect(runBtn.getAttribute('aria-current')).toBeNull();

    // ai -> code
    await act(async () => codeBtn.click());
    expect(workbench?.getAttribute('data-mobile-view')).toBe('code');
    expect(codeBtn.getAttribute('aria-current')).toBe('page');
    expect(aiBtn.getAttribute('aria-current')).toBeNull();

    // in-memory values and nodes remain intact across view switches
    expect(container?.querySelector('.candidate-editor-buffer')).toBe(editor);
    expect(container?.querySelector('.terminal-input')).toBe(command);
    expect(container?.querySelector('#candidate-ai-prompt')).toBe(prompt);
    expect(command?.value).toBe('python -m unittest');
    expect(prompt?.value).toBe('Explain cache invalidation');
    expect(
      container?.querySelector('.candidate-code-editor .cm-content')
        ?.textContent,
    ).toContain('def get_inventory()');
  });

  it('renders server-restored command history on reload while keeping command draft input independent and empty', async () => {
    const initialCommands: readonly CommandHistoryEntry[] = [
      {
        id: 'cmd-history-1',
        command: 'pytest tests/test_bookings.py',
        state: 'COMPLETED_SUCCESS',
        result: {
          commandId: 'cmd-history-1',
          exitCode: 0,
          timedOut: false,
          durationMs: 340,
          stdoutPreview: '2 passed in 0.34s\n',
          stdoutBytes: 18,
          stdoutTruncated: false,
          stderrPreview: '',
          stderrBytes: 0,
          stderrTruncated: false,
        },
        platformError: null,
      },
      {
        id: 'cmd-history-2',
        command: 'cat /etc/issue',
        state: 'COMPLETED_FAILURE',
        result: {
          commandId: 'cmd-history-2',
          exitCode: 1,
          timedOut: false,
          durationMs: 25,
          stdoutPreview: '',
          stdoutBytes: 0,
          stdoutTruncated: false,
          stderrPreview: 'cat: /etc/issue: Permission denied\n',
          stderrBytes: 35,
          stderrTruncated: false,
        },
        platformError: null,
      },
    ];

    await renderWorkspace(activeSessionFixture, initialCommands);

    // Terminal log should render both restored commands
    const terminalLog = container?.querySelector('.terminal-log');
    expect(terminalLog).not.toBeNull();
    const commandEntries = container?.querySelectorAll('.command-entry');
    expect(commandEntries).toHaveLength(2);

    // Verify first command details
    expect(commandEntries![0].querySelector('.command-text')?.textContent).toBe(
      'pytest tests/test_bookings.py',
    );
    expect(
      commandEntries![0].querySelector('.badge-success')?.textContent,
    ).toBe('Completed: exit 0');
    expect(
      commandEntries![0].querySelector('.command-output')?.textContent,
    ).toBe('2 passed in 0.34s\n');

    // Verify second command details
    expect(commandEntries![1].querySelector('.command-text')?.textContent).toBe(
      'cat /etc/issue',
    );
    expect(commandEntries![1].querySelector('.badge-error')?.textContent).toBe(
      'Completed: non-zero exit 1',
    );
    expect(
      commandEntries![1].querySelector('.command-output.stderr')?.textContent,
    ).toBe('cat: /etc/issue: Permission denied\n');

    // Terminal input draft must remain independent and empty
    const terminalInput =
      container?.querySelector<HTMLInputElement>('.terminal-input');
    expect(terminalInput).not.toBeNull();
    expect(terminalInput?.value).toBe('');

    // Typing into the draft input modifies only the draft, leaving history unchanged
    await act(async () => {
      setInputValue(terminalInput!, 'echo "test draft"');
    });
    expect(terminalInput?.value).toBe('echo "test draft"');
    expect(container?.querySelectorAll('.command-entry')).toHaveLength(2);
  });

  it('ensures the CodeMirror editor content is keyboard focusable without scroller focus hijacking', async () => {
    await renderWorkspace();
    const scroller = container?.querySelector<HTMLElement>(
      '.candidate-code-editor .cm-scroller',
    );
    const content = container?.querySelector<HTMLElement>(
      '.candidate-code-editor .cm-content',
    );

    expect(content).not.toBeNull();
    expect(scroller).not.toBeNull();
    // Content is explicitly marked focusable with tabindex="0" so axe-core and keyboard users can reach the editor region
    expect(content?.getAttribute('tabindex')).toBe('0');
    // Scroller does not define a positive tabindex that would create redundant tab stops or steal focus
    expect(scroller?.getAttribute('tabindex')).toBe('-1');
  });
});
