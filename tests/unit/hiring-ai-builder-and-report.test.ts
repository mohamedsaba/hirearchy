import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { R27Evidence } from '../../database/postgres/r27/contract.mjs';
import { callNvidiaKimiChat } from '../../apps/web/src/ai/kimi-client';
import { generateHiringAssessmentWithKimi } from '../../apps/web/src/hiring/ai-builder';
import {
  buildDeterministicPerformanceFitReport,
  generateAcceptancePerformanceReport,
} from '../../apps/web/src/hiring/ai-performance-report';
import { validateAssessmentDraft } from '../../apps/web/src/r211-builder/validation';
import { generateR27AiCandidateReview } from '../../apps/web/src/r27-evidence/ai-review';

function makeEvidence(): R27Evidence {
  const starter = 'def process_item(item):\n    return item\n';
  const submitted =
    'def process_item(item):\n    if item.get("id") in SEEN:\n        return None\n    SEEN.add(item.get("id"))\n    return item\n';

  return {
    permission: 'assigned_reviewer',
    reviewer: {
      subjectId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
    },
    organizationId: '3d58ca5b-bba6-4ba8-b561-8d9802aa3b8a',
    sessionId: 'sess_kimi_unit_001',
    assignment: {
      id: 'assign_001',
      version: '1',
      assignedAt: '2026-11-18T10:00:00.000Z',
    },
    scenario: {
      id: 'webhook-dedup',
      version: '1',
      title: 'Idempotent Event Pipeline',
      snapshotText: JSON.stringify({
        scenario: {
          brief: 'Deduplicate retried webhook events safely.',
          acceptanceCriteria: [
            'Skip duplicate event IDs cleanly.',
            'Add unit tests covering out-of-order replay.',
          ],
        },
      }),
      snapshotDigest: 'sha256:snap001',
      starterFiles: {
        'src/pipeline.py': starter,
        'tests/test_pipeline.py': 'def test_ok():\n    assert True\n',
      },
    },
    status: 'SUBMITTED',
    createdAt: '2026-11-18T09:50:00.000Z',
    activatedAt: '2026-11-18T10:00:00.000Z',
    submittedAt: '2026-11-18T10:25:00.000Z',
    closureReason: 'candidate_submission',
    submission: {
      submittedAt: '2026-11-18T10:25:00.000Z',
      closureReason: 'candidate_submission',
      workspaceDigest: 'sha256:ws001',
      manifestDigest: 'sha256:man001',
      files: [
        {
          path: 'src/pipeline.py',
          content: submitted,
          version: '2',
          digest: 'sha256:sub',
        },
        {
          path: 'tests/test_pipeline.py',
          content: 'def test_ok():\n    assert True\n',
          version: '1',
          digest: 'sha256:tst',
        },
      ],
    },
    revisions: [],
    events: [
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
        payload: { path: 'src/pipeline.py', version: '2' },
        provenance: 'hirearchy.candidate_session_events',
      },
      {
        sequence: '3',
        type: 'EXECUTION_COMPLETED',
        timestamp: '2026-11-18T10:20:00.000Z',
        payload: {},
        provenance: 'hirearchy.candidate_session_events',
      },
    ],
    executions: [],
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

describe('Kimi K3.1 Pro AI Builder, Evidence Timing Deltas & Fit Report', () => {
  it('polls an accepted NVIDIA request without sending another prompt', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 202,
          headers: { 'nvcf-reqid': 'demo-request' },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ choices: [{ message: { content: 'READY' } }] }),
      );
    expect(
      await callNvidiaKimiChat({
        systemPrompt: 'Local test',
        userPrompt: 'Reply READY',
        fetchImpl,
      }),
    ).toMatchObject({ content: 'READY' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toEqual(
      'https://integrate.api.nvidia.com/v1/status/demo-request',
    );
    expect(fetchImpl.mock.calls[1][1]?.body).toBeUndefined();
  });
  const prevNvidia = process.env.NVIDIA_API_KEY;

  beforeEach(() => {
    process.env.NVIDIA_API_KEY = 'nvapi-test-real-looking-key-1234567890abcdef';
  });

  afterEach(() => {
    if (prevNvidia === undefined) {
      delete process.env.NVIDIA_API_KEY;
    } else {
      process.env.NVIDIA_API_KEY = prevNvidia;
    }
    vi.restoreAllMocks();
  });

  it('generates a schema-valid assessment problem using moonshotai/kimi-k3.1-pro', async () => {
    let capturedBody = '';
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: 'Outbox Relay Ordering Fix',
                  brief:
                    'Debug and fix idempotent event ordering across a two-file Python relay worker and store.',
                  primaryFilePath: 'src/relay.py',
                  expectedBehavior: [
                    'Processes each event ID at most once.',
                    'Preserves partition ordering under concurrent workers.',
                  ],
                  acceptanceCriteria: [
                    'Duplicate event deliveries do not emit duplicate messages.',
                    'Unit test suite passes cleanly under pytest.',
                  ],
                  starterFiles: [
                    { path: 'README.md', content: '# Outbox Relay' },
                    {
                      path: 'src/relay.py',
                      content: 'def relay(events):\n    return events\n',
                    },
                    {
                      path: 'tests/test_relay.py',
                      content: 'def test_relay():\n    assert True\n',
                    },
                  ],
                  rubric: [
                    {
                      id: 'core',
                      label: 'Idempotency & ordering',
                      description:
                        'Correct deduplication and state transitions.',
                      weight: 70,
                    },
                    {
                      id: 'tests',
                      label: 'Tests',
                      description: 'Covers replay scenarios.',
                      weight: 30,
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await generateHiringAssessmentWithKimi(
      {
        targetRole: 'Backend Engineer',
        experienceLevel: 'senior',
        yearsExperience: 6,
        skills: ['Python', 'Concurrency & Idempotency'],
        problemStructure: 'multi_file',
        workKind: 'incident',
        domain: 'fintech',
        durationMinutes: 60,
        integratedAi: true,
      },
      { fetchImpl },
    );

    expect(result.modelId).toBe('moonshotai/kimi-k3.1-pro');
    expect(capturedBody).toContain('"model":"moonshotai/kimi-k3.1-pro"');
    expect(capturedBody).toContain('Backend Engineer');
    expect(result.draft.templateId).toBe('ai-generated');
    expect(validateAssessmentDraft(result.draft).valid).toBe(true);
  });

  it('includes chronological timing deltas and role context in AI Candidate Review', async () => {
    let capturedPrompt = '';
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      capturedPrompt = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  score: 82,
                  verdict: 'accept',
                  confidenceLabel: 'High confidence',
                  headline: 'Methodical deduplication implementation',
                  rationale:
                    'Implemented deduplication cleanly within 12 minutes and executed tests at +20m.',
                  strengths: ['Clean idempotency guard added cleanly'],
                  weaknesses: ['Uses in-memory SEEN set without bounding'],
                  timingInsights: [
                    '12m initial reading & design pause before first edit in src/pipeline.py (Δ+12m 0s).',
                  ],
                  requirementBreakdown: [
                    {
                      requirement: 'Skip duplicate event IDs cleanly.',
                      status: 'met',
                      evidence: 'SEEN guard added in src/pipeline.py.',
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const report = await generateR27AiCandidateReview(makeEvidence(), {
      preset: 'nvidia:kimi-k2',
      hiringContext: {
        targetRole: 'Backend Engineer',
        experienceLevel: 'senior',
        skills: ['Python', 'Concurrency & Idempotency'],
      },
      fetchImpl,
    });

    expect(report.provider.mode).toBe('live_ai');
    expect(report.provider.modelId).toBe('moonshotai/kimi-k3.1-pro');
    expect(capturedPrompt).toContain('Δ+12m 0s');
    expect(capturedPrompt).toContain('Backend Engineer');
    expect(report.timingInsights).toHaveLength(1);
    expect(report.requirementBreakdown?.[0]?.status).toBe('met');
  });

  it('produces Managerial Performance & Fit Report with Kimi K3.1 Pro and deterministic fallback', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  overallFitVerdict: 'good_fit_with_probes',
                  fitHeadline:
                    'Strong backend fundamentals; probe distributed persistence',
                  whyGoodOrBadFit:
                    'Resolved duplicate webhook processing swiftly; verify storage trade-offs next.',
                  requirementAssessment: [
                    {
                      requirement: 'Skip duplicate event IDs cleanly.',
                      status: 'demonstrated',
                      evidence: 'Guarded process_item with SEEN set.',
                    },
                  ],
                  strengths: ['Fast problem localization'],
                  weaknessesAndRisks: [
                    'Unbounded memory state in starter solution',
                  ],
                  clearlyDemonstrated: ['Clean Python control flow'],
                  unclearOrNotAssessed: ['Persistence across worker restarts'],
                  suggestedNextInterviewQuestions: [
                    'How would you swap the in-memory set for Postgres transactional deduplication?',
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const live = await generateAcceptancePerformanceReport({
      evidence: makeEvidence(),
      targetRole: 'Backend Engineer',
      experienceLevel: 'senior',
      skills: ['Python', 'PostgreSQL'],
      evaluatorStrengths: ['Readable code'],
      evaluatorWeaknesses: ['No new tests'],
      evaluatorFeedbackNote: 'Good signal overall.',
      internalNotes: 'Probe distributed state.',
      nextStageLabel: 'Managerial Interview',
      allowLiveAi: true,
      fetchImpl,
    });

    expect(live.provider.mode).toBe('live_ai');
    expect(live.provider.modelId).toBe('moonshotai/kimi-k3.1-pro');
    expect(live.suggestedNextInterviewQuestions.length).toBeGreaterThan(0);

    const offline = buildDeterministicPerformanceFitReport(
      {
        evidence: makeEvidence(),
        targetRole: 'Backend Engineer',
        experienceLevel: 'senior',
        skills: ['Python'],
        evaluatorStrengths: ['Readable code'],
        evaluatorWeaknesses: [],
        evaluatorFeedbackNote: 'Good.',
        internalNotes: 'Notes.',
        nextStageLabel: 'Managerial Interview',
        allowLiveAi: false,
      },
      'Plan preview',
    );
    expect(offline.provider.mode).toBe('evidence_summary');
    expect(offline.overallFitVerdict).toBe('not_assessed');
    expect(
      offline.requirementAssessment.every(
        (item) => item.status === 'not_assessed',
      ),
    ).toBe(true);
    expect(offline.clearlyDemonstrated.length).toBeGreaterThan(0);
  });
});
