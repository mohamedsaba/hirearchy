export interface R212AiCapabilitySnapshot {
  readonly enabled: boolean;
  readonly contractVersion: string;
  readonly configuredProviderId: string;
  readonly configuredModelId: string;
  readonly configurationVersion: string;
  readonly maxInteractions: number;
  readonly maxPromptChars: number;
}

export interface R212RecordedInteraction {
  readonly interactionId: string;
  readonly requestId: string;
  readonly sequenceStart: number;
  readonly sequenceCompleted: number | null;
  readonly candidatePrompt: string;
  readonly assistantResponse: string | null;
  readonly status: 'ADMITTED' | 'COMPLETED' | 'FAILED';
  readonly failureReason: string | null;
  readonly errorMessage: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface R212CandidateAiView {
  readonly enabled: boolean;
  readonly providerId: string;
  readonly modelId: string;
  readonly remainingInteractions: number;
  readonly totalInteractionsAllowed: number;
  readonly interactions: readonly R212RecordedInteraction[];
}

export interface R212AdmissionResult {
  readonly status: 'ADMITTED' | 'REPLAY' | 'DENIED' | 'CONFLICT';
  readonly reason?: string;
  readonly interaction?: R212RecordedInteraction;
  readonly remainingBudget?: number;
}
