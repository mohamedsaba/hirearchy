import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiInteractionService } from '../../apps/web/src/ai/ai-interaction-service';
import { SqliteAiInteractionStore } from '../../apps/web/src/ai/sqlite-ai-interaction-store';
import { SqliteTransactionRunner } from '../../apps/web/src/database/sqlite-transaction-runner';
import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { MockSandboxAdapter } from '../../apps/web/src/sandbox/mock-sandbox-adapter';
import { scenario001 } from '../../apps/web/src/scenarios/scenario-001';
import { SessionOperationCoordinator } from '../../apps/web/src/sessions/session-operation-coordinator';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

describe('C8A — finality recovery projection correction', () => {
  let directory: string;
  let databasePath: string;
  let now: string;
  let store: SqliteSessionStore;
  let eventStore: SqliteEventStore;
  let sandbox: MockSandboxAdapter;
  let transactionRunner: SqliteTransactionRunner;
  let service: SessionService;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-c8a-'));
    databasePath = path.join(directory, 'test.sqlite');
    now = '2026-09-22T10:00:00.000Z';
    store = new SqliteSessionStore(databasePath);
    eventStore = new SqliteEventStore(databasePath);
    sandbox = new MockSandboxAdapter();
    transactionRunner = new SqliteTransactionRunner(databasePath);
    service = new SessionService(store, {
      now: () => now,
      eventStore,
      sandboxAdapter: sandbox,
      coordinator: new SessionOperationCoordinator(),
      transactionRunner,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  const createActive = async () => {
    const created = service.createSession({
      scenario: { ...scenario001, durationSeconds: 60 },
      aiCapability: {
        enabled: true,
        configuredProviderId: 'mock',
        configuredModelId: 'mock-model',
      },
    });
    await service.activate(created.candidateToken);
    return created;
  };

  it('admits only ACTIVE sessions, changes only closureReason, and keeps first reason', async () => {
    const created = service.createSession({ scenario: scenario001 });
    expect(() =>
      store.admitFinalization(created.session.id, 'candidate_submission'),
    ).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_ACTIVE' }));

    await service.activate(created.candidateToken);
    const before = store.findById(created.session.id)!;
    const admitted = store.admitFinalization(
      created.session.id,
      'candidate_submission',
    );
    const repeated = store.admitFinalization(created.session.id, 'timeout');

    expect(admitted).toEqual({
      ...before,
      closureReason: 'candidate_submission',
    });
    expect(repeated.closureReason).toBe('candidate_submission');
  });

  it('uses the existing schema without adding a durable status or column', async () => {
    await createActive();
    const database = new Database(databasePath);
    const columns = database
      .prepare('PRAGMA table_info(assessment_sessions)')
      .all() as Array<{ name: string }>;
    const sql = (
      database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assessment_sessions'",
        )
        .get() as { sql: string }
    ).sql;
    database.close();

    expect(columns.map(({ name }) => name)).not.toContain(
      'finalization_status',
    );
    expect(sql).not.toMatch(/FINALIZING|RECOVERY_PENDING/);
  });

  it('keeps ordinary ACTIVE sessions mutable and CREATED/SUBMITTED behavior unchanged', async () => {
    const created = service.createSession({ scenario: scenario001 });
    await expect(
      service.save(created.candidateToken, 'x'),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    await service.activate(created.candidateToken);
    await expect(
      service.saveWorkspaceFile(
        created.candidateToken,
        'inventory/service.py',
        '# mutable\n',
      ),
    ).resolves.toMatchObject({ ok: true });
    const submitted = await service.submit(created.candidateToken);
    expect(submitted).toMatchObject({
      status: 'SUBMITTED',
      closureReason: 'candidate_submission',
    });
    await expect(service.submit(created.candidateToken)).resolves.toEqual(
      submitted,
    );
  });

  it('leaves ACTIVE + null when pre-freeze drift capture fails', async () => {
    const { candidateToken, session } = await createActive();
    sandbox.failCaptureTree = true;

    await expect(service.submit(candidateToken)).rejects.toMatchObject({
      code: 'PLATFORM_CAPTURE_FAILED',
    });
    expect(store.findById(session.id)).toMatchObject({
      status: 'ACTIVE',
      closureReason: null,
    });
    expect(sandbox.isFrozen(session.id)).toBe(false);
  });

  it('persists manual admission before freeze and preserves it at SUBMITTED', async () => {
    const { candidateToken, session } = await createActive();
    const freeze = sandbox.freeze.bind(sandbox);
    vi.spyOn(sandbox, 'freeze').mockImplementation(async (sessionId) => {
      expect(store.findById(session.id)).toMatchObject({
        status: 'ACTIVE',
        closureReason: 'candidate_submission',
      });
      return freeze(sessionId);
    });

    await expect(service.submit(candidateToken)).resolves.toMatchObject({
      status: 'SUBMITTED',
      closureReason: 'candidate_submission',
    });
  });

  it('persists timeout admission before freeze and preserves it at SUBMITTED', async () => {
    const { session } = await createActive();
    const freeze = sandbox.freeze.bind(sandbox);
    vi.spyOn(sandbox, 'freeze').mockImplementation(async (sessionId) => {
      expect(store.findById(session.id)).toMatchObject({
        status: 'ACTIVE',
        closureReason: 'timeout',
      });
      return freeze(sessionId);
    });
    now = '2026-09-22T10:01:00.000Z';

    await expect(
      service.finalizeTimedOutSession(session.id, now),
    ).resolves.toMatchObject({ status: 'SUBMITTED', closureReason: 'timeout' });
  });

  it('keeps admitted finality after freeze or frozen-capture failure', async () => {
    const freezeFailure = await createActive();
    sandbox.failFreeze = true;
    await expect(
      service.submit(freezeFailure.candidateToken),
    ).rejects.toMatchObject({ code: 'PLATFORM_CAPTURE_FAILED' });
    expect(store.findById(freezeFailure.session.id)).toMatchObject({
      status: 'ACTIVE',
      closureReason: 'candidate_submission',
    });

    sandbox.failFreeze = false;
    const captureFailure = await createActive();
    sandbox.failCaptureFrozenEvidence = true;
    await expect(
      service.submit(captureFailure.candidateToken),
    ).rejects.toMatchObject({ code: 'PLATFORM_CAPTURE_FAILED' });
    expect(store.findById(captureFailure.session.id)).toMatchObject({
      status: 'ACTIVE',
      closureReason: 'candidate_submission',
    });
    expect(sandbox.isFrozen(captureFailure.session.id)).toBe(true);
  });

  it('rejects save, workspace save, Commands, and new AI after admission', async () => {
    const { candidateToken, session } = await createActive();
    store.admitFinalization(session.id, 'candidate_submission');
    const expected = { code: 'SESSION_FINALIZATION_STARTED' };

    await expect(service.save(candidateToken, 'later')).rejects.toMatchObject(
      expected,
    );
    await expect(
      service.saveWorkspaceFile(
        candidateToken,
        'inventory/service.py',
        '# later\n',
      ),
    ).rejects.toMatchObject(expected);
    await expect(
      service.executeCommand(candidateToken, 'pwd'),
    ).rejects.toMatchObject(expected);

    const aiService = new AiInteractionService({
      sessionStore: store,
      eventStore,
      aiInteractionStore: new SqliteAiInteractionStore(databasePath),
      transactionRunner,
    });
    expect(() =>
      aiService.admitInteraction(session.id, {
        clientRequestId: 'after-finality',
        candidatePromptText: 'continue',
      }),
    ).toThrowError(expect.objectContaining(expected));
  });

  it('resumes admitted manual submission retry after transient failure', async () => {
    const { candidateToken, session } = await createActive();
    sandbox.failCaptureFrozenEvidence = true;
    const capture = vi.spyOn(sandbox, 'captureFrozenEvidence');
    await expect(service.submit(candidateToken)).rejects.toBeDefined();

    sandbox.failCaptureFrozenEvidence = false;
    await expect(service.submit(candidateToken)).resolves.toMatchObject({
      status: 'SUBMITTED',
      closureReason: 'candidate_submission',
    });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(store.findById(session.id)?.submittedAt).not.toBeNull();
  });

  it('background recovery resumes manual admission before deadline', async () => {
    const { candidateToken, session } = await createActive();
    sandbox.failCaptureFrozenEvidence = true;
    await expect(service.submit(candidateToken)).rejects.toBeDefined();
    sandbox.failCaptureFrozenEvidence = false;

    const results = await service.sweepTimedOutSessions(now);
    expect(results[0]).toMatchObject({ status: 'fulfilled' });
    expect(store.findById(session.id)).toMatchObject({
      status: 'SUBMITTED',
      closureReason: 'candidate_submission',
    });
  });

  it('background recovery preserves timeout admission', async () => {
    const { session } = await createActive();
    now = '2026-09-22T10:01:00.000Z';
    sandbox.failCaptureFrozenEvidence = true;
    await expect(
      service.finalizeTimedOutSession(session.id, now),
    ).rejects.toBeDefined();
    sandbox.failCaptureFrozenEvidence = false;

    await service.sweepTimedOutSessions(now);
    expect(store.findById(session.id)).toMatchObject({
      status: 'SUBMITTED',
      closureReason: 'timeout',
    });
  });
});
