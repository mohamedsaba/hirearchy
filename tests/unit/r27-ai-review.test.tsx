// @vitest-environment happy-dom
import { NextRequest } from 'next/server';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { R27Evidence } from '../../database/postgres/r27/contract.mjs';
import { proxy } from '../../apps/web/proxy';
import { R27AiReviewPanel } from '../../apps/web/app/evaluator/sessions/[sessionId]/ai-review-panel';
import { generateR27AiCandidateReview } from '../../apps/web/src/r27-evidence/ai-review';
import {
  buildDeterministicEvidencePreviewReport,
  computeEvidenceMetricsAndDiffSummary,
} from '../../apps/web/src/r27-evidence/ai-review-contract';
import { GENERATED_TERMS_AND_CONDITIONS_FOOTER } from '../../apps/web/src/scenarios/generated-terms-and-conditions';

const plainBrief = 'Prevent duplicate retry dispatches for the same job ID.';

function makeEvidence(options?: {
  modified?: boolean;
  brief?: string;
}): R27Evidence {
  const modified = options?.modified ?? true;
  const starterService = [
    'def retry_failed(jobs):',
    '    for job in jobs:',
    '        send(job)',
  ].join('\n');
  const submittedService = modified
    ? [
        'def retry_failed(jobs):',
        '    seen = set()',
        '    for job in jobs:',
        '        if job["id"] in seen:',
        '            continue',
        '        seen.add(job["id"])',
        '        send(job)',
      ].join('\n')
    : starterService;

  const starterTest = 'def test_retry():\n    assert True\n';
  const submittedTest = modified
    ? 'def test_retry_deduplicates():\n    assert retry_failed([{"id": 1}, {"id": 1}]) == 1\n'
    : starterTest;

  return {
    permission: 'assigned_reviewer',
    reviewer: {
      subjectId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
    },
    organizationId: '3d58ca5b-bba6-4ba8-b561-8d9802aa3b8a',
    sessionId: 'sess_ai_review_test_001',
    assignment: {
      id: 'assign_001',
      version: '1',
      assignedAt: '2026-11-18T10:00:00.000Z',
    },
    scenario: {
      id: 'reservation-moves',
      version: '1',
      title: 'Deduplicate Notification Retries',
      snapshotText: JSON.stringify({
        scenario: {
          brief: options?.brief ?? plainBrief,
          acceptanceCriteria: [
            'Skip already processed job IDs during retry.',
            'Add a unit test verifying deduplication.',
          ],
        },
      }),
      snapshotDigest: 'sha256:snap001',
      starterFiles: {
        'src/service.py': starterService,
        'tests/test_moves.py': starterTest,
      },
    },
    status: 'SUBMITTED',
    createdAt: '2026-11-18T09:50:00.000Z',
    activatedAt: '2026-11-18T10:00:00.000Z',
    submittedAt: '2026-11-18T10:25:00.000Z',
    closureReason: modified ? 'candidate_submission' : 'timeout',
    submission: {
      submittedAt: '2026-11-18T10:25:00.000Z',
      closureReason: modified ? 'candidate_submission' : 'timeout',
      workspaceDigest: 'sha256:ws001',
      manifestDigest: 'sha256:man001',
      files: [
        {
          path: 'src/service.py',
          content: submittedService,
          version: modified ? '2' : '1',
          digest: 'sha256:svc',
        },
        {
          path: 'tests/test_moves.py',
          content: submittedTest,
          version: modified ? '2' : '1',
          digest: 'sha256:tst',
        },
      ],
    },
    revisions: [
      {
        path: 'src/service.py',
        version: '1',
        digest: 'sha256:starter-svc',
        content: starterService,
        source: 'starter',
      },
      {
        path: 'src/service.py',
        version: modified ? '2' : '1',
        digest: 'sha256:sub-svc',
        content: submittedService,
        source: 'submitted',
      },
    ],
    events: modified
      ? [
          {
            sequence: '1',
            type: 'SESSION_ACTIVATED',
            timestamp: '2026-11-18T10:00:00.000Z',
            payload: {},
            provenance: 'hirearchy.candidate_session_events',
          },
          {
            sequence: '2',
            type: 'WORKSPACE_CHANGED',
            timestamp: '2026-11-18T10:12:00.000Z',
            payload: { path: 'src/service.py', version: '2' },
            provenance: 'hirearchy.candidate_session_events',
          },
          {
            sequence: '3',
            type: 'WORKSPACE_CHANGED',
            timestamp: '2026-11-18T10:20:00.000Z',
            payload: { path: 'tests/test_moves.py', version: '2' },
            provenance: 'hirearchy.candidate_session_events',
          },
        ]
      : [
          {
            sequence: '1',
            type: 'SESSION_ACTIVATED',
            timestamp: '2026-11-18T10:00:00.000Z',
            payload: {},
            provenance: 'hirearchy.candidate_session_events',
          },
        ],
    executions: modified
      ? [
          {
            organizationId: '3d58ca5b-bba6-4ba8-b561-8d9802aa3b8a',
            sessionId: 'sess_ai_review_test_001',
            operationId: 'op_1',
            requestId: 'req_1',
            sequenceStart: '2',
            sequenceCompleted: '3',
            workspaceDigest: 'sha256:ws001',
            workspaceVersion: '2',
            recipeId: 'pytest',
            recipeVersion: '1',
            recipeDigest: 'sha256:rec',
            generation: 1,
            fence: 1,
            status: 'COMPLETED',
            exitCode: 0,
            stdout: '1 passed in 0.04s',
            stderr: '',
            stdoutDigest: null,
            stderrDigest: null,
            truncatedStdout: false,
            truncatedStderr: false,
            durationMs: 42,
            failureReason: null,
            errorMessage: null,
            cleanupStatus: 'CLEAN',
            isUnknown: false,
            provenance: 'restricted-executor-service',
            isSynthetic: true,
            createdAt: '2026-11-18T10:22:00.000Z',
            completedAt: '2026-11-18T10:22:01.000Z',
          },
        ]
      : [],
    pagination: { limit: 50, nextAfterSequence: null },
    availability: {
      terminal: 'unavailable',
      ai: 'unavailable',
      verification: 'unavailable',
      history: 'metadata_only',
      limitations: [],
    },
  };
}

