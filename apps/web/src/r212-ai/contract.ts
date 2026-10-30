/**
 * R2.12 Candidate AI Assistance Contract.
 * Defines shared types, budgets, error codes, and gateway models for isolated candidate AI assistance.
 */

export const R212_SYNTHETIC_PROVIDER_ID = 'synthetic-test-provider';
export const R212_SYNTHETIC_MODEL_ID = 'synthetic-model-r212';
export const R212_POLICY_VERSION = 'r212-synthetic-policy-v1';
export const R212_MAX_PROMPT_CHARS = 4000;
export const R212_MAX_INTERACTIONS_PER_SESSION = 5;

export type R212AiCapabilitySnapshot = Readonly<{
  enabled: boolean;
  contractVersion: string;
  configuredProviderId: string;
  configuredModelId: string;
  configurationVersion: string;
  maxInteractions: number;
  maxPromptChars: number;
}>;

export const defaultDisabledAiSnapshot: R212AiCapabilitySnapshot = {
  enabled: false,
  contractVersion: 'r212-v1',
  configuredProviderId: 'none',
  configuredModelId: 'none',
  configurationVersion: '1.0.0',
  maxInteractions: 0,
  maxPromptChars: 0,
};

export const defaultSyntheticAiSnapshot: R212AiCapabilitySnapshot = {
  enabled: true,
  contractVersion: 'r212-synthetic-v1',
  configuredProviderId: R212_SYNTHETIC_PROVIDER_ID,
  configuredModelId: R212_SYNTHETIC_MODEL_ID,
  configurationVersion: '1.0.0',
  maxInteractions: R212_MAX_INTERACTIONS_PER_SESSION,
  maxPromptChars: R212_MAX_PROMPT_CHARS,
};

export type R212PriorMessage = Readonly<{
  author: 'candidate' | 'assistant';
  content: string;
  timestamp: string;
}>;

export type R212GatewayRequest = Readonly<{
  organizationId: string;
  sessionId: string;
  requestId: string;
  candidatePrompt: string;
  capabilitySnapshot: R212AiCapabilitySnapshot;
  priorContext?: readonly R212PriorMessage[];
  deadline?: string | null;
  policyVersion?: string;
}>;

export type R212AdmissionStatus =
  | 'ADMITTED'
  | 'REPLAY_COMPLETED'
  | 'DENIED_NOT_ENABLED'
  | 'DENIED_BUDGET_EXHAUSTED'
  | 'DENIED_SESSION_CLOSED'
  | 'DENIED_DEADLINE_EXCEEDED'
  | 'DENIED_PROMPT_TOO_LARGE'
  | 'CONFLICT_CHANGED_INTENT';

export type R212GatewayResponse = Readonly<{
  requestId: string;
  interactionId: string;
  providerId: string;
  modelId: string;
  status: 'COMPLETED' | 'FAILED' | 'DENIED';
  admissionStatus: R212AdmissionStatus;
  candidatePrompt: string;
  assistantResponse: string | null;
  errorMessage: string | null;
  failureReason: string | null;
  serverTimestamp: string;
  sequenceStart: number;
  sequenceCompleted: number | null;
  isReplay: boolean;
  usage: {
    promptChars: number;
    responseChars: number;
    synthetic: true;
  };
}>;

export type R212RecordedInteraction = Readonly<{
  interactionId: string;
  requestId: string;
  sequenceStart: number;
  sequenceCompleted: number | null;
  candidatePrompt: string;
  assistantResponse: string | null;
  status: 'ADMITTED' | 'COMPLETED' | 'FAILED';
  failureReason: string | null;
  errorMessage: string | null;
  providerId: string;
  modelId: string;
  createdAt: string;
  completedAt: string | null;
}>;

export type R212CandidateAiView = Readonly<{
  enabled: boolean;
  providerId: string;
  modelId: string;
  remainingInteractions: number;
  totalInteractionsAllowed: number;
  interactions: readonly R212RecordedInteraction[];
}>;
