import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';
import {
  EvaluatorAccessError,
  getAuthorizedEvidence,
} from '../../apps/web/src/access/evaluator-evidence';
import { sliceOneScenario } from '../../apps/web/src/scenarios/slice-one-scenario';
import { SessionError } from '../../apps/web/src/sessions/session';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

describe('persisted session flow', () => {
  let directory: string;
  let databasePath: string;
  let sequence: number;

  const createService = () =>
    new SessionService(new SqliteSessionStore(databasePath), {
      now: () => `2026-09-14T12:0${sequence++}:00.000Z`,
      createId: () => `session-${sequence}`,
      createToken: () => `candidate-token-${sequence}`,
    });

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-session-'));
    databasePath = path.join(directory, 'sessions.sqlite');
    sequence = 0;
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('loads the fixed scenario and restores persisted edits after reload', async () => {
    const service = createService();
    const { candidateToken, session } = service.createSession();

    expect(session.scenario).toEqual(sliceOneScenario);
    expect(session.status).toBe('CREATED');

    await service.activate(candidateToken);
    await service.save(candidateToken, 'candidate edit\r\n');

    const reloadedService = createService();
    expect(reloadedService.getCandidateSession(candidateToken)).toMatchObject({
      status: 'ACTIVE',
      workingContent: 'candidate edit\n',
    });
  });

  it('preserves immutable evidence and defines repeated submission as idempotent', async () => {
    const service = createService();
    const { candidateToken, session } = service.createSession();
    await service.activate(candidateToken);
    await service.save(candidateToken, 'candidate submission\n');

    const firstSubmission = await service.submit(candidateToken);
    const secondSubmission = await service.submit(candidateToken);

    expect(secondSubmission).toEqual(firstSubmission);
    await expect(
      service.save(candidateToken, 'later mutation'),
    ).rejects.toThrowError(SessionError);

    const evidence = service.getSubmittedEvidence(session.id);
    expect(evidence.originalContent).toBe(sliceOneScenario.originalContent);
    expect(evidence.submittedContent).toBe('candidate submission\n');
    expect(evidence.diff).toContain('-export const formatGreeting');
    expect(evidence).not.toHaveProperty('verdict');
    expect(evidence).not.toHaveProperty('score');
    expect(evidence).not.toHaveProperty('decision');
  });

  it('keeps candidate sessions separate and evaluator evidence independently authorized', async () => {
    const service = createService();
    const first = service.createSession();
    const second = service.createSession();

    expect(service.getCandidateSession(first.candidateToken).id).toBe(
      first.session.id,
    );
    expect(service.getCandidateSession(first.candidateToken).id).not.toBe(
      second.session.id,
    );
    expect(() =>
      service.getCandidateSession('not-a-session-token'),
    ).toThrowError(SessionError);

    await service.activate(first.candidateToken);
    await service.submit(first.candidateToken);

    expect(() =>
      getAuthorizedEvidence(first.session.id, first.candidateToken, {
        credential: 'review-secret',
        service,
      }),
    ).toThrowError(EvaluatorAccessError);

    const evidence = getAuthorizedEvidence(
      first.session.id,
      createSignedEvaluatorToken('review-secret'),
      { credential: 'review-secret', service },
    );
    expect(evidence.sessionId).toBe(first.session.id);
  });
});
