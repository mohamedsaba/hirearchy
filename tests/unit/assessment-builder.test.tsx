// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssessmentBuilder } from '../../apps/web/app/evaluator/assessments/new/assessment-builder';

const selection = {
  field: 'backend',
  workKind: 'incident',
  domain: 'travel',
  stack: 'python-flask',
  depth: 'layered',
  durationMinutes: 60,
  integratedAi: false,
  terminalEnabled: true,
};
const rubric = {
  version: 'task-rubric-v1',
  criteria: [
    {
      id: 'correctness',
      label: 'Behavior',
      description: 'Implements the required behavior.',
      weight: 20,
      applicability: { kind: 'always', rule: 'Always applicable.' },
    },
    {
      id: 'tests',
      label: 'Verification',
      description: 'Verifies the change.',
      weight: 25,
      applicability: { kind: 'always', rule: 'Always applicable.' },
    },
    {
      id: 'implementation',
      label: 'Implementation',
      description: 'Maintains the intended behavior.',
      weight: 25,
      applicability: { kind: 'always', rule: 'Always applicable.' },
    },
    {
      id: 'approach',
      label: 'Approach',
      description: 'Addresses the task requirements.',
      weight: 20,
      applicability: { kind: 'always', rule: 'Always applicable.' },
    },
    {
      id: 'ai-collaboration',
      label: 'Recorded AI collaboration',
      description: 'Evaluates observable integrated-AI use.',
      weight: 10,
      applicability: {
        kind: 'recorded_integrated_ai_interaction',
        rule: 'Applies when an integrated-AI interaction is recorded.',
      },
    },
  ],
};
const generatedAssessmentId =
  'generated-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const briefText = 'Investigate and correct duplicate booking notifications.';
const response = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});
const preview = (requestSelection: typeof selection) => ({
  generatedAssessmentId,
  scenario: {
    id: generatedAssessmentId,
    version: '1.0.0',
    title: 'Booking notification retry',
    brief: briefText,
    acceptanceCriteria: ['Avoid duplicate messages.'],
    durationSeconds: requestSelection.durationMinutes * 60,
  },
  taskRubric: rubric,
  aiCapability: { enabled: requestSelection.integratedAi },
  terminalEnabled: requestSelection.terminalEnabled,
  recommendations: {
    durationMinutes: 45,
    integratedAi: true,
    terminalEnabled: false,
  },
});

