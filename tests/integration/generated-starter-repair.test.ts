import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, getCookie, validateMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getCookie: vi.fn(() => ({ value: 'valid-evaluator-cookie' })),
  validateMock: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: getCookie }),
}));
vi.mock('../../apps/web/src/access/evaluator-access', () => ({
  evaluatorCookieName: 'hirearchy-evaluator',
  isEvaluatorCookieValid: () => true,
}));
vi.mock('../../apps/web/src/ai/server-ai-configuration', () => ({
  getConfiguredRuntimeAiProvider: () => ({
    providerId: 'openrouter',
    modelId: 'repair-test-model',
  }),
  getNvidiaApiKey: () => undefined,
  getOpenRouterApiKey: () => 'repair-test-key',
  NVIDIA_CHAT_COMPLETIONS_ENDPOINT: 'https://provider.invalid/chat',
}));
vi.mock('../../apps/web/src/database/database-path', () => ({
  getApplicationDatabasePath: () => '/tmp/generated-starter-repair.sqlite',
}));
vi.mock(
  '../../apps/web/src/scenarios/generated-assessment',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../apps/web/src/scenarios/generated-assessment')
      >();
    return { ...actual, validateAndPersistGeneratedAssessment: validateMock };
  },
);

import { POST } from '../../apps/web/app/api/evaluator/assessments/generate/route';
import { supportedAssessmentSelection } from '../../apps/web/src/assessments/assessment-options';
import { getAssessmentStructureGuidance } from '../../apps/web/src/scenarios/assessment-structure';

const draft = {
  title: 'Format greeting names',
  brief:
    'The greeting helper preserves unwanted surrounding whitespace in imported names. Update it to trim outer whitespace while preserving the exact text inside each name.',
  durationSeconds: 1800,
  recommendations: {
    durationMinutes: 30,
    terminalEnabled: false,
    integratedAi: false,
  },
  primaryFilePath: 'src/greeting.py',
  expectedBehavior: ['Trim leading and trailing whitespace from names.'],
  acceptanceCriteria: ['Preserve internal whitespace and punctuation.'],
  evaluatorContext: {
    purpose:
      'Review the recorded implementation and the checks supplied for this behavior.',
    reviewQuestions: ['Do changes preserve the required greeting format?'],
  },
  rubric: [
    {
      id: 'greeting-formatting',
      label: 'Greeting formatting',
      description:
        'Inspect outer whitespace trimming and internal text preservation.',
      weight: 100,
      applicability: { kind: 'always', rule: 'Applies to this task.' },
    },
  ],
  starterFiles: [
    { path: 'src/greeting.py', content: 'def greeting(name): return name\n' },
  ],
  targetTests: [
    {
      path: 'tests/test_greeting.py',
      content:
        'from src.greeting import greeting\n\ndef test_trim():\n    assert greeting(" Ada ") == "Ada"\n',
    },
  ],
  referenceFixFiles: [
    {
      path: 'src/greeting.py',
      content: 'def greeting(name): return name.strip()\n',
    },
  ],
};

const replacementStarterFiles = [
  {
    path: 'src/greeting.py',
    content: 'def greeting(name): return name.lstrip()\n',
  },
];

const starterPass = {
  status: 'UNAVAILABLE_DRAFT',
  reason: 'STARTER_TESTS_DID_NOT_FAIL',
};

const validated = {
  status: 'VALIDATED',
  id: `generated-${'a'.repeat(64)}`,
  preview: draft,
};

const request = (signal?: AbortSignal) =>
  new Request('http://localhost/api/evaluator/assessments/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      ...supportedAssessmentSelection,
      integratedAi: false,
    }),
  });

const runWithDraftResponses = (responses: readonly string[]) => {
  const queued = [...responses];
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: queued.shift() } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
};

