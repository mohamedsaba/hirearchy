import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as executeAiInteraction } from '../../apps/web/app/api/candidate/sessions/[token]/ai/interactions/route';
import { defaultAiCapabilitySnapshot } from '../../apps/web/src/ai/ai-interaction';
import {
  AiInteractionService,
  getAiInteractionService,
} from '../../apps/web/src/ai/ai-interaction-service';
import { DefaultAiProviderRegistry } from '../../apps/web/src/ai/ai-provider';
import { MockAiProvider } from '../../apps/web/src/ai/mock-ai-provider';
import { SqliteAiInteractionStore } from '../../apps/web/src/ai/sqlite-ai-interaction-store';
import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { toCandidateSessionView } from '../../apps/web/src/sessions/candidate-session-view';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

/**
 * F2 regression coverage: when no real AI provider is configured, the system
 * must never answer the candidate with synthetic mock output posing as a
 * real AI response. This file deliberately uses the REAL service factory
 * (no module mocks) so it exercises production wiring:
 *
 *  1. Sessions issued without a configured provider are honestly AI-disabled
 *     end to end (issuance → candidate view → admission rejection).
 *  2. A legacy session that still claims a 'mock-ai' provider fails the
 *     dispatch honestly (PROVIDER_NOT_CONFIGURED) and records a terminal
 *     FAILED interaction — never a COMPLETED synthetic answer.
 *  3. Deterministic mock output remains available through EXPLICIT provider
 *     injection only (intentional test mocks preserved).
 */
describe('Candidate AI provider honesty (no implicit mock fallback)', () => {
  let directory: string;
  let databasePath: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(
      path.join(tmpdir(), 'hirearchy-ai-provider-honesty-'),
    );
    databasePath = path.join(directory, 'sessions.sqlite');
    originalDbPath = process.env.HIREARCHY_DB_PATH;
    process.env.HIREARCHY_DB_PATH = databasePath;
  });

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.HIREARCHY_DB_PATH;
    else process.env.HIREARCHY_DB_PATH = originalDbPath;
    rmSync(directory, { recursive: true, force: true });
  });

  const aiRequest = (token: string, clientRequestId: string) =>
    new Request(
      `http://localhost/api/candidate/sessions/${token}/ai/interactions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId,
          candidatePromptText: 'How should I investigate this bug?',
        }),
      },
    );

  const routeContext = (token: string) => ({
    params: Promise.resolve({ token }),
  });

  it('rejects AI interaction with AI_NOT_ENABLED when the session was issued without a configured provider', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore);

    // Sessions created without an explicit capability default to the honest
    // disabled snapshot — the same shape issuance produces when no runtime
    // AI provider is configured (see getIssuableScenario).
    const { candidateToken, session } = sessionService.createSession();
    await sessionService.activate(candidateToken);

    expect(session.aiCapabilitySnapshot?.enabled).toBe(false);
    expect(session.aiCapabilitySnapshot?.configuredProviderId).toBe('none');
    expect(session.aiCapabilitySnapshot?.configuredModelId).toBe('none');
    expect(toCandidateSessionView(session).aiCapability).toEqual({
      enabled: false,
      includesWorkspaceContext: false,
    });

    const response = await executeAiInteraction(
      aiRequest(candidateToken, 'honesty-disabled-1'),
      routeContext(candidateToken),
    );

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error?.code).toBe('AI_NOT_ENABLED');

    // No AI lifecycle evidence is recorded for a rejected admission.
    const aiEvents = new SqliteEventStore(databasePath)
      .getEvents(session.id)
      .filter((event) => event.type.startsWith('AI_'));
    expect(aiEvents).toHaveLength(0);
  });

  it('fails honestly with PROVIDER_NOT_CONFIGURED for a legacy session claiming an unregistered provider, never a synthetic COMPLETED answer', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore);

    // Legacy shape: the snapshot still claims the old 'mock-ai' provider
    // (e.g. a session issued before this gate). No provider is registered,
    // so dispatch must fail terminally instead of answering with mock text.
    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    const response = await executeAiInteraction(
      aiRequest(candidateToken, 'honesty-legacy-1'),
      routeContext(candidateToken),
    );

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error?.code).toBe('PROVIDER_NOT_CONFIGURED');

    // The interaction is recorded as terminal FAILED, not COMPLETED.
    const aiStore = new SqliteAiInteractionStore(databasePath);
    const interactions = aiStore.findBySessionId(session.id);
    expect(interactions).toHaveLength(1);
    expect(interactions[0].status).toBe('FAILED');
    expect(interactions[0].terminalReason).toBe('provider_not_configured');
    expect(interactions[0].capturedResponseText).toBeNull();

    // Evidence log contains the failure, never a synthetic completion.
    const eventTypes = new SqliteEventStore(databasePath)
      .getEvents(session.id)
      .map((event) => event.type);
    expect(eventTypes).not.toContain('AI_RESPONSE_COMPLETED');

    // Idempotent retry replays the persisted terminal FAILED interaction
    // (HTTP 200 envelope carrying the stored failure) without creating a
    // second row or ever producing synthetic output.
    const retry = await executeAiInteraction(
      aiRequest(candidateToken, 'honesty-legacy-1'),
      routeContext(candidateToken),
    );
    expect(retry.status).toBe(200);
    const retryData = await retry.json();
    expect(retryData.interactionId).toBe(interactions[0].id);
    expect(retryData.status).toBe('FAILED');
    expect(retryData.terminalReason).toBe('provider_not_configured');
    expect(retryData.responseText ?? null).toBeNull();
    expect(aiStore.findBySessionId(session.id)).toHaveLength(1);
  });

  it('returns deterministic mock output when a mock provider is EXPLICITLY injected through the service factory', async () => {
    // Explicit injection — the only sanctioned way to obtain deterministic
    // mock AI output. This preserves intentional test mocks without any
    // implicit production fallback.
    const service: AiInteractionService = getAiInteractionService(
      databasePath,
      {
        providerRegistry: new DefaultAiProviderRegistry([new MockAiProvider()]),
      },
    );

    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore);
    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    await sessionService.activate(candidateToken);

    const result = await service.executeInteraction(session.id, {
      clientRequestId: 'honesty-injected-1',
      candidatePromptText: 'Explain the cache invalidation contract.',
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.responseText).toContain(
      'Mock response for: Explain the cache invalidation contract.',
    );
    expect(result.configuredModelId).toBe('mock-chat-v1');
  });
});
