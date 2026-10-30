import { describe, expect, it } from 'vitest';
import type { AiInteraction } from '../../apps/web/src/ai/ai-interaction';
import { buildChronologicalReconstruction } from '../../apps/web/src/evidence/chronological-reconstruction';
import type { SessionEvent } from '../../apps/web/src/events/session-event';
import { buildEvaluatorAiConversations } from '../../apps/web/src/evaluator/evaluator-ai-conversations';
import { buildEvidenceReferenceCatalog } from '../../apps/web/src/reconstruction/evidence-reference-catalog';

const sessionId = 'ai-review-session';
const startedAt = '2026-10-21T00:00:10.000Z';

const events: SessionEvent[] = [
  {
    id: 'ai-start',
    sessionId,
    sequence: 1,
    type: 'AI_REQUEST_STARTED',
    timestamp: startedAt,
    source: 'server',
    payload: {
      interactionId: 'linked-interaction',
      clientRequestId: 'request-1',
      configuredProviderId: 'private-provider',
      configuredModelId: 'private-model',
      candidateInputExcerpt: 'prompt excerpt',
      candidateInputBytes: 2500,
    },
  },
  {
    id: 'ai-response',
    sessionId,
    sequence: 2,
    type: 'AI_RESPONSE_COMPLETED',
    timestamp: '2026-10-21T00:00:12.000Z',
    source: 'server',
    payload: {
      interactionId: 'linked-interaction',
      reportedModelId: 'private-model',
      responseExcerpt: 'response excerpt',
      responseBytes: 2600,
      durationMs: 2000,
    },
  },
];

const reconstruction = buildChronologicalReconstruction(
  {
    activatedAt: '2026-10-21T00:00:00.000Z',
    submittedAt: '2026-10-21T00:01:00.000Z',
  },
  events,
);
const entries = buildEvidenceReferenceCatalog(
  sessionId,
  reconstruction,
).entries;

const interaction = (
  id: string,
  candidatePromptText: string,
  capturedResponseText: string,
): AiInteraction => ({
  id,
  sessionId,
  clientRequestId: id,
  status: 'COMPLETED',
  configuredProviderId: 'private-provider',
  configuredModelId: 'private-model',
  candidatePromptText,
  capturedResponseText,
  createdAt: startedAt,
});

describe('evaluator AI conversations', () => {
  it('shows full stored messages only for interactions linked to this session evidence', () => {
    const conversations = buildEvaluatorAiConversations(
      reconstruction,
      entries,
      [
        interaction(
          'linked-interaction',
          'full candidate prompt',
          'full assistant response',
        ),
        {
          ...interaction(
            'linked-interaction',
            'foreign session prompt',
            'foreign response',
          ),
          sessionId: 'another-session',
        },
        interaction(
          'unlinked-interaction',
          'unlinked prompt',
          'unlinked response',
        ),
      ],
      '2026-10-21T00:00:00.000Z',
    );

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      interactionId: 'linked-interaction',
      prompt: 'full candidate prompt',
      response: 'full assistant response',
      promptTruncated: false,
      responseTruncated: false,
      outcome: 'completed',
      elapsedLabel: '+10s',
      responseElapsedLabel: '+12s',
    });
    expect(conversations[0]?.evidenceRefs).toHaveLength(2);
    expect(JSON.stringify(conversations)).not.toContain('private-provider');
    expect(JSON.stringify(conversations)).not.toContain('private-model');
  });

  it('marks event-only prompt and response excerpts as partial when stored text is unavailable', () => {
    const conversations = buildEvaluatorAiConversations(
      reconstruction,
      entries,
      [],
      null,
    );

    expect(conversations[0]).toMatchObject({
      prompt: 'prompt excerpt',
      response: 'response excerpt',
      promptTruncated: true,
      responseTruncated: true,
      outcome: 'completed',
      elapsedLabel: null,
    });
  });
});
