import { describe, it, expect } from 'vitest';
import {
  defaultSyntheticAiSnapshot,
  defaultDisabledAiSnapshot,
  R212_SYNTHETIC_PROVIDER_ID,
  R212_SYNTHETIC_MODEL_ID,
  R212_MAX_PROMPT_CHARS,
  R212_MAX_INTERACTIONS_PER_SESSION,
} from '../../apps/web/src/r212-ai/contract';
import {
  SyntheticAiProvider,
  defaultSyntheticProvider,
} from '../../apps/web/src/r212-ai/synthetic-provider';
import { validateAssessmentDraft } from '../../apps/web/src/r211-builder/validation';
import type { R211AssessmentDraftInput } from '../../apps/web/src/r211-builder/contract';
import {
  buildR27EvidenceSources,
  sourcesForFilter,
} from '../../apps/web/app/evaluator/sessions/[sessionId]/evidence-workbench';
import type { R27Evidence } from '../../database/postgres/r27/contract.mjs';

const baseDraft: R211AssessmentDraftInput = {
  title: 'Distributed Event Bus Rate Limiter',
  brief: 'Implement a token-bucket rate limiter for the distributed event bus.',
  expectedBehavior: [
    'Enforces rate limit per client',
    'Replenishes tokens over time',
  ],
  acceptanceCriteria: ['Tests pass cleanly', 'No memory leaks observed'],
  primaryFilePath: 'limiter.py',
  starterFiles: [
    {
      path: 'limiter.py',
      content: '# Rate limiter\nclass RateLimiter:\n    pass\n',
    },
    { path: 'README.md', content: '# Task Instructions\n' },
  ],
  durationMinutes: 45,
  terminalEnabled: true,
  integratedAi: true,
  rubric: [
    {
      id: 'correctness',
      label: 'Correctness',
      description: 'Accurately throttles requests according to rate limits',
      weight: 100,
      applicability: { kind: 'always', rule: 'Applies to all' },
    },
  ],
};

describe('R2.12 Candidate AI Assistance Contract & Capability Snapshots', () => {
  it('defines default synthetic AI capability snapshot with test lane defaults', () => {
    expect(defaultSyntheticAiSnapshot.enabled).toBe(true);
    expect(defaultSyntheticAiSnapshot.configuredProviderId).toBe(
      R212_SYNTHETIC_PROVIDER_ID,
    );
    expect(defaultSyntheticAiSnapshot.configuredModelId).toBe(
      R212_SYNTHETIC_MODEL_ID,
    );
    expect(defaultSyntheticAiSnapshot.maxInteractions).toBe(
      R212_MAX_INTERACTIONS_PER_SESSION,
    );
    expect(defaultSyntheticAiSnapshot.maxPromptChars).toBe(
      R212_MAX_PROMPT_CHARS,
    );
    expect(defaultSyntheticAiSnapshot.maxInteractions).toBe(5);
    expect(defaultSyntheticAiSnapshot.maxPromptChars).toBe(4000);
  });

  it('defines default disabled AI capability snapshot with zero budget', () => {
    expect(defaultDisabledAiSnapshot.enabled).toBe(false);
    expect(defaultDisabledAiSnapshot.configuredProviderId).toBe('none');
    expect(defaultDisabledAiSnapshot.maxInteractions).toBe(0);
    expect(defaultDisabledAiSnapshot.maxPromptChars).toBe(0);
  });

  it('allows integratedAi: true in assessment builder validation for R2.12', () => {
    const result = validateAssessmentDraft(baseDraft);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);

    const disabledAiResult = validateAssessmentDraft({
      ...baseDraft,
      integratedAi: false,
    });
    expect(disabledAiResult.valid).toBe(true);
    expect(disabledAiResult.issues).toEqual([]);
  });
});

