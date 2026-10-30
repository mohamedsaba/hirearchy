import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getCookie } = vi.hoisted(() => ({ getCookie: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: getCookie }),
}));

import {
  GET,
  POST,
} from '../../apps/web/app/api/evaluator/sessions/[sessionId]/assessment-score/route';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

describe('task assessment score route', () => {
  let directory: string;
  let databasePath: string;
  let originalDbPath: string | undefined;
  let originalKey: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-task-score-route-'));
    databasePath = path.join(directory, 'sessions.sqlite');
    originalDbPath = process.env.HIREARCHY_DB_PATH;
    originalKey = process.env.HIREARCHY_EVALUATOR_KEY;
    process.env.HIREARCHY_DB_PATH = databasePath;
    process.env.HIREARCHY_EVALUATOR_KEY = 'score-route-test-key';
    getCookie.mockReturnValue({
      value: createSignedEvaluatorToken('score-route-test-key'),
    });
    const store = new SqliteSessionStore(databasePath);
    const service = new SessionService(store, {
      createId: () => 'submitted-legacy-session',
      createToken: () => 'candidate-token',
      now: () => '2026-10-03T10:00:00.000Z',
    });
    const session = service.createSession().session;
    store.activate(session.candidateTokenHash, '2026-10-03T09:00:00.000Z');
    store.submit(session.candidateTokenHash, '2026-10-03T10:00:00.000Z', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDbPath === undefined) delete process.env.HIREARCHY_DB_PATH;
    else process.env.HIREARCHY_DB_PATH = originalDbPath;
    if (originalKey === undefined) delete process.env.HIREARCHY_EVALUATOR_KEY;
    else process.env.HIREARCHY_EVALUATOR_KEY = originalKey;
    rmSync(directory, { recursive: true, force: true });
  });

  const context = {
    params: Promise.resolve({ sessionId: 'submitted-legacy-session' }),
  };

  it('requires evaluator authorization before returning an analysis state', async () => {
    getCookie.mockReturnValue(undefined);
    const response = await GET(new Request('http://localhost/score'), context);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'EVALUATOR_ACCESS_REQUIRED' },
    });
  });

  it('requires authorization and uses an explicit unavailable legacy-rubric state', async () => {
    getCookie.mockReturnValue(undefined);
    const request = new Request('http://localhost/score');
    const unauthorized = await POST(request, context);
    expect(unauthorized.status).toBe(401);

    getCookie.mockReturnValue({
      value: createSignedEvaluatorToken('score-route-test-key'),
    });
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({
      status: 'rubric_unavailable',
      rubric: null,
      totalScore: null,
      providerId: null,
      model: null,
    });
  });
});
