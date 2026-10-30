import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AiCapabilitySnapshot,
  AiInteraction,
} from '../../apps/web/src/ai/ai-interaction';
import type { SessionEvent } from '../../apps/web/src/events/session-event';
import type { TaskRubricSnapshot } from '../../apps/web/src/assessments/task-rubric';
import {
  TaskAssessmentScoringService,
  type TaskAssessmentScoringProvider,
  type TaskScoringSource,
} from '../../apps/web/src/scoring/task-assessment-scoring';
import { SqliteTaskAssessmentScoreStore } from '../../apps/web/src/scoring/task-assessment-score-store';

const directories: string[] = [];
const makeStore = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-task-score-'));
  directories.push(directory);
  return new SqliteTaskAssessmentScoreStore(
    path.join(directory, 'scores.sqlite'),
  );
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const rubric: TaskRubricSnapshot = {
  version: 'task-rubric-v1',
  criteria: [
    {
      id: 'implementation',
      label: 'Implementation quality',
      description: 'The task change is clear.',
      weight: 40,
      applicability: { kind: 'always', rule: 'Always applies.' },
    },
    {
      id: 'verification',
      label: 'Relevant verification',
      description: 'Recorded checks exercise the behavior.',
      weight: 50,
      applicability: { kind: 'always', rule: 'Always applies.' },
    },
    {
      id: 'ai-collaboration',
      label: 'Recorded AI collaboration',
      description: 'Recorded integrated-AI use is checked.',
      weight: 10,
      applicability: {
        kind: 'recorded_integrated_ai_interaction',
        rule: 'Only applies to recorded integrated-AI interactions.',
      },
    },
  ],
};

const enabledAi: AiCapabilitySnapshot = {
  enabled: true,
  contractVersion: 'slice-6b-v1',
  configuredProviderId: 'mock-ai',
  configuredModelId: 'mock-chat-v1',
  configurationVersion: '1',
};

const source = (
  overrides: Partial<TaskScoringSource> = {},
): TaskScoringSource => ({
  sessionId: 'session-1',
  scenario: {
    id: 'scenario-002',
    version: '1.0.0',
    title: 'A bounded engineering task',
    brief: 'Investigate the reported behavior.',
    acceptanceCriteria: ['Preserve the invariant.'],
  },
  activatedAt: '2026-10-03T09:00:00.000Z',
  submittedAt: '2026-10-03T10:00:00.000Z',
  diff: '--- a/app.py\n+++ b/app.py\n+return value\n',
  events: [],
  rubric,
  aiCapabilitySnapshot: enabledAi,
  aiInteractions: [],
  ...overrides,
});

const validProvider = (
  analyze: TaskAssessmentScoringProvider['analyze'] = async (packet) => ({
    criteria: packet.applicableCriteria.map((criterion) => ({
      criterionId: criterion.id,
      status: 'scored',
      score: criterion.id === 'implementation' ? 80 : 100,
      reason: 'Linked task evidence supports this assessment.',
      evidenceRefs: ['session:session-1:final-diff'],
    })),
  }),
): TaskAssessmentScoringProvider => ({
  providerId: 'test-provider',
  modelId: 'test-model',
  analyze,
});

