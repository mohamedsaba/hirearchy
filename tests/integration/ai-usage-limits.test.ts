import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as executeAiInteraction } from '../../apps/web/app/api/candidate/sessions/[token]/ai/interactions/route';
import { defaultAiCapabilitySnapshot } from '../../apps/web/src/ai/ai-interaction';
import {
  AiInteractionService,
  DEFAULT_MAX_AI_INTERACTIONS_PER_SESSION,
  DEFAULT_MAX_AI_CONCURRENT_PER_SESSION,
  DEFAULT_MAX_AI_REQUESTS_PER_MINUTE,
} from '../../apps/web/src/ai/ai-interaction-service';
import { MockAiProvider } from '../../apps/web/src/ai/mock-ai-provider';
import { DefaultAiProviderRegistry } from '../../apps/web/src/ai/ai-provider';
import { SqliteAiInteractionStore } from '../../apps/web/src/ai/sqlite-ai-interaction-store';
import { SqliteTransactionRunner } from '../../apps/web/src/database/sqlite-transaction-runner';
import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

// Explicit test injection: production code no longer registers a mock AI
// provider by default. Route-level limit tests exercise the success path,
// so the deterministic MockAiProvider is injected here on purpose.
vi.mock(
  '../../apps/web/src/ai/ai-interaction-service',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../apps/web/src/ai/ai-interaction-service')
      >();
    const { MockAiProvider: MockProvider } =
      await import('../../apps/web/src/ai/mock-ai-provider');
    const { DefaultAiProviderRegistry: Registry } =
      await import('../../apps/web/src/ai/ai-provider');
    return {
      ...actual,
      getAiInteractionService: (
        databasePath?: string,
        options?: Parameters<typeof actual.getAiInteractionService>[1],
      ) =>
        actual.getAiInteractionService(databasePath, {
          ...options,
          providerRegistry:
            options?.providerRegistry ?? new Registry([new MockProvider()]),
        }),
    };
  },
);