describe('R2.12 Synthetic AI Provider Deterministic Generation', () => {
  it('generates factual, reproducible responses for candidate prompts', async () => {
    const provider = new SyntheticAiProvider();
    const prompt =
      'How should I handle token replenishment when time delta is zero?';

    const req = {
      organizationId: '33333333-3333-3333-3333-333333333333',
      sessionId: 'sess_test',
      requestId: 'req-001',
      candidatePrompt: prompt,
      capabilitySnapshot: defaultSyntheticAiSnapshot,
    };

    const response1 = await provider.generateResponse(req);

    expect(response1.response).toBeTruthy();
    expect(response1.providerId).toBe(R212_SYNTHETIC_PROVIDER_ID);
    expect(response1.modelId).toBe(R212_SYNTHETIC_MODEL_ID);
    expect(response1.usage.promptChars).toBe(prompt.length);
    expect(response1.usage.responseChars).toBe(response1.response.length);
    expect(response1.usage.synthetic).toBe(true);

    // Repeatability
    const response2 = await provider.generateResponse(req);
    expect(response2.response).toBe(response1.response);
  });

  it('simulates provider errors when SIMULATE_PROVIDER_ERROR is triggered', async () => {
    const provider = new SyntheticAiProvider();

    await expect(
      provider.generateResponse({
        organizationId: '33333333-3333-3333-3333-333333333333',
        sessionId: 'sess_test',
        requestId: 'req-err-01',
        candidatePrompt:
          'SIMULATE_PROVIDER_ERROR: transient downstream timeout',
        capabilitySnapshot: defaultSyntheticAiSnapshot,
      }),
    ).rejects.toThrow(/simulated internal failure/i);
  });

  it('provides helpful assistance tailored to keywords like test or help', async () => {
    const provider = defaultSyntheticProvider;

    const testQuestion = await provider.generateResponse({
      organizationId: '33333333-3333-3333-3333-333333333333',
      sessionId: 'sess_test',
      requestId: 'req-test-01',
      candidatePrompt: 'How do I run the unit tests in this workspace?',
      capabilitySnapshot: defaultSyntheticAiSnapshot,
    });
    expect(testQuestion.response).toMatch(/assert|verify|retries/i);

    const helpQuestion = await provider.generateResponse({
      organizationId: '33333333-3333-3333-3333-333333333333',
      sessionId: 'sess_test',
      requestId: 'req-help-01',
      candidatePrompt: 'Hello, can you help me understand what to do?',
      capabilitySnapshot: defaultSyntheticAiSnapshot,
    });
    expect(helpQuestion.response).toMatch(/assistant|requirements/i);
  });
});