describe('TaskAssessmentScoringService', () => {
  it('reports unavailable when no trusted scoring provider is configured', async () => {
    const service = new TaskAssessmentScoringService(
      makeStore(),
      null,
      () => [],
    );

    expect(service.get(source()).status).toBe('unavailable');
    expect((await service.request(source())).status).toBe('unavailable');
  });

  it('keeps legacy sessions rubric-unavailable without inventing criteria', async () => {
    const service = new TaskAssessmentScoringService(
      makeStore(),
      validProvider(),
      () => [],
    );

    const report = await service.request(source({ rubric: null }));
    expect(report.status).toBe('rubric_unavailable');
    expect(report.rubric).toBeNull();
    expect(report.totalScore).toBeNull();
  });

  it('excludes a conditionally not-applicable AI criterion and recomputes the total', async () => {
    const analyze = vi.fn(validProvider().analyze);
    const service = new TaskAssessmentScoringService(
      makeStore(),
      validProvider(analyze),
      () => [],
    );

    const report = await service.request(source());
    expect(report.status).toBe('available');
    expect(report.providerId).toBe('test-provider');
    expect(report.applicableWeight).toBe(90);
    expect(report.scoredWeight).toBe(90);
    expect(report.totalScore).toBe(91.1);
    expect(
      report.criteria.find((item) => item.criterionId === 'ai-collaboration'),
    ).toMatchObject({
      status: 'not_applicable',
      score: null,
    });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(
      analyze.mock.calls[0][0].applicableCriteria.map((item) => item.id),
    ).toEqual(['implementation', 'verification']);
  });

  it('withholds the total when conditional applicability cannot be established', async () => {
    const service = new TaskAssessmentScoringService(
      makeStore(),
      validProvider(),
      () => [],
    );

    const report = await service.request(
      source({
        aiCapabilitySnapshot: {
          ...enabledAi,
          contractVersion: 'unknown-capture-contract',
        },
      }),
    );
    expect(report.status).toBe('incomplete');
    expect(report.totalScore).toBeNull();
    expect(report.applicableWeight).toBe(100);
    expect(report.scoredWeight).toBe(90);
    expect(
      report.criteria.find((item) => item.criterionId === 'ai-collaboration'),
    ).toMatchObject({
      status: 'insufficient_evidence',
      score: null,
    });
  });

  it('scores recorded integrated-AI activity only when events and interaction records agree', async () => {
    const interaction: AiInteraction = {
      id: 'ai-interaction-1',
      sessionId: 'session-1',
      clientRequestId: 'request-1',
      status: 'COMPLETED',
      configuredProviderId: 'mock-ai',
      configuredModelId: 'mock-chat-v1',
      candidatePromptText: 'Check the idempotency behavior.',
      capturedResponseText: 'Consider a uniqueness constraint.',
      createdAt: '2026-10-03T09:30:00.000Z',
      terminalAt: '2026-10-03T09:31:00.000Z',
      startedSequence: 11,
      terminalSequence: 12,
    };
    const events = [
      {
        id: 'event-ai-start',
        sessionId: 'session-1',
        sequence: 11,
        type: 'AI_REQUEST_STARTED',
        timestamp: interaction.createdAt,
        source: 'server',
        payload: {
          interactionId: interaction.id,
          clientRequestId: interaction.clientRequestId,
          configuredProviderId: interaction.configuredProviderId,
          configuredModelId: interaction.configuredModelId,
          candidateInputExcerpt: interaction.candidatePromptText,
          candidateInputBytes: interaction.candidatePromptText.length,
        },
      },
      {
        id: 'event-ai-complete',
        sessionId: 'session-1',
        sequence: 12,
        type: 'AI_RESPONSE_COMPLETED',
        timestamp: interaction.terminalAt,
        source: 'server',
        payload: {
          interactionId: interaction.id,
          durationMs: 60_000,
          reportedModelId: interaction.configuredModelId,
          responseExcerpt: interaction.capturedResponseText!,
          responseBytes: interaction.capturedResponseText!.length,
        },
      },
    ] as SessionEvent[];
    const provider = validProvider();
    const analyze = vi.fn(provider.analyze);
    const service = new TaskAssessmentScoringService(
      makeStore(),
      { ...provider, analyze },
      () => [interaction],
    );

    const report = await service.request(source({ events }));
    expect(report.status).toBe('available');
    expect(report.applicableWeight).toBe(100);
    expect(
      report.criteria.find((item) => item.criterionId === 'ai-collaboration')
        ?.status,
    ).toBe('scored');
    expect(
      analyze.mock.calls[0][0].applicableCriteria.map((item) => item.id),
    ).toContain('ai-collaboration');
  });

  it('marks AI applicability insufficient when the event stream has no matching interaction record', async () => {
    const events = [
      {
        id: 'event-ai-start',
        sessionId: 'session-1',
        sequence: 11,
        type: 'AI_REQUEST_STARTED',
        timestamp: '2026-10-03T09:30:00.000Z',
        source: 'server',
        payload: {
          interactionId: 'missing-row',
          clientRequestId: 'request-1',
          configuredProviderId: 'mock-ai',
          configuredModelId: 'mock-chat-v1',
          candidateInputExcerpt: 'Check the idempotency behavior.',
          candidateInputBytes: 31,
        },
      },
    ] as SessionEvent[];
    const service = new TaskAssessmentScoringService(
      makeStore(),
      validProvider(),
      () => [],
    );

    const report = await service.request(source({ events }));
    expect(report.status).toBe('incomplete');
    expect(report.totalScore).toBeNull();
    expect(
      report.criteria.find((item) => item.criterionId === 'ai-collaboration'),
    ).toMatchObject({
      status: 'insufficient_evidence',
      score: null,
    });
  });

  it('rejects unknown evidence references and persists a failed state without a total', async () => {
    const provider = validProvider(async (packet) => ({
      criteria: packet.applicableCriteria.map((criterion) => ({
        criterionId: criterion.id,
        status: 'scored',
        score: 90,
        reason: 'Provider result.',
        evidenceRefs: ['untrusted:path'],
      })),
    }));
    const service = new TaskAssessmentScoringService(
      makeStore(),
      provider,
      () => [],
    );

    const report = await service.request(source());
    expect(report.status).toBe('failed');
    expect(report.totalScore).toBeNull();
    expect(report.criteria.every((item) => item.status !== 'scored')).toBe(
      true,
    );
    expect(service.get(source()).status).toBe('failed');
  });

  it('reuses a saved report rather than calling the provider again', async () => {
    const analyze = vi.fn(validProvider().analyze);
    const service = new TaskAssessmentScoringService(
      makeStore(),
      validProvider(analyze),
      () => [],
    );

    const first = await service.request(source());
    const second = await service.request(source());
    expect(first.status).toBe('available');
    expect(second).toMatchObject({
      status: 'available',
      totalScore: 91.1,
      rubric: { version: 'task-rubric-v1' },
      providerId: 'test-provider',
      model: 'test-model',
    });
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('keeps every criterion unscored when the provider fails', async () => {
    const service = new TaskAssessmentScoringService(
      makeStore(),
      validProvider(async () => {
        throw new Error('provider unavailable');
      }),
      () => [],
    );

    const report = await service.request(source());
    expect(report.status).toBe('failed');
    expect(report.totalScore).toBeNull();
    expect(report.criteria.every((item) => item.status !== 'scored')).toBe(
      true,
    );
  });
});
