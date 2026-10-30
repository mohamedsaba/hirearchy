import type {
  R212RecordedInteraction,
  R212CandidateAiView,
  R212AdmissionResult,
} from './contract.d.mts';

export declare class R212AiSecurityError extends Error {
  readonly code: string;
  constructor(message: string, code?: string);
}

export declare class R212AiConflictError extends Error {
  readonly code: string;
  constructor(message?: string);
}

export declare function installR212AiFixture(
  clientOrPool: unknown,
): Promise<void>;

export declare function admitCandidateAiInteraction(
  clientOrPool: unknown,
  params: {
    tokenHash: string;
    sessionId: string;
    requestId: string;
    prompt?: string;
    candidatePrompt?: string;
    providerId?: string;
    modelId?: string;
  },
): Promise<R212AdmissionResult>;

export declare const admitAiInteraction: typeof admitCandidateAiInteraction;

export declare function completeCandidateAiInteraction(
  clientOrPool: unknown,
  params: {
    tokenHash: string;
    sessionId: string;
    requestId: string;
    interactionId?: string;
    assistantResponse?: string;
    response?: string;
    durationMs?: number | null;
  },
): Promise<R212RecordedInteraction>;

export declare const completeAiInteraction: typeof completeCandidateAiInteraction;

export declare function failCandidateAiInteraction(
  clientOrPool: unknown,
  params: {
    tokenHash: string;
    sessionId: string;
    requestId: string;
    interactionId?: string;
    failureReason?: string;
    reason?: string;
    errorMessage: string;
    durationMs?: number | null;
  },
): Promise<R212RecordedInteraction>;

export declare const failAiInteraction: typeof failCandidateAiInteraction;

export declare function getCandidateAiView(
  clientOrPool: unknown,
  params: {
    tokenHash: string;
    sessionId: string;
  },
): Promise<R212CandidateAiView>;

export declare function getEvaluatorAiInteractions(
  clientOrPool: unknown,
  params: {
    organizationId: string;
    sessionId: string;
    reviewerPrincipalId?: string | null;
  },
): Promise<readonly R212RecordedInteraction[]>;

export interface R212AiAdapter {
  readonly pool: unknown;
  getCandidateAiView(params: {
    tokenHash: string;
    sessionId: string;
  }): Promise<R212CandidateAiView>;
  admitAiInteraction(params: {
    tokenHash: string;
    sessionId: string;
    requestId: string;
    candidatePrompt?: string;
    prompt?: string;
    providerId?: string;
    modelId?: string;
  }): Promise<R212AdmissionResult>;
  admitCandidateAiInteraction(params: {
    tokenHash: string;
    sessionId: string;
    requestId: string;
    candidatePrompt?: string;
    prompt?: string;
    providerId?: string;
    modelId?: string;
  }): Promise<R212AdmissionResult>;
  completeAiInteraction(params: {
    tokenHash: string;
    sessionId: string;
    requestId: string;
    interactionId?: string;
    assistantResponse?: string;
    response?: string;
    durationMs?: number | null;
  }): Promise<R212RecordedInteraction>;
  completeCandidateAiInteraction(params: {
    tokenHash: string;
    sessionId: string;
    requestId: string;
    interactionId?: string;
    assistantResponse?: string;
    response?: string;
    durationMs?: number | null;
  }): Promise<R212RecordedInteraction>;
  failAiInteraction(params: {
    tokenHash: string;
    sessionId: string;
    requestId: string;
    interactionId?: string;
    failureReason?: string;
    reason?: string;
    errorMessage: string;
    durationMs?: number | null;
  }): Promise<R212RecordedInteraction>;
  failCandidateAiInteraction(params: {
    tokenHash: string;
    sessionId: string;
    requestId: string;
    interactionId?: string;
    failureReason?: string;
    reason?: string;
    errorMessage: string;
    durationMs?: number | null;
  }): Promise<R212RecordedInteraction>;
  getEvaluatorAiInteractions(params: {
    organizationId: string;
    sessionId: string;
    reviewerPrincipalId?: string | null;
  }): Promise<readonly R212RecordedInteraction[]>;
  close(): Promise<void>;
}

export declare function createR212AiAdapter(options?: {
  connectionString?: string;
  pool?: unknown;
}): R212AiAdapter;

export type {
  R212AiCapabilitySnapshot,
  R212RecordedInteraction,
  R212CandidateAiView,
  R212AdmissionResult,
} from './contract.d.mts';
