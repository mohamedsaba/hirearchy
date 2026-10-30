import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '../../apps/web/app/api/candidate/sessions/[token]/ai/interactions/route';
import {
  defaultAiCapabilitySnapshot,
  disabledAiCapabilitySnapshot,
} from '../../apps/web/src/ai/ai-interaction';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

// Explicit test injection: production code no longer registers a mock AI
// provider by default (missing provider must surface as an honest failure).
// These tests exercise the route's success path, so the deterministic
// MockAiProvider is injected here on purpose — never implicitly.
vi.mock(
  '../../apps/web/src/ai/ai-interaction-service',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../apps/web/src/ai/ai-interaction-service')
      >();
    const { MockAiProvider } =
      await import('../../apps/web/src/ai/mock-ai-provider');
    const { DefaultAiProviderRegistry } =
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
            options?.providerRegistry ??
            new DefaultAiProviderRegistry([new MockAiProvider()]),
        }),
    };
  },
);

describe('Candidate AI API endpoint POST /api/candidate/sessions/[token]/ai/interactions', () => {
  let directory: string;
  let databasePath: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-candidate-ai-api-'));
    databasePath = path.join(directory, 'api-test.sqlite');
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

  const createRequest = (body: Record<string, unknown>) =>
    new Request(
      'http://localhost:3000/api/candidate/sessions/token/ai/interactions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

  it('rejects invalid candidate token with 404', async () => {
    const request = createRequest({
      clientRequestId: 'req_1',
      candidatePromptText: 'Hello',
    });

    const response = await POST(request, {
      params: Promise.resolve({ token: 'non-existent-token' }),
    });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error?.code).toBe('SESSION_NOT_FOUND');
  });

  it('rejects inactive (CREATED) session with 409', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore);
    const { candidateToken } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });

    const request = createRequest({
      clientRequestId: 'req_inactive',
      candidatePromptText: 'Should fail before activation',
    });

    const response = await POST(request, {
      params: Promise.resolve({ token: candidateToken }),
    });

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error?.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('rejects AI-disabled session with 409', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore);
    const { candidateToken, session } = sessionService.createSession({
      aiCapability: disabledAiCapabilitySnapshot,
    });
    sessionStore.activate(session.candidateTokenHash, new Date().toISOString());

    const request = createRequest({
      clientRequestId: 'req_disabled',
      candidatePromptText: 'Should fail because AI is disabled',
    });

    const response = await POST(request, {
      params: Promise.resolve({ token: candidateToken }),
    });

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error?.code).toBe('AI_NOT_ENABLED');
  });

  it('rejects missing clientRequestId with 400', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore);
    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    sessionStore.activate(session.candidateTokenHash, new Date().toISOString());

    const request = createRequest({
      candidatePromptText: 'Valid prompt without clientRequestId',
    });

    const response = await POST(request, {
      params: Promise.resolve({ token: candidateToken }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects empty prompt with 400', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore);
    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    sessionStore.activate(session.candidateTokenHash, new Date().toISOString());

    const request = createRequest({
      clientRequestId: 'req_empty_prompt',
      candidatePromptText: '   ',
    });

    const response = await POST(request, {
      params: Promise.resolve({ token: candidateToken }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects path traversal in context attachments with 400', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore);
    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    sessionStore.activate(session.candidateTokenHash, new Date().toISOString());

    const request = createRequest({
      clientRequestId: 'req_traversal_api',
      candidatePromptText: 'Path traversal attempt',
      candidateContext: [{ filePath: '../../etc/shadow' }],
    });

    const response = await POST(request, {
      params: Promise.resolve({ token: candidateToken }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error?.code).toBe('INVALID_INPUT');
  });

  it('executes successful synchronous request and returns normalized completion', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore);
    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });
    sessionStore.activate(session.candidateTokenHash, new Date().toISOString());

    const request = createRequest({
      clientRequestId: 'req_api_success',
      candidatePromptText: 'How should I fix the cache staleness bug?',
      candidateContext: [
        { filePath: 'inventory/cache.py', startLine: 1, endLine: 15 },
      ],
      // Injection attempt: these must be ignored by the server
      provider: 'evil-override-provider',
      model: 'evil-override-model',
    });

    const response = await POST(request, {
      params: Promise.resolve({ token: candidateToken }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('COMPLETED');
    expect(data.responseText).toContain(
      'Mock response for: How should I fix the cache staleness bug?',
    );
    expect(data.configuredModelId).toBe('mock-chat-v1'); // Not evil-override-model
    expect(data.interactionId).toMatch(/^ai_int_/);

    // Verify idempotency on identical retry
    const retryRequest = createRequest({
      clientRequestId: 'req_api_success',
      candidatePromptText: 'How should I fix the cache staleness bug?',
    });

    const retryResponse = await POST(retryRequest, {
      params: Promise.resolve({ token: candidateToken }),
    });

    expect(retryResponse.status).toBe(200);
    const retryData = await retryResponse.json();
    expect(retryData.interactionId).toBe(data.interactionId);
    expect(retryData.status).toBe('COMPLETED');
    expect(retryData.responseText).toBe(data.responseText);
  });
});
