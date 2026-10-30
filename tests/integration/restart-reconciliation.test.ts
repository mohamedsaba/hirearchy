import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', () => ({
  after: vi.fn(),
}));

import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { DockerSandboxAdapter } from '../../apps/web/src/sandbox/docker-sandbox-adapter';
import {
  SessionReconciliationError,
  SessionService,
} from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';
import { startSessionTimeoutSweeper } from '../../apps/web/src/sessions/session-timeout-sweeper';
import { SqliteTransactionRunner } from '../../apps/web/src/database/sqlite-transaction-runner';

// Helpers
const volumeExists = (name: string): boolean =>
  spawnSync('docker', ['volume', 'inspect', name]).status === 0;

const containerPaused = (name: string): boolean => {
  const r = spawnSync('docker', ['inspect', '-f', '{{.State.Paused}}', name]);
  return r.status === 0 && r.stdout.toString().trim() === 'true';
};

const containerExists = (name: string): boolean =>
  spawnSync('docker', ['inspect', name]).status === 0;

describe('T1B.2 — Restart / Reconciliation', { timeout: 60000 }, () => {
  let directory: string;
  let databasePath: string;
  let adapter: DockerSandboxAdapter;
  let store: SqliteSessionStore;
  let eventStore: SqliteEventStore;
  let service: SessionService;
  const createdSessions: string[] = [];

  let mockTime: number;
  let idCounter: number;
  const now = () => new Date(mockTime).toISOString();
  const createId = () => `id-${mockTime}-${idCounter++}`;
  const createToken = () => `token-${mockTime}-${idCounter++}`;

  beforeEach(() => {
    mockTime = new Date('2026-09-21T10:00:00Z').getTime();
    idCounter = 0;
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-reconciliation-'));
    databasePath = path.join(directory, 'db.sqlite');
    adapter = new DockerSandboxAdapter({ defaultTimeoutMs: 10_000 });
    store = new SqliteSessionStore(databasePath);
    eventStore = new SqliteEventStore(databasePath);

    store.withDatabase((db) => SqliteSessionStore.ensureSchema(db));
    eventStore.withDatabase((db) => SqliteEventStore.ensureSchema(db));

    const runner = new SqliteTransactionRunner(databasePath);
    runner.registerInitializer(SqliteSessionStore.ensureSchema);
    runner.registerInitializer(SqliteEventStore.ensureSchema);

    service = new SessionService(store, {
      now,
      createId,
      createToken,
      eventStore,
      sandboxAdapter: adapter,
      transactionRunner: runner,
    });
  });

  afterEach(async () => {
    for (const sid of createdSessions) {
      await adapter.teardown(sid).catch(() => {});
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('records cleanup failure when startup reconciliation retries submitted resources', async () => {
    const { session, candidateToken } = service.createSession({
      scenarioId: 'scenario-001',
    });
    const errorMessage = 'Subprocess transport error: spawn docker ENOENT';
    store.withDatabase((db) =>
      db
        .prepare(
          `UPDATE assessment_sessions
           SET status = 'SUBMITTED', submitted_content = working_content,
               submitted_at = ?, closure_reason = 'candidate_submission'
           WHERE id = ?`,
        )
        .run(now(), session.id),
    );
    vi.spyOn(adapter, 'inspectResources').mockResolvedValue({
      containerStatus: 'running',
      volumeExists: true,
    });
    vi.spyOn(adapter, 'teardown').mockRejectedValueOnce(
      new Error(errorMessage),
    );

    await expect(service.reconcileSessions(now())).rejects.toBeInstanceOf(
      SessionReconciliationError,
    );

    const storedEvent = eventStore
      .getEvents(session.id)
      .find((event) => event.type === 'SANDBOX_CLEANUP_FAILED');
    expect(storedEvent).toMatchObject({
      type: 'SANDBOX_CLEANUP_FAILED',
      payload: { phase: 'reconciliation', errorMessage },
    });

    const candidateEvent = service
      .getSessionEvents(candidateToken)
      .find((event) => event.type === 'SANDBOX_CLEANUP_FAILED');
    expect(candidateEvent).toMatchObject({
      type: 'SANDBOX_CLEANUP_FAILED',
      payload: {
        phase: 'reconciliation',
        errorMessage: 'Sandbox cleanup failed.',
      },
    });
    expect(JSON.stringify(candidateEvent)).not.toContain(errorMessage);
    expect(store.findById(session.id)?.status).toBe('SUBMITTED');
  });

  it('R1: overdue ACTIVE + running container -> timeout finalization', async () => {
    const { session, candidateToken } = service.createSession({
      scenarioId: 'scenario-001',
    });
    createdSessions.push(session.id);
    await service.activate(candidateToken);

    expect(containerExists(adapter.getContainerName(session.id))).toBe(true);

    mockTime += (session.durationSeconds! + 10) * 1000;

    await service.reconcileSessions(now());

    const reloaded = store.findById(session.id);
    expect(reloaded?.status).toBe('SUBMITTED');
    expect(reloaded?.closureReason).toBe('timeout');

    // evidence captured, resources cleaned
    expect(containerExists(adapter.getContainerName(session.id))).toBe(false);
    expect(volumeExists(adapter.getVolumeName(session.id))).toBe(false);
  }, 30000);

  it('R2: overdue ACTIVE + PAUSED container -> finalizes without unpause', async () => {
    const { session, candidateToken } = service.createSession({
      scenarioId: 'scenario-001',
    });
    createdSessions.push(session.id);
    await service.activate(candidateToken);

    await adapter.freeze(session.id);
    expect(containerPaused(adapter.getContainerName(session.id))).toBe(true);

    mockTime += (session.durationSeconds! + 10) * 1000;

    await service.reconcileSessions(now());

    const reloaded = store.findById(session.id);
    expect(reloaded?.status).toBe('SUBMITTED');
    expect(reloaded?.closureReason).toBe('timeout');

    expect(containerExists(adapter.getContainerName(session.id))).toBe(false);
  }, 30000);

  it('C8A: admitted manual finalization with running container resumes before deadline', async () => {
    const { session, candidateToken } = service.createSession({
      scenarioId: 'scenario-001',
    });
    createdSessions.push(session.id);
    await service.activate(candidateToken);
    store.admitFinalization(session.id, 'candidate_submission');

    await service.reconcileSessions(now());

    expect(store.findById(session.id)).toMatchObject({
      status: 'SUBMITTED',
      closureReason: 'candidate_submission',
    });
    expect(containerExists(adapter.getContainerName(session.id))).toBe(false);
    expect(volumeExists(adapter.getVolumeName(session.id))).toBe(false);
  }, 30000);

  it('C8A: admitted timeout finalization with paused container preserves reason', async () => {
    const { session, candidateToken } = service.createSession({
      scenarioId: 'scenario-001',
    });
    createdSessions.push(session.id);
    await service.activate(candidateToken);
    await adapter.freeze(session.id);
    store.admitFinalization(session.id, 'timeout');

    await service.reconcileSessions(now());

    expect(store.findById(session.id)).toMatchObject({
      status: 'SUBMITTED',
      closureReason: 'timeout',
    });
    expect(containerExists(adapter.getContainerName(session.id))).toBe(false);
  }, 30000);

  it('C8A: admitted finalization keeps existing missing-container mismatch fail closed', async () => {
    const { session, candidateToken } = service.createSession({
      scenarioId: 'scenario-001',
    });
    createdSessions.push(session.id);
    await service.activate(candidateToken);
    store.admitFinalization(session.id, 'candidate_submission');
    spawnSync('docker', ['rm', '-f', adapter.getContainerName(session.id)]);

    await expect(service.reconcileSessions(now())).rejects.toBeInstanceOf(
      SessionReconciliationError,
    );

    expect(store.findById(session.id)).toMatchObject({
      status: 'ACTIVE',
      closureReason: 'candidate_submission',
    });
    expect(volumeExists(adapter.getVolumeName(session.id))).toBe(true);
    expect(
      eventStore
        .getEvents(session.id)
        .some(
          (event) =>
            event.type === 'WORKSPACE_CAPTURE_FAILED' &&
            (event.payload as { phase?: string }).phase === 'reconciliation',
        ),
    ).toBe(true);
  }, 30000);

  it('R3: ACTIVE + missing container + existing volume follows explicit safe behavior', async () => {
    const { session, candidateToken } = service.createSession({
      scenarioId: 'scenario-001',
    });
    createdSessions.push(session.id);
    await service.activate(candidateToken);

    // Delete container manually to simulate R3
    spawnSync('docker', ['rm', '-f', adapter.getContainerName(session.id)]);
    expect(containerExists(adapter.getContainerName(session.id))).toBe(false);
    expect(volumeExists(adapter.getVolumeName(session.id))).toBe(true);

    mockTime += (session.durationSeconds! + 10) * 1000;

    await expect(service.reconcileSessions(now())).rejects.toBeInstanceOf(
      SessionReconciliationError,
    );

    const reloaded = store.findById(session.id);
    expect(reloaded?.status).toBe('ACTIVE'); // Fails closed

    // Volume preserved
    expect(volumeExists(adapter.getVolumeName(session.id))).toBe(true);

    const events = eventStore.getEvents(session.id);
    const failureEvent = events.find(
      (e) => e.type === 'WORKSPACE_CAPTURE_FAILED',
    );
    expect(failureEvent).toBeDefined();
  }, 30000);

  it('R4: ACTIVE + container + missing volume fails closed', async () => {
    const { session, candidateToken } = service.createSession({
      scenarioId: 'scenario-001',
    });
    createdSessions.push(session.id);
    await service.activate(candidateToken);

    const spy = vi.spyOn(adapter, 'inspectResources').mockResolvedValue({
      containerStatus: 'running',
      volumeExists: false,
    });

    mockTime += (session.durationSeconds! + 10) * 1000;
    await expect(service.reconcileSessions(now())).rejects.toBeInstanceOf(
      SessionReconciliationError,
    );

    const reloaded = store.findById(session.id);
    expect(reloaded?.status).toBe('ACTIVE');

    spy.mockRestore();
  }, 30000);

  it('R5: SUBMITTED + leaked container -> cleanup only', async () => {
    const { session, candidateToken } = service.createSession({
      scenarioId: 'scenario-001',
    });
    createdSessions.push(session.id);
    await service.activate(candidateToken);

    // Submit normally
    await service.submit(candidateToken);

    // Recreate container and volume manually to simulate leak
    await adapter.createAndVerify(session.id, {
      scenarioType: 'multi_file',
      imageName: 'hirearchy-scenario-001:latest',
    });
    expect(containerExists(adapter.getContainerName(session.id))).toBe(true);

    // Reconcile should clean up
    await service.reconcileSessions(now());

    expect(containerExists(adapter.getContainerName(session.id))).toBe(false);
    expect(volumeExists(adapter.getVolumeName(session.id))).toBe(false);

    const reloaded = store.findById(session.id);
    expect(reloaded?.status).toBe('SUBMITTED');
  }, 40000);

  it('R6: ACTIVE legacy durationSeconds=null ignored', async () => {
    const { session, candidateToken } = service.createSession({
      scenarioId: 'scenario-001',
    });
    createdSessions.push(session.id);
    // Force durationSeconds to null manually
    store.withDatabase((db) =>
      db
        .prepare(
          'UPDATE assessment_sessions SET duration_seconds = NULL WHERE id = ?',
        )
        .run(session.id),
    );
    await service.activate(candidateToken);

    mockTime += 1000000;
    await service.reconcileSessions(now());

    const reloaded = store.findById(session.id);
    expect(reloaded?.status).toBe('ACTIVE');
  });

  it('R7: CREATED not timeout-finalized', async () => {
    const { session } = service.createSession({ scenarioId: 'scenario-001' });
    createdSessions.push(session.id);

    mockTime += 1000000;
    await service.reconcileSessions(now());

    const reloaded = store.findById(session.id);
    expect(reloaded?.status).toBe('CREATED');
  });

  it('IDEMPOTENCY: repeated reconciliation on already timeout-finalized session', async () => {
    const { session, candidateToken } = service.createSession({
      scenarioId: 'scenario-001',
    });
    createdSessions.push(session.id);
    await service.activate(candidateToken);

    mockTime += (session.durationSeconds! + 10) * 1000;
    await service.reconcileSessions(now());

    const firstRun = store.findById(session.id);
    expect(firstRun?.status).toBe('SUBMITTED');
    expect(firstRun?.closureReason).toBe('timeout');
    const firstEventsCount = eventStore.getEvents(session.id).length;

    // Run reconciliation again on the submitted session
    await service.reconcileSessions(now());

    const secondRun = store.findById(session.id);
    expect(secondRun?.status).toBe('SUBMITTED');
    expect(secondRun?.closureReason).toBe('timeout');
    expect(secondRun?.submittedAt).toBe(firstRun?.submittedAt);
    expect(eventStore.getEvents(session.id).length).toBe(firstEventsCount);
    expect(containerExists(adapter.getContainerName(session.id))).toBe(false);
    expect(volumeExists(adapter.getVolumeName(session.id))).toBe(false);
  }, 30000);

  it('IDEMPOTENCY: repeated cleanup for SUBMITTED leaked resources', async () => {
    const { session, candidateToken } = service.createSession({
      scenarioId: 'scenario-001',
    });
    createdSessions.push(session.id);
    await service.activate(candidateToken);
    await service.submit(candidateToken);

    // Leak resources
    await adapter.createAndVerify(session.id, {
      scenarioType: 'multi_file',
      imageName: 'hirearchy-scenario-001:latest',
    });
    expect(containerExists(adapter.getContainerName(session.id))).toBe(true);

    // Reconcile once -> cleaned
    await service.reconcileSessions(now());
    expect(containerExists(adapter.getContainerName(session.id))).toBe(false);
    expect(volumeExists(adapter.getVolumeName(session.id))).toBe(false);

    // Reconcile second time -> no-op, no error, remains submitted
    await expect(service.reconcileSessions(now())).resolves.not.toThrow();

    const reloaded = store.findById(session.id);
    expect(reloaded?.status).toBe('SUBMITTED');
    expect(reloaded?.closureReason).toBe('candidate_submission');
    expect(containerExists(adapter.getContainerName(session.id))).toBe(false);
    expect(volumeExists(adapter.getVolumeName(session.id))).toBe(false);
  }, 40000);

  it('IDEMPOTENCY: repeated R3 recovery preserves volume and ACTIVE status without unpause or recreation', async () => {
    const { session, candidateToken } = service.createSession({
      scenarioId: 'scenario-001',
    });
    createdSessions.push(session.id);
    await service.activate(candidateToken);

    // Delete container manually (R3 condition)
    spawnSync('docker', ['rm', '-f', adapter.getContainerName(session.id)]);
    expect(containerExists(adapter.getContainerName(session.id))).toBe(false);
    expect(volumeExists(adapter.getVolumeName(session.id))).toBe(true);

    mockTime += (session.durationSeconds! + 10) * 1000;

    // First reconciliation
    await expect(service.reconcileSessions(now())).rejects.toBeInstanceOf(
      SessionReconciliationError,
    );
    const firstState = store.findById(session.id);
    expect(firstState?.status).toBe('ACTIVE');
    expect(volumeExists(adapter.getVolumeName(session.id))).toBe(true);
    expect(containerExists(adapter.getContainerName(session.id))).toBe(false);

    // Second reconciliation
    await expect(service.reconcileSessions(now())).rejects.toBeInstanceOf(
      SessionReconciliationError,
    );
    const secondState = store.findById(session.id);
    expect(secondState?.status).toBe('ACTIVE');
    expect(volumeExists(adapter.getVolumeName(session.id))).toBe(true);
    expect(containerExists(adapter.getContainerName(session.id))).toBe(false);

    // Each retry records an explicit platform failure event
    const events = eventStore
      .getEvents(session.id)
      .filter((e) => e.type === 'WORKSPACE_CAPTURE_FAILED');
    expect(events.length).toBe(2);
  }, 30000);

  it('STARTUP: reconciliation initiates once at startup and prevents duplicate registration', async () => {
    const globalKey = Symbol.for('hirearchy.sessionTimeoutSweeper');
    const target = globalThis as unknown as Record<
      symbol,
      { running?: boolean; timer?: NodeJS.Timeout | null }
    >;
    delete target[globalKey];

    const reconcileSpy = vi
      .spyOn(service, 'reconcileSessions')
      .mockImplementation(async () => {
        // Verify sweeper state is marked running during initial reconciliation
        const state = target[globalKey];
        expect(state?.running).toBe(true);
      });

    const sweepSpy = vi
      .spyOn(service, 'sweepTimedOutSessions')
      .mockResolvedValue();

    startSessionTimeoutSweeper(service, 50);

    const firstState = target[globalKey];
    expect(firstState).toBeDefined();

    // Repeated call must not create a new interval or re-trigger reconciliation
    startSessionTimeoutSweeper(service, 50);
    expect(target[globalKey]).toBe(firstState);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    // Let the reconciliation promise chain complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(firstState.running).toBe(false);

    // Clean up timer
    clearInterval(firstState.timer);
    delete target[globalKey];
    reconcileSpy.mockRestore();
    sweepSpy.mockRestore();
  });
});
