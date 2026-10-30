import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getApplicationDatabasePath } from '../database/database-path';

import { SqliteTransactionRunner } from '../database/sqlite-transaction-runner';
import { SqliteEventStore } from '../events/sqlite-event-store';
import {
  deriveSessionDeadline,
  isDeadlineExceeded,
} from '../sessions/session-timing';
import { SqliteSessionStore } from '../sessions/sqlite-session-store';
import {
  type AiInteraction,
  AiInteractionError,
  boundExcerpt,
  type CandidateContextAttachment,
  type HirearchyContextMetadata,
  type ExecuteAiInteractionResult,
  isValidAiInteractionTransition,
  MAXIMUM_PROMPT_LENGTH,
  MAXIMUM_RESPONSE_LENGTH,
  validateCandidateContextAttachments,
} from './ai-interaction';
import {
  type AiProviderRegistry,
  DefaultAiProviderRegistry,
  type NormalizedAiRequest,
} from './ai-provider';
import {
  NvidiaNimAiProvider,
  OpenRouterAiProvider,
} from './openrouter-ai-provider';
import {
  getNvidiaApiKey,
  getOpenRouterApiKey,
} from './server-ai-configuration';
import { SqliteAiInteractionStore } from './sqlite-ai-interaction-store';

export type AdmitAiInteractionParams = Readonly<{
  clientRequestId: string;
  candidatePromptText: string;
  candidateContext?: readonly CandidateContextAttachment[];
  hirearchyContext?: HirearchyContextMetadata;
}>;

export type ExecuteAiInteractionParams = Readonly<{
  clientRequestId: string;
  candidatePromptText: string;
  candidateContext?: readonly CandidateContextAttachment[];
  hirearchyContext?: HirearchyContextMetadata;
}>;

export type CompleteAiInteractionParams = Readonly<{
  responseText: string;
  durationMs: number;
  reportedModelId?: string;
  providerRequestId?: string;
  finishReason?: string;
  tokenUsage?: Readonly<{
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }>;
}>;

export type CancelAiInteractionParams = Readonly<{
  durationMs: number;
  cancelReason:
    | 'candidate_requested_cancel'
    | 'session_ended'
    | 'platform_policy_abort'
    | string;
}>;

export type FailAiInteractionParams = Readonly<{
  durationMs: number;
  failureReason:
    | 'provider_error'
    | 'provider_disconnected'
    | 'server_timeout'
    | 'server_error'
    | string;
  errorMessage: string;
}>;

export const DEFAULT_MAX_AI_INTERACTIONS_PER_SESSION = 25;
export const DEFAULT_MAX_AI_CONCURRENT_PER_SESSION = 1;
export const DEFAULT_MAX_AI_REQUESTS_PER_MINUTE = 6;
export const DEFAULT_MAX_AI_TOTAL_ATTEMPTS_PER_SESSION = 50;

/** Terminal reason recorded when a dispatch is released without a result. */
export const ABANDONED_DISPATCH_FAILURE_REASON = 'dispatch_abandoned';

/**
 * Recovery horizon for interactions stuck in a non-terminal state after a
 * provider initialization failure, a crashed request, or an interrupted
 * process. It must outlast `timeoutMs` so a slow-but-live provider call is not
 * reclaimed while it is still running.
 */
const DISPATCH_RECOVERY_TIMEOUT_MULTIPLIER = 3;
const MINIMUM_DISPATCH_RECOVERY_MS = 90_000;

const STRICT_POSITIVE_INTEGER_PATTERN = /^\d{1,9}$/;

/**
 * Parse an operator-supplied limit, failing closed to `defaultValue`.
 *
 * `Number.parseInt` alone is unsafe here: it accepts partial parses such as
 * `"2oops"` and would silently widen a protection limit beyond the
 * conservative default (for example turning the default concurrency of 1 into
 * 2). Only an unambiguous positive integer may override the default.
 */
const parsePositiveInt = (
  value: string | undefined,
  defaultValue: number,
): number => {
  if (value === undefined) return defaultValue;
  const trimmed = value.trim();
  if (!STRICT_POSITIVE_INTEGER_PATTERN.test(trimmed)) return defaultValue;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue;
};

