import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getCookie } = vi.hoisted(() => ({ getCookie: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: getCookie }),
}));

import { POST as createAssessment } from '../../apps/web/app/api/evaluator/assessments/route';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';
import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { MockSandboxAdapter } from '../../apps/web/src/sandbox/mock-sandbox-adapter';
import { sliceOneScenario } from '../../apps/web/src/scenarios/slice-one-scenario';
import { getReviewerWorkflowStore } from '../../apps/web/src/review-workflow/reviewer-workflow-store';
import {
  getSessionService,
  SessionReconciliationError,
  SessionService,
} from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';
import {
  ApplicationStartupNotReadyError,
  markApplicationStartupFailed,
  markApplicationStartupPending,
  markApplicationStartupReady,
} from '../../apps/web/src/startup-status';

describe('startup fail-closed runtime guard', () => {
  let directory = '';
  const originalDatabasePath = process.env.HIREARCHY_DB_PATH;
  const originalEvaluatorKey = process.env.HIREARCHY_EVALUATOR_KEY;

  afterEach(() => {
    markApplicationStartupReady();
    getCookie.mockReset();
    if (originalDatabasePath === undefined) {
      delete process.env.HIREARCHY_DB_PATH;
    } else {
      process.env.HIREARCHY_DB_PATH = originalDatabasePath;
    }
    if (originalEvaluatorKey === undefined) {
      delete process.env.HIREARCHY_EVALUATOR_KEY;
    } else {
      process.env.HIREARCHY_EVALUATOR_KEY = originalEvaluatorKey;
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  it('blocks issuance, candidate mutation, and review writes after real reconciliation fails', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-startup-fail-'));
    const databasePath = path.join(directory, 'sessions.sqlite');
    process.env.HIREARCHY_DB_PATH = databasePath;
    process.env.HIREARCHY_EVALUATOR_KEY = 'startup-gate-test-key';
    getCookie.mockReturnValue({
      value: createSignedEvaluatorToken('startup-gate-test-key'),
    });

    let now = '2026-10-24T10:00:00.000Z';
    const store = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const adapter = new MockSandboxAdapter();
    const fixtureService = new SessionService(store, {
      eventStore,
      sandboxAdapter: adapter,
      now: () => now,
    });
    const { session, candidateToken } = fixtureService.createSession({
      scenario: { ...sliceOneScenario, durationSeconds: 1 },
    });
    await fixtureService.activate(candidateToken);
    now = '2026-10-24T10:00:00.010Z';
    store.admitFinalization(session.id, 'timeout');
    Object.assign(adapter, {
      inspectResources: vi.fn().mockResolvedValue({
        containerStatus: 'missing',
        volumeExists: false,
      }),
    });

    await expect(fixtureService.reconcileSessions(now)).rejects.toBeInstanceOf(
      SessionReconciliationError,
    );
    expect(
      eventStore
        .getEvents(session.id)
        .some((event) => event.type === 'WORKSPACE_CAPTURE_FAILED'),
    ).toBe(true);

    const guardedService = getSessionService();
    const guardedReviewerStore = getReviewerWorkflowStore();
    const database = new Database(databasePath, { readonly: true });
    const beforeSession = database
      .prepare(
        'SELECT status, working_content FROM assessment_sessions WHERE id = ?',
      )
      .get(session.id);
    const beforeSchema = database
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    const beforeCount = database
      .prepare('SELECT COUNT(*) AS count FROM assessment_sessions')
      .get() as { count: number };
    database.close();

    markApplicationStartupPending();
    const pendingResponse = await createAssessment(
      new Request('http://localhost/api/evaluator/assessments', {
        method: 'POST',
        body: '{}',
      }),
    );
    expect(pendingResponse.status).toBe(503);

    markApplicationStartupFailed('reconciliation');
    expect(() => guardedService.save(candidateToken, 'not persisted')).toThrow(
      ApplicationStartupNotReadyError,
    );
    expect(() =>
      guardedReviewerStore.saveNote(session.id, 'not persisted', 0),
    ).toThrow(ApplicationStartupNotReadyError);
    const failedResponse = await createAssessment(
      new Request('http://localhost/api/evaluator/assessments', {
        method: 'POST',
        body: '{}',
      }),
    );
    expect(failedResponse.status).toBe(503);

    const after = new Database(databasePath, { readonly: true });
    expect(
      after
        .prepare(
          'SELECT status, working_content FROM assessment_sessions WHERE id = ?',
        )
        .get(session.id),
    ).toEqual(beforeSession);
    expect(
      after
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all(),
    ).toEqual(beforeSchema);
    expect(
      after.prepare('SELECT COUNT(*) AS count FROM assessment_sessions').get(),
    ).toEqual(beforeCount);
    after.close();
  });
});