describe('AI Usage Protection and Server-Side Limits', () => {
  let directory: string;
  let databasePath: string;
  let originalDbPath: string | undefined;
  let sessionService: SessionService;
  let candidateToken: string;
  let sessionId: string;

  beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-ai-limits-'));
    databasePath = path.join(directory, 'sessions.sqlite');
    originalDbPath = process.env.HIREARCHY_DB_PATH;
    process.env.HIREARCHY_DB_PATH = databasePath;

    const store = new SqliteSessionStore(databasePath);
    sessionService = new SessionService(store);
    // Explicit fixture: this test verifies server-side limits, not issuance.
    // Issuance honesty (no provider → AI disabled) is covered by
    // candidate-ai-provider-honesty.test.ts.
    const created = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    candidateToken = created.candidateToken;
    sessionId = created.session.id;

    // Activate the session
    await sessionService.activate(candidateToken);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDbPath === undefined) delete process.env.HIREARCHY_DB_PATH;
    else process.env.HIREARCHY_DB_PATH = originalDbPath;
    rmSync(directory, { recursive: true, force: true });
  });

  const aiRequest = (
    clientRequestId: string,
    prompt: string,
    token = candidateToken,
  ) =>
    new Request(
      `http://localhost/api/candidate/sessions/${token}/ai/interactions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId,
          candidatePromptText: prompt,
        }),
      },
    );

  const context = (token = candidateToken) => ({
    params: Promise.resolve({ token }),
  });

  describe('Default Limit Configurations', () => {
    it('declares safe defaults to prevent unbounded expenditure', () => {
      expect(DEFAULT_MAX_AI_INTERACTIONS_PER_SESSION).toBe(25);
      expect(DEFAULT_MAX_AI_CONCURRENT_PER_SESSION).toBe(1);
      expect(DEFAULT_MAX_AI_REQUESTS_PER_MINUTE).toBe(6);
    });
  });

  describe('Concurrency protection', () => {
    it('blocks concurrent in-flight AI requests for the same session', async () => {
      const runner = new SqliteTransactionRunner(databasePath);
      runner.registerInitializer(SqliteSessionStore.ensureSchema);
      runner.registerInitializer(SqliteEventStore.ensureSchema);
      runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

      const aiStore = new SqliteAiInteractionStore(databasePath);
      const sessionStore = new SqliteSessionStore(databasePath);
      const eventStore = new SqliteEventStore(databasePath);

      // Create an artificial provider that pauses during execution
      let resolveProvider: () => void = () => {};
      const pendingPromise = new Promise<void>((resolve) => {
        resolveProvider = resolve;
      });

      const delayedProvider = new MockAiProvider();
      vi.spyOn(delayedProvider, 'execute').mockImplementation(async () => {
        await pendingPromise;
        return {
          responseText: 'Delayed response',
          reportedModelId: 'mock-chat-v1',
          durationMs: 50,
        };
      });

      const service = new AiInteractionService({
        sessionStore,
        eventStore,
        aiInteractionStore: aiStore,
        transactionRunner: runner,
        providerRegistry: new DefaultAiProviderRegistry([delayedProvider]),
        maxConcurrentPerSession: 1,
      });

      // Start first interaction (stays in-flight until resolveProvider is called)
      const firstPromise = service.executeInteraction(sessionId, {
        clientRequestId: 'req-first-in-flight',
        candidatePromptText: 'First question',
      });

      // Give event loop a tick to ensure first interaction is admitted and claimed
      await new Promise((r) => setTimeout(r, 10));

      // Attempt second interaction concurrently with different requestId
      await expect(
        service.executeInteraction(sessionId, {
          clientRequestId: 'req-second-concurrent',
          candidatePromptText: 'Second question while first is in flight',
        }),
      ).rejects.toMatchObject({
        code: 'AI_CONCURRENT_REQUEST_LIMIT',
      });

      // Release first interaction
      resolveProvider();
      const firstResult = await firstPromise;
      expect(firstResult.status).toBe('COMPLETED');

      // Now that first is finished, next interaction can be admitted
      const thirdResult = await service.executeInteraction(sessionId, {
        clientRequestId: 'req-third-after-completion',
        candidatePromptText: 'Third question',
      });
      expect(thirdResult.status).toBe('COMPLETED');
    });

    it('allows retrying the SAME clientRequestId even if in-flight or completed without triggering concurrency error', async () => {
      const firstRes = await executeAiInteraction(
        aiRequest('req-idempotent-1', 'What is cache invalidation?'),
        context(),
      );
      expect(firstRes.status).toBe(200);

      // Same clientRequestId retried
      const retryRes = await executeAiInteraction(
        aiRequest('req-idempotent-1', 'What is cache invalidation?'),
        context(),
      );
      expect(retryRes.status).toBe(200);
      const data = await retryRes.json();
      expect(data.status).toBe('COMPLETED');
      expect(data.clientRequestId ?? data.interactionId).toBeTruthy();
    });
  });

  describe('Session completed interaction quota (expenditure limit)', () => {
    it('enforces configured max completed interactions per session server-side', async () => {
      const runner = new SqliteTransactionRunner(databasePath);
      runner.registerInitializer(SqliteSessionStore.ensureSchema);
      runner.registerInitializer(SqliteEventStore.ensureSchema);
      runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

      const aiStore = new SqliteAiInteractionStore(databasePath);
      const sessionStore = new SqliteSessionStore(databasePath);
      const eventStore = new SqliteEventStore(databasePath);

      const service = new AiInteractionService({
        sessionStore,
        eventStore,
        aiInteractionStore: aiStore,
        transactionRunner: runner,
        providerRegistry: new DefaultAiProviderRegistry([new MockAiProvider()]),
        maxInteractionsPerSession: 2, // Low quota for test
      });

      // 1st interaction succeeds
      const res1 = await service.executeInteraction(sessionId, {
        clientRequestId: 'quota-req-1',
        candidatePromptText: 'Question 1',
      });
      expect(res1.status).toBe('COMPLETED');

      // 2nd interaction succeeds
      const res2 = await service.executeInteraction(sessionId, {
        clientRequestId: 'quota-req-2',
        candidatePromptText: 'Question 2',
      });
      expect(res2.status).toBe('COMPLETED');

      // 3rd interaction exceeds quota
      await expect(
        service.executeInteraction(sessionId, {
          clientRequestId: 'quota-req-3',
          candidatePromptText: 'Question 3 exceeds quota',
        }),
      ).rejects.toMatchObject({
        code: 'AI_INTERACTION_LIMIT_EXCEEDED',
      });
    });

    it('returns HTTP 429 via API route when interaction limit is exceeded', async () => {
      // Configure low limit via environment variable
      process.env.HIREARCHY_AI_MAX_INTERACTIONS_PER_SESSION = '2';

      const res1 = await executeAiInteraction(
        aiRequest('http-quota-1', 'Question 1'),
        context(),
      );
      expect(res1.status).toBe(200);

      const res2 = await executeAiInteraction(
        aiRequest('http-quota-2', 'Question 2'),
        context(),
      );
      expect(res2.status).toBe(200);

      const res3 = await executeAiInteraction(
        aiRequest('http-quota-3', 'Question 3'),
        context(),
      );
      expect(res3.status).toBe(429);
      const data3 = await res3.json();
      expect(data3).toMatchObject({
        error: {
          code: 'AI_INTERACTION_LIMIT_EXCEEDED',
        },
      });

      delete process.env.HIREARCHY_AI_MAX_INTERACTIONS_PER_SESSION;
    });
  });

  describe('Rate limiting (rapid fire protection)', () => {
    it('blocks rapid bursts exceeding max requests per minute', async () => {
      const runner = new SqliteTransactionRunner(databasePath);
      runner.registerInitializer(SqliteSessionStore.ensureSchema);
      runner.registerInitializer(SqliteEventStore.ensureSchema);
      runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

      const aiStore = new SqliteAiInteractionStore(databasePath);
      const sessionStore = new SqliteSessionStore(databasePath);
      const eventStore = new SqliteEventStore(databasePath);

      const service = new AiInteractionService({
        sessionStore,
        eventStore,
        aiInteractionStore: aiStore,
        transactionRunner: runner,
        providerRegistry: new DefaultAiProviderRegistry([new MockAiProvider()]),
        maxRateLimitPerMinute: 3, // Rate limit: 3 per minute
        maxInteractionsPerSession: 10,
      });

      // Fire 3 requests in quick succession
      for (let i = 1; i <= 3; i++) {
        const res = await service.executeInteraction(sessionId, {
          clientRequestId: `burst-req-${i}`,
          candidatePromptText: `Burst question ${i}`,
        });
        expect(res.status).toBe('COMPLETED');
      }

      // 4th request in same minute triggers rate limit
      await expect(
        service.executeInteraction(sessionId, {
          clientRequestId: 'burst-req-4',
          candidatePromptText: 'Burst question 4',
        }),
      ).rejects.toMatchObject({
        code: 'AI_RATE_LIMIT_EXCEEDED',
      });
    });
  });
});
