import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '../../apps/web/app/api/sessions/route';
import { POST as executeAiInteraction } from '../../apps/web/app/api/candidate/sessions/[token]/ai/interactions/route';
import { POST as activateCandidateSession } from '../../apps/web/app/api/candidate/sessions/[token]/activate/route';
import {
  OPENROUTER_MODEL_ID,
  OPENROUTER_PROVIDER_ID,
} from '../../apps/web/src/ai/server-ai-configuration';
import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { scenario001AiCapability } from '../../apps/web/src/scenarios/scenario-001';
import { getIssuableScenario } from '../../apps/web/src/scenarios/issuable-scenarios';
import { DockerSandboxAdapter } from '../../apps/web/src/sandbox/docker-sandbox-adapter';
import { MockSandboxAdapter } from '../../apps/web/src/sandbox/mock-sandbox-adapter';
import { toCandidateSessionView } from '../../apps/web/src/sessions/candidate-session-view';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

// Controllable runtime-provider configuration: default is "no provider
// configured" (the honest-unavailability path this gate enforces). The
// configured-provider test flips this for one case and resets it.
const configuredRuntimeProvider = vi.hoisted(() => ({
  current: null as null | {
    providerId: string;
    modelId: string;
    configurationVersion: string;
  },
}));

vi.mock(
  '../../apps/web/src/ai/server-ai-configuration',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../apps/web/src/ai/server-ai-configuration')
      >();
    return {
      ...actual,
      getConfiguredRuntimeAiProvider: () => configuredRuntimeProvider.current,
    };
  },
);