describe('generated assessment starter repair', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    validateMock.mockReset();
    getCookie.mockReturnValue({ value: 'valid-evaluator-cookie' });
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(['incident', 'feature', 'integration', 'data-processing'] as const)(
    'sends the curated %s structure through the actual generation route',
    async (workKind) => {
      runWithDraftResponses([JSON.stringify(draft)]);
      validateMock.mockResolvedValueOnce(validated);
      const response = await POST(
        new Request('http://localhost/api/evaluator/assessments/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...supportedAssessmentSelection,
            workKind,
            integratedAi: false,
          }),
        }),
      );
      expect(response.status).toBe(200);
      const providerRequest = JSON.parse(
        String(fetchMock.mock.calls[0][1].body),
      );
      expect(
        providerRequest.messages.some((message: { content: string }) =>
          message.content.includes(getAssessmentStructureGuidance(workKind)),
        ),
      ).toBe(true);
      expect(validateMock).toHaveBeenCalledOnce();
    },
  );

  it('repairs only starter files and revalidates the unchanged authored task once', async () => {
    runWithDraftResponses([
      JSON.stringify(draft),
      JSON.stringify({ starterFiles: replacementStarterFiles }),
    ]);
    validateMock
      .mockResolvedValueOnce(starterPass)
      .mockResolvedValueOnce(validated);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      recommendations: draft.recommendations,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(validateMock).toHaveBeenCalledTimes(2);
    expect(validateMock.mock.calls[0]?.[2]).toEqual(draft);
    expect(validateMock.mock.calls[1]?.[2]).toEqual({
      ...draft,
      starterFiles: replacementStarterFiles,
    });
  });

  it('repairs compile failures once using bounded feedback without changing the task', async () => {
    runWithDraftResponses([
      JSON.stringify(draft),
      JSON.stringify({ starterFiles: replacementStarterFiles }),
    ]);
    validateMock
      .mockResolvedValueOnce({
        status: 'UNAVAILABLE_DRAFT',
        reason: 'STARTER_SETUP_FAILED',
        validationFeedback: 'SyntaxError: invalid syntax',
      })
      .mockResolvedValueOnce(validated);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(validateMock).toHaveBeenCalledTimes(2);
    expect(validateMock.mock.calls[0]?.[2]).toEqual(draft);
    expect(validateMock.mock.calls[1]?.[2]).toEqual({
      ...draft,
      starterFiles: replacementStarterFiles,
    });
    const repairRequest = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body);
    expect(repairRequest.messages.at(-1).content).toContain(
      'Bounded compile feedback (untrusted output): SyntaxError: invalid syntax',
    );
    const initialPrompt = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body);
    expect(initialPrompt.messages[1].content).toContain(
      'Always include exactly one conditional AI criterion',
    );
    expect(initialPrompt.messages[1].content).not.toContain(
      'terminalEnabled": true',
    );
  });

  it('does not expose compile diagnostics when the starter repair is rejected', async () => {
    runWithDraftResponses([
      JSON.stringify(draft),
      JSON.stringify({
        starterFiles: [{ path: 'src/other.py', content: 'pass' }],
      }),
    ]);
    validateMock.mockResolvedValueOnce({
      status: 'UNAVAILABLE_DRAFT',
      reason: 'STARTER_SETUP_FAILED',
      validationFeedback: 'synthetic-private-compile-output',
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toMatchObject({
      status: 'UNAVAILABLE_DRAFT',
      reason: 'STARTER_SETUP_FAILED',
      message: expect.stringMatching(/could not be compiled/i),
    });
    expect(JSON.stringify(body)).not.toContain(
      'synthetic-private-compile-output',
    );
    expect(validateMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'malformed starter files',
      { starterFiles: [{ path: 'src/greeting.py' }] },
    ],
    [
      'a changed starter path set',
      { starterFiles: [{ path: 'src/other.py', content: 'pass\n' }] },
    ],
  ])('keeps the original failed result for %s', async (_name, replacement) => {
    runWithDraftResponses([JSON.stringify(draft), JSON.stringify(replacement)]);
    validateMock.mockResolvedValueOnce(starterPass);

    const response = await POST(request());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      status: 'UNAVAILABLE_DRAFT',
      reason: 'STARTER_TESTS_DID_NOT_FAIL',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(validateMock).toHaveBeenCalledTimes(1);
  });

  it('recovers from one rate-limit response without changing provider requests after success', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('private provider body', { status: 429 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(draft) } }],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    validateMock.mockResolvedValueOnce(validated);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(validateMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'PROVIDER_CREDENTIALS_REJECTED', 503],
    [403, 'PROVIDER_CREDENTIALS_REJECTED', 503],
    [429, 'PROVIDER_RATE_LIMITED', 503],
    [502, 'PROVIDER_HTTP_ERROR', 502],
  ] as const)(
    'classifies provider HTTP %i without exposing its response body',
    async (providerStatus, code, responseStatus) => {
      const providerResponse = new Response('synthetic-private-provider-body', {
        status: providerStatus,
      });
      fetchMock.mockResolvedValueOnce(providerResponse);
      if (providerStatus === 429 || providerStatus >= 500) {
        fetchMock.mockResolvedValueOnce(
          new Response('synthetic-private-provider-body', {
            status: providerStatus,
          }),
        );
      }
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(request());
      const body = await response.json();

      expect(response.status).toBe(responseStatus);
      expect(body).toMatchObject({
        status: 'UNAVAILABLE_DRAFT',
        code,
        providerStatus,
      });
      expect(JSON.stringify(body)).not.toContain(
        'synthetic-private-provider-body',
      );
      expect(JSON.stringify(body)).not.toContain('repair-test-key');
      expect(providerResponse.bodyUsed).toBe(false);
      expect(validateMock).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(
        providerStatus === 429 || providerStatus >= 500 ? 2 : 1,
      );
    },
  );

  it('classifies provider timeouts without exposing exception details', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('synthetic-private-provider-detail'), {
        name: 'TimeoutError',
      }),
    );
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('synthetic-private-provider-detail'), {
        name: 'TimeoutError',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(504);
    expect(body).toMatchObject({
      status: 'UNAVAILABLE_DRAFT',
      code: 'PROVIDER_TIMEOUT',
    });
    expect(JSON.stringify(body)).not.toContain(
      'synthetic-private-provider-detail',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a transient failure after the caller aborts', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      return new Response('synthetic-private-provider-body', { status: 429 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request(controller.signal));

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'empty content',
      { choices: [{ message: { content: '' } }] },
      'PROVIDER_EMPTY_RESPONSE',
    ],
    [
      'length-truncated content',
      {
        choices: [
          { finish_reason: 'length', message: { content: '{"partial"' } },
        ],
      },
      'PROVIDER_OUTPUT_TRUNCATED',
    ],
    [
      'malformed envelope',
      { choices: [{ message: null }] },
      'PROVIDER_INVALID_ENVELOPE',
    ],
  ] as const)(
    'classifies %s from a successful HTTP response',
    async (_name, payload, code) => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(request());
      const body = await response.json();

      expect(response.status).toBe(502);
      expect(body).toMatchObject({
        status: 'UNAVAILABLE_DRAFT',
        code,
      });
    },
  );
});