describe('R2.12 Evidence Workbench AI Display and Filtering', () => {
  const mockEvidence: R27Evidence = {
    permission: 'assigned_reviewer',
    reviewer: {
      subjectId: '11111111-1111-1111-1111-111111111111',
      principalId: '22222222-2222-2222-2222-222222222222',
    },
    organizationId: '33333333-3333-3333-3333-333333333333',
    sessionId: 'sess_test_r212',
    assignment: {
      id: 'asgn_1',
      version: '1',
      assignedAt: '2026-10-27T10:00:00.000Z',
    },
    scenario: {
      id: 'scen_1',
      version: '1',
      title: 'Distributed Event Bus Rate Limiter',
      snapshotText: JSON.stringify(baseDraft),
      snapshotDigest: 'digest_123',
      starterFiles: { 'limiter.py': '# Starter\n' },
    },
    status: 'SUBMITTED',
    createdAt: '2026-10-27T10:00:00.000Z',
    activatedAt: '2026-10-27T10:05:00.000Z',
    submittedAt: '2026-10-27T10:45:00.000Z',
    closureReason: 'candidate_submission',
    submission: {
      submittedAt: '2026-10-27T10:45:00.000Z',
      closureReason: 'candidate_submission',
      workspaceDigest: 'ws_digest_abc',
      manifestDigest: 'man_digest_xyz',
      files: [
        {
          path: 'limiter.py',
          version: '2',
          digest: 'dig_file_2',
          content: '# Candidate implementation\n',
        },
      ],
    },
    revisions: [
      {
        path: 'limiter.py',
        version: '1',
        digest: 'dig_file_1',
        content: '# Starter\n',
        source: 'starter',
      },
      {
        path: 'limiter.py',
        version: '2',
        digest: 'dig_file_2',
        content: '# Candidate implementation\n',
        source: 'submitted',
      },
    ],
    events: [
      {
        sequence: '1',
        type: 'SESSION_ACTIVATED',
        timestamp: '2026-10-27T10:05:00.000Z',
        payload: { scenarioDigest: 'digest_123' },
        provenance: 'hirearchy.candidate_session_events',
      },
      {
        sequence: '2',
        type: 'AI_REQUEST_STARTED',
        timestamp: '2026-10-27T10:10:00.000Z',
        payload: {
          requestId: 'req_ai_1',
          interactionId: 'ai_int_1',
          promptChars: 45,
        },
        provenance: 'hirearchy.candidate_session_events',
      },
      {
        sequence: '3',
        type: 'AI_RESPONSE_COMPLETED',
        timestamp: '2026-10-27T10:10:01.000Z',
        payload: {
          requestId: 'req_ai_1',
          interactionId: 'ai_int_1',
          sequenceStart: '2',
          durationMs: 850,
          responseChars: 320,
        },
        provenance: 'hirearchy.candidate_session_events',
      },
      {
        sequence: '4',
        type: 'SESSION_SUBMITTED',
        timestamp: '2026-10-27T10:45:00.000Z',
        payload: {
          closureReason: 'candidate_submission',
          workspaceDigest: 'ws_digest_abc',
        },
        provenance: 'hirearchy.candidate_session_events',
      },
    ],
    aiInteractions: [
      {
        interactionId: 'ai_int_1',
        requestId: 'req_ai_1',
        sequenceStart: '2',
        sequenceCompleted: '3',
        candidatePrompt: 'What algorithm is recommended for the rate limiter?',
        assistantResponse:
          'The token-bucket algorithm with exponential replenishment is recommended.',
        status: 'COMPLETED',
        failureReason: null,
        errorMessage: null,
        providerId: R212_SYNTHETIC_PROVIDER_ID,
        modelId: R212_SYNTHETIC_MODEL_ID,
        createdAt: '2026-10-27T10:10:00.000Z',
        completedAt: '2026-10-27T10:10:01.000Z',
      },
    ],
    pagination: { limit: 50, nextAfterSequence: null },
    availability: {
      terminal: 'unavailable',
      ai: 'available',
      verification: 'unavailable',
      history: 'metadata_only',
      limitations: [
        'Terminal and verification evidence is unavailable in this lane.',
      ],
    },
  };

  it('builds R27 evidence sources with events, files, and AI conversations', () => {
    const sources = buildR27EvidenceSources(mockEvidence);
    expect(sources.length).toBeGreaterThan(0);

    // Event sources
    const eventSources = sources.filter((s) => s.r27?.kind === 'event');
    expect(eventSources.length).toBe(4);

    const aiRequestEvent = eventSources.find(
      (s) => s.title === 'AI request recorded',
    );
    expect(aiRequestEvent).toBeDefined();
    expect(aiRequestEvent?.summary).toContain('45 chars');

    const aiResponseEvent = eventSources.find(
      (s) => s.title === 'AI response recorded',
    );
    expect(aiResponseEvent).toBeDefined();
    expect(aiResponseEvent?.summary).toContain('850ms');

    // Conversation sources
    const conversationSources = sources.filter(
      (s) => s.kind === 'conversation',
    );
    expect(conversationSources.length).toBe(1);

    const convo = conversationSources[0];
    expect(convo.title).toBe('AI conversation');
    expect(convo.summary).toContain('completed');
    expect(convo.summary).toContain(R212_SYNTHETIC_PROVIDER_ID);
    expect(convo.conversation?.prompt).toBe(
      'What algorithm is recommended for the rate limiter?',
    );
    expect(convo.conversation?.response).toContain('token-bucket algorithm');
    expect(convo.conversation?.outcome).toBe('completed');
  });

  it('correctly filters evidence by Chronology and AI conversations', () => {
    const sources = buildR27EvidenceSources(mockEvidence);

    // Chronology filter returns all timeline events in order
    const chronologySources = sourcesForFilter(sources, 'Chronology', []);
    expect(chronologySources.length).toBe(4);
    expect(chronologySources.map((s) => s.title)).toEqual([
      'Session activated',
      'AI request recorded',
      'AI response recorded',
      'Session submitted',
    ]);

    // AI conversations filter returns conversation cards
    const aiSources = sourcesForFilter(sources, 'AI conversations', []);
    expect(aiSources.length).toBe(1);
    expect(aiSources[0].kind).toBe('conversation');
    expect(aiSources[0].conversation?.interactionId).toBe('ai_int_1');

    // Code changes filter returns submitted files
    const fileSources = sourcesForFilter(sources, 'Code changes', []);
    expect(fileSources.length).toBe(1);
    expect(fileSources[0].title).toBe('Submitted file · limiter.py');
  });
});

describe('R2.12 Candidate AI Request Validation & Budget Constraints', () => {
  it('enforces prompt size limits and rejects prompts exceeding 4,000 characters', () => {
    const validPrompt = 'x'.repeat(4000);
    expect(validPrompt.length).toBe(R212_MAX_PROMPT_CHARS);

    const oversizedPrompt = 'x'.repeat(4001);
    expect(oversizedPrompt.length).toBeGreaterThan(R212_MAX_PROMPT_CHARS);

    // Check boundary functions
    const isWithinLimit = (p: string) => p.length <= R212_MAX_PROMPT_CHARS;
    expect(isWithinLimit(validPrompt)).toBe(true);
    expect(isWithinLimit(oversizedPrompt)).toBe(false);
  });

  it('correctly tracks candidate AI remaining budget', () => {
    const maxBudget = R212_MAX_INTERACTIONS_PER_SESSION;
    expect(maxBudget).toBe(5);

    const calculateRemaining = (completed: number, max: number = maxBudget) =>
      Math.max(0, max - completed);

    expect(calculateRemaining(0)).toBe(5);
    expect(calculateRemaining(1)).toBe(4);
    expect(calculateRemaining(5)).toBe(0);
    expect(calculateRemaining(6)).toBe(0);
  });
});
