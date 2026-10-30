import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { MockSandboxAdapter } from '../../apps/web/src/sandbox/mock-sandbox-adapter';
import { SessionError } from '../../apps/web/src/sessions/session';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';
import { getCandidateCommandHistory } from '../../apps/web/src/server/candidate-command-history';

describe('Candidate Command History Integration', () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(
      path.join(tmpdir(), 'hirearchy-cmd-history-integration-'),
    );
    databasePath = path.join(directory, 'test.sqlite');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('proves authoritative command history restores on reload, is isolated per token, and persists through submission', async () => {
    const sandboxAdapter = new MockSandboxAdapter();
    const eventStore = new SqliteEventStore(databasePath);
    const sessionStore = new SqliteSessionStore(databasePath);

    const service = new SessionService(sessionStore, {
      eventStore,
      sandboxAdapter,
    });

    // Configure mock command execution responses
    sandboxAdapter.customExecHandler = (cmd) => {
      if (cmd === 'pytest') {
        return {
          exitCode: 0,
          stdout: 'collected 3 items\n3 passed in 0.12s\n',
          stderr: '',
        };
      }
      if (cmd === 'exit 42') {
        return {
          exitCode: 42,
          stdout: '',
          stderr: 'Process terminated with code 42\n',
        };
      }
      return { exitCode: 0, stdout: 'ok\n', stderr: '' };
    };

    // 1. Pre-start (CREATED) session must return no command history
    const { candidateToken: tokenA, session: sessionA } =
      service.createSession();
    expect(sessionA.status).toBe('CREATED');

    const preStartHistory = getCandidateCommandHistory(
      service,
      tokenA,
      sessionA,
    );
    expect(preStartHistory).toEqual([]);

    // 2. Activate session (ACTIVE)
    await service.activate(tokenA);
    const activeSessionA = service.getCandidateSession(tokenA);
    expect(activeSessionA.status).toBe('ACTIVE');

    // Initially active session has zero command history
    expect(getCandidateCommandHistory(service, tokenA, activeSessionA)).toEqual(
      [],
    );

    // 3. Execute commands
    const res1 = await service.executeCommand(tokenA, 'pytest');
    expect(res1.exitCode).toBe(0);

    const res2 = await service.executeCommand(tokenA, 'exit 42');
    expect(res2.exitCode).toBe(42);

    // 4. Simulate page reload by querying server-authoritative projection via candidate token
    const reloadedHistory = getCandidateCommandHistory(service, tokenA);
    expect(reloadedHistory).toHaveLength(2);

    expect(reloadedHistory[0]).toMatchObject({
      command: 'pytest',
      state: 'COMPLETED_SUCCESS',
      result: {
        exitCode: 0,
        timedOut: false,
        stdoutPreview: 'collected 3 items\n3 passed in 0.12s\n',
      },
    });

    expect(reloadedHistory[1]).toMatchObject({
      command: 'exit 42',
      state: 'COMPLETED_FAILURE',
      result: {
        exitCode: 42,
        timedOut: false,
        stderrPreview: 'Process terminated with code 42\n',
      },
    });

    // 5. Submit the assessment and verify history remains queryable for candidate read-only view
    await service.submit(tokenA);
    const submittedSessionA = service.getCandidateSession(tokenA);
    expect(submittedSessionA.status).toBe('SUBMITTED');

    const postSubmitHistory = getCandidateCommandHistory(
      service,
      tokenA,
      submittedSessionA,
    );
    expect(postSubmitHistory).toHaveLength(2);
    expect(postSubmitHistory[0].command).toBe('pytest');
    expect(postSubmitHistory[1].command).toBe('exit 42');

    // 6. Cross-session boundary: A different candidate token cannot access session A's history
    const { candidateToken: tokenB } = service.createSession();
    await service.activate(tokenB);
    const tokenBHistory = getCandidateCommandHistory(service, tokenB);
    expect(tokenBHistory).toEqual([]);

    // 7. Invalid token fails with SESSION_NOT_FOUND
    expect(() =>
      getCandidateCommandHistory(service, 'non-existent-token-xyz'),
    ).toThrowError(SessionError);
  });

  it('returns empty history when terminal is explicitly disabled', async () => {
    const sandboxAdapter = new MockSandboxAdapter();
    const eventStore = new SqliteEventStore(databasePath);
    const sessionStore = new SqliteSessionStore(databasePath);

    const service = new SessionService(sessionStore, {
      eventStore,
      sandboxAdapter,
    });

    const { candidateToken, session } = service.createSession();
    // Simulate terminalEnabled = false
    const disabledSession = {
      ...session,
      terminalEnabled: false,
      status: 'ACTIVE' as const,
    };

    const history = getCandidateCommandHistory(
      service,
      candidateToken,
      disabledSession,
    );
    expect(history).toEqual([]);
  });
});