describe('R27 AI Candidate Review', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('allows R27 ai-review GET and POST in staging/founder-uat proxy while keeping lockdown blocked', () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-authenticated');
    const getRes = proxy(
      new NextRequest(
        'http://localhost/r27/api/organizations/3d58ca5b-bba6-4ba8-b561-8d9802aa3b8a/sessions/sess_123/ai-review',
        { method: 'GET' },
      ),
    );
    const postRes = proxy(
      new NextRequest(
        'http://localhost/r27/api/organizations/3d58ca5b-bba6-4ba8-b561-8d9802aa3b8a/sessions/sess_123/ai-review',
        { method: 'POST' },
      ),
    );
    expect(getRes.headers.get('x-middleware-next')).toBe('1');
    expect(postRes.headers.get('x-middleware-next')).toBe('1');

    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-lockdown');
    expect(
      proxy(
        new NextRequest(
          'http://localhost/r27/api/organizations/3d58ca5b-bba6-4ba8-b561-8d9802aa3b8a/sessions/sess_123/ai-review',
          { method: 'POST' },
        ),
      ).status,
    ).toBe(503);
  });

  it('produces an evidence-grounded Should Accept preview report for verified edits', () => {
    const report = buildDeterministicEvidencePreviewReport(
      makeEvidence({ modified: true }),
    );

    expect(report.verdict).toBe('accept');
    expect(report.verdictLabel).toBe('Should Accept');
    expect(report.score).toBeGreaterThanOrEqual(75);
    expect(report.metrics.modifiedFilesCount).toBe(2);
    expect(report.strengths.join(' ')).toContain('src/service.py');
    expect(report.rationale).toContain('Should Accept');
  });

  it('produces Should Reject preview report when no starter files were changed', () => {
    const report = buildDeterministicEvidencePreviewReport(
      makeEvidence({ modified: false }),
    );

    expect(report.verdict).toBe('reject');
    expect(report.verdictLabel).toBe('Should Reject');
    expect(report.score).toBeLessThan(50);
    expect(report.metrics.modifiedFilesCount).toBe(0);
    expect(report.weaknesses.join(' ')).toContain('No code differences');
  });

  const briefWithEmbeddedFooter =
    plainBrief + GENERATED_TERMS_AND_CONDITIONS_FOOTER + '\nMore task text.';
  const briefCases = [
    {
      name: 'preserves a brief without the footer and parses the NVIDIA NIM verdict',
      brief: plainBrief,
      expectedBrief: plainBrief,
    },
    {
      name: 'removes the exact footer suffix from the live review prompt',
      brief: plainBrief + GENERATED_TERMS_AND_CONDITIONS_FOOTER,
      expectedBrief: plainBrief,
    },
    {
      name: 'preserves matching text within the brief',
      brief: briefWithEmbeddedFooter,
      expectedBrief: briefWithEmbeddedFooter,
    },
  ];
  it.each(briefCases)('$name', async ({ brief, expectedBrief }) => {
    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  score: 89,
                  verdict: 'accept',
                  confidenceLabel: 'High Confidence',
                  headline:
                    'Implemented clean job-ID deduplication with passing pytest verification.',
                  rationale:
                    'The candidate guarded retry_failed using a set of seen job IDs and added a regression test that passed execution.',
                  strengths: [
                    'Clean O(1) lookup set added in src/service.py.',
                    'Added regression test in tests/test_moves.py.',
                  ],
                  weaknesses: [
                    'Assumes job objects always expose an "id" key.',
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const evidence = makeEvidence({ modified: true, brief });
    const report = await generateR27AiCandidateReview(evidence, {
      fetchImpl: mockFetch,
      providerOverride: {
        presetId: 'nvidia:kimi-k2',
        providerId: 'nvidia',
        modelId: 'moonshotai/kimi-k2-instruct',
        label: 'NVIDIA NIM · Kimi K2 / 3.1',
        endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
        apiKey: 'nvapi-real-test-key-123456',
        mode: 'live_ai',
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = request.messages.find((message) => message.role === 'user');
    expect(prompt?.content).toContain(
      `Scenario Brief:\n${expectedBrief}\n\nAcceptance Criteria:\n1. Skip already processed job IDs during retry.`,
    );
    expect(computeEvidenceMetricsAndDiffSummary(evidence).brief).toBe(brief);
    expect(report.provider.mode).toBe('live_ai');
    expect(report.provider.modelId).toBe('moonshotai/kimi-k2-instruct');
    expect(report.score).toBe(89);
    expect(report.verdictLabel).toBe('Should Accept');
    expect(report.strengths).toContain(
      'Clean O(1) lookup set added in src/service.py.',
    );
  });

  it('removes the copied platform footer before clipping an outbound AI interaction excerpt', async () => {
    const prefix = 'Review the Terms and Conditions for job retries.';
    const followup = '\nPlease focus on the retry guard. '.repeat(10);
    const candidatePrompt =
      prefix + GENERATED_TERMS_AND_CONDITIONS_FOOTER + followup;
    const interaction = Object.freeze({
      interactionId: 'interaction_1',
      requestId: 'request_1',
      sequenceStart: '4',
      sequenceCompleted: '5',
      candidatePrompt,
      assistantResponse:
        'The guard checks whether the job ID is already present.',
      status: 'COMPLETED' as const,
      failureReason: null,
      errorMessage: null,
      providerId: 'nvidia',
      modelId: 'moonshotai/kimi-k2-instruct',
      createdAt: '2026-11-18T10:20:00.000Z',
      completedAt: '2026-11-18T10:21:00.000Z',
    });
    const evidence: R27Evidence = {
      ...makeEvidence(),
      aiInteractions: [interaction],
    };
    const mockFetch = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 401 }),
    );

    await generateR27AiCandidateReview(evidence, {
      fetchImpl: mockFetch,
      providerOverride: {
        presetId: 'nvidia:kimi-k2',
        providerId: 'nvidia',
        modelId: 'moonshotai/kimi-k2-instruct',
        label: 'NVIDIA NIM · Kimi K2 / 3.1',
        endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
        apiKey: 'nvapi-real-test-key-123456',
        mode: 'live_ai',
      },
    });

    const request = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = request.messages.find((message) => message.role === 'user');
    expect(prompt?.content).toContain(
      `1. [seq 4] prompt="${(prefix + followup).slice(0, 260)}" status=COMPLETED`,
    );
    expect(prompt?.content).not.toContain(
      GENERATED_TERMS_AND_CONDITIONS_FOOTER,
    );
    expect(evidence.aiInteractions).toEqual([interaction]);
    expect(evidence.aiInteractions?.[0]?.candidatePrompt).toBe(candidatePrompt);
  });

  it('falls back gracefully to evidence preview when upstream returns HTTP 401', async () => {
    const mockFetch = vi.fn(
      async () => new Response('Unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;

    const report = await generateR27AiCandidateReview(
      makeEvidence({ modified: true }),
      {
        fetchImpl: mockFetch,
        providerOverride: {
          presetId: 'openrouter:gemini-flash',
          providerId: 'openrouter',
          modelId: 'google/gemini-2.5-flash',
          label: 'OpenRouter · Gemini 2.5 Flash',
          endpoint: 'https://openrouter.ai/api/v1/chat/completions',
          apiKey: 'sk-or-invalid-key-1234',
          mode: 'live_ai',
        },
      },
    );

    expect(report.provider.mode).toBe('evidence_preview');
    expect(report.provider.fallbackReason).toContain('HTTP 401');
    expect(report.verdictLabel).toBe('Should Accept');
  });

  it('keeps initial SSR HTML free of legacy score strings and renders report on click', async () => {
    const evidence = makeEvidence({ modified: true });
    const ssrHtml = renderToStaticMarkup(
      <R27AiReviewPanel
        organizationId={evidence.organizationId}
        sessionId={evidence.sessionId}
        evidence={evidence}
      />,
    );

    expect(ssrHtml).toContain('AI Candidate Review');
    expect(ssrHtml).toContain('Generate AI Review');
    expect(ssrHtml).not.toContain('Score:');
    expect(ssrHtml).not.toContain('/ 100');
    expect(ssrHtml).not.toContain('Performance score:');

    await act(async () => {
      root = createRoot(container);
      root.render(
        <R27AiReviewPanel
          organizationId={evidence.organizationId}
          sessionId={evidence.sessionId}
          evidence={evidence}
        />,
      );
    });

    const previewBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Instant Preview'),
    );
    expect(previewBtn).toBeDefined();

    await act(async () => {
      previewBtn!.click();
    });

    expect(
      container.querySelector('[data-testid="r27-ai-review-score"]')
        ?.textContent,
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="r27-ai-review-verdict"]')
        ?.textContent,
    ).toBe('Should Accept');
    expect(container.textContent).toContain('Observed Strengths');
    expect(container.textContent).toContain('Weaknesses & Verification Risks');
  });
});