export type AiInteractionServiceOptions = Readonly<{
  sessionStore: SqliteSessionStore;
  eventStore: SqliteEventStore;
  aiInteractionStore: SqliteAiInteractionStore;
  transactionRunner: SqliteTransactionRunner;
  providerRegistry?: AiProviderRegistry;
  timeoutMs?: number;
  createId?: () => string;
  now?: () => string;
  maxInteractionsPerSession?: number;
  maxConcurrentPerSession?: number;
  maxRateLimitPerMinute?: number;
  maxTotalAttemptsPerSession?: number;
  dispatchRecoveryAfterMs?: number;
}>;

export class AiInteractionService {
  private readonly sessionStore: SqliteSessionStore;
  private readonly eventStore: SqliteEventStore;
  private readonly aiInteractionStore: SqliteAiInteractionStore;
  private readonly transactionRunner: SqliteTransactionRunner;
  private readonly providerRegistry: AiProviderRegistry;
  private readonly timeoutMs: number;
  private readonly createId: () => string;
  private readonly now: () => string;
  readonly maxInteractionsPerSession: number;
  readonly maxConcurrentPerSession: number;
  readonly maxRateLimitPerMinute: number;
  readonly maxTotalAttemptsPerSession: number;
  readonly dispatchRecoveryAfterMs: number;

  constructor(options: AiInteractionServiceOptions) {
    this.sessionStore = options.sessionStore;
    this.eventStore = options.eventStore;
    this.aiInteractionStore = options.aiInteractionStore;
    this.transactionRunner = options.transactionRunner;
    this.providerRegistry =
      options.providerRegistry ?? new DefaultAiProviderRegistry();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxInteractionsPerSession =
      options.maxInteractionsPerSession ??
      parsePositiveInt(
        process.env.HIREARCHY_AI_MAX_INTERACTIONS_PER_SESSION,
        DEFAULT_MAX_AI_INTERACTIONS_PER_SESSION,
      );
    this.maxConcurrentPerSession =
      options.maxConcurrentPerSession ??
      parsePositiveInt(
        process.env.HIREARCHY_AI_MAX_CONCURRENT_PER_SESSION,
        DEFAULT_MAX_AI_CONCURRENT_PER_SESSION,
      );
    this.maxRateLimitPerMinute =
      options.maxRateLimitPerMinute ??
      parsePositiveInt(
        process.env.HIREARCHY_AI_MAX_REQUESTS_PER_MINUTE,
        DEFAULT_MAX_AI_REQUESTS_PER_MINUTE,
      );
    this.maxTotalAttemptsPerSession =
      options.maxTotalAttemptsPerSession ??
      parsePositiveInt(
        process.env.HIREARCHY_AI_MAX_TOTAL_ATTEMPTS_PER_SESSION,
        DEFAULT_MAX_AI_TOTAL_ATTEMPTS_PER_SESSION,
      );
    this.dispatchRecoveryAfterMs =
      options.dispatchRecoveryAfterMs ??
      Math.max(
        this.timeoutMs * DISPATCH_RECOVERY_TIMEOUT_MULTIPLIER,
        MINIMUM_DISPATCH_RECOVERY_MS,
      );
  }

