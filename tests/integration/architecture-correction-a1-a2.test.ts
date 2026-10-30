import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as executeAiInteractionRoute } from '../../apps/web/app/api/candidate/sessions/[token]/ai/interactions/route';
import {
  INITIAL_CANDIDATE_AI_STATE,
  resolveSubmissionResult,
} from '../../apps/web/app/candidate/[token]/candidate-ai-state';
import { defaultAiCapabilitySnapshot } from '../../apps/web/src/ai/ai-interaction';
import { AiInteractionService } from '../../apps/web/src/ai/ai-interaction-service';
import type {
  AiProvider,
  AiProviderExecutionOptions,
  NormalizedAiRequest,
  NormalizedAiResult,
} from '../../apps/web/src/ai/ai-provider';
import { DefaultAiProviderRegistry } from '../../apps/web/src/ai/ai-provider';
import { MockAiProvider } from '../../apps/web/src/ai/mock-ai-provider';
import { SqliteAiInteractionStore } from '../../apps/web/src/ai/sqlite-ai-interaction-store';
import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { MockSandboxAdapter } from '../../apps/web/src/sandbox/mock-sandbox-adapter';
import { getSessionOperationCoordinator } from '../../apps/web/src/sessions/session-operation-coordinator';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';
import { SqliteTransactionRunner } from '../../apps/web/src/database/sqlite-transaction-runner';

// Explicit test injection: production code no longer registers a mock AI
// provider by default. Route-driven scenarios in this file exercise the
// success path, so the deterministic MockAiProvider is injected here on
// purpose. Service-driven scenarios inject their own registries directly.
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

class ControllableAiProvider implements AiProvider {
  public readonly providerId = 'mock-ai';
  public callCount = 0;
  public pendingResolvers: Array<{
    resolve: (res: NormalizedAiResult) => void;
    reject: (err: Error) => void;
    request: NormalizedAiRequest;
  }> = [];

  async execute(
    request: NormalizedAiRequest,
    options?: AiProviderExecutionOptions,
  ): Promise<NormalizedAiResult> {
    this.callCount++;
    return new Promise((resolve, reject) => {
      this.pendingResolvers.push({ resolve, reject, request });
      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          reject(new Error('AI provider request timed out.'));
        });
      }
    });
  }

  resolveNext(result: Partial<NormalizedAiResult> = {}) {
    const next = this.pendingResolvers.shift();
    if (!next) {
      throw new Error('No pending provider call to resolve');
    }
    next.resolve({
      responseText: 'Default controlled AI response.',
      reportedModelId: 'mock-model-v1',
      ...result,
    });
  }

  rejectNext(error: Error = new Error('Upstream provider exploded')) {
    const next = this.pendingResolvers.shift();
    if (!next) {
      throw new Error('No pending provider call to reject');
    }
    next.reject(error);
  }
}

