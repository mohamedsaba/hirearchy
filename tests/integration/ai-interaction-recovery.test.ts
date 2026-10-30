import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ABANDONED_DISPATCH_FAILURE_REASON,
  AiInteractionService,
  DEFAULT_MAX_AI_CONCURRENT_PER_SESSION,
  DEFAULT_MAX_AI_INTERACTIONS_PER_SESSION,
  DEFAULT_MAX_AI_REQUESTS_PER_MINUTE,
} from '../../apps/web/src/ai/ai-interaction-service';
import { defaultAiCapabilitySnapshot } from '../../apps/web/src/ai/ai-interaction';
import { DefaultAiProviderRegistry } from '../../apps/web/src/ai/ai-provider';
import { SqliteAiInteractionStore } from '../../apps/web/src/ai/sqlite-ai-interaction-store';
import { SqliteTransactionRunner } from '../../apps/web/src/database/sqlite-transaction-runner';
import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

/**
 * Regression coverage for two AI-interaction protection defects:
 *
 *  1. A provider initialization failure (missing provider configuration) left
 *     the interaction in DISPATCH_STARTED forever, so the per-session
 *     concurrency allowance was consumed by a request that could never finish.
 *
 *  2. A process interruption between admission and dispatch left the same kind
 *     of stranded row, holding the concurrency allowance and the session
 *     attempt quota indefinitely.
 *
 * Both must resolve to a terminal, evidence-recorded state without changing the
 * SQLite data model or the existing transition rules.
 */