  admitInteraction(
    sessionId: string,
    params: AdmitAiInteractionParams,
  ): { interaction: AiInteraction; wasAdmitted: boolean } {
    const interactionId = `ai_int_${this.createId()}`;
    const createdAt = this.now();

    try {
      return this.transactionRunner.run((database) => {
        const session = this.sessionStore.findByIdWithDatabase(
          database,
          sessionId,
        );
        if (!session) {
          throw new AiInteractionError(
            'SESSION_NOT_FOUND',
            `Session ${sessionId} was not found.`,
          );
        }

        const existing =
          this.aiInteractionStore.findByClientRequestIdWithDatabase(
            database,
            sessionId,
            params.clientRequestId,
          );

        if (existing) {
          return {
            interaction: existing,
            wasAdmitted: false,
          };
        }

        if (session.status !== 'ACTIVE') {
          throw new AiInteractionError(
            'SESSION_NOT_ACTIVE',
            `AI interactions can only be admitted for active sessions. Current status: ${session.status}.`,
          );
        }

        if (session.closureReason !== null) {
          throw new AiInteractionError(
            'SESSION_FINALIZATION_STARTED',
            'Finalization has already started. New AI interactions are no longer permitted.',
          );
        }

        const deadline = deriveSessionDeadline(session);
        const now = this.now();
        if (deadline !== null && isDeadlineExceeded(deadline, now)) {
          throw new AiInteractionError(
            'SESSION_DEADLINE_EXCEEDED',
            'The assessment time limit has been reached. New modifications are no longer permitted.',
          );
        }

        const snapshot = session.aiCapabilitySnapshot;
        if (!snapshot || !snapshot.enabled) {
          throw new AiInteractionError(
            'AI_NOT_ENABLED',
            'AI capability is not enabled for this session.',
          );
        }

        if (
          !params.candidatePromptText ||
          params.candidatePromptText.trim().length === 0
        ) {
          throw new AiInteractionError(
            'INVALID_INPUT',
            'Candidate prompt cannot be empty.',
          );
        }

        const inputBytes = Buffer.byteLength(
          params.candidatePromptText,
          'utf8',
        );
        if (inputBytes > MAXIMUM_PROMPT_LENGTH) {
          throw new AiInteractionError(
            'INPUT_TOO_LARGE',
            `The prompt exceeds the maximum allowed length of ${MAXIMUM_PROMPT_LENGTH} bytes.`,
          );
        }

        validateCandidateContextAttachments(params.candidateContext);

        // 0. Release interactions stranded in a non-terminal state by a provider
        //    initialization failure, a crashed request, or an interrupted
        //    process, so they cannot hold the concurrency allowance or the
        //    session attempt quota indefinitely.
        this.reclaimAbandonedDispatchesWithDatabase(database, sessionId, now);

        // 1. Concurrency limit: Ensure no more than maxConcurrentPerSession active interactions
        const openInteractions =
          this.aiInteractionStore.findOpenBySessionIdWithDatabase(
            database,
            sessionId,
          );
        const activeOpenInteractions = openInteractions.filter(
          (interaction) =>
            new Date(now).getTime() -
              new Date(interaction.createdAt).getTime() <=
            this.timeoutMs,
        );
        if (activeOpenInteractions.length >= this.maxConcurrentPerSession) {
          throw new AiInteractionError(
            'AI_CONCURRENT_REQUEST_LIMIT',
            'An AI interaction is already in progress for this session. Please wait for it to complete.',
          );
        }

        // 2. Session completed interactions quota (expenditure protection)
        const completedCount =
          this.aiInteractionStore.countCompletedBySessionIdWithDatabase(
            database,
            sessionId,
          );
        if (completedCount >= this.maxInteractionsPerSession) {
          throw new AiInteractionError(
            'AI_INTERACTION_LIMIT_EXCEEDED',
            `Session AI limit of ${this.maxInteractionsPerSession} completed requests has been reached.`,
          );
        }

        // 3. Session total attempts limit (protect against unbounded retries / failure spam)
        const totalAttempts =
          this.aiInteractionStore.countTotalBySessionIdWithDatabase(
            database,
            sessionId,
          );
        if (totalAttempts >= this.maxTotalAttemptsPerSession) {
          throw new AiInteractionError(
            'AI_INTERACTION_LIMIT_EXCEEDED',
            `Session AI attempt limit of ${this.maxTotalAttemptsPerSession} requests has been reached.`,
          );
        }

        // 4. Rate limit: Max requests per minute
        const recentAttempts =
          this.aiInteractionStore.countRecentBySessionIdWithDatabase(
            database,
            sessionId,
            60,
            now,
          );
        if (recentAttempts >= this.maxRateLimitPerMinute) {
          throw new AiInteractionError(
            'AI_RATE_LIMIT_EXCEEDED',
            `AI request rate limit exceeded. Maximum ${this.maxRateLimitPerMinute} requests per minute allowed.`,
          );
        }

        const interaction: AiInteraction = {
          id: interactionId,
          sessionId,
          clientRequestId: params.clientRequestId,
          status: 'ADMITTED',
          configuredProviderId: snapshot.configuredProviderId,
          configuredModelId: snapshot.configuredModelId,
          candidatePromptText: params.candidatePromptText,
          candidateContext: params.candidateContext,
          hirearchyContext: params.hirearchyContext,
          createdAt,
        };

        this.aiInteractionStore.createWithDatabase(database, interaction);

        const event = this.eventStore.appendWithDatabase(database, {
          id: `evt_${this.createId()}`,
          sessionId,
          type: 'AI_REQUEST_STARTED',
          timestamp: createdAt,
          source: 'server',
          payload: {
            interactionId,
            clientRequestId: params.clientRequestId,
            configuredProviderId: snapshot.configuredProviderId,
            configuredModelId: snapshot.configuredModelId,
            candidateInputExcerpt: boundExcerpt(params.candidatePromptText),
            candidateInputBytes: inputBytes,
            candidateContext: params.candidateContext,
            hirearchyContext: params.hirearchyContext,
          },
        });

        this.aiInteractionStore.updateStartedSequenceWithDatabase(
          database,
          interactionId,
          event.sequence,
        );

        return {
          interaction: {
            ...interaction,
            startedSequence: event.sequence,
          },
          wasAdmitted: true,
        };
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.message.includes('UNIQUE constraint failed') ||
          error.message.includes('SQLITE_CONSTRAINT'))
      ) {
        const existing = this.aiInteractionStore.findByClientRequestId(
          sessionId,
          params.clientRequestId,
        );
        if (existing) {
          return {
            interaction: existing,
            wasAdmitted: false,
          };
        }
      }
      throw error;
    }
  }

