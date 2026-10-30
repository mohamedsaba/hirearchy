import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';
import { GET as discoveryGet } from '../../apps/web/app/api/evaluator/sessions/route';
import { GET as sessionGet } from '../../apps/web/app/api/evaluator/sessions/[sessionId]/route';
import { GET as reconstructionGet } from '../../apps/web/app/api/evaluator/sessions/[sessionId]/reconstruction/route';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

const state = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (state.cookie ? { value: state.cookie } : undefined),
  }),
}));

const directories: string[] = [];

const createFixture = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-discovery-'));
  directories.push(directory);
  const databasePath = path.join(directory, 'sessions.sqlite');
  const store = new SqliteSessionStore(databasePath);
  let sequence = 0;
  const service = new SessionService(store, {
    createId: () => `session-${String(++sequence).padStart(2, '0')}`,
    createToken: () => `candidate-token-${sequence}`,
    now: () => '2026-09-22T10:00:00.000Z',
  });

  const submit = (submittedAt: string) => {
    const { session } = service.createSession();
    store.activate(session.candidateTokenHash, '2026-09-22T09:00:00.000Z');
    store.submit(session.candidateTokenHash, submittedAt, '');
    return session.id;
  };

  return { databasePath, service, store, submit };
};

afterEach(() => {
  vi.unstubAllEnvs();
  state.cookie = undefined;
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    );
});

describe('evaluator review discovery', () => {
  it('requires evaluator access and returns no session enumeration to an unauthorized caller', async () => {
    const { databasePath, submit } = createFixture();
    const sessionId = submit('2026-09-22T10:00:00.000Z');
    vi.stubEnv('HIREARCHY_DB_PATH', databasePath);
    vi.stubEnv('HIREARCHY_EVALUATOR_KEY', 'review-key');

    const response = await discoveryGet();

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'EVALUATOR_ACCESS_REQUIRED',
        message: 'Evaluator access is required.',
      },
    });
    expect(JSON.stringify(body)).not.toContain(sessionId);
  });

  it('returns only bounded, reviewable submitted metadata in stable newest-first order', async () => {
    const { databasePath, service, store, submit } = createFixture();
    const submittedIds = Array.from({ length: 52 }, (_, index) =>
      submit(new Date(Date.UTC(2026, 8, 22, 10, index)).toISOString()),
    );
    const active = service.createSession().session;
    store.activate(active.candidateTokenHash, '2026-09-22T10:00:00.000Z');
    service.createSession();
    vi.stubEnv('HIREARCHY_DB_PATH', databasePath);
    vi.stubEnv('HIREARCHY_EVALUATOR_KEY', 'review-key');
    state.cookie = createSignedEvaluatorToken('review-key');

    const response = await discoveryGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(body.sessions).toHaveLength(50);
    expect(
      body.sessions.map((session: { sessionId: string }) => session.sessionId),
    ).toEqual(submittedIds.toReversed().slice(0, 50));
    expect(
      body.sessions.every((session: Record<string, unknown>) =>
        Object.keys(session).every((key) =>
          [
            'sessionId',
            'scenarioTitle',
            'submittedAt',
            'durationSeconds',
            'closureReason',
            'reviewProcessStatus',
          ].includes(key),
        ),
      ),
    ).toBe(true);
    expect(JSON.stringify(body)).not.toContain('candidate-token-');
    expect(JSON.stringify(body)).not.toContain('candidateTokenHash');
    expect(JSON.stringify(body)).not.toContain('submittedContent');
    expect(JSON.stringify(body)).not.toContain('events');
    expect(JSON.stringify(body)).not.toContain(active.id);
  });

  it('preserves evaluator-only direct session access after discovery is introduced', async () => {
    const { databasePath, submit } = createFixture();
    const sessionId = submit('2026-09-22T10:00:00.000Z');
    vi.stubEnv('HIREARCHY_DB_PATH', databasePath);
    vi.stubEnv('HIREARCHY_EVALUATOR_KEY', 'review-key');

    expect(
      (
        await sessionGet(
          new Request(`http://localhost/api/evaluator/sessions/${sessionId}`),
          {
            params: Promise.resolve({ sessionId }),
          },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await reconstructionGet(
          new Request(
            `http://localhost/api/evaluator/sessions/${sessionId}/reconstruction`,
          ),
          { params: Promise.resolve({ sessionId }) },
        )
      ).status,
    ).toBe(401);

    state.cookie = createSignedEvaluatorToken('review-key');
    const response = await sessionGet(
      new Request(`http://localhost/api/evaluator/sessions/${sessionId}`),
      { params: Promise.resolve({ sessionId }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).sessionId).toBe(sessionId);
  });
});
