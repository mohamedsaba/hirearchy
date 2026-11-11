import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const runtimeProfile = vi.hoisted(() => ({
  isFounderUatEnabled: vi.fn(),
}));

vi.mock('../../apps/web/src/runtime/profile', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../apps/web/src/runtime/profile')>();
  return { ...actual, isFounderUatEnabled: runtimeProfile.isFounderUatEnabled };
});

import {
  founderDraftGenerationAvailable,
  generateFounderDraft,
} from '../../apps/web/src/r211-builder/founder-draft-generation';
import { NVIDIA_CHAT_COMPLETIONS_ENDPOINT } from '../../apps/web/src/ai/server-ai-configuration';
import { proxy } from '../../apps/web/proxy';
import { operationalLogger } from '../../apps/web/src/observability/logger.mjs';

const recruiterId = '10000000-0000-4000-8000-0000000000a1';
const roleBrief =
  'Build a Python service that retries notification delivery without sending duplicates.';
const modelDraft = {
  title: 'Reliable Notification Delivery',
  brief:
    'Improve a notification service so transient delivery failures can be retried without creating duplicate messages.',
  expectedBehavior: ['Retries transient failures safely.'],
  acceptanceCriteria: ['Repeated delivery does not create duplicates.'],
  primaryFilePath: 'src/notifications.py',
  starterFiles: [
    {
      path: 'src/notifications.py',
      content: 'def deliver(message):\n    pass\n',
    },
    {
      path: 'README.md',
      content: '# Notification delivery\n\nImplement the task.\n',
    },
  ],
  rubric: [
    {
      id: 'idempotency',
      label: 'Idempotency',
      description: 'Handles repeated delivery attempts safely.',
      weight: 60,
      applicability: { kind: 'always', rule: 'Applies to every submission.' },
    },
    {
      id: 'failure-handling',
      label: 'Failure handling',
      description: 'Handles transient failures with clear behavior.',
      weight: 40,
      applicability: { kind: 'always', rule: 'Applies to every submission.' },
    },
  ],
};

