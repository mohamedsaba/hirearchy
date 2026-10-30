export type AiInteractionStatus =
  'ADMITTED' | 'DISPATCH_STARTED' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

export type CandidateContextAttachment = Readonly<{
  filePath: string;
  startLine?: number;
  endLine?: number;
}>;

export type AssistantPlatformContext = Readonly<{
  publishedBrief: string;
  savedFiles: readonly Readonly<{
    filePath: string;
    content: string;
    truncated: boolean;
  }>[];
  recordedChecks: readonly Readonly<{
    eventId: string;
    commandId: string;
    command: string;
    exitCode: number | null;
    timedOut: boolean;
    stdoutPreview: string;
    stderrPreview: string;
  }>[];
}>;

export type HirearchyContextMetadata = Readonly<{
  scenarioId: string;
  scenarioVersion: string;
  configurationVersion: string;
  injectedBriefingIncluded?: boolean;
  assistantContext?: AssistantPlatformContext;
}>;

export type AiCapabilitySnapshot = Readonly<{
  enabled: boolean;
  contractVersion: string;
  configuredProviderId: string;
  configuredModelId: string;
  configurationVersion: string;
}>;

export const defaultAiCapabilitySnapshot: AiCapabilitySnapshot = {
  enabled: true,
  contractVersion: 'slice-6b-v1',
  configuredProviderId: 'mock-ai',
  configuredModelId: 'mock-chat-v1',
  configurationVersion: '1.0.0',
};

export const disabledAiCapabilitySnapshot: AiCapabilitySnapshot = {
  enabled: false,
  contractVersion: 'slice-6b-v1',
  configuredProviderId: 'none',
  configuredModelId: 'none',
  configurationVersion: '1.0.0',
};

export const cloneAiCapabilitySnapshot = (
  snapshot: AiCapabilitySnapshot | null,
): AiCapabilitySnapshot | null => (snapshot ? { ...snapshot } : null);

export const MAXIMUM_PROMPT_LENGTH = 32_768; // 32 KiB
export const MAXIMUM_RESPONSE_LENGTH = 65_536; // 64 KiB
export const MAXIMUM_EXCERPT_LENGTH = 500;
export const MAXIMUM_AI_CONTEXT_ATTACHMENTS = 3;

export const boundExcerpt = (
  text: string,
  maxLength: number = MAXIMUM_EXCERPT_LENGTH,
): string => {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
};

export const validateCandidateContextAttachments = (
  attachments?: readonly CandidateContextAttachment[],
): void => {
  if (!attachments) {
    return;
  }
  if (!Array.isArray(attachments)) {
    throw new AiInteractionError(
      'INVALID_INPUT',
      'Candidate context attachments must be an array.',
    );
  }
  if (attachments.length > MAXIMUM_AI_CONTEXT_ATTACHMENTS) {
    throw new AiInteractionError(
      'INVALID_INPUT',
      `No more than ${MAXIMUM_AI_CONTEXT_ATTACHMENTS} context files may be attached.`,
    );
  }
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      throw new AiInteractionError(
        'INVALID_INPUT',
        'Candidate context attachment must be an object.',
      );
    }
    const { filePath, startLine, endLine } = attachment;
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new AiInteractionError(
        'INVALID_INPUT',
        'Candidate context attachment filePath must be a non-empty string.',
      );
    }
    if (filePath.startsWith('/') || filePath.includes('\\')) {
      throw new AiInteractionError(
        'INVALID_INPUT',
        `Candidate context attachment filePath must be a relative path within workspace: ${filePath}`,
      );
    }
    const segments = filePath.split('/');
    if (segments.some((segment) => segment === '..')) {
      throw new AiInteractionError(
        'INVALID_INPUT',
        `Candidate context attachment path cannot contain traversal segments: ${filePath}`,
      );
    }
    if (startLine !== undefined) {
      if (!Number.isInteger(startLine) || startLine < 1) {
        throw new AiInteractionError(
          'INVALID_INPUT',
          `startLine must be an integer >= 1: ${startLine}`,
        );
      }
    }
    if (endLine !== undefined) {
      if (!Number.isInteger(endLine) || endLine < 1) {
        throw new AiInteractionError(
          'INVALID_INPUT',
          `endLine must be an integer >= 1: ${endLine}`,
        );
      }
      if (startLine !== undefined && endLine < startLine) {
        throw new AiInteractionError(
          'INVALID_INPUT',
          `endLine (${endLine}) cannot be less than startLine (${startLine})`,
        );
      }
    }
  }
};

export type ExecuteAiInteractionResult = Readonly<{
  interactionId: string;
  status: AiInteractionStatus;
  responseText: string | null;
  configuredModelId: string;
  reportedModelId: string | null;
  terminalReason: string | null;
  errorMessage: string | null;
  durationMs: number | null;
}>;

export type AiInteraction = Readonly<{
  id: string;
  sessionId: string;
  clientRequestId: string;
  status: AiInteractionStatus;
  configuredProviderId: string;
  configuredModelId: string;
  candidatePromptText: string;
  candidateContext?: readonly CandidateContextAttachment[];
  hirearchyContext?: HirearchyContextMetadata;
  capturedResponseText?: string | null;
  terminalReason?: string | null;
  errorMessage?: string | null;
  durationMs?: number | null;
  createdAt: string;
  terminalAt?: string | null;
  startedSequence?: number | null;
  terminalSequence?: number | null;
}>;

export class AiInteractionError extends Error {
  constructor(
    readonly code:
      | 'SESSION_NOT_FOUND'
      | 'SESSION_NOT_ACTIVE'
      | 'SESSION_FINALIZATION_STARTED'
      | 'SESSION_DEADLINE_EXCEEDED'
      | 'AI_NOT_ENABLED'
      | 'INVALID_INPUT'
      | 'INPUT_TOO_LARGE'
      | 'INVALID_STATE_TRANSITION'
      | 'INTERACTION_NOT_FOUND'
      | 'PROVIDER_NOT_CONFIGURED'
      | 'PLATFORM_PERSISTENCE_FAILED'
      | 'AMBIGUOUS_DISPATCH'
      | 'AI_CONCURRENT_REQUEST_LIMIT'
      | 'AI_INTERACTION_LIMIT_EXCEEDED'
      | 'AI_RATE_LIMIT_EXCEEDED',
    message: string,
  ) {
    super(message);
    this.name = 'AiInteractionError';
  }
}

export const isValidAiInteractionTransition = (
  currentStatus: AiInteractionStatus,
  nextStatus: AiInteractionStatus,
): boolean => {
  if (
    currentStatus === 'COMPLETED' ||
    currentStatus === 'CANCELLED' ||
    currentStatus === 'FAILED'
  ) {
    return false;
  }

  if (currentStatus === 'ADMITTED') {
    return (
      nextStatus === 'DISPATCH_STARTED' ||
      nextStatus === 'CANCELLED' ||
      nextStatus === 'FAILED'
    );
  }

  if (currentStatus === 'DISPATCH_STARTED') {
    return (
      nextStatus === 'COMPLETED' ||
      nextStatus === 'CANCELLED' ||
      nextStatus === 'FAILED'
    );
  }

  return false;
};
