import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MockSandboxAdapter } from '../../apps/web/src/sandbox/mock-sandbox-adapter';
import { getIssuableScenario } from '../../apps/web/src/scenarios/issuable-scenarios';
import { scenario002 } from '../../apps/web/src/scenarios/scenario-002-booking-notification-retry';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

describe('scenario 002 issuance snapshot', () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-scenario-002-'));
    databasePath = path.join(directory, 'sessions.sqlite');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('persists the authored runtime identity through reload and activation', async () => {
    const issuance = getIssuableScenario(scenario002.id);
    expect(issuance?.scenario).toMatchObject({
      id: 'scenario-002-booking-notification-retry',
      version: '1.0.0',
      title: 'The second confirmation',
      imageName: 'hirearchy-scenario-002:v1.0.0',
      type: 'multi_file',
      evaluationContext: { version: '1.0.0' },
    });

    const store = new SqliteSessionStore(databasePath);
    const service = new SessionService(store);
    const { candidateToken, session } = service.createSession({
      scenario: issuance!.scenario,
      aiCapability: issuance!.aiCapability,
    });
    expect(store.findById(session.id)?.scenario.imageName).toBe(
      'hirearchy-scenario-002:v1.0.0',
    );

    const sandbox = new MockSandboxAdapter();
    const createAndVerify = vi.spyOn(sandbox, 'createAndVerify');
    await new SessionService(store, { sandboxAdapter: sandbox }).activate(
      candidateToken,
    );
    expect(createAndVerify).toHaveBeenCalledWith(session.id, {
      imageName: 'hirearchy-scenario-002:v1.0.0',
      scenarioType: 'multi_file',
    });
  });

  it('keeps scenario 001 issuance on its published runtime', () => {
    const store = new SqliteSessionStore(databasePath);
    const original = new SessionService(store).createSession({
      scenarioId: 'scenario-001',
    });
    expect(store.findById(original.session.id)?.scenario.imageName).toBe(
      'hirearchy-scenario-001:latest',
    );
    expect(store.findById(original.session.id)?.scenario.id).toBe(
      'scenario-001-cache-staleness',
    );
  });
});