describe('AI Interaction Dispatch Recovery', () => {
  let directory: string;
  let databasePath: string;
  let originalDbPath: string | undefined;
  let sessionService: SessionService;
  let sessionId: string;
  let candidateToken: string;

  const buildService = (
    options: Partial<
      ConstructorParameters<typeof AiInteractionService>[0]
    > = {},
    providers: ConstructorParameters<typeof DefaultAiProviderRegistry>[0] = [],
  ) => {
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    return new AiInteractionService({
      sessionStore: new SqliteSessionStore(databasePath),
      eventStore: new SqliteEventStore(databasePath),
      aiInteractionStore: new SqliteAiInteractionStore(databasePath),
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry(providers),
      ...options,
    });
  };

  beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-ai-recovery-'));
    databasePath = path.join(directory, 'sessions.sqlite');
    originalDbPath = process.env.HIREARCHY_DB_PATH;
    process.env.HIREARCHY_DB_PATH = databasePath;

    const store = new SqliteSessionStore(databasePath);
    sessionService = new SessionService(store);
    // Explicit fixture: the session claims a 'mock-ai' provider while the
    // services below use an empty registry, which is exactly the honest
    // missing-provider scenario (dispatch must fail terminally, never with
    // synthetic output). Issuance honesty is covered separately.
    const created = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    sessionId = created.session.id;
    candidateToken = created.candidateToken;
    await sessionService.activate(candidateToken);
  });

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.HIREARCHY_DB_PATH;
    else process.env.HIREARCHY_DB_PATH = originalDbPath;
    rmSync(directory, { recursive: true, force: true });
  });

  describe('Missing provider configuration', () => {
    it('releases the dispatch instead of leaving it in DISPATCH_STARTED', async () => {
      // An empty registry cannot resolve the scenario's configured provider.
      const service = buildService();

      await expect(
        service.executeInteraction(sessionId, {
          clientRequestId: 'req-no-provider',
          candidatePromptText: 'Explain the cache staleness fix.',
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });

      const open = service
        .getInteractionsForSession(sessionId)
        .filter((interaction) =>
          ['ADMITTED', 'DISPATCH_STARTED'].includes(interaction.status),
        );
      expect(open).toHaveLength(0);
    });

    it('records a FAILED terminal state with a provider reason', async () => {
      const service = buildService();

      await expect(
        service.executeInteraction(sessionId, {
          clientRequestId: 'req-no-provider-terminal',
          candidatePromptText: 'Explain the cache staleness fix.',
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });

      const [interaction] = service.getInteractionsForSession(sessionId);
      expect(interaction.status).toBe('FAILED');
      expect(interaction.terminalReason).toBe('provider_not_configured');
    });

    it('does not consume the concurrency allowance after a provider failure', async () => {
      const service = buildService({ maxConcurrentPerSession: 1 });

      for (const clientRequestId of ['req-a', 'req-b', 'req-c']) {
        await expect(
          service.executeInteraction(sessionId, {
            clientRequestId,
            candidatePromptText: 'Explain the cache staleness fix.',
          }),
        ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
      }

      // Every attempt reached the provider lookup instead of being rejected by
      // a leaked concurrency slot.
      expect(service.getInteractionsForSession(sessionId)).toHaveLength(3);
      expect(
        service
          .getInteractionsForSession(sessionId)
          .every((interaction) => interaction.status === 'FAILED'),
      ).toBe(true);
    });
  });

  describe('Interrupted dispatch recovery', () => {
    it('reclaims an abandoned dispatch during the next admission', async () => {
      const service = buildService({ timeoutMs: 30_000 });

      // Simulate an interruption: admit and claim, then abandon the process.
      const admission = service.admitInteraction(sessionId, {
        clientRequestId: 'req-abandoned',
        candidatePromptText: 'Explain the cache staleness fix.',
      });
      expect(admission.wasAdmitted).toBe(true);
      service.claimDispatch(admission.interaction.id);

      const stranded = service.getInteraction(admission.interaction.id)!;
      expect(stranded.status).toBe('DISPATCH_STARTED');

      // A fresh admission inside the recovery horizon still respects the
      // concurrency allowance.
      await expect(
        service.executeInteraction(sessionId, {
          clientRequestId: 'req-too-early',
          candidatePromptText: 'Too soon.',
        }),
      ).rejects.toMatchObject({ code: 'AI_CONCURRENT_REQUEST_LIMIT' });

      expect(service.getInteraction(admission.interaction.id)!.status).toBe(
        'DISPATCH_STARTED',
      );
    });

    it('reclaims a stranded dispatch once the recovery horizon has passed', async () => {
      // A zero horizon makes every open interaction immediately reclaimable.
      const service = buildService({
        timeoutMs: 30_000,
        dispatchRecoveryAfterMs: 0,
      });

      const admission = service.admitInteraction(sessionId, {
        clientRequestId: 'req-abandoned-old',
        candidatePromptText: 'Explain the cache staleness fix.',
      });
      service.claimDispatch(admission.interaction.id);
      expect(service.getInteraction(admission.interaction.id)!.status).toBe(
        'DISPATCH_STARTED',
      );

      const next = service.admitInteraction(sessionId, {
        clientRequestId: 'req-after-recovery',
        candidatePromptText: 'A new request.',
      });

      expect(next.wasAdmitted).toBe(true);

      const recovered = service.getInteraction(admission.interaction.id)!;
      expect(recovered.status).toBe('FAILED');
      expect(recovered.terminalReason).toBe(ABANDONED_DISPATCH_FAILURE_REASON);
    });

    it('appends an AI_REQUEST_FAILED event so recovery stays observable', async () => {
      const service = buildService({ dispatchRecoveryAfterMs: 0 });

      const admission = service.admitInteraction(sessionId, {
        clientRequestId: 'req-abandoned-event',
        candidatePromptText: 'Explain the cache staleness fix.',
      });
      service.claimDispatch(admission.interaction.id);

      service.admitInteraction(sessionId, {
        clientRequestId: 'req-trigger-recovery',
        candidatePromptText: 'Trigger the sweep.',
      });

      const events = new SqliteEventStore(databasePath).getRecentEvents(
        sessionId,
        200,
      );
      const recoveryEvent = events.find(
        (event) =>
          event.type === 'AI_REQUEST_FAILED' &&
          (event.payload as { failureReason?: string }).failureReason ===
            ABANDONED_DISPATCH_FAILURE_REASON,
      );
      expect(recoveryEvent).toBeDefined();
      expect(
        (recoveryEvent!.payload as { interactionId: string }).interactionId,
      ).toBe(admission.interaction.id);
    });

    it('preserves idempotent replay for a recovered interaction', async () => {
      const service = buildService({ dispatchRecoveryAfterMs: 0 });

      const admission = service.admitInteraction(sessionId, {
        clientRequestId: 'req-replay',
        candidatePromptText: 'Explain the cache staleness fix.',
      });
      service.claimDispatch(admission.interaction.id);

      service.admitInteraction(sessionId, {
        clientRequestId: 'req-other',
        candidatePromptText: 'Trigger the sweep.',
      });

      // Replaying the original clientRequestId must return the terminal result
      // rather than re-entering a permanently ambiguous dispatch.
      const replay = await service.executeInteraction(sessionId, {
        clientRequestId: 'req-replay',
        candidatePromptText: 'Explain the cache staleness fix.',
      });

      expect(replay.status).toBe('FAILED');
      expect(replay.terminalReason).toBe(ABANDONED_DISPATCH_FAILURE_REASON);
      expect(
        service
          .getInteractionsForSession(sessionId)
          .filter((i) => i.clientRequestId === 'req-replay'),
      ).toHaveLength(1);
    });
  });

  describe('AI limit environment variable parsing', () => {
    const limitEnvVars = [
      'HIREARCHY_AI_MAX_INTERACTIONS_PER_SESSION',
      'HIREARCHY_AI_MAX_CONCURRENT_PER_SESSION',
      'HIREARCHY_AI_MAX_REQUESTS_PER_MINUTE',
      'HIREARCHY_AI_MAX_TOTAL_ATTEMPTS_PER_SESSION',
    ] as const;

    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const name of limitEnvVars) {
        originalEnv[name] = process.env[name];
        delete process.env[name];
      }
    });

    afterEach(() => {
      for (const name of limitEnvVars) {
        const value = originalEnv[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    const readLimits = () => buildService();

    it('applies conservative defaults when no limits are configured', () => {
      const service = readLimits();
      expect(service.maxInteractionsPerSession).toBe(
        DEFAULT_MAX_AI_INTERACTIONS_PER_SESSION,
      );
      expect(service.maxConcurrentPerSession).toBe(
        DEFAULT_MAX_AI_CONCURRENT_PER_SESSION,
      );
      expect(service.maxRateLimitPerMinute).toBe(
        DEFAULT_MAX_AI_REQUESTS_PER_MINUTE,
      );
    });

    it('ignores malformed values instead of silently widening a limit', () => {
      // Each of these would parse to a numeric value under a naive
      // Number.parseInt and could widen the limit past the safe default.
      for (const malformed of ['abc', '2oops', '1.5', '-1', '0', '', '   ']) {
        for (const name of limitEnvVars) {
          delete process.env[name];
          process.env[name] = malformed;
          const service = buildService();

          expect(service.maxInteractionsPerSession).toBe(
            DEFAULT_MAX_AI_INTERACTIONS_PER_SESSION,
          );
          expect(service.maxConcurrentPerSession).toBe(
            DEFAULT_MAX_AI_CONCURRENT_PER_SESSION,
          );
          expect(service.maxRateLimitPerMinute).toBe(
            DEFAULT_MAX_AI_REQUESTS_PER_MINUTE,
          );
        }
      }
    });

    it('honours a well-formed explicit value', () => {
      process.env.HIREARCHY_AI_MAX_INTERACTIONS_PER_SESSION = '3';
      const service = buildService();
      expect(service.maxInteractionsPerSession).toBe(3);
    });

    it('never derives a permissive concurrency limit from a malformed value', () => {
      // The concurrency default of 1 is the strictest setting, so any widening
      // is the security-relevant failure mode.
      process.env.HIREARCHY_AI_MAX_CONCURRENT_PER_SESSION = '99oops';
      expect(buildService().maxConcurrentPerSession).toBe(
        DEFAULT_MAX_AI_CONCURRENT_PER_SESSION,
      );

      process.env.HIREARCHY_AI_MAX_CONCURRENT_PER_SESSION = '99';
      expect(buildService().maxConcurrentPerSession).toBe(99);
    });
  });
});
