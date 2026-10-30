import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', () => ({
  after: vi.fn(),
}));

import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { MockSandboxAdapter } from '../../apps/web/src/sandbox/mock-sandbox-adapter';
import { scenario001 } from '../../apps/web/src/scenarios/scenario-001';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

describe('Submission Finality Retry', () => {
  let tempDir: string;
  let store: SqliteSessionStore;
  let eventStore: SqliteEventStore;
  let sandbox: MockSandboxAdapter;
  let service: SessionService;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'hirearchy-retry-test-'));
    const dbPath = path.join(tempDir, 'test.sqlite');
    store = new SqliteSessionStore(dbPath);
    eventStore = new SqliteEventStore(dbPath);
    sandbox = new MockSandboxAdapter();
    service = new SessionService(store, {
      eventStore,
      sandboxAdapter: sandbox,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    sandbox.failFreeze = false;
    sandbox.failCaptureFrozenEvidence = false;
    sandbox.failTeardown = false;
  });

  it('allows candidate retry of admitted finalization after transient capture failure', async () => {
    const { candidateToken, session } = service.createSession({
      scenarioId: scenario001.id,
    });
    await service.activate(candidateToken);

    await service.saveWorkspaceFile(
      candidateToken,
      'inventory/service.py',
      '# CANDIDATE_RETRY_MUTATION\n',
    );

    // Initial submission attempt fails during frozen capture
    sandbox.failCaptureFrozenEvidence = true;
    await expect(service.submit(candidateToken)).rejects.toMatchObject({
      code: 'PLATFORM_CAPTURE_FAILED',
    });

    // Session remains admitted in ACTIVE state; sandbox remains frozen and intact
    const admittedSession = store.findById(session.id);
    expect(admittedSession).toMatchObject({
      status: 'ACTIVE',
      closureReason: 'candidate_submission',
    });
    expect(sandbox.hasSandbox(session.id)).toBe(true);
    expect(sandbox.isFrozen(session.id)).toBe(true);

    // Candidate mutations remain blocked while finalization is admitted
    await expect(
      service.saveWorkspaceFile(
        candidateToken,
        'inventory/service.py',
        '# SHOULD_BE_BLOCKED\n',
      ),
    ).rejects.toMatchObject({
      code: 'SESSION_FINALIZATION_STARTED',
    });

    // Transient capture failure clears and candidate retries submission
    sandbox.failCaptureFrozenEvidence = false;
    const submitted = await service.submit(candidateToken);

    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.closureReason).toBe('candidate_submission');
    expect(submitted.submittedDiff).toContain('CANDIDATE_RETRY_MUTATION');
    expect(sandbox.hasSandbox(session.id)).toBe(false);

    // Audit trail records initial capture failure event
    const events = eventStore.getEvents(session.id);
    expect(
      events.some(
        (e) =>
          e.type === 'WORKSPACE_CAPTURE_FAILED' &&
          (e.payload as { phase: string }).phase ===
            'submission_frozen_capture',
      ),
    ).toBe(true);
  });

  it('freeze is idempotent on mock sandbox adapter', async () => {
    const { candidateToken, session } = service.createSession({
      scenarioId: scenario001.id,
    });
    await service.activate(candidateToken);

    await sandbox.freeze(session.id);
    expect(sandbox.isFrozen(session.id)).toBe(true);

    // Subsequent freeze calls are no-ops and do not fail
    sandbox.failFreeze = true;
    await expect(sandbox.freeze(session.id)).resolves.not.toThrow();
  });

  it('mock captureFrozenEvidence accepts optional generatedStarterFiles signature', async () => {
    const { candidateToken, session } = service.createSession({
      scenarioId: scenario001.id,
    });
    await service.activate(candidateToken);
    await sandbox.freeze(session.id);

    const generatedStarterFiles = {
      'sample.py': '# generated starter\n',
    };

    const evidence = await sandbox.captureFrozenEvidence(
      session.id,
      undefined,
      generatedStarterFiles,
    );

    expect(evidence.currentTree).toBeTruthy();
    expect(typeof evidence.rawDiff).toBe('string');
  });
});