  /**
   * Move interactions that have been open longer than the recovery horizon into
   * a terminal FAILED state, appending an `AI_REQUEST_FAILED` event so the
   * release is visible in reconstructed evidence rather than being a silent
   * bookkeeping edit.
   *
   * Runs inside the admission transaction, which keeps admission atomic and
   * preserves the existing SQLite data model: both `ADMITTED` and
   * `DISPATCH_STARTED` already have a valid transition to `FAILED`, so no schema
   * or state-machine change is required.
   */
  reclaimAbandonedDispatchesWithDatabase(
    database: Database.Database,
    sessionId: string,
    nowIso: string,
  ): readonly AiInteraction[] {
    const nowMs = new Date(nowIso).getTime();
    const cutoff = nowMs - this.dispatchRecoveryAfterMs;
    const abandoned = this.aiInteractionStore
      .findOpenBySessionIdWithDatabase(database, sessionId)
      .filter(
        (interaction) => new Date(interaction.createdAt).getTime() <= cutoff,
      );

    const reclaimed: AiInteraction[] = [];
    for (const interaction of abandoned) {
      const durationMs = Math.max(
        0,
        nowMs - new Date(interaction.createdAt).getTime(),
      );
      try {
        reclaimed.push(
          this.recordFailureWithDatabase(database, interaction.id, {
            durationMs,
            failureReason: ABANDONED_DISPATCH_FAILURE_REASON,
            errorMessage:
              'The AI request was abandoned before the provider returned and was released by the platform.',
          }),
        );
      } catch {
        // Best effort. A session that is no longer active cannot record a
        // failure; those interactions are cancelled by session finalization.
      }
    }

    return reclaimed;
  }

  /**
   * Drive a claimed dispatch to a terminal FAILED state on an error path that
   * would otherwise leave it stuck in DISPATCH_STARTED. Persistence failures
   * are swallowed here because `reclaimAbandonedDispatchesWithDatabase` will
   * release the interaction on the next admission.
   */
  private releaseStuckDispatch(
    interactionId: string,
    failureReason: string,
    errorMessage: string,
    dispatchStartedAtMs: number,
  ): void {
    try {
      this.recordFailure(interactionId, {
        durationMs: Math.max(0, Date.now() - dispatchStartedAtMs),
        failureReason,
        errorMessage,
      });
    } catch {
      // Recovery is handled by the next admission sweep.
    }
  }

  claimDispatchWithDatabase(
    database: Database.Database,
    interactionId: string,
  ):
    | { claimed: true; interaction: AiInteraction }
    | { claimed: false; interaction: AiInteraction } {
    const current = this.aiInteractionStore.findByIdWithDatabase(
      database,
      interactionId,
    );
    if (!current) {
      throw new AiInteractionError(
        'INTERACTION_NOT_FOUND',
        `AI interaction ${interactionId} was not found.`,
      );
    }

    if (
      current.status === 'CANCELLED' &&
      current.terminalReason === 'session_ended'
    ) {
      return { claimed: false, interaction: current };
    }

    if (!isValidAiInteractionTransition(current.status, 'DISPATCH_STARTED')) {
      throw new AiInteractionError(
        'INVALID_STATE_TRANSITION',
        `Cannot transition AI interaction from ${current.status} to DISPATCH_STARTED.`,
      );
    }

    const session = this.sessionStore.findByIdWithDatabase(
      database,
      current.sessionId,
    );
    if (!session) {
      throw new AiInteractionError(
        'SESSION_NOT_FOUND',
        `Session ${current.sessionId} was not found.`,
      );
    }

    if (session.status !== 'ACTIVE') {
      throw new AiInteractionError(
        'SESSION_NOT_ACTIVE',
        `AI interactions can only be dispatched for active sessions. Current status: ${session.status}.`,
      );
    }

    const updated = this.aiInteractionStore.updateStatusWithDatabase(database, {
      id: interactionId,
      status: 'DISPATCH_STARTED',
    });

    return { claimed: true, interaction: updated };
  }

