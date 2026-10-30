import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as executeAiInteraction } from '../../apps/web/app/api/candidate/sessions/[token]/ai/interactions/route';
import { POST as activateSession } from '../../apps/web/app/api/candidate/sessions/[token]/activate/route';

import {
  defaultAiCapabilitySnapshot,
  disabledAiCapabilitySnapshot,
} from '../../apps/web/src/ai/ai-interaction';
import { DockerSandboxAdapter } from '../../apps/web/src/sandbox/docker-sandbox-adapter';
import { SandboxError } from '../../apps/web/src/sandbox/sandbox';
import { toCandidateSessionView } from '../../apps/web/src/sessions/candidate-session-view';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

// Explicit test injection: production code no longer registers a mock AI
// provider by default. The lifecycle test exercises the route's success
// path, so the deterministic MockAiProvider is injected here on purpose.
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

describe('Candidate AI Workspace End-to-End Integration', () => {
  let directory: string;
  let databasePath: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-candidate-ai-ws-'));
    databasePath = path.join(directory, 'ws-test.sqlite');
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

  it('verifies complete lifecycle: capability projection, activation, interaction, and session submission', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore);

    // 1. Session created with AI capability enabled
    const { candidateToken, session } = sessionService.createSession({
      aiCapability: defaultAiCapabilitySnapshot,
    });

    const initialView = toCandidateSessionView(session);
    expect(initialView.status).toBe('CREATED');
    expect(initialView.aiCapability).toEqual({
      enabled: true,
      includesWorkspaceContext: false,
    });

    // 2. Candidate activates session
    const activateReq = createRequest(
      `http://localhost:3000/api/candidate/sessions/${candidateToken}/activate`,
    );
    const activateRes = await activateSession(activateReq, {
      params: Promise.resolve({ token: candidateToken }),
    });
    expect(activateRes.status).toBe(200);
    const activeSessionData = await activateRes.json();
    expect(activeSessionData.status).toBe('ACTIVE');
    expect(activeSessionData.aiCapability).toEqual({
      enabled: true,
      includesWorkspaceContext: false,
    });

    // 3. Candidate dispatches AI interaction with context reference
    const aiReq = createRequest(
      `http://localhost:3000/api/candidate/sessions/${candidateToken}/ai/interactions`,
      {
        clientRequestId: 'client_req_ws_1',
        candidatePromptText: 'Explain the cache invalidation contract.',
        candidateContext: [{ filePath: 'inventory/cache.py' }],
      },
    );
    const aiRes = await executeAiInteraction(aiReq, {
      params: Promise.resolve({ token: candidateToken }),
    });

    expect(aiRes.status).toBe(200);
    const aiData = await aiRes.json();
    expect(aiData.status).toBe('COMPLETED');
    expect(aiData.responseText).toContain(
      'Mock response for: Explain the cache invalidation contract.',
    );
    expect(aiData.configuredModelId).toBe('mock-chat-v1');

    // 4. Candidate submits the assessment
    const submittedSession = await sessionService.submit(candidateToken);
    expect(submittedSession.status).toBe('SUBMITTED');
    const submittedView = toCandidateSessionView(submittedSession);
    expect(submittedView.status).toBe('SUBMITTED');
    expect(submittedView.aiCapability).toEqual({
      enabled: true,
      includesWorkspaceContext: false,
    });

    // 5. Subsequent AI interactions on submitted session are rejected with 409
    const postSubmitAiReq = createRequest(
      `http://localhost:3000/api/candidate/sessions/${candidateToken}/ai/interactions`,
      {
        clientRequestId: 'client_req_ws_2',
        candidatePromptText: 'Can I ask after submission?',
      },
    );
    const postSubmitAiRes = await executeAiInteraction(postSubmitAiReq, {
      params: Promise.resolve({ token: candidateToken }),
    });
    expect(postSubmitAiRes.status).toBe(409);
    const postSubmitAiData = await postSubmitAiRes.json();
    expect(postSubmitAiData.error?.code).toBe('SESSION_NOT_ACTIVE');
  });

  it('projects disabled capability accurately through session service and route', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore);

    const { candidateToken } = sessionService.createSession({
      aiCapability: disabledAiCapabilitySnapshot,
    });

    const activateReq = createRequest(
      `http://localhost:3000/api/candidate/sessions/${candidateToken}/activate`,
    );
    const activateRes = await activateSession(activateReq, {
      params: Promise.resolve({ token: candidateToken }),
    });
    expect(activateRes.status).toBe(200);
    const activeData = await activateRes.json();
    expect(activeData.aiCapability).toEqual({
      enabled: false,
      includesWorkspaceContext: false,
    });

    // Attempting interaction fails with 409 AI_NOT_ENABLED
    const aiReq = createRequest(
      `http://localhost:3000/api/candidate/sessions/${candidateToken}/ai/interactions`,
      {
        clientRequestId: 'client_req_disabled',
        candidatePromptText: 'Attempting with disabled AI',
      },
    );
    const aiRes = await executeAiInteraction(aiReq, {
      params: Promise.resolve({ token: candidateToken }),
    });
    expect(aiRes.status).toBe(409);
    const aiData = await aiRes.json();
    expect(aiData.error?.code).toBe('AI_NOT_ENABLED');
  });

  it('returns HTTP 503 and leaves session in CREATED state when sandbox creation fails with SandboxError', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore);
    const { candidateToken } = sessionService.createSession();

    const createSpy = vi
      .spyOn(DockerSandboxAdapter.prototype, 'createAndVerify')
      .mockRejectedValueOnce(
        new SandboxError(
          'SANDBOX_CREATION_FAILED',
          'Simulated platform container daemon failure',
        ),
      );

    try {
      const activateReq = createRequest(
        `http://localhost:3000/api/candidate/sessions/${candidateToken}/activate`,
      );
      const activateRes = await activateSession(activateReq, {
        params: Promise.resolve({ token: candidateToken }),
      });

      expect(activateRes.status).toBe(503);
      const data = await activateRes.json();
      expect(data).toEqual({
        error: {
          code: 'SANDBOX_CREATION_FAILED',
          message: 'Simulated platform container daemon failure',
        },
      });

      // Session must remain in CREATED state and activatedAt must remain null
      const sessionAfterFailure =
        sessionService.getCandidateSession(candidateToken);
      expect(sessionAfterFailure.status).toBe('CREATED');
      expect(sessionAfterFailure.activatedAt).toBeNull();
    } finally {
      createSpy.mockRestore();
    }
  });

  it('returns HTTP 500 when unexpected internal failure occurs during activation', async () => {
    const sessionStore = new SqliteSessionStore(databasePath);
    const sessionService = new SessionService(sessionStore);
    const { candidateToken } = sessionService.createSession();

    const unexpectedSpy = vi
      .spyOn(DockerSandboxAdapter.prototype, 'createAndVerify')
      .mockRejectedValueOnce(new Error('Unexpected disk fault'));

    try {
      const activateReq = createRequest(
        `http://localhost:3000/api/candidate/sessions/${candidateToken}/activate`,
      );
      const activateRes = await activateSession(activateReq, {
        params: Promise.resolve({ token: candidateToken }),
      });

      expect(activateRes.status).toBe(500);
      const data = await activateRes.json();
      expect(data).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The request could not be completed.',
        },
      });
    } finally {
      unexpectedSpy.mockRestore();
    }
  });
});