describe('R2 — scenario issuance and access hardening', () => {
  let directory: string;
  let databasePath: string;
  let originalDbPath: string | undefined;
  let originalKey: string | undefined;
  const configuredEvaluatorKey = 'test-scenario-issuance-key';

  beforeEach(() => {
    directory = mkdtempSync(
      path.join(tmpdir(), 'hirearchy-scenario-issuance-'),
    );
    databasePath = path.join(directory, 'sessions.sqlite');
    originalDbPath = process.env.HIREARCHY_DB_PATH;
    originalKey = process.env.HIREARCHY_EVALUATOR_KEY;
    process.env.HIREARCHY_DB_PATH = databasePath;
    process.env.HIREARCHY_EVALUATOR_KEY = configuredEvaluatorKey;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDbPath === undefined) delete process.env.HIREARCHY_DB_PATH;
    else process.env.HIREARCHY_DB_PATH = originalDbPath;
    if (originalKey === undefined) delete process.env.HIREARCHY_EVALUATOR_KEY;
    else process.env.HIREARCHY_EVALUATOR_KEY = originalKey;
    rmSync(directory, { recursive: true, force: true });
  });

  const request = (body: unknown, customHeaders: Record<string, string> = {}) =>
    new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${configuredEvaluatorKey}`,
        ...customHeaders,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('rejects unauthorized session creation requests without evaluator authorization', async () => {
    const createAndVerify = vi.spyOn(
      DockerSandboxAdapter.prototype,
      'createAndVerify',
    );

    const unauthorized = new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'scenario-001-cache-staleness' }),
    });

    const response = await POST(unauthorized);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'EVALUATOR_ACCESS_REQUIRED',
        message: 'Evaluator access is required to create a session.',
      },
    });
    expect(existsSync(databasePath)).toBe(false);
    expect(createAndVerify).not.toHaveBeenCalled();
  });

  it('rejects unauthorized session creation requests with an invalid credential', async () => {
    const createAndVerify = vi.spyOn(
      DockerSandboxAdapter.prototype,
      'createAndVerify',
    );

    const response = await POST(
      request(
        { scenarioId: 'scenario-001-cache-staleness' },
        { Authorization: 'Bearer wrong-key' },
      ),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'EVALUATOR_ACCESS_REQUIRED' },
    });
    expect(existsSync(databasePath)).toBe(false);
    expect(createAndVerify).not.toHaveBeenCalled();
  });

  it('issues only the registered product scenario, with AI honestly disabled when no runtime provider is configured', async () => {
    const response = await POST(
      request({
        scenarioId: 'scenario-001-cache-staleness',
      }),
    );

    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.scenarioId).toBe('scenario-001-cache-staleness');

    const store = new SqliteSessionStore(databasePath);
    const stored = store.findById(result.sessionId);
    expect(stored).toMatchObject({
      scenario: {
        id: 'scenario-001-cache-staleness',
        type: 'multi_file',
        version: '1.0.0',
        durationSeconds: 3600,
      },
      scenarioType: 'multi_file',
      // Honest issuance: no runtime AI provider is configured, so the stored
      // snapshot must declare AI disabled — never a synthetic 'mock-ai' claim.
      aiCapabilitySnapshot: {
        ...scenario001AiCapability,
        enabled: false,
        configuredProviderId: 'none',
        configuredModelId: 'none',
      },
    });
    expect(toCandidateSessionView(stored!).aiCapability).toEqual({
      enabled: false,
      includesWorkspaceContext: false,
    });

    // Legitimate candidate activation does NOT require evaluator auth and succeeds
    const sandbox = new MockSandboxAdapter();
    const createAndVerify = vi.spyOn(sandbox, 'createAndVerify');
    await new SessionService(store, { sandboxAdapter: sandbox }).activate(
      result.candidatePath.split('/').at(-1)!,
    );
    expect(createAndVerify).toHaveBeenCalledWith(result.sessionId, {
      imageName: 'hirearchy-scenario-001:latest',
      scenarioType: 'multi_file',
    });

    // AI interaction on an honestly-disabled session fails admission with
    // AI_NOT_ENABLED instead of returning synthetic mock output.
    const aiResponse = await executeAiInteraction(
      new Request(
        `http://localhost/api/candidate/sessions/${result.candidatePath.split('/').at(-1)!}/ai/interactions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientRequestId: 'scenario-001-authoritative-ai',
            candidatePromptText: 'How should I investigate cache staleness?',
          }),
        },
      ),
      {
        params: Promise.resolve({
          token: result.candidatePath.split('/').at(-1)!,
        }),
      },
    );
    expect(aiResponse.status).toBe(409);
    expect((await aiResponse.json()).error?.code).toBe('AI_NOT_ENABLED');
    // No AI lifecycle evidence is recorded for a rejected admission.
    const aiEvents = new SqliteEventStore(databasePath)
      .getEvents(result.sessionId)
      .filter((event) => event.type.startsWith('AI_'));
    expect(aiEvents).toHaveLength(0);
  });

  it('allows candidate activation via HTTP without evaluator authorization', async () => {
    const response = await POST(
      request({ scenarioId: 'scenario-001-cache-staleness' }),
    );
    expect(response.status).toBe(201);
    const { candidatePath } = await response.json();
    const token = candidatePath.split('/').at(-1)!;

    // Candidate calls activate route directly without any evaluator cookies or auth header
    const activateReq = new Request(
      `http://localhost/api/candidate/sessions/${token}/activate`,
      { method: 'POST' },
    );
    const activateRes = await activateCandidateSession(activateReq, {
      params: Promise.resolve({ token }),
    });

    expect(activateRes.status).toBe(200);
    const candidateView = await activateRes.json();
    expect(candidateView.status).toBe('ACTIVE');
  });

  it('disables Scenario 001 AI capability in issuable configuration when no runtime provider is configured', () => {
    expect(getIssuableScenario('scenario-001-cache-staleness')).toEqual({
      scenario: expect.objectContaining({ id: 'scenario-001-cache-staleness' }),
      aiCapability: {
        ...scenario001AiCapability,
        enabled: false,
        configuredProviderId: 'none',
        configuredModelId: 'none',
      },
    });
  });

  it('carries the configured runtime provider into Scenario 001 AI capability when one is configured', () => {
    configuredRuntimeProvider.current = {
      providerId: OPENROUTER_PROVIDER_ID,
      modelId: OPENROUTER_MODEL_ID,
      configurationVersion: 'test-configuration-version',
    };
    try {
      expect(getIssuableScenario('scenario-001-cache-staleness')).toEqual({
        scenario: expect.objectContaining({
          id: 'scenario-001-cache-staleness',
        }),
        aiCapability: {
          ...scenario001AiCapability,
          configuredProviderId: OPENROUTER_PROVIDER_ID,
          configuredModelId: OPENROUTER_MODEL_ID,
          configurationVersion: 'test-configuration-version',
        },
      });
    } finally {
      configuredRuntimeProvider.current = null;
    }
  });

  it('copies the public capability configuration into an immutable session snapshot', () => {
    const sourceCapability = { ...scenario001AiCapability };
    const store = new SqliteSessionStore(databasePath);
    const { session } = new SessionService(store).createSession({
      scenario: getIssuableScenario('scenario-001-cache-staleness')!.scenario,
      aiCapability: sourceCapability,
    });

    sourceCapability.enabled = false;

    expect(session.aiCapabilitySnapshot).toEqual(scenario001AiCapability);
    expect(store.findById(session.id)?.aiCapabilitySnapshot).toEqual(
      scenario001AiCapability,
    );
  });

  it('rejects malformed JSON before creating a session when authorized', async () => {
    const response = await POST(request('{'));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_SESSION_REQUEST');
    expect(existsSync(databasePath)).toBe(false);
  });

  it.each([
    [{}, 'MISSING_SCENARIO_ID', 400],
    [{ scenarioId: '' }, 'MISSING_SCENARIO_ID', 400],
    [{ scenarioId: '  ' }, 'INVALID_SCENARIO_ID', 400],
    [
      { scenarioId: ['scenario-001-cache-staleness'] },
      'INVALID_SCENARIO_ID',
      400,
    ],
    [{ scenarioId: 'scenario-001' }, 'UNSUPPORTED_SCENARIO', 404],
    [{ scenarioId: 'slice-1-greeting-format' }, 'UNSUPPORTED_SCENARIO', 404],
    [{ scenarioId: 'not-a-scenario' }, 'UNSUPPORTED_SCENARIO', 404],
  ])('rejects non-issuable input %#', async (body, code, status) => {
    const createAndVerify = vi.spyOn(
      DockerSandboxAdapter.prototype,
      'createAndVerify',
    );
    const response = await POST(request(body));

    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
    expect(existsSync(databasePath)).toBe(false);
    expect(createAndVerify).not.toHaveBeenCalled();
  });
});