  claimDispatch(
    interactionId: string,
  ):
    | { claimed: true; interaction: AiInteraction }
    | { claimed: false; interaction: AiInteraction } {
    return this.transactionRunner.run((database) =>
      this.claimDispatchWithDatabase(database, interactionId),
    );
  }

  transitionToDispatchStarted(interactionId: string): AiInteraction {
    const result = this.claimDispatch(interactionId);
    return result.interaction;
  }

  recordCompletionWithDatabase(
    database: Database.Database,
    interactionId: string,
    params: CompleteAiInteractionParams,
  ): AiInteraction {
    const current = this.aiInteractionStore.findByIdWithDatabase(
      database,
      interactionId,
    );
    if (!current) {
      throw new AiInteractionError(
        'INTERACTION_NOT_FOUND',
        `AI interaction ${interactionId} was not found.`,
      );
    }

    if (
      current.status === 'CANCELLED' &&
      current.terminalReason === 'session_ended'
    ) {
      return current;
    }

    if (!isValidAiInteractionTransition(current.status, 'COMPLETED')) {
      throw new AiInteractionError(
        'INVALID_STATE_TRANSITION',
        `Cannot transition AI interaction from ${current.status} to COMPLETED.`,
      );
    }

    const session = this.sessionStore.findByIdWithDatabase(
      database,
      current.sessionId,
    );
    if (!session) {
      throw new AiInteractionError(
        'SESSION_NOT_FOUND',
        `Session ${current.sessionId} was not found.`,
      );
    }

    if (session.status !== 'ACTIVE') {
      throw new AiInteractionError(
        'SESSION_NOT_ACTIVE',
        `AI interactions can only be completed for active sessions. Current status: ${session.status}.`,
      );
    }

    const terminalAt = this.now();
    const responseBytes = Buffer.byteLength(params.responseText, 'utf8');

    const event = this.eventStore.appendWithDatabase(database, {
      id: `evt_${this.createId()}`,
      sessionId: current.sessionId,
      type: 'AI_RESPONSE_COMPLETED',
      timestamp: terminalAt,
      source: 'server',
      payload: {
        interactionId: current.id,
        durationMs: params.durationMs,
        reportedModelId: params.reportedModelId ?? current.configuredModelId,
        providerRequestId: params.providerRequestId,
        responseExcerpt: boundExcerpt(params.responseText),
        responseBytes,
        finishReason: params.finishReason,
        tokenUsage: params.tokenUsage,
      },
    });

    return this.aiInteractionStore.updateStatusWithDatabase(database, {
      id: interactionId,
      status: 'COMPLETED',
      capturedResponseText: params.responseText,
      durationMs: params.durationMs,
      terminalAt,
      terminalSequence: event.sequence,
    });
  }

  recordCompletion(
    interactionId: string,
    params: CompleteAiInteractionParams,
  ): AiInteraction {
    return this.transactionRunner.run((database) =>
      this.recordCompletionWithDatabase(database, interactionId, params),
    );
  }

  recordCancellationWithDatabase(
    database: Database.Database,
    interactionId: string,
    params: CancelAiInteractionParams,
    now?: string,
  ): AiInteraction {
    const current = this.aiInteractionStore.findByIdWithDatabase(
      database,
      interactionId,
    );
    if (!current) {
      throw new AiInteractionError(
        'INTERACTION_NOT_FOUND',
        `AI interaction ${interactionId} was not found.`,
      );
    }

    if (!isValidAiInteractionTransition(current.status, 'CANCELLED')) {
      throw new AiInteractionError(
        'INVALID_STATE_TRANSITION',
        `Cannot transition AI interaction from ${current.status} to CANCELLED.`,
      );
    }

    const terminalAt = now ?? this.now();

    const event = this.eventStore.appendWithDatabase(database, {
      id: `evt_${this.createId()}`,
      sessionId: current.sessionId,
      type: 'AI_REQUEST_CANCELLED',
      timestamp: terminalAt,
      source: 'server',
      payload: {
        interactionId: current.id,
        durationMs: params.durationMs,
        cancelReason: params.cancelReason,
      },
    });

    return this.aiInteractionStore.updateStatusWithDatabase(database, {
      id: interactionId,
      status: 'CANCELLED',
      terminalReason: params.cancelReason,
      durationMs: params.durationMs,
      terminalAt,
      terminalSequence: event.sequence,
    });
  }

