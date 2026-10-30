import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MockSandboxAdapter } from '../../apps/web/src/sandbox/mock-sandbox-adapter';
import { sliceOneScenario } from '../../apps/web/src/scenarios/slice-one-scenario';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

describe('terminal capability snapshot', () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(
      path.join(tmpdir(), 'hirearchy-terminal-capability-'),
    );
    databasePath = path.join(directory, 'sessions.sqlite');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('rejects disabled terminal access in the session service before sandbox execution', async () => {
    const store = new SqliteSessionStore(databasePath);
    const sandbox = new MockSandboxAdapter();
    const execute = vi.spyOn(sandbox, 'exec');
    const service = new SessionService(store, { sandboxAdapter: sandbox });
    const issued = service.createSession({
      scenario: sliceOneScenario,
      terminalEnabled: false,
    });
    await service.activate(issued.candidateToken);

    await expect(
      service.executeCommand(issued.candidateToken, 'pwd'),
    ).rejects.toMatchObject({
      code: 'TERMINAL_NOT_ENABLED',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(store.findById(issued.session.id)?.terminalEnabled).toBe(false);
  });

  it('backfills prior sessions as terminal-enabled when adding the capability column', () => {
    const store = new SqliteSessionStore(databasePath);
    const issued = new SessionService(store).createSession({
      scenario: sliceOneScenario,
    });
    const database = new Database(databasePath);
    database.exec(
      'ALTER TABLE assessment_sessions DROP COLUMN terminal_enabled',
    );
    database.close();

    expect(store.findById(issued.session.id)?.terminalEnabled).toBe(true);
  });
});