describe('assessment builder', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(
      'hirearchy-assessment-draft-v1',
      JSON.stringify(selection),
    );
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
    localStorage.clear();
    sessionStorage.clear();
  });

  const button = (label: string) =>
    Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === label,
    ) as HTMLButtonElement | undefined;
  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const remount = async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AssessmentBuilder />));
    await flush();
  };
  const terminalToggle = () =>
    container.querySelector<HTMLInputElement>('input[aria-label="Terminal"]')!;
  const aiToggle = () =>
    container.querySelector<HTMLInputElement>(
      'input[aria-label="Integrated AI"]',
    )!;
  const changeWeight = async (label: string, value: string) => {
    const input = container.querySelector<HTMLInputElement>(
      `input[aria-label="Weight for ${label}"]`,
    );
    await act(async () => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  const chooseOption = async (label: string, optionLabel: string) => {
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
        ?.click();
    });
    await flush();
    await act(async () => {
      Array.from(container.querySelectorAll('[role="option"]'))
        .find((option) => option.textContent?.includes(optionLabel))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
  };
  const goToStage = async (stage: 'Define' | 'Validate' | 'Issue') => {
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          `button[aria-label="Go to ${stage} stage"]`,
        )
        ?.click();
    });
    await flush();
  };
  const continueToValidate = async () => {
    await act(async () => button('Continue to Validate')?.click());
    await flush();
  };

  const briefNodes = () =>
    Array.from(
      container.querySelectorAll<HTMLElement>('p, span, li, summary, div'),
    ).filter(
      (element) =>
        element.textContent?.includes(briefText) &&
        !Array.from(element.children).some((child) =>
          child.textContent?.includes(briefText),
        ),
    );

  it('explains unsupported stack status and enables generation when a supported stack is chosen', async () => {
    localStorage.setItem(
      'hirearchy-assessment-draft-v1',
      JSON.stringify({ ...selection, stack: 'typescript-node' }),
    );
    await act(async () => root.render(<AssessmentBuilder />));
    await flush();

    expect(button('Continue to Validate')?.disabled).toBe(true);
    await goToStage('Validate');
    expect(button('Generate and validate task')?.disabled).toBe(true);
    expect(
      button('Generate and validate task')?.getAttribute('aria-describedby'),
    ).toBe('assessment-generation-blocker');
    expect(
      container.querySelector('#assessment-generation-blocker')?.textContent,
    ).toContain('This stack is not yet available');
    expect(
      container.querySelector('#assessment-generation-blocker')?.textContent,
    ).toContain('Choose Python · Flask');
    await goToStage('Define');
    expect(container.textContent).toContain('This stack is not yet available');
    expect(
      container.querySelector('button[aria-label="Stack"]')?.textContent,
    ).toContain('TypeScript · Node.js (not yet available)');
    await act(async () => button('Generate and validate task')?.click());
    expect(fetchMock).not.toHaveBeenCalled();
    await chooseOption('Stack', 'Python · Flask');
    await continueToValidate();
    expect(button('Generate and validate task')?.disabled).toBe(false);
    expect(
      container.querySelector('#assessment-generation-blocker'),
    ).toBeNull();
    fetchMock.mockResolvedValue(response(preview(selection)));
    await act(async () => button('Generate and validate task')?.click());
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).stack).toBe(
      'python-flask',
    );
  });

  it('clearly marks unsupported stacks as not yet available in the stack selector and prevents selecting them', async () => {
    localStorage.setItem(
      'hirearchy-assessment-draft-v1',
      JSON.stringify({ ...selection, stack: 'python-flask' }),
    );
    await act(async () => root.render(<AssessmentBuilder />));
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Stack"]')
        ?.click();
    });
    await flush();

    const stackOptions = Array.from(
      container.querySelectorAll<HTMLElement>('[role="option"]'),
    );
    const pythonOption = stackOptions.find((opt) =>
      opt.textContent?.includes('Python · Flask'),
    );
    const tsNodeOption = stackOptions.find((opt) =>
      opt.textContent?.includes('TypeScript · Node.js'),
    );
    const reactOption = stackOptions.find((opt) =>
      opt.textContent?.includes('TypeScript · React'),
    );

    expect(pythonOption?.getAttribute('aria-disabled')).toBeNull();
    expect(pythonOption?.textContent).not.toContain('not yet available');

    expect(tsNodeOption?.getAttribute('aria-disabled')).toBe('true');
    expect(tsNodeOption?.textContent).toContain(
      'TypeScript · Node.js (not yet available)',
    );

    expect(reactOption?.getAttribute('aria-disabled')).toBe('true');
    expect(reactOption?.textContent).toContain(
      'TypeScript · React (not yet available)',
    );

    await act(async () => {
      reactOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(
      container.querySelector('button[aria-label="Stack"]')?.textContent,
    ).toContain('Python · Flask');
  });

  it('keeps the prepared task through runtime setting changes and issues current values', async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (String(url).endsWith('/generate')) return response(preview(body));
      if (String(url).endsWith('/api/evaluator/assessments'))
        return response(
          {
            sessionId: 'session-123',
            candidatePath: '/candidate/one-time-token',
            scenario: {
              title: 'Booking notification retry',
              version: '1.0.0',
              durationSeconds: body.durationMinutes * 60,
            },
            taskRubric: rubric,
            terminalEnabled: body.terminalEnabled,
          },
          201,
        );
      throw new Error(`Unexpected request to ${String(url)}`);
    });

    await act(async () => {
      root.render(<AssessmentBuilder />);
    });
    await flush();

    const terminal = terminalToggle();
    expect(terminal.checked).toBe(true);
    expect(aiToggle().checked).toBe(false);
    await continueToValidate();
    expect(container.textContent).toContain('Choose how to prepare the task');

    await act(async () => {
      button('Generate and validate task')?.click();
    });
    await flush();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/evaluator/assessments/generate',
    );
    expect(container.textContent).toContain('Sandbox validated');
    expect(container.textContent).toContain('Booking notification retry');
    expect(container.textContent).toContain('60 minutes');

    expect(briefNodes()).toHaveLength(1);
    const brief = briefNodes()[0];
    const briefToggle = button('Show full brief');
    expect(briefToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(briefToggle?.getAttribute('aria-controls')).toBe(brief?.id);
    expect(brief?.dataset.expanded).toBe('false');

    await act(async () => {
      briefToggle?.click();
    });
    expect(button('Show less')?.getAttribute('aria-expanded')).toBe('true');
    expect(briefNodes()).toHaveLength(1);
    expect(briefNodes()[0]).toBe(brief);
    expect(brief?.dataset.expanded).toBe('true');
    expect(brief?.textContent).toBe(briefText);

    await act(async () => {
      button('Show less')?.click();
    });
    expect(button('Show full brief')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(briefNodes()).toHaveLength(1);
    expect(briefNodes()[0]).toBe(brief);

    await goToStage('Issue');
    expect(container.textContent).toContain('Selected weights 100%');
    expect(container.textContent).toContain('Terminal on');
    expect(container.textContent).toContain('AI assistant off');
    expect(container.textContent).toContain(
      'Not applicable: integrated AI is disabled for this assessment.',
    );
    expect(container.textContent).toContain('Task recommendations');

    await goToStage('Define');
    await act(async () => {
      container
        .querySelector<HTMLInputElement>(
          'input[name="assessment-duration"][value="45"]',
        )
        ?.click();
      terminalToggle().click();
      aiToggle().click();
    });
    await flush();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/generate')),
    ).toHaveLength(1);
    await goToStage('Validate');
    expect(container.textContent).toContain('45 minutes');
    expect(container.textContent).toContain('Terminal off');
    expect(container.textContent).toContain('AI assistant available');
    expect(container.textContent).toContain(
      'No candidate terminal verification will be available.',
    );

    await goToStage('Issue');
    expect(container.textContent).toContain('Booking notification retry');
    expect(container.textContent).toContain('45 minutes');
    expect(container.textContent).toContain('Terminal off');
    expect(container.textContent).toContain('AI assistant available');

    await act(async () => {
      container
        .querySelector<HTMLDetailsElement>('.assessment-rubric-disclosure')
        ?.querySelector('summary')
        ?.click();
    });
    await changeWeight('Behavior', '30');
    expect(button('Create candidate link')?.disabled).toBe(true);
    await changeWeight('Verification', '15');
    expect(container.textContent).toContain('Selected weights 100%');

    const create = button('Create candidate link');
    expect(create?.disabled).toBe(false);
    await act(async () => {
      create?.click();
    });
    await flush();

    const createCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/api/evaluator/assessments'),
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      ...selection,
      durationMinutes: 45,
      terminalEnabled: false,
      integratedAi: true,
      generatedAssessmentId,
      rubricWeights: {
        correctness: 30,
        tests: 15,
        implementation: 25,
        approach: 20,
        'ai-collaboration': 10,
      },
    });
    expect(container.textContent).toContain(
      'A candidate session has been created.',
    );
    expect(button('Create candidate link')).toBeUndefined();
    expect(document.activeElement).toBe(
      container.querySelector('.assessment-created'),
    );
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Candidate link"]')
        ?.value,
    ).toContain('/candidate/one-time-token');
  });

  it('confirms copied candidate links and exposes a selected fallback when clipboard access fails', async () => {
    const writeText = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Clipboard permission denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/generate'))
        return response(preview(selection));
      if (String(url).endsWith('/api/evaluator/assessments'))
        return response(
          {
            sessionId: 'session-copy-123',
            candidatePath: '/candidate/one-time-token',
            scenario: {
              title: 'Booking notification retry',
              version: '1.0.0',
              durationSeconds: 60 * 60,
            },
            taskRubric: rubric,
            terminalEnabled: true,
          },
          201,
        );
      throw new Error(`Unexpected request to ${String(url)}`);
    });

    await act(async () => root.render(<AssessmentBuilder />));
    await flush();
    await continueToValidate();
    await act(async () => button('Generate and validate task')?.click());
    await flush();
    await goToStage('Issue');
    await act(async () => button('Create candidate link')?.click());
    await flush();

    const candidateLink = container.querySelector<HTMLInputElement>(
      '[aria-label="Candidate link"]',
    );
    expect(candidateLink?.readOnly).toBe(true);
    expect(candidateLink?.value).toBe(
      new URL('/candidate/one-time-token', window.location.origin).toString(),
    );

    await act(async () => button('Copy candidate link')?.click());
    await flush();
    expect(writeText).toHaveBeenNthCalledWith(1, candidateLink?.value);
    expect(button('Copied')).toBeDefined();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => button('Copied')?.click());
    await flush();
    expect(
      container.querySelector('.assessment-created .assessment-kicker')
        ?.textContent,
    ).toBe('Session issued');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Clipboard access is unavailable. Select the link below to copy it.',
    );
    expect(candidateLink?.selectionStart).toBe(0);
    expect(candidateLink?.selectionEnd).toBe(candidateLink?.value.length);
  });

  it('saves and restores the draft and reports corrupt or unavailable browser storage', async () => {
    await act(async () => root.render(<AssessmentBuilder />));
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLInputElement>(
          'input[name="assessment-duration"][value="45"]',
        )
        ?.click();
      button('Save draft')?.click();
    });
    expect(
      JSON.parse(localStorage.getItem('hirearchy-assessment-draft-v1') ?? '{}')
        .durationMinutes,
    ).toBe(45);
    await remount();
    expect(
      container.querySelector<HTMLInputElement>(
        'input[name="assessment-duration"][value="45"]',
      )?.checked,
    ).toBe(true);

    localStorage.setItem('hirearchy-assessment-draft-v1', '{ invalid');
    await remount();
    expect(container.textContent).toContain(
      'The saved draft could not be read. Start a new draft.',
    );

    localStorage.setItem(
      'hirearchy-assessment-draft-v1',
      JSON.stringify(selection),
    );
    const readSpy = vi
      .spyOn(window, 'localStorage', 'get')
      .mockImplementation(() => {
        throw new Error('private storage detail');
      });
    await remount();
    expect(container.textContent).toContain(
      'Saved drafts are unavailable in this browser.',
    );
    expect(container.textContent).not.toContain('private storage detail');
    readSpy.mockRestore();
    await remount();

    const realStorage = window.localStorage;
    const failingStorage = {
      get length() {
        return realStorage.length;
      },
      clear: () => realStorage.clear(),
      getItem: (key: string) => realStorage.getItem(key),
      key: (index: number) => realStorage.key(index),
      removeItem: (key: string) => realStorage.removeItem(key),
      setItem: () => {
        throw new Error('private storage detail');
      },
    } as Storage;
    const writeSpy = vi
      .spyOn(window, 'localStorage', 'get')
      .mockReturnValue(failingStorage);
    await act(async () => button('Save draft')?.click());
    expect(container.textContent).toContain(
      'Draft could not be saved on this device.',
    );
    expect(
      container.querySelector('button[aria-label="Stack"]')?.textContent,
    ).toContain('Python · Flask');
    expect(container.textContent).not.toContain('private storage detail');
    writeSpy.mockRestore();
  });

  it('routes evaluator access failures safely and does not offer a provider retry before access', async () => {
    fetchMock.mockResolvedValue(
      response(
        {
          error: { code: 'EVALUATOR_ACCESS_REQUIRED' },
          message: 'private provider response',
        },
        401,
      ),
    );
    await act(async () => root.render(<AssessmentBuilder />));
    await flush();
    await continueToValidate();
    await act(async () => button('Generate and validate task')?.click());
    await flush();

    expect(container.textContent).toContain('Evaluator access is required');
    expect(container.querySelector('a[href="/evaluator"]')).not.toBeNull();
    expect(button('Retry generation')?.disabled).toBe(true);
    expect(container.textContent).not.toContain('private provider response');
  });

  it('classifies provider unavailability and offers a safe retry', async () => {
    fetchMock.mockResolvedValue(
      response(
        {
          status: 'UNAVAILABLE_DRAFT',
          message: 'private provider response',
          details: 'private provider detail',
        },
        503,
      ),
    );
    await act(async () => root.render(<AssessmentBuilder />));
    await flush();
    await continueToValidate();
    await act(async () => button('Generate and validate task')?.click());
    await flush();

    expect(container.textContent).toContain('Task provider unavailable');
    expect(container.textContent).toContain(
      'The task provider is unavailable or did not return a usable task.',
    );
    expect(button('Retry generation')?.disabled).toBe(false);
    expect(container.textContent).not.toContain('private provider');
  });

  it('classifies a missing authored scenario as unavailable rather than a provider outage', async () => {
    fetchMock.mockResolvedValue(
      response(
        {
          error: { code: 'SCENARIO_UNAVAILABLE' },
          message: 'private scenario configuration detail',
        },
        503,
      ),
    );
    await act(async () => root.render(<AssessmentBuilder />));
    await flush();
    await continueToValidate();
    await act(async () => button('Load published task')?.click());
    await flush();

    expect(container.textContent).toContain(
      'Task preparation could not be completed',
    );
    expect(container.textContent).toContain(
      'This task is temporarily unavailable.',
    );
    expect(container.textContent).not.toContain('Task provider unavailable');
    expect(container.textContent).not.toContain(
      'private scenario configuration detail',
    );
    expect(button('Retry published task')?.disabled).toBe(false);
  });

  it('gates authored preparation on Terminal and issues the fixed blueprint through its existing contract', async () => {
    localStorage.setItem(
      'hirearchy-assessment-draft-v1',
      JSON.stringify({ ...selection, terminalEnabled: false }),
    );
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/preview')) return response(preview(selection));
      if (String(url).endsWith('/api/evaluator/assessments'))
        return response(
          {
            sessionId: 'session-curated-123',
            candidatePath: '/candidate/curated-one-time-token',
            scenario: {
              title: 'Booking notification retry',
              version: '1.0.0',
              durationSeconds: 60 * 60,
            },
            taskRubric: rubric,
            terminalEnabled: true,
          },
          201,
        );
      throw new Error(`Unexpected request to ${String(url)}`);
    });

    await act(async () => root.render(<AssessmentBuilder />));
    await flush();
    await continueToValidate();
    expect(button('Load published task')?.disabled).toBe(true);
    expect(container.textContent).toContain(
      'Turn Terminal on in Define to use this blueprint.',
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await goToStage('Define');
    await act(async () => terminalToggle().click());
    await continueToValidate();
    await act(async () => button('Load published task')?.click());
    await flush();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/evaluator/assessments/preview',
    );
    expect(container.textContent).toContain('Published authored task');
    expect(container.textContent).toContain(
      'Its task story remains the same regardless of selected field',
    );

    await goToStage('Issue');
    await goToStage('Define');
    await act(async () => terminalToggle().click());
    await goToStage('Issue');
    expect(button('Create candidate link')?.disabled).toBe(true);
    expect(container.textContent).toContain(
      'The authored blueprint requires Terminal for candidate verification.',
    );

    await goToStage('Define');
    await act(async () => terminalToggle().click());
    await goToStage('Issue');
    await act(async () => button('Create candidate link')?.click());
    await flush();
    const createCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/api/evaluator/assessments'),
    );
    const createBody = JSON.parse(String(createCall?.[1]?.body));
    expect(createBody.useCuratedBlueprint).toBe(true);
    expect(createBody.generatedAssessmentId).toBeUndefined();
  });

  it.each([
    {
      label: 'transport loss',
      issue: () => Promise.reject(new Error('private transport detail')),
    },
    {
      label: 'malformed success',
      issue: () => Promise.resolve(response({ sessionId: 'session-only' })),
    },
    {
      label: 'server failure',
      issue: () =>
        Promise.resolve(
          response(
            {
              error: { code: 'SERVER_ERROR' },
              message: 'private server detail',
            },
            503,
          ),
        ),
    },
  ])(
    'retries ambiguous $label issuance with the same saved key and payload',
    async ({ issue }) => {
      let issueAttempts = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).endsWith('/generate'))
          return response(preview(selection));
        issueAttempts += 1;
        if (issueAttempts === 1) return issue();
        return response(
          {
            sessionId: 'session-recovered-123',
            candidatePath: '/candidate/recovered-one-time-token',
            scenario: {
              title: 'Booking notification retry',
              version: '1.0.0',
              durationSeconds: 60 * 60,
            },
            taskRubric: rubric,
            terminalEnabled: true,
          },
          200,
        );
      });
      await act(async () => root.render(<AssessmentBuilder />));
      await flush();
      await continueToValidate();
      await act(async () => button('Generate and validate task')?.click());
      await flush();
      await act(async () => button('Continue to Issue')?.click());
      await act(async () => button('Create candidate link')?.click());
      await flush();
      await remount();

      expect(container.textContent).toContain('Issuance outcome is uncertain.');
      expect(container.textContent).not.toContain('Validation required');
      expect(
        container.querySelector('a[href="/evaluator/assessments"]'),
      ).not.toBe(null);
      expect(button('Retry same issuance')).toBeDefined();
      const assessmentCalls = () =>
        fetchMock.mock.calls.filter(([url]) =>
          String(url).endsWith('/api/evaluator/assessments'),
        );
      expect(assessmentCalls()).toHaveLength(1);
      const firstCall = assessmentCalls()[0];
      const firstRequest = firstCall?.[1] as RequestInit;
      const firstBody = String(firstRequest.body);
      const firstKey = new Headers(firstRequest.headers).get('Idempotency-Key');
      const saved = JSON.parse(
        sessionStorage.getItem('hirearchy-assessment-issuance-v1') ?? 'null',
      ) as { key: string; payload: unknown };
      expect(firstKey).toBeTruthy();
      expect(saved).toEqual({ key: firstKey, payload: JSON.parse(firstBody) });
      expect(JSON.stringify(saved)).not.toContain('recovered-one-time-token');
      expect(JSON.stringify(saved)).not.toContain('/candidate/');

      await act(async () => button('Retry same issuance')?.click());
      await flush();

      expect(assessmentCalls()).toHaveLength(2);
      const retryRequest = assessmentCalls()[1]?.[1] as RequestInit;
      expect(new Headers(retryRequest.headers).get('Idempotency-Key')).toBe(
        firstKey,
      );
      expect(retryRequest.body).toBe(firstBody);
      expect(
        container.querySelector('.assessment-created .assessment-kicker')
          ?.textContent,
      ).toBe('Candidate link recovered');
      expect(
        container.querySelector<HTMLInputElement>(
          '[aria-label="Candidate link"]',
        )?.value,
      ).toContain('/candidate/recovered-one-time-token');
      expect(
        sessionStorage.getItem('hirearchy-assessment-issuance-v1'),
      ).toBeNull();
      expect(container.textContent).not.toContain('private transport detail');
      expect(container.textContent).not.toContain('private server detail');
    },
  );

  it('retains the exact issuance after an authentication rejection and recovers after access returns', async () => {
    let attempts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/generate'))
        return response(preview(selection));
      attempts += 1;
      if (attempts === 1) throw new Error('private transport detail');
      if (attempts === 2)
        return response({ error: { code: 'EVALUATOR_ACCESS_REQUIRED' } }, 401);
      return response(
        {
          sessionId: 'session-after-reauth-123',
          candidatePath: '/candidate/reauth-recovered-token',
          scenario: {
            title: 'Booking notification retry',
            version: '1.0.0',
            durationSeconds: 60 * 60,
          },
          taskRubric: rubric,
          terminalEnabled: true,
        },
        200,
      );
    });

    await act(async () => root.render(<AssessmentBuilder />));
    await flush();
    await continueToValidate();
    await act(async () => button('Generate and validate task')?.click());
    await flush();
    await act(async () => button('Continue to Issue')?.click());
    await act(async () => button('Create candidate link')?.click());
    await flush();

    const calls = () =>
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/api/evaluator/assessments'),
      );
    await remount();
    const originalRequest = calls()[0]?.[1] as RequestInit;
    const originalKey = new Headers(originalRequest.headers).get(
      'Idempotency-Key',
    );
    const originalBody = originalRequest.body;
    expect(calls()).toHaveLength(1);
    expect(button('Retry same issuance')).toBeDefined();

    await act(async () => button('Retry same issuance')?.click());
    await flush();
    expect(calls()).toHaveLength(2);
    expect(container.textContent).toContain(
      'The saved key and payload are retained.',
    );
    expect(container.textContent).toContain('Restore evaluator access');
    expect(button('Retry same issuance')).toBeDefined();
    expect(button('Start a new assessment with a new key')).toBeDefined();
    expect(
      sessionStorage.getItem('hirearchy-assessment-issuance-v1'),
    ).not.toBeNull();

    await act(async () => button('Retry same issuance')?.click());
    await flush();
    expect(calls()).toHaveLength(3);
    for (const [, init] of calls()) {
      expect(
        new Headers((init as RequestInit).headers).get('Idempotency-Key'),
      ).toBe(originalKey);
      expect((init as RequestInit).body).toBe(originalBody);
    }
    expect(
      container.querySelector('.assessment-created .assessment-kicker')
        ?.textContent,
    ).toBe('Candidate link recovered');
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Candidate link"]')
        ?.value,
    ).toContain('/candidate/reauth-recovered-token');
    expect(
      sessionStorage.getItem('hirearchy-assessment-issuance-v1'),
    ).toBeNull();
  });

  it('shows generated draft validation feedback and permits a fresh retry', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response(
          {
            status: 'UNAVAILABLE_DRAFT',
            message:
              'The reference implementation did not pass the target tests. Try preparing the assessment again.',
          },
          422,
        ),
      )
      .mockResolvedValueOnce(response(preview(selection)));
    await act(async () => root.render(<AssessmentBuilder />));
    await flush();
    await continueToValidate();
    await act(async () => button('Generate and validate task')?.click());
    await flush();
    expect(container.textContent).toContain(
      'The reference implementation did not pass the target tests.',
    );
    expect(button('Generate and validate task')).toBeUndefined();
    expect(button('Retry generation')?.disabled).toBe(false);
    await act(async () => button('Retry generation')?.click());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => button('Continue to Issue')?.click());
    expect(button('Create candidate link')?.disabled).toBe(false);
  });

  it('ignores a preview result after the work identity changes', async () => {
    let completePreview: ((value: unknown) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          completePreview = resolve;
        }),
    );

    await act(async () => root.render(<AssessmentBuilder />));
    await flush();
    await continueToValidate();
    await act(async () => button('Generate and validate task')?.click());
    await flush();
    expect(container.textContent).toContain('Preparing and checking the task');

    await goToStage('Define');
    await chooseOption('Technical field', 'Cloud and platform engineering');
    await act(async () => {
      completePreview?.(response(preview(selection)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(container.textContent).not.toContain('Booking notification retry');
    expect(container.textContent).not.toContain('Sandbox validated');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports real elapsed waiting time and resets it for each generation', async () => {
    const pendingPreviews: ((value: unknown) => void)[] = [];
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingPreviews.push(resolve);
        }),
    );

    vi.useFakeTimers();
    try {
      await act(async () => {
        root.render(<AssessmentBuilder />);
      });
      await act(async () => button('Continue to Validate')?.click());
      const elapsed = () =>
        container.querySelector('[role="timer"]')?.textContent ?? null;

      await act(async () => {
        button('Generate and validate task')?.click();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(elapsed()).toContain('Elapsed 0:00');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(65_000);
      });
      expect(elapsed()).toContain('Elapsed 1:05');

      await act(async () => {
        pendingPreviews[0]?.(response(preview(selection)));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(elapsed()).toBeNull();
      expect(container.textContent).toContain('Sandbox validated');

      await act(async () => {
        button('Generate another task')?.click();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(elapsed()).toContain('Elapsed 0:00');
    } finally {
      vi.useRealTimers();
    }
  });
});