  recordCancellation(
    interactionId: string,
    params: CancelAiInteractionParams,
  ): AiInteraction {
    return this.transactionRunner.run((database) =>
      this.recordCancellationWithDatabase(database, interactionId, params),
    );
  }

  cancelOpenForSessionEndWithDatabase(
    database: Database.Database,
    sessionId: string,
    closureTimestamp: string,
  ): readonly AiInteraction[] {
    const openInteractions =
      this.aiInteractionStore.findOpenBySessionIdWithDatabase(
        database,
        sessionId,
      );

    const sorted = [...openInteractions].sort((a, b) => {
      const seqDiff = (a.startedSequence ?? 0) - (b.startedSequence ?? 0);
      if (seqDiff !== 0) return seqDiff;
      return a.id.localeCompare(b.id);
    });

    return sorted.map((interaction) => {
      const durationMs = Math.max(
        0,
        new Date(closureTimestamp).getTime() -
          new Date(interaction.createdAt).getTime(),
      );

      return this.recordCancellationWithDatabase(
        database,
        interaction.id,
        {
          durationMs,
          cancelReason: 'session_ended',
        },
        closureTimestamp,
      );
    });
  }

  recordFailureWithDatabase(
    database: Database.Database,
    interactionId: string,
    params: FailAiInteractionParams,
  ): AiInteraction {
    const current = this.aiInteractionStore.findByIdWithDatabase(
      database,
      interactionId,
    );
    if (!current) {
      throw new AiInteractionError(
        'INTERACTION_NOT_FOUND',
        `AI interaction ${interactionId} was not found.`,
      );
    }

    if (
      current.status === 'CANCELLED' &&
      current.terminalReason === 'session_ended'
    ) {
      return current;
    }

    if (!isValidAiInteractionTransition(current.status, 'FAILED')) {
      throw new AiInteractionError(
        'INVALID_STATE_TRANSITION',
        `Cannot transition AI interaction from ${current.status} to FAILED.`,
      );
    }

    const session = this.sessionStore.findByIdWithDatabase(
      database,
      current.sessionId,
    );
    if (!session) {
      throw new AiInteractionError(
        'SESSION_NOT_FOUND',
        `Session ${current.sessionId} was not found.`,
      );
    }

    if (session.status !== 'ACTIVE') {
      throw new AiInteractionError(
        'SESSION_NOT_ACTIVE',
        `AI interactions can only be recorded as failed for active sessions. Current status: ${session.status}.`,
      );
    }

    const terminalAt = this.now();

    const event = this.eventStore.appendWithDatabase(database, {
      id: `evt_${this.createId()}`,
      sessionId: current.sessionId,
      type: 'AI_REQUEST_FAILED',
      timestamp: terminalAt,
      source: 'server',
      payload: {
        interactionId: current.id,
        durationMs: params.durationMs,
        failureReason: params.failureReason,
        errorMessageExcerpt: boundExcerpt(params.errorMessage),
      },
    });

    return this.aiInteractionStore.updateStatusWithDatabase(database, {
      id: interactionId,
      status: 'FAILED',
      terminalReason: params.failureReason,
      errorMessage: params.errorMessage,
      durationMs: params.durationMs,
      terminalAt,
      terminalSequence: event.sequence,
    });
  }

  recordFailure(
    interactionId: string,
    params: FailAiInteractionParams,
  ): AiInteraction {
    return this.transactionRunner.run((database) =>
      this.recordFailureWithDatabase(database, interactionId, params),
    );
  }