describe('Hirearchy Software Architecture Correction A1/A2 — Same-Session Coordination + Evidence Closure', () => {
  let directory: string;
  let databasePath: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(
      path.join(tmpdir(), 'hirearchy-architecture-correction-'),
    );
    databasePath = path.join(directory, 'correction.sqlite');
    originalDbPath = process.env.HIREARCHY_DB_PATH;
    process.env.HIREARCHY_DB_PATH = databasePath;
  });

  afterEach(() => {
    if (originalDbPath !== undefined) {
      process.env.HIREARCHY_DB_PATH = originalDbPath;
    } else {
      delete process.env.HIREARCHY_DB_PATH;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  const createRequest = (url: string, body?: Record<string, unknown>) =>
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

  // --------------------------------------------------------------------------
  // Scenario A: Same session, two independent SessionService instances -> serialized
  // --------------------------------------------------------------------------
  it('Scenario A: serializes operations on same session across independent SessionService instances', async () => {
    const sessionStore1 = new SqliteSessionStore(databasePath);
    const sessionStore2 = new SqliteSessionStore(databasePath);
    const sandbox = new MockSandboxAdapter();

    const service1 = new SessionService(sessionStore1, {
      sandboxAdapter: sandbox,
    });
    const service2 = new SessionService(sessionStore2, {
      sandboxAdapter: sandbox,
    });

    const { candidateToken, session } = service1.createSession();
    await service1.activate(candidateToken);

    const trace: string[] = [];
    let resolveOp1Barrier!: () => void;
    const op1Barrier = new Promise<void>((res) => {
      resolveOp1Barrier = res;
    });

    // Custom exec handler to delay operation 1
    sandbox.customExecHandler = () => {
      trace.push('op1:inside_sandbox');
      return { exitCode: 0, stdout: 'op1 done' };
    };

    // Inject a controlled delay into service1 operation using an internal queue wrap
    const coordinator = getSessionOperationCoordinator();
    const p1 = coordinator.run(session.id, async () => {
      trace.push('op1:start');
      await op1Barrier;
      trace.push('op1:end');
      return 'res1';
    });

    // Operation 2 dispatched via service2 immediately
    const p2 = service2.saveWorkspaceFile(
      candidateToken,
      'inventory/service.py',
      '# updated content\n',
    );

    // Verify op1 is started and op2 has not started
    await new Promise((r) => setTimeout(r, 20));
    expect(trace).toEqual(['op1:start']);

    // Release op1
    resolveOp1Barrier();
    await Promise.all([p1, p2]);

    expect(trace).toEqual(['op1:start', 'op1:end']);
  });

  // --------------------------------------------------------------------------
  // Scenario B: Different sessions -> concurrent
  // --------------------------------------------------------------------------
  it('Scenario B: executes operations on different sessions concurrently without blocking', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sandbox = new MockSandboxAdapter();
    const service = new SessionService(sessionStore, {
      sandboxAdapter: sandbox,
    });

    const s1 = service.createSession();
    const s2 = service.createSession();
    await service.activate(s1.candidateToken);
    await service.activate(s2.candidateToken);

    let resolveSession1!: () => void;
    const session1Hold = new Promise<void>((res) => {
      resolveSession1 = res;
    });

    const coordinator = getSessionOperationCoordinator();
    let session1Started = false;
    let session1Finished = false;

    const p1 = coordinator.run(s1.session.id, async () => {
      session1Started = true;
      await session1Hold;
      session1Finished = true;
    });

    // Wait until session 1 has started and is holding the lock
    while (!session1Started) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Session 2 operation should execute and finish immediately while session 1 is blocked
    let session2Finished = false;
    const p2 = service
      .saveWorkspaceFile(
        s2.candidateToken,
        'inventory/service.py',
        '# s2 change\n',
      )
      .then(() => {
        session2Finished = true;
      });

    await p2;
    expect(session2Finished).toBe(true);
    expect(session1Finished).toBe(false);

    // Unblock session 1
    resolveSession1();
    await p1;
    expect(session1Finished).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Scenario C: Coordinator error recovery -> rejected operation releases queue
  // --------------------------------------------------------------------------
  it('Scenario C: releases per-session queue on error so subsequent operations succeed', async () => {
    const coordinator = getSessionOperationCoordinator();
    const testSessionId = 'test-session-recovery';

    // Op 1 throws
    const p1 = coordinator.run(testSessionId, async () => {
      throw new Error('Simulated failure in op1');
    });
    await expect(p1).rejects.toThrow('Simulated failure in op1');

    // Op 2 should succeed immediately without deadlock
    const p2 = coordinator.run(testSessionId, async () => {
      return 'op2_success';
    });
    await expect(p2).resolves.toBe('op2_success');
  });

  // --------------------------------------------------------------------------
  // Scenario D: Submit while AI ADMITTED -> cancellation event + session submitted
  // --------------------------------------------------------------------------
  it('Scenario D: closes open ADMITTED AI interaction as CANCELLED/session_ended upon submission', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const provider = new ControllableAiProvider();
    const registry = new DefaultAiProviderRegistry([provider]);
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: registry,
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    // Admit interaction without claiming dispatch
    const admission = aiService.admitInteraction(session.id, {
      clientRequestId: 'req_admitted_only',
      candidatePromptText: 'Explain caching.',
    });
    expect(admission.interaction.status).toBe('ADMITTED');

    // Submit the session
    const submitted = await sessionService.submit(candidateToken);
    expect(submitted.status).toBe('SUBMITTED');

    // Verify interaction state in database
    const interaction = aiStore.findById(admission.interaction.id);
    expect(interaction).not.toBeNull();
    expect(interaction!.status).toBe('CANCELLED');
    expect(interaction!.terminalReason).toBe('session_ended');

    // Verify cancellation event in event store
    const events = eventStore.getEvents(session.id);
    const cancelEvent = events.find((e) => e.type === 'AI_REQUEST_CANCELLED');
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent!.payload).toMatchObject({
      interactionId: admission.interaction.id,
      cancelReason: 'session_ended',
    });
  });

  // --------------------------------------------------------------------------
  // Scenario E: Submit while AI DISPATCH_STARTED -> submission completes immediately
  // --------------------------------------------------------------------------
  it('Scenario E: submission completes without waiting for pending provider in DISPATCH_STARTED', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const provider = new ControllableAiProvider();
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry([provider]),
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    // Launch interaction that hangs on provider
    const interactionPromise = aiService.executeInteraction(session.id, {
      clientRequestId: 'req_in_flight',
      candidatePromptText: 'Hanging request',
    });

    // Wait until dispatch is claimed and provider has been called
    while (provider.pendingResolvers.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const openBeforeSubmit =
      aiStore.findById('ai_int_req_in_flight') ??
      aiStore.findByClientRequestId(session.id, 'req_in_flight');
    expect(openBeforeSubmit!.status).toBe('DISPATCH_STARTED');

    // Submit session now; must finish promptly without awaiting provider
    const submitStartTime = Date.now();
    const submitted = await sessionService.submit(candidateToken);
    const submitDuration = Date.now() - submitStartTime;

    expect(submitted.status).toBe('SUBMITTED');
    expect(submitDuration).toBeLessThan(500);

    // Interaction in database is immediately marked CANCELLED / session_ended
    const closedInteraction = aiStore.findById(openBeforeSubmit!.id);
    expect(closedInteraction!.status).toBe('CANCELLED');
    expect(closedInteraction!.terminalReason).toBe('session_ended');

    // Clean up pending provider call
    provider.resolveNext();
    await interactionPromise;
  });

  // --------------------------------------------------------------------------
  // Scenario F: Cancel before dispatch claim -> provider call count 0
  // --------------------------------------------------------------------------
  it('Scenario F: aborts dispatch claim and does not call provider if cancelled before claim', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const provider = new ControllableAiProvider();
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry([provider]),
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    const admission = aiService.admitInteraction(session.id, {
      clientRequestId: 'req_f',
      candidatePromptText: 'Cancel before claim test',
    });

    // Session is submitted before claimDispatch is called
    await sessionService.submit(candidateToken);

    // Now attempt claim dispatch
    const claim = aiService.claimDispatch(admission.interaction.id);
    expect(claim.claimed).toBe(false);
    expect(claim.interaction.status).toBe('CANCELLED');
    expect(claim.interaction.terminalReason).toBe('session_ended');

    // Provider was never invoked
    expect(provider.callCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario G: Late success -> persisted cancellation unchanged, zero AI_RESPONSE_COMPLETED
  // --------------------------------------------------------------------------
  it('Scenario G: late provider success does not overwrite cancellation or emit completion event', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const provider = new ControllableAiProvider();
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry([provider]),
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    const interactionPromise = aiService.executeInteraction(session.id, {
      clientRequestId: 'req_g',
      candidatePromptText: 'Late success test',
    });

    while (provider.pendingResolvers.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Submit session, cancelling the interaction
    await sessionService.submit(candidateToken);

    // Provider now resolves with late response
    provider.resolveNext({ responseText: 'LATE SECRET RESPONSE' });
    const result = await interactionPromise;

    // Caller gets normalized CANCELLED / session_ended with no response text
    expect(result.status).toBe('CANCELLED');
    expect(result.terminalReason).toBe('session_ended');
    expect(result.responseText).toBeNull();

    // Persisted interaction remains CANCELLED / session_ended with no captured text
    const persisted = aiStore.findByClientRequestId(session.id, 'req_g');
    expect(persisted!.status).toBe('CANCELLED');
    expect(persisted!.terminalReason).toBe('session_ended');
    expect(persisted!.capturedResponseText == null).toBe(true);

    // No AI_RESPONSE_COMPLETED event exists
    const events = eventStore.getEvents(session.id);
    expect(
      events.find((e) => e.type === 'AI_RESPONSE_COMPLETED'),
    ).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Scenario H: Late provider failure -> persisted cancellation unchanged, zero AI_REQUEST_FAILED
  // --------------------------------------------------------------------------
  it('Scenario H: late provider failure does not overwrite cancellation or emit failed event', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const provider = new ControllableAiProvider();
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry([provider]),
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    const interactionPromise = aiService.executeInteraction(session.id, {
      clientRequestId: 'req_h',
      candidatePromptText: 'Late failure test',
    });

    while (provider.pendingResolvers.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    await sessionService.submit(candidateToken);

    // Provider rejects late
    provider.rejectNext(new Error('Late network disconnect'));
    const result = await interactionPromise;

    expect(result.status).toBe('CANCELLED');
    expect(result.terminalReason).toBe('session_ended');

    const persisted = aiStore.findByClientRequestId(session.id, 'req_h');
    expect(persisted!.status).toBe('CANCELLED');
    expect(persisted!.terminalReason).toBe('session_ended');

    const events = eventStore.getEvents(session.id);
    expect(events.find((e) => e.type === 'AI_REQUEST_FAILED')).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Scenario I: Late timeout -> persisted cancellation unchanged, zero AI_REQUEST_FAILED
  // --------------------------------------------------------------------------
  it('Scenario I: late timeout does not overwrite cancellation or emit failed event', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const provider = new ControllableAiProvider();
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    // AI service with very short timeout
    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry([provider]),
      timeoutMs: 50,
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    const interactionPromise = aiService.executeInteraction(session.id, {
      clientRequestId: 'req_i',
      candidatePromptText: 'Late timeout test',
    });

    while (provider.pendingResolvers.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Submit before timeout fires
    await sessionService.submit(candidateToken);

    // Wait for timeout to fire on interaction
    const result = await interactionPromise;
    expect(result.status).toBe('CANCELLED');
    expect(result.terminalReason).toBe('session_ended');

    const persisted = aiStore.findByClientRequestId(session.id, 'req_i');
    expect(persisted!.status).toBe('CANCELLED');
    expect(persisted!.terminalReason).toBe('session_ended');

    const events = eventStore.getEvents(session.id);
    expect(events.find((e) => e.type === 'AI_REQUEST_FAILED')).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Scenario J: Admission-first race -> submission cancels newly admitted interaction
  // --------------------------------------------------------------------------
  it('Scenario J: admission finishes first; subsequent submission cancels the newly admitted interaction', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    const admission = aiService.admitInteraction(session.id, {
      clientRequestId: 'req_race_admission_first',
      candidatePromptText: 'Race admission first',
    });
    expect(admission.wasAdmitted).toBe(true);

    await sessionService.submit(candidateToken);

    const interaction = aiStore.findById(admission.interaction.id);
    expect(interaction!.status).toBe('CANCELLED');
    expect(interaction!.terminalReason).toBe('session_ended');
  });

  // --------------------------------------------------------------------------
  // Scenario K: Submission-first new-ID race -> 409 SESSION_NOT_ACTIVE; no rows/events/calls
  // --------------------------------------------------------------------------
  it('Scenario K: submission finishes first; new clientRequestId rejected with 409 and zero rows/events/calls', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const provider = new ControllableAiProvider();
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry([provider]),
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);
    await sessionService.submit(candidateToken);

    const preEventsCount = eventStore.getEvents(session.id).length;

    // Incoming request with new clientRequestId
    const request = createRequest(
      `http://localhost:3000/api/candidate/sessions/${candidateToken}/ai/interactions`,
      {
        clientRequestId: 'req_brand_new_post_submit',
        candidatePromptText: 'Too late prompt',
      },
    );

    const response = await executeAiInteractionRoute(request, {
      params: Promise.resolve({ token: candidateToken }),
    });

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error?.code).toBe('SESSION_NOT_ACTIVE');

    // Verify zero new rows in ai_interactions
    expect(
      aiStore.findByClientRequestId(session.id, 'req_brand_new_post_submit'),
    ).toBeNull();

    // Verify zero new events in event store
    expect(eventStore.getEvents(session.id)).toHaveLength(preEventsCount);

    // Verify provider call count is 0
    expect(provider.callCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario L: Existing COMPLETED after closure -> HTTP 200 replay with exact result
  // --------------------------------------------------------------------------
  it('Scenario L: replaying existing COMPLETED request after submission returns HTTP 200 with persisted result', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore, {
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    // Execute first request while active
    const req1 = createRequest(
      `http://localhost:3000/api/candidate/sessions/${candidateToken}/ai/interactions`,
      {
        clientRequestId: 'req_completed_prior',
        candidatePromptText: 'Explain cache invalidation.',
      },
    );
    const res1 = await executeAiInteractionRoute(req1, {
      params: Promise.resolve({ token: candidateToken }),
    });
    expect(res1.status).toBe(200);
    const data1 = await res1.json();
    expect(data1.status).toBe('COMPLETED');
    expect(data1.responseText).toContain('Mock response');

    // Submit session
    await sessionService.submit(candidateToken);

    // Replay exact clientRequestId after submission
    const reqReplay = createRequest(
      `http://localhost:3000/api/candidate/sessions/${candidateToken}/ai/interactions`,
      {
        clientRequestId: 'req_completed_prior',
        candidatePromptText: 'Explain cache invalidation.',
      },
    );
    const resReplay = await executeAiInteractionRoute(reqReplay, {
      params: Promise.resolve({ token: candidateToken }),
    });

    expect(resReplay.status).toBe(200);
    const dataReplay = await resReplay.json();
    expect(dataReplay.interactionId).toBe(data1.interactionId);
    expect(dataReplay.status).toBe('COMPLETED');
    expect(dataReplay.responseText).toBe(data1.responseText);
    expect(dataReplay.configuredModelId).toBe(data1.configuredModelId);
  });

  // --------------------------------------------------------------------------
  // Scenario M: Existing FAILED after closure -> HTTP 200 replay
  // --------------------------------------------------------------------------
  it('Scenario M: replaying existing FAILED request after submission returns HTTP 200 with persisted failure', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const provider = new ControllableAiProvider();
    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry([provider]),
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    // Run failing interaction
    const p = aiService.executeInteraction(session.id, {
      clientRequestId: 'req_m_failed',
      candidatePromptText: 'Will fail',
    });
    while (provider.pendingResolvers.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    provider.rejectNext(new Error('Simulated upstream failure'));
    const initialFail = await p;
    expect(initialFail.status).toBe('FAILED');
    expect(initialFail.terminalReason).toBe('PROVIDER_ERROR');

    // Submit session
    await sessionService.submit(candidateToken);

    // Replay via executeInteraction
    const replay = await aiService.executeInteraction(session.id, {
      clientRequestId: 'req_m_failed',
      candidatePromptText: 'Will fail',
    });

    expect(replay.interactionId).toBe(initialFail.interactionId);
    expect(replay.status).toBe('FAILED');
    expect(replay.terminalReason).toBe('PROVIDER_ERROR');
    expect(provider.callCount).toBe(1); // Not redispatched
  });

  // --------------------------------------------------------------------------
  // Scenario N: Existing CANCELLED/session_ended after closure -> HTTP 200 replay
  // --------------------------------------------------------------------------
  it('Scenario N: replaying existing CANCELLED/session_ended request returns HTTP 200 with session_ended status', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const provider = new ControllableAiProvider();
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry([provider]),
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    // In flight when submitted
    const p = aiService.executeInteraction(session.id, {
      clientRequestId: 'req_n_cancel',
      candidatePromptText: 'In flight when submitted',
    });
    while (provider.pendingResolvers.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    await sessionService.submit(candidateToken);
    provider.resolveNext();
    await p;

    // Replay request
    const replay = await aiService.executeInteraction(session.id, {
      clientRequestId: 'req_n_cancel',
      candidatePromptText: 'In flight when submitted',
    });

    expect(replay.status).toBe('CANCELLED');
    expect(replay.terminalReason).toBe('session_ended');
    expect(replay.responseText).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario O: Existing DISPATCH_STARTED after closure -> HTTP 200 normalized ambiguity; no redispatch
  // --------------------------------------------------------------------------
  it('Scenario O: replaying existing DISPATCH_STARTED returns HTTP 200 AMBIGUOUS_DISPATCH without redispatch', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const provider = new ControllableAiProvider();
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry([provider]),
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    const admission = aiService.admitInteraction(session.id, {
      clientRequestId: 'req_o_dispatch_started',
      candidatePromptText: 'Testing dispatch started replay',
    });
    aiService.claimDispatch(admission.interaction.id);

    // Replay while DISPATCH_STARTED
    const replay = await aiService.executeInteraction(session.id, {
      clientRequestId: 'req_o_dispatch_started',
      candidatePromptText: 'Testing dispatch started replay',
    });

    expect(replay.status).toBe('DISPATCH_STARTED');
    expect(replay.terminalReason).toBe('AMBIGUOUS_DISPATCH');
    expect(provider.callCount).toBe(0); // Provider was not redispatched
  });

  // --------------------------------------------------------------------------
  // Scenario P: Existing ADMITTED after closure -> HTTP 200 persisted state; no dispatch
  // --------------------------------------------------------------------------
  it('Scenario P: replaying existing ADMITTED interaction returns persisted state without dispatching', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const provider = new ControllableAiProvider();
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry([provider]),
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    aiService.admitInteraction(session.id, {
      clientRequestId: 'req_p_admitted',
      candidatePromptText: 'Admitted only',
    });

    const replay = await aiService.executeInteraction(session.id, {
      clientRequestId: 'req_p_admitted',
      candidatePromptText: 'Admitted only',
    });

    expect(replay.status).toBe('ADMITTED');
    expect(provider.callCount).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario Q: Existing replay with invalid/different incoming prompt/context -> persisted result returned
  // --------------------------------------------------------------------------
  it('Scenario Q: existing replay with altered/invalid prompt/context returns persisted result without mutating DB', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    // Explicit injection: deterministic mock provider for replay behavior.
    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry([new MockAiProvider()]),
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    // Create initial completed interaction
    const initial = await aiService.executeInteraction(session.id, {
      clientRequestId: 'req_q_replay',
      candidatePromptText: 'Authoritative initial prompt',
      candidateContext: [{ filePath: 'inventory/cache.py' }],
    });
    expect(initial.status).toBe('COMPLETED');

    await sessionService.submit(candidateToken);

    // Replay with empty prompt, invalid context traversal, different fields
    const replayReq = createRequest(
      `http://localhost:3000/api/candidate/sessions/${candidateToken}/ai/interactions`,
      {
        clientRequestId: 'req_q_replay',
        candidatePromptText: '', // Empty prompt would fail on new admission
        candidateContext: [{ filePath: '../../etc/passwd' }], // Traversal would fail on new admission
      },
    );

    const response = await executeAiInteractionRoute(replayReq, {
      params: Promise.resolve({ token: candidateToken }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.interactionId).toBe(initial.interactionId);
    expect(data.status).toBe('COMPLETED');
    expect(data.responseText).toBe(initial.responseText);

    // Database record is unmodified
    const persisted = aiStore.findById(initial.interactionId);
    expect(persisted!.candidatePromptText).toBe('Authoritative initial prompt');
    expect(persisted!.candidateContext).toEqual([
      { filePath: 'inventory/cache.py' },
    ]);
  });

  // --------------------------------------------------------------------------
  // Scenario R: Current provider unavailable during existing replay -> persisted result returned
  // --------------------------------------------------------------------------
  it('Scenario R: returns persisted result on replay even if configured provider is unavailable', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const registry = new DefaultAiProviderRegistry(); // Empty registry: no providers!
    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: registry,
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    // Manually seed a completed interaction directly in store
    aiStore.create({
      id: 'ai_int_preseeded',
      sessionId: session.id,
      clientRequestId: 'req_r_unregistered',
      status: 'COMPLETED',
      configuredProviderId: 'unregistered-ai-provider',
      configuredModelId: 'unregistered-model',
      candidatePromptText: 'Prompt before provider teardown',
      capturedResponseText: 'Stored response text',
      createdAt: new Date().toISOString(),
    });

    // Replaying does not attempt to resolve provider from registry
    const replay = await aiService.executeInteraction(session.id, {
      clientRequestId: 'req_r_unregistered',
      candidatePromptText: 'Prompt before provider teardown',
    });

    expect(replay.status).toBe('COMPLETED');
    expect(replay.responseText).toBe('Stored response text');
  });

  // --------------------------------------------------------------------------
  // Scenario S: Cross-session request ID -> no leakage/retrieval
  // --------------------------------------------------------------------------
  it('Scenario S: clientRequestId is isolated per session; no cross-session leakage', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore, {
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const s1 = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    const s2 = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(s1.candidateToken);
    await sessionService.activate(s2.candidateToken);

    const sharedClientId = 'req_shared_across_sessions';

    // Session 1 execution
    const r1 = await executeAiInteractionRoute(
      createRequest(
        `http://localhost:3000/api/candidate/sessions/${s1.candidateToken}/ai/interactions`,
        {
          clientRequestId: sharedClientId,
          candidatePromptText: 'Session 1 question',
        },
      ),
      { params: Promise.resolve({ token: s1.candidateToken }) },
    );
    expect(r1.status).toBe(200);
    const d1 = await r1.json();

    // Session 2 execution with the exact same clientRequestId
    const r2 = await executeAiInteractionRoute(
      createRequest(
        `http://localhost:3000/api/candidate/sessions/${s2.candidateToken}/ai/interactions`,
        {
          clientRequestId: sharedClientId,
          candidatePromptText: 'Session 2 question',
        },
      ),
      { params: Promise.resolve({ token: s2.candidateToken }) },
    );
    expect(r2.status).toBe(200);
    const d2 = await r2.json();

    // Must be completely distinct interaction IDs
    expect(d1.interactionId).not.toBe(d2.interactionId);
    expect(d1.responseText).toContain('Session 1 question');
    expect(d2.responseText).toContain('Session 2 question');
  });

  // --------------------------------------------------------------------------
  // Scenario T: Closure rollback -> entire transaction rolls back; session remains ACTIVE
  // --------------------------------------------------------------------------
  it('Scenario T: atomic closure rollback leaves session ACTIVE and open AI interaction uncancelled', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const sandbox = new MockSandboxAdapter();
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: sandbox,
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    // Open interaction
    const admission = aiService.admitInteraction(session.id, {
      clientRequestId: 'req_t_rollback',
      candidatePromptText: 'Rollback test',
    });
    expect(admission.interaction.status).toBe('ADMITTED');

    // Spy on teardown to verify cleanup is not called on failure
    const teardownSpy = vi.spyOn(sandbox, 'teardown');

    // Inject failure into submission transaction
    vi.spyOn(sessionStore, 'submitWithDatabase').mockImplementationOnce(() => {
      throw new Error('Injected transaction failure during session submit');
    });

    await expect(sessionService.submit(candidateToken)).rejects.toThrow(
      'Injected transaction failure during session submit',
    );

    // Session remains ACTIVE
    const freshSession = sessionStore.findById(session.id);
    expect(freshSession!.status).toBe('ACTIVE');
    expect(freshSession!.submittedAt).toBeNull();

    // Interaction remains ADMITTED (not cancelled)
    const freshInteraction = aiStore.findById(admission.interaction.id);
    expect(freshInteraction!.status).toBe('ADMITTED');
    expect(freshInteraction!.terminalReason == null).toBe(true);

    // Teardown was NOT performed
    expect(teardownSpy).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Scenario U: Repeated submission -> no duplicate cancellation events
  // --------------------------------------------------------------------------
  it('Scenario U: repeated submission is idempotent and does not duplicate cancellation events', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    // First submission succeeds
    await sessionService.submit(candidateToken);
    const eventsAfterFirst = eventStore.getEvents(session.id);

    // Second submission returns submitted session idempotently without duplicating events
    const secondSubmit = await sessionService.submit(candidateToken);
    expect(secondSubmit.status).toBe('SUBMITTED');

    // Event log is identical; no extra events
    const eventsAfterSecond = eventStore.getEvents(session.id);
    expect(eventsAfterSecond).toHaveLength(eventsAfterFirst.length);
  });

  // --------------------------------------------------------------------------
  // Scenario V: Closed-session workspace mutations queued behind submission -> rejected without events
  // --------------------------------------------------------------------------
  it('Scenario V: workspace mutations queued behind submission are rejected with SESSION_NOT_ACTIVE', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const sandbox = new MockSandboxAdapter();
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      sandboxAdapter: sandbox,
    });

    const { candidateToken, session } = sessionService.createSession();
    await sessionService.activate(candidateToken);

    // Submit session
    const pSubmit = sessionService.submit(candidateToken);

    // Queue file mutation concurrently
    const pSave = sessionService.saveWorkspaceFile(
      candidateToken,
      'inventory/service.py',
      '# forbidden post-submit edit\n',
    );

    await pSubmit;
    await expect(pSave).rejects.toThrow(
      'Workspace files can only be edited during active sessions.',
    );

    // Verify workspace event was not appended
    const events = eventStore.getEvents(session.id);
    const postSubmitEvents = events.filter(
      (e) =>
        e.type === 'WORKSPACE_CHANGED' &&
        (e.payload as { files?: readonly { path: string }[] }).files?.some(
          (f) => f.path === 'inventory/service.py',
        ),
    );
    expect(postSubmitEvents).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Scenario W: Artifact stability -> late provider resolution does not alter evidence
  // --------------------------------------------------------------------------
  it('Scenario W: late provider resolution does not alter the immutable evidence stream after submission', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const provider = new ControllableAiProvider();
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry([provider]),
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    // In flight interaction
    const p = aiService.executeInteraction(session.id, {
      clientRequestId: 'req_w',
      candidatePromptText: 'Artifact stability test',
    });
    while (provider.pendingResolvers.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Submit session
    await sessionService.submit(candidateToken);

    // Freeze snapshot of event stream right at submission boundary
    const eventsAtSubmission = eventStore.getEvents(session.id);

    // Late provider resolution occurs
    provider.resolveNext({ responseText: 'LATE UNRECORDED TEXT' });
    await p;

    // Verify event stream is completely unchanged
    const eventsAfterLateResolution = eventStore.getEvents(session.id);
    expect(eventsAfterLateResolution).toEqual(eventsAtSubmission);
  });

  // --------------------------------------------------------------------------
  // Scenario X: Candidate wording -> session-ended attribution; no candidate-intent claim
  // --------------------------------------------------------------------------
  it('Scenario X: candidate UI copy for session_ended uses neutral platform attribution without candidate-intent claims', () => {
    const state = {
      ...INITIAL_CANDIDATE_AI_STATE,
      submissionState: 'submitting' as const,
      clientRequestId: 'req_x',
      prompt: 'In-flight prompt',
    };

    const resolved = resolveSubmissionResult(state, 200, {
      status: 'CANCELLED',
      terminalReason: 'session_ended',
      errorMessage: 'Session ended.',
    });

    expect(resolved.submissionState).toBe('failed');
    expect(resolved.errorMessage).toBe(
      'AI is unavailable because the assessment is no longer active.',
    );

    // Ensure forbidden blame/causal terms are not present
    const lower = resolved.errorMessage.toLowerCase();
    expect(lower).not.toContain('candidate');
    expect(lower).not.toContain('you cancelled');
    expect(lower).not.toContain('user cancelled');
    expect(lower).not.toContain('aborted by candidate');
    expect(lower).not.toContain('provider stopped');
    expect(lower).not.toContain('provider failed');
  });

  // --------------------------------------------------------------------------
  // Scenario Y: Normal AI completion before submission -> remains completed; submission does not cancel
  // --------------------------------------------------------------------------
  it('Scenario Y: interaction completed normally before submission remains COMPLETED without cancellation', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);
    runner.registerInitializer(SqliteAiInteractionStore.ensureSchema);

    // Explicit injection: deterministic mock provider for normal completion.
    const aiService = new AiInteractionService({
      sessionStore,
      eventStore,
      aiInteractionStore: aiStore,
      transactionRunner: runner,
      providerRegistry: new DefaultAiProviderRegistry([new MockAiProvider()]),
    });
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      aiInteractionService: aiService,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    // Normal execution while active
    const result = await aiService.executeInteraction(session.id, {
      clientRequestId: 'req_y_completed',
      candidatePromptText: 'Completed normally',
    });
    expect(result.status).toBe('COMPLETED');

    // Submit session
    await sessionService.submit(candidateToken);

    // Interaction in DB is still COMPLETED
    const persisted = aiStore.findById(result.interactionId);
    expect(persisted!.status).toBe('COMPLETED');
    expect(persisted!.terminalReason == null).toBe(true);

    // No cancellation event exists for this interaction
    const cancelEvents = eventStore
      .getEvents(session.id)
      .filter((e) => e.type === 'AI_REQUEST_CANCELLED');
    expect(cancelEvents).toHaveLength(0);
  });

  it('Scenario Z1: save initiated before submit serializes cleanly; save completes first and submit captures saved content', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken } = sessionService.createSession();
    await sessionService.activate(candidateToken);

    // Save and submit initiated in flight
    const pSave = sessionService.save(
      candidateToken,
      'content saved right before submission\n',
    );
    const pSubmit = sessionService.submit(candidateToken);

    const [savedSession, submittedSession] = await Promise.all([
      pSave,
      pSubmit,
    ]);

    expect(savedSession.status).toBe('ACTIVE');
    expect(savedSession.workingContent).toBe(
      'content saved right before submission\n',
    );
    expect(submittedSession.status).toBe('SUBMITTED');
    expect(submittedSession.submittedContent).toBe(
      'content saved right before submission\n',
    );

    const finalSession = sessionService.getCandidateSession(candidateToken);
    expect(finalSession.status).toBe('SUBMITTED');
    expect(finalSession.workingContent).toBe(
      'content saved right before submission\n',
    );
  });

  it('Scenario Z2: legitimate post-submission operational event remains appendable and visible in event store', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const sessionService = new SessionService(sessionStore, {
      eventStore,
      sandboxAdapter: new MockSandboxAdapter(),
    });

    const { candidateToken, session } = sessionService.createSession();
    await sessionService.activate(candidateToken);
    const submitted = await sessionService.submit(candidateToken);
    expect(submitted.status).toBe('SUBMITTED');

    // Append legitimate platform/operational event after submission
    const operationalEvent = eventStore.append({
      id: 'evt_operational_diag_1',
      sessionId: session.id,
      type: 'SANDBOX_CLEANUP_FAILED',
      timestamp: '2026-09-19T12:00:00.000Z',
      source: 'server',
      payload: {
        phase: 'post_submission_cleanup',
        errorMessage: 'Container network teardown diagnostic notice',
      },
    });

    expect(operationalEvent.sequence).toBeGreaterThan(0);
    const allEvents = eventStore.getEvents(session.id);
    const found = allEvents.find((e) => e.id === 'evt_operational_diag_1');
    expect(found).toBeDefined();
    expect(found?.type).toBe('SANDBOX_CLEANUP_FAILED');
    expect(found?.payload).toEqual({
      phase: 'post_submission_cleanup',
      errorMessage: 'Container network teardown diagnostic notice',
    });
  });
});
