import type { AiInteraction } from '../ai/ai-interaction';
import type { ReconstructionItem } from '../evidence/chronological-reconstruction';
import type { EvidenceCatalogEntry } from '../reconstruction/evidence-reference-catalog';
import { formatElapsed } from './evaluator-review-presentation';

type AiEvidenceItem = Extract<
  ReconstructionItem,
  {
    kind:
      | 'AI_REQUEST_STARTED'
      | 'AI_RESPONSE_COMPLETED'
      | 'AI_REQUEST_CANCELLED'
      | 'AI_REQUEST_FAILED';
  }
>;

export type EvaluatorAiConversation = Readonly<{
  interactionId: string;
  startedAt: string | null;
  respondedAt: string | null;
  elapsedLabel: string | null;
  responseElapsedLabel: string | null;
  prompt: string | null;
  promptTruncated: boolean;
  response: string | null;
  responseTruncated: boolean;
  outcome: 'completed' | 'cancelled' | 'failed' | 'incomplete';
  evidenceRefs: readonly string[];
}>;

const isAiItem = (item: ReconstructionItem): item is AiEvidenceItem =>
  item.kind === 'AI_REQUEST_STARTED' ||
  item.kind === 'AI_RESPONSE_COMPLETED' ||
  item.kind === 'AI_REQUEST_CANCELLED' ||
  item.kind === 'AI_REQUEST_FAILED';

const excerptIsTruncated = (text: string, bytes: number) =>
  Buffer.byteLength(text, 'utf8') < bytes;

export const buildEvaluatorAiConversations = (
  chronology: readonly ReconstructionItem[],
  evidenceEntries: readonly EvidenceCatalogEntry[],
  interactions: readonly AiInteraction[],
  activatedAt: string | null,
): readonly EvaluatorAiConversation[] => {
  const groups = new Map<string, AiEvidenceItem[]>();
  for (const item of chronology) {
    if (!isAiItem(item)) continue;
    const group = groups.get(item.interactionId) ?? [];
    group.push(item);
    groups.set(item.interactionId, group);
  }

  const storedById = new Map(
    interactions
      .filter(
        (interaction) =>
          groups.has(interaction.id) &&
          interaction.sessionId === evidenceEntries[0]?.sessionId,
      )
      .map((interaction) => [interaction.id, interaction]),
  );
  const evidenceRefByEventId = new Map<string, string>();
  for (const entry of evidenceEntries) {
    const item = entry.item;
    if (item && 'rawEventId' in item)
      evidenceRefByEventId.set(item.rawEventId, entry.evidenceRef);
  }

  return [...groups].map(([interactionId, items]) => {
    const request = items.find((item) => item.kind === 'AI_REQUEST_STARTED');
    const response = items.find(
      (item) => item.kind === 'AI_RESPONSE_COMPLETED',
    );
    const cancellation = items.find(
      (item) => item.kind === 'AI_REQUEST_CANCELLED',
    );
    const failure = items.find((item) => item.kind === 'AI_REQUEST_FAILED');
    const stored = storedById.get(interactionId);
    const prompt =
      request && typeof stored?.candidatePromptText === 'string'
        ? stored.candidatePromptText
        : (request?.candidateInputExcerpt ?? null);
    const responseText =
      response && typeof stored?.capturedResponseText === 'string'
        ? stored.capturedResponseText
        : (response?.responseExcerpt ?? null);
    const elapsedLabel = request
      ? formatElapsed(activatedAt, request.timestamp)
      : response
        ? formatElapsed(activatedAt, response.timestamp)
        : null;

    return {
      interactionId,
      startedAt: request?.timestamp ?? null,
      respondedAt: response?.timestamp ?? null,
      elapsedLabel,
      responseElapsedLabel: response
        ? formatElapsed(activatedAt, response.timestamp)
        : null,
      prompt,
      promptTruncated:
        Boolean(request && typeof stored?.candidatePromptText !== 'string') &&
        request?.kind === 'AI_REQUEST_STARTED' &&
        excerptIsTruncated(
          request.candidateInputExcerpt,
          request.candidateInputBytes,
        ),
      response: responseText,
      responseTruncated:
        Boolean(response && typeof stored?.capturedResponseText !== 'string') &&
        response?.kind === 'AI_RESPONSE_COMPLETED' &&
        excerptIsTruncated(response.responseExcerpt, response.responseBytes),
      outcome: response
        ? 'completed'
        : cancellation
          ? 'cancelled'
          : failure
            ? 'failed'
            : 'incomplete',
      evidenceRefs: items.flatMap((item) => {
        const reference = evidenceRefByEventId.get(item.rawEventId);
        return reference ? [reference] : [];
      }),
    };
  });
};