  async executeInteraction(
    sessionId: string,
    params: ExecuteAiInteractionParams,
  ): Promise<ExecuteAiInteractionResult> {
    const admission = this.admitInteraction(sessionId, params);
    if (!admission.wasAdmitted) {
      const existing = admission.interaction;
      if (
        existing.status === 'COMPLETED' ||
        existing.status === 'FAILED' ||
        existing.status === 'CANCELLED'
      ) {
        return {
          interactionId: existing.id,
          status: existing.status,
          responseText: existing.capturedResponseText ?? null,
          configuredModelId: existing.configuredModelId,
          reportedModelId: null,
          terminalReason: existing.terminalReason ?? null,
          errorMessage: existing.errorMessage ?? null,
          durationMs: existing.durationMs ?? null,
        };
      }

      if (existing.status === 'DISPATCH_STARTED') {
        return {
          interactionId: existing.id,
          status: 'DISPATCH_STARTED',
          responseText: null,
          configuredModelId: existing.configuredModelId,
          reportedModelId: null,
          terminalReason: 'AMBIGUOUS_DISPATCH',
          errorMessage:
            'Interaction dispatch is already in progress and cannot be replayed automatically.',
          durationMs: null,
        };
      }

      return {
        interactionId: existing.id,
        status: existing.status,
        responseText: null,
        configuredModelId: existing.configuredModelId,
        reportedModelId: null,
        terminalReason: null,
        errorMessage: null,
        durationMs: null,
      };
    }

    const dispatchClaim = this.claimDispatch(admission.interaction.id);
    if (!dispatchClaim.claimed) {
      const cancelled = dispatchClaim.interaction;
      return {
        interactionId: cancelled.id,
        status: 'CANCELLED',
        responseText: null,
        configuredModelId: cancelled.configuredModelId,
        reportedModelId: null,
        terminalReason: cancelled.terminalReason ?? 'session_ended',
        errorMessage: null,
        durationMs: cancelled.durationMs ?? null,
      };
    }

    // From here on the interaction is already in DISPATCH_STARTED. Every exit
    // path must therefore drive it to a terminal state, otherwise it would hold
    // the per-session concurrency allowance and attempt quota indefinitely.
    const dispatchStartedAt = Date.now();

    let provider;
    try {
      provider = this.providerRegistry.getProvider(
        admission.interaction.configuredProviderId,
      );
    } catch (error: unknown) {
      this.releaseStuckDispatch(
        admission.interaction.id,
        'provider_lookup_failed',
        error instanceof Error
          ? error.message
          : 'The AI provider registry could not resolve the configured provider.',
        dispatchStartedAt,
      );
      throw error;
    }

    if (!provider) {
      // An unconfigured provider is a permanent failure for this interaction.
      // Releasing it here is what prevents an unconfigured platform from
      // wedging the session's concurrency allowance.
      const message = `AI provider "${admission.interaction.configuredProviderId}" is not configured on the platform.`;
      this.releaseStuckDispatch(
        admission.interaction.id,
        'provider_not_configured',
        message,
        dispatchStartedAt,
      );
      throw new AiInteractionError('PROVIDER_NOT_CONFIGURED', message);
    }

    const abortController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort(new Error('AI provider request timed out.'));
    }, this.timeoutMs);

    const startTime = Date.now();
    try {
      const conversationHistory = this.aiInteractionStore
        .findBySessionId(sessionId)
        .filter(
          (interaction) =>
            interaction.status === 'COMPLETED' &&
            typeof interaction.capturedResponseText === 'string',
        )
        .slice(-4)
        .map((interaction) => ({
          candidateInput: boundExcerpt(interaction.candidatePromptText),
          responseText: boundExcerpt(interaction.capturedResponseText ?? ''),
        }));
      const normalizedRequest: NormalizedAiRequest = {
        configuredModelId: admission.interaction.configuredModelId,
        candidateInput: params.candidatePromptText,
        candidateContext: params.candidateContext,
        hirearchyContext: params.hirearchyContext,
        conversationHistory,
      };
      const providerResult = await provider.execute(normalizedRequest, {
        signal: abortController.signal,
      });
      clearTimeout(timer);

      const durationMs = Math.max(0, Date.now() - startTime);
      const boundedResponse = boundExcerpt(
        providerResult.responseText,
        MAXIMUM_RESPONSE_LENGTH,
      );

      let completed: AiInteraction;
      try {
        completed = this.recordCompletion(admission.interaction.id, {
          durationMs,
          responseText: boundedResponse,
          reportedModelId: providerResult.reportedModelId,
          providerRequestId: providerResult.providerRequestId,
          finishReason: providerResult.finishReason,
          tokenUsage: providerResult.tokenUsage,
        });
      } catch (error) {
        throw new AiInteractionError(
          'PLATFORM_PERSISTENCE_FAILED',
          `Failed to persist completed AI interaction: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (
        completed.status === 'CANCELLED' &&
        completed.terminalReason === 'session_ended'
      ) {
        return {
          interactionId: completed.id,
          status: 'CANCELLED',
          responseText: null,
          configuredModelId: completed.configuredModelId,
          reportedModelId: null,
          terminalReason: 'session_ended',
          errorMessage: null,
          durationMs: completed.durationMs ?? durationMs,
        };
      }

      return {
        interactionId: completed.id,
        status: 'COMPLETED',
        responseText: completed.capturedResponseText ?? boundedResponse,
        configuredModelId: completed.configuredModelId,
        reportedModelId: providerResult.reportedModelId ?? null,
        terminalReason: null,
        errorMessage: null,
        durationMs: completed.durationMs ?? durationMs,
      };
    } catch (error: unknown) {
      clearTimeout(timer);

      if (error instanceof AiInteractionError) {
        // Platform and state-machine errors must surface unchanged so a
        // persistence failure is never reported as a normal outcome. The
        // dispatch is still released first, because the transaction that raised
        // this error rolled back and left the interaction in DISPATCH_STARTED.
        this.releaseStuckDispatch(
          admission.interaction.id,
          'dispatch_error',
          error.message,
          dispatchStartedAt,
        );
        throw error;
      }

      const durationMs = Math.max(0, Date.now() - startTime);
      const failureReason = timedOut ? 'TIMEOUT' : 'PROVIDER_ERROR';
      const errorMessage = timedOut
        ? 'The AI request timed out.'
        : error instanceof Error
          ? error.message
          : 'The AI provider failed to execute the request.';

      let failed: AiInteraction;
      try {
        failed = this.recordFailure(admission.interaction.id, {
          durationMs,
          failureReason,
          errorMessage,
        });
      } catch (persistError) {
        throw new AiInteractionError(
          'PLATFORM_PERSISTENCE_FAILED',
          `Failed to persist failed AI interaction: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
        );
      }

      if (
        failed.status === 'CANCELLED' &&
        failed.terminalReason === 'session_ended'
      ) {
        return {
          interactionId: failed.id,
          status: 'CANCELLED',
          responseText: null,
          configuredModelId: failed.configuredModelId,
          reportedModelId: null,
          terminalReason: 'session_ended',
          errorMessage: null,
          durationMs: failed.durationMs ?? durationMs,
        };
      }

      return {
        interactionId: failed.id,
        status: 'FAILED',
        responseText: null,
        configuredModelId: failed.configuredModelId,
        reportedModelId: null,
        terminalReason: failed.terminalReason ?? failureReason,
        errorMessage: failed.errorMessage ?? errorMessage,
        durationMs: failed.durationMs ?? durationMs,
      };
    }
  }

  getInteraction(interactionId: string): AiInteraction | null {
    return this.aiInteractionStore.findById(interactionId);
  }

  getInteractionsForSession(sessionId: string): readonly AiInteraction[] {
    return this.aiInteractionStore.findBySessionId(sessionId);
  }
}