const providerResponse = (draft: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: JSON.stringify(draft) },
        },
      ],
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Founder UAT assessment draft generation', () => {
  it('uses only the explicit Founder UAT key and returns a statically valid editable draft', async () => {
    runtimeProfile.isFounderUatEnabled.mockReturnValue(true);
    vi.stubEnv('NVIDIA_API_KEY', 'general-runtime-key');
    expect(founderDraftGenerationAvailable()).toBe(false);
    vi.stubEnv('FOUNDER_UAT_NVIDIA_API_KEY', 'founder-uat-only-key');
    expect(founderDraftGenerationAvailable()).toBe(true);

    const fetchMock = vi.fn<typeof fetch>(async () =>
      providerResponse(modelDraft),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await generateFounderDraft(
      { brief: roleBrief, durationMinutes: 45 },
      recruiterId,
    );

    expect(result).toMatchObject({
      status: 'ready',
      draft: {
        templateId: 'custom',
        durationMinutes: 45,
        terminalEnabled: true,
        integratedAi: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe(NVIDIA_CHAT_COMPLETIONS_ENDPOINT);
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer founder-uat-only-key',
    });
    const body = JSON.parse(String(request.body));
    expect(body.model).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b');
    expect(body.messages[1].content).toContain(roleBrief);
    expect(body.messages[1].content).not.toContain(recruiterId);
    expect(JSON.stringify(result)).not.toContain('founder-uat-only-key');
    expect(body.response_format).toEqual({ type: 'json_object' });
    const requestedSchema = JSON.parse(
      body.messages[1].content.split('\nJSON schema\n')[1],
    );
    expect(requestedSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 8, maxLength: 120 },
        brief: { type: 'string', minLength: 20, maxLength: 5000 },
        expectedBehavior: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: { type: 'string', minLength: 8, maxLength: 400 },
        },
        rubric: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            properties: {
              weight: { type: 'integer', minimum: 1, maximum: 100 },
            },
          },
        },
      },
    });
  });

  it('does not use the general NVIDIA key when the Founder UAT key is missing', async () => {
    runtimeProfile.isFounderUatEnabled.mockReturnValue(true);
    vi.stubEnv('NVIDIA_API_KEY', 'general-runtime-key');
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      generateFounderDraft(
        { brief: roleBrief, durationMinutes: 45 },
        recruiterId,
      ),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps generation unavailable outside Founder UAT and in automation', () => {
    vi.stubEnv('FOUNDER_UAT_NVIDIA_API_KEY', 'founder-uat-only-key');
    runtimeProfile.isFounderUatEnabled.mockReturnValue(false);
    expect(founderDraftGenerationAvailable()).toBe(false);

    runtimeProfile.isFounderUatEnabled.mockReturnValue(true);
    vi.stubEnv(
      'FOUNDER_UAT_AUTOMATION_RUN_ID',
      '10000000-0000-4000-8000-0000000000f1',
    );
    expect(founderDraftGenerationAvailable()).toBe(false);
  });

  it('rejects unsafe or structurally invalid model output before returning it', async () => {
    runtimeProfile.isFounderUatEnabled.mockReturnValue(true);
    vi.stubEnv('FOUNDER_UAT_NVIDIA_API_KEY', 'founder-uat-only-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        providerResponse({
          ...modelDraft,
          starterFiles: [
            ...modelDraft.starterFiles,
            { path: '../outside.py', content: 'pass' },
          ],
        }),
      ),
    );

    await expect(
      generateFounderDraft(
        { brief: roleBrief, durationMinutes: 45 },
        recruiterId,
      ),
    ).resolves.toEqual({ status: 'invalid' });
  });

  it('logs only safe field paths and codes for a static rubric mismatch', async () => {
    runtimeProfile.isFounderUatEnabled.mockReturnValue(true);
    vi.stubEnv('FOUNDER_UAT_NVIDIA_API_KEY', 'founder-uat-only-key');
    const warning = vi.spyOn(operationalLogger, 'warn');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        providerResponse({
          ...modelDraft,
          rubric: [
            modelDraft.rubric[0],
            { ...modelDraft.rubric[1], weight: 30 },
          ],
        }),
      ),
    );

    await expect(
      generateFounderDraft(
        { brief: roleBrief, durationMinutes: 45 },
        recruiterId,
      ),
    ).resolves.toEqual({ status: 'invalid' });
    expect(warning).toHaveBeenCalledWith(
      'Founder UAT assessment draft rejected',
      {
        provider: 'nvidia-nim',
        code: 'STATIC_VALIDATION_REJECTED',
        issues: [{ path: 'rubric', code: 'R211_STATIC_VALIDATION' }],
      },
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      'Reliable Notification',
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      'founder-uat-only-key',
    );
  });

  it('rejects flattened Python source without running it', async () => {
    runtimeProfile.isFounderUatEnabled.mockReturnValue(true);
    vi.stubEnv('FOUNDER_UAT_NVIDIA_API_KEY', 'founder-uat-only-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        providerResponse({
          ...modelDraft,
          starterFiles: [
            {
              path: 'src/notifications.py',
              content: 'class Delivery:    def send(self):        pass',
            },
            modelDraft.starterFiles[1],
          ],
        }),
      ),
    );
    await expect(
      generateFounderDraft(
        { brief: roleBrief, durationMinutes: 45 },
        recruiterId,
      ),
    ).resolves.toEqual({ status: 'invalid' });
  });

  it('rejects overlapping generation requests from the same recruiter', async () => {
    runtimeProfile.isFounderUatEnabled.mockReturnValue(true);
    vi.stubEnv('FOUNDER_UAT_NVIDIA_API_KEY', 'founder-uat-only-key');
    let resolveProvider!: (response: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (resolveProvider = resolve)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = generateFounderDraft(
      { brief: roleBrief, durationMinutes: 45 },
      recruiterId,
    );
    await expect(
      generateFounderDraft(
        { brief: roleBrief, durationMinutes: 45 },
        recruiterId,
      ),
    ).resolves.toEqual({ status: 'busy' });
    resolveProvider(providerResponse(modelDraft));
    await expect(first).resolves.toMatchObject({ status: 'ready' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('allows the endpoint only in Founder UAT', () => {
    runtimeProfile.isFounderUatEnabled.mockReturnValue(true);
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'founder-uat');
    expect(
      proxy(
        new NextRequest(
          'http://localhost/r23/api/organizations/org/assessments/generate',
          { method: 'POST' },
        ),
      ).headers.get('x-middleware-next'),
    ).toBe('1');

    runtimeProfile.isFounderUatEnabled.mockReturnValue(false);
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-authenticated');
    expect(
      proxy(
        new NextRequest(
          'http://localhost/r23/api/organizations/org/assessments/generate',
          { method: 'POST' },
        ),
      ).status,
    ).toBe(503);
  });
});
