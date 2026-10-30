import type { CandidateContextAttachment } from '../../../../../../../src/ai/ai-interaction';
import { createHash } from 'node:crypto';
import { validateCandidateContextAttachments } from '../../../../../../../src/ai/ai-interaction';
import {
  NVIDIA_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
} from '../../../../../../../src/ai/server-ai-configuration';
import { getAiInteractionService } from '../../../../../../../src/ai/ai-interaction-service';
import { errorResponse } from '../../../../../../../src/http/error-response';
import { getSessionService } from '../../../../../../../src/sessions/session-service';

type CandidateRouteContext = Readonly<{
  params: Promise<{ token: string }>;
}>;

type AiInteractionRequestBody = Readonly<{
  clientRequestId?: unknown;
  candidatePromptText?: unknown;
  candidateInput?: unknown;
  candidateContext?: readonly CandidateContextAttachment[];
}>;

const redactSecrets = (value: string) =>
  value
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
      '[redacted]',
    )
    .replace(
      /\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]',
    );

export const POST = async (
  request: Request,
  context: CandidateRouteContext,
) => {
  try {
    const [{ token }, body] = await Promise.all([
      context.params,
      request.json() as Promise<AiInteractionRequestBody>,
    ]);

    const sessionService = getSessionService();
    const session = sessionService.getCandidateSession(token);

    const clientRequestId =
      typeof body?.clientRequestId === 'string'
        ? body.clientRequestId.trim()
        : '';
    if (!clientRequestId) {
      return Response.json(
        {
          error: {
            code: 'INVALID_INPUT',
            message: 'clientRequestId is required.',
          },
        },
        { status: 400 },
      );
    }

    const aiService = getAiInteractionService();
    const existing = aiService
      .getInteractionsForSession(session.id)
      .find((interaction) => interaction.clientRequestId === clientRequestId);
    if (existing) {
      const result = await aiService.executeInteraction(session.id, {
        clientRequestId,
        candidatePromptText: existing.candidatePromptText,
      });
      return Response.json(result);
    }

    const rawPrompt = body?.candidatePromptText ?? body?.candidateInput;
    const candidatePromptText = typeof rawPrompt === 'string' ? rawPrompt : '';

    validateCandidateContextAttachments(body?.candidateContext);
    const usesPlatformContext =
      session.aiCapabilitySnapshot?.configuredProviderId ===
        OPENROUTER_PROVIDER_ID ||
      session.aiCapabilitySnapshot?.configuredProviderId === NVIDIA_PROVIDER_ID;
    const attachedFiles = usesPlatformContext
      ? (body?.candidateContext ?? [])
      : [];
    const savedFiles = await Promise.all(
      attachedFiles.map(async ({ filePath, startLine, endLine }) => {
        const saved = await sessionService.readWorkspaceFile(token, filePath);
        const lines = saved.split('\n');
        const selected = lines.slice((startLine ?? 1) - 1, endLine);
        const content = redactSecrets(selected.join('\n')).slice(0, 8_192);
        return {
          filePath,
          content,
          truncated: content.length < selected.join('\n').length,
          contentSha256: createHash('sha256').update(content).digest('hex'),
          ...(startLine === undefined ? {} : { startLine }),
          ...(endLine === undefined ? {} : { endLine }),
        };
      }),
    );
    const recentEvents = usesPlatformContext
      ? sessionService.getRecentSessionEvents(token, 100)
      : [];
    const completedChecks = usesPlatformContext
      ? recentEvents
          .filter((event) => event.type === 'COMMAND_FINISHED')
          .map((event) => {
            const payload = event.payload as {
              commandId: string;
              exitCode: number | null;
              timedOut: boolean;
              stdoutPreview: string;
              stderrPreview: string;
            };
            const started = recentEvents.find(
              (candidate) =>
                candidate.type === 'COMMAND_STARTED' &&
                (candidate.payload as { commandId?: string }).commandId ===
                  payload.commandId,
            );
            const command = started
              ? (started.payload as { command: string }).command
              : '';
            if (
              !/^(pytest|python -m pytest|npm test|npm run test|npx vitest run|go test|cargo test)(\s|$)/.test(
                command,
              ) ||
              /[;&|`$<>]/.test(command)
            )
              return null;
            return {
              eventId: event.id,
              commandId: payload.commandId,
              command,
              exitCode: payload.exitCode,
              timedOut: payload.timedOut,
              stdoutPreview: redactSecrets(payload.stdoutPreview).slice(
                0,
                1000,
              ),
              stderrPreview: redactSecrets(payload.stderrPreview).slice(
                0,
                1000,
              ),
            };
          })
          .filter((check): check is NonNullable<typeof check> => check !== null)
          .slice(-3)
      : [];

    const hirearchyContext = {
      scenarioId: session.scenario.id,
      scenarioVersion: session.scenario.version,
      configurationVersion:
        session.aiCapabilitySnapshot?.configurationVersion ?? '1.0.0',
      injectedBriefingIncluded: usesPlatformContext,
      ...(usesPlatformContext
        ? {
            assistantContext: {
              publishedBrief: session.scenario.brief,
              savedFiles,
              recordedChecks: completedChecks,
            },
          }
        : {}),
    };

    const result = await aiService.executeInteraction(session.id, {
      clientRequestId,
      candidatePromptText,
      candidateContext: body?.candidateContext,
      hirearchyContext,
    });

    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
};