export const getAiInteractionService = (
  databasePath?: string,
  options?: Partial<AiInteractionServiceOptions>,
) => {
  const resolvedPath = databasePath ?? getApplicationDatabasePath();

  const sessionStore =
    options?.sessionStore ?? new SqliteSessionStore(resolvedPath);
  const eventStore = options?.eventStore ?? new SqliteEventStore(resolvedPath);
  const aiInteractionStore =
    options?.aiInteractionStore ?? new SqliteAiInteractionStore(resolvedPath);
  const runner =
    options?.transactionRunner ?? new SqliteTransactionRunner(resolvedPath);
  runner.registerInitializer(SqliteSessionStore.ensureSchema);
  runner.registerInitializer(SqliteEventStore.ensureSchema);
  runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

  const providerRegistry =
    options?.providerRegistry ??
    new DefaultAiProviderRegistry([
      ...(getOpenRouterApiKey() ? [new OpenRouterAiProvider()] : []),
      ...(getNvidiaApiKey() ? [new NvidiaNimAiProvider()] : []),
    ]);
  return new AiInteractionService({
    sessionStore,
    eventStore,
    aiInteractionStore,
    transactionRunner: runner,
    providerRegistry,
    timeoutMs: options?.timeoutMs,
    createId: options?.createId,
    now: options?.now,
    maxInteractionsPerSession: options?.maxInteractionsPerSession,
    maxConcurrentPerSession: options?.maxConcurrentPerSession,
    maxRateLimitPerMinute: options?.maxRateLimitPerMinute,
    maxTotalAttemptsPerSession: options?.maxTotalAttemptsPerSession,
  });
};
