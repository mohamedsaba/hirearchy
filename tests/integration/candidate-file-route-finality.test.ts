import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PUT } from '../../apps/web/app/api/candidate/sessions/[token]/file/route';
import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { MockSandboxAdapter } from '../../apps/web/src/sandbox/mock-sandbox-adapter';
import * as sessionService from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

describe('Candidate file PUT after submission', () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects edits without changing submitted evidence or token authorization', async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'hirearchy-file-finality-'),
    );
    directories.push(directory);
    const databasePath = path.join(directory, 'sessions.sqlite');
    const store = new SqliteSessionStore(databasePath);
    const eventStore = new SqliteEventStore(databasePath);
    const service = new sessionService.SessionService(store, {
      eventStore,
      sandboxAdapter: new MockSandboxAdapter(),
    });
    vi.spyOn(sessionService, 'getSessionService').mockReturnValue(service);
    const { candidateToken, session } = service.createSession();
    await service.activate(candidateToken);

    const save = (token: string, content: string) =>
      PUT(
        new Request('http://localhost/api/candidate/sessions/synthetic/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        }),
        { params: Promise.resolve({ token }) },
      );

    expect(
      (await save(candidateToken, 'submitted synthetic work\n')).status,
    ).toBe(200);
    await service.submit(candidateToken);
    const before = store.findById(session.id);
    const evidence = service.getSubmittedEvidence(session.id);
    expect(before?.submittedContent).toBe('submitted synthetic work\n');

    const rejected = await save(
      candidateToken,
      'post-submission modification\n',
    );
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).error.code).toBe('SESSION_NOT_ACTIVE');
    const unauthorized = await save(
      'invalid-synthetic-token',
      'unauthorized\n',
    );
    expect(unauthorized.status).toBe(404);
    expect((await unauthorized.json()).error.code).toBe('SESSION_NOT_FOUND');

    expect(new SqliteSessionStore(databasePath).findById(session.id)).toEqual(
      before,
    );
    expect(service.getSubmittedEvidence(session.id)).toEqual(evidence);
    expect(eventStore.getEvents(session.id)).toEqual(evidence.events);
  });
});
