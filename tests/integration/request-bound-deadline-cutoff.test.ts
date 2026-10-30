import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', () => ({
  after: vi.fn(),
}));

import {
  type AiCapabilitySnapshot,
  AiInteractionError,
  defaultAiCapabilitySnapshot,
} from '../../apps/web/src/ai/ai-interaction';
import { AiInteractionService } from '../../apps/web/src/ai/ai-interaction-service';
import { DefaultAiProviderRegistry } from '../../apps/web/src/ai/ai-provider';
import { MockAiProvider } from '../../apps/web/src/ai/mock-ai-provider';
import { SqliteAiInteractionStore } from '../../apps/web/src/ai/sqlite-ai-interaction-store';
import { SqliteTransactionRunner } from '../../apps/web/src/database/sqlite-transaction-runner';
import { SqliteEventStore } from '../../apps/web/src/events/sqlite-event-store';
import { errorResponse } from '../../apps/web/src/http/error-response';
import { MockSandboxAdapter } from '../../apps/web/src/sandbox/mock-sandbox-adapter';
import { sliceOneScenario } from '../../apps/web/src/scenarios/slice-one-scenario';
import { SessionError } from '../../apps/web/src/sessions/session';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { deriveSessionDeadline } from '../../apps/web/src/sessions/session-timing';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';
import { migrateLegacyCandidateTokens } from '../../apps/web/src/sessions/candidate-token-storage.mjs';
import { POST as submitRoutePost } from '../../apps/web/app/api/candidate/sessions/[token]/submit/route';

const hashCandidateToken = (candidateToken: string) =>
  createHash('sha256').update(candidateToken).digest('hex');

const createLegacySessionDatabase = (databasePath: string) => {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE assessment_sessions (
      id TEXT PRIMARY KEY,
      candidate_token_hash TEXT NOT NULL UNIQUE,
      scenario_id TEXT NOT NULL,
      scenario_version TEXT NOT NULL,
      scenario_title TEXT NOT NULL,
      scenario_brief TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      file_path TEXT NOT NULL,
      original_content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('CREATED', 'ACTIVE', 'SUBMITTED')),
      working_content TEXT NOT NULL,
      submitted_content TEXT,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      submitted_at TEXT,
      duration_seconds INTEGER,
      closure_reason TEXT,
      scenario_type TEXT DEFAULT 'single_file',
      submitted_diff TEXT,
      scenario_evaluation_context TEXT,
      scenario_semantic_snapshot TEXT,
      ai_capability_snapshot TEXT
    );
  `);

  database
    .prepare(
      `INSERT INTO assessment_sessions (
        id, candidate_token_hash, scenario_id, scenario_version, scenario_title,
        scenario_brief, acceptance_criteria, file_path, original_content, status,
        working_content, submitted_content, created_at, activated_at, submitted_at,
        duration_seconds, closure_reason, ai_capability_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'hist-active-untimed',
      hashCandidateToken('legacy-candidate-token'),
      'slice-1-greeting-format',
      '1.0.0',
      'Greeting Format',
      'Brief',
      JSON.stringify(['Acceptance criterion 1']),
      'src/file.ts',
      'export const original = 1;\n',
      'ACTIVE',
      'export const original = 1;\n',
      null,
      '2026-09-01T10:00:00.000Z',
      '2026-09-01T10:01:00.000Z',
      null,
      null,
      null,
      JSON.stringify(defaultAiCapabilitySnapshot),
    );

  database.close();
  const adoption = new Database(databasePath);
  try {
    migrateLegacyCandidateTokens(adoption, { adoptExisting: true });
  } finally {
    adoption.close();
  }
};

describe('T1A.2 — Request-Bound Deadline Cutoff', () => {
  let tempDir: string;
  let databasePath: string;
  let currentTime: string;
  let store: SqliteSessionStore;
  let eventStore: SqliteEventStore;
  let sandboxAdapter: MockSandboxAdapter;
  let mockAiProvider: MockAiProvider;
  let aiService: AiInteractionService;
  let service: SessionService;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'hirearchy-t1a2-'));
    databasePath = path.join(tempDir, 'hirearchy.sqlite');
    currentTime = '2026-09-20T10:00:00.000Z';

    store = new SqliteSessionStore(databasePath);
    eventStore = new SqliteEventStore(databasePath);
    sandboxAdapter = new MockSandboxAdapter();
    mockAiProvider = new MockAiProvider();

    const transactionRunner = new SqliteTransactionRunner(databasePath);
    transactionRunner.registerInitializer(SqliteSessionStore.ensureSchema);
    transactionRunner.registerInitializer(SqliteEventStore.ensureSchema);
    transactionRunner.registerInitializer(
      SqliteAiInteractionStore.ensureSchema,
    );

    aiService = new AiInteractionService({
      sessionStore: store,
      eventStore,
      aiInteractionStore: new SqliteAiInteractionStore(databasePath),
      transactionRunner,
      providerRegistry: new DefaultAiProviderRegistry([mockAiProvider]),
      now: () => currentTime,
    });

    service = new SessionService(store, {
      eventStore,
      sandboxAdapter,
      transactionRunner,
      aiInteractionService: aiService,
      now: () => currentTime,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Setup helper for a timed active session (activated at 10:00:00, duration 900s -> deadline 10:15:00)
  const setupActiveTimedSession = async (options?: {
    scenarioType?: 'single_file' | 'multi_file';
    aiCapability?: AiCapabilitySnapshot;
  }) => {
    currentTime = '2026-09-20T10:00:00.000Z';
    const { candidateToken } = service.createSession({
      scenario: {
        ...sliceOneScenario,
        durationSeconds: 900,
        type: options?.scenarioType ?? 'single_file',
      },
      aiCapability: options?.aiCapability ?? defaultAiCapabilitySnapshot,
    });

    const active = await service.activate(candidateToken);
    expect(active.status).toBe('ACTIVE');
    expect(deriveSessionDeadline(active)).toBe('2026-09-20T10:15:00.000Z');
    return { candidateToken, session: active };
  };

  describe('1. Single-File Save Cutoff', () => {
    it('1. single-file save before deadline succeeds', async () => {
      const { candidateToken } = await setupActiveTimedSession();

      currentTime = '2026-09-20T10:14:59.999Z';
      const updated = await service.save(candidateToken, 'edits before zero\n');

      expect(updated.workingContent).toBe('edits before zero\n');
    });

    it('2. single-file save at exact deadline is rejected', async () => {
      const { candidateToken } = await setupActiveTimedSession();

      currentTime = '2026-09-20T10:15:00.000Z'; // exact boundary
      await expect(
        service.save(candidateToken, 'edit at deadline\n'),
      ).rejects.toThrowError(
        new SessionError(
          'SESSION_DEADLINE_EXCEEDED',
          'The assessment time limit has been reached. New modifications are no longer permitted.',
        ),
      );
    });

    it('3. single-file save after deadline is rejected', async () => {
      const { candidateToken } = await setupActiveTimedSession();

      currentTime = '2026-09-20T10:15:00.001Z';
      await expect(
        service.save(candidateToken, 'edit after deadline\n'),
      ).rejects.toThrowError(
        new SessionError(
          'SESSION_DEADLINE_EXCEEDED',
          'The assessment time limit has been reached. New modifications are no longer permitted.',
        ),
      );
    });

    it('4. rejected save leaves authoritative content and sandbox mirror unchanged', async () => {
      const { candidateToken, session } = await setupActiveTimedSession();

      // Pre-deadline save sets baseline content
      currentTime = '2026-09-20T10:05:00.000Z';
      await service.save(
        candidateToken,
        'authoritative content before deadline\n',
      );

      // Attempt save after deadline
      currentTime = '2026-09-20T10:16:00.000Z';
      await expect(
        service.save(candidateToken, 'illegal post-deadline content\n'),
      ).rejects.toThrowError(SessionError);

      // Verify authoritative database content unchanged
      const reloaded = service.getCandidateSession(candidateToken);
      expect(reloaded.workingContent).toBe(
        'authoritative content before deadline\n',
      );

      // Verify sandbox mirror unchanged
      const sandboxContent = await sandboxAdapter.readFile(
        session.id,
        session.scenario.filePath,
      );
      expect(sandboxContent).toBe('authoritative content before deadline\n');
    });

    it('5. rejected save emits no workspace-change evidence', async () => {
      const { candidateToken, session } = await setupActiveTimedSession();

      currentTime = '2026-09-20T10:15:05.000Z';
      await expect(
        service.save(candidateToken, 'attempted change\n'),
      ).rejects.toThrowError(SessionError);

      const events = eventStore.getEvents(session.id);
      const workspaceEvents = events.filter(
        (e) => e.type === 'WORKSPACE_CHANGED',
      );
      expect(workspaceEvents).toHaveLength(0);
    });

    it('6. queued pre-deadline save that reaches execution after deadline is rejected', async () => {
      const { candidateToken } = await setupActiveTimedSession();

      // Initial save establishes content
      currentTime = '2026-09-20T10:10:00.000Z';
      await service.save(candidateToken, 'initial state\n');

      let releaseOp1Write: () => void;
      const op1WriteBarrier = new Promise<void>((resolve) => {
        releaseOp1Write = resolve;
      });
      let notifyOp1ReachedBarrier: () => void;
      const op1ReachedBarrier = new Promise<void>((resolve) => {
        notifyOp1ReachedBarrier = resolve;
      });

      let writeCount = 0;
      const originalWriteFile = sandboxAdapter.writeFile.bind(sandboxAdapter);
      vi.spyOn(sandboxAdapter, 'writeFile').mockImplementation(
        async (id, filePath, content) => {
          writeCount++;
          if (writeCount === 1) {
            notifyOp1ReachedBarrier();
            await op1WriteBarrier;
          }
          return originalWriteFile(id, filePath, content);
        },
      );

      // Start op1 before deadline (enters withSessionLock and pauses inside write barrier)
      currentTime = '2026-09-20T10:14:59.900Z';
      const op1Promise = service.save(candidateToken, 'mutation 1\n');

      // Wait until op1 is confirmed running inside lock and waiting on barrier
      await op1ReachedBarrier;

      // While op1 is holding the lock, op2 queues before deadline
      currentTime = '2026-09-20T10:14:59.950Z';
      const op2Promise = service.save(candidateToken, 'mutation 2\n');

      // Now server clock advances past deadline while op1 finishes:
      currentTime = '2026-09-20T10:15:00.050Z';

      // Release op1 to complete its write
      releaseOp1Write!();
      const op1Result = await op1Promise;
      expect(op1Result.workingContent).toBe('mutation 1\n');

      // op2 now enters withSessionLock, checks now (10:15:00.050 >= 10:15:00.000), and is denied!
      await expect(op2Promise).rejects.toThrowError(
        new SessionError(
          'SESSION_DEADLINE_EXCEEDED',
          'The assessment time limit has been reached. New modifications are no longer permitted.',
        ),
      );

      // Content remains mutation 1
      const finalSession = service.getCandidateSession(candidateToken);
      expect(finalSession.workingContent).toBe('mutation 1\n');
    });

    it('7. multi-file workspace save is rejected with zero mutation and zero evidence', async () => {
      const { candidateToken, session } = await setupActiveTimedSession({
        scenarioType: 'multi_file',
      });

      currentTime = '2026-09-20T10:15:00.000Z';
      await expect(
        service.saveWorkspaceFile(
          candidateToken,
          'src/greeting.ts',
          'export const greeting = "overdue";',
        ),
      ).rejects.toThrowError(
        new SessionError(
          'SESSION_DEADLINE_EXCEEDED',
          'The assessment time limit has been reached. New modifications are no longer permitted.',
        ),
      );

      const events = eventStore.getEvents(session.id);
      const changeEvents = events.filter(
        (e) =>
          e.type === 'WORKSPACE_CHANGED' ||
          e.type === 'WORKSPACE_CAPTURE_FAILED',
      );
      expect(changeEvents).toHaveLength(0);
    });
  });

  describe('2. Command Admission Cutoff', () => {
    it('8. command before deadline is admitted normally', async () => {
      const { candidateToken } = await setupActiveTimedSession();

      currentTime = '2026-09-20T10:14:00.000Z';
      const result = await service.executeCommand(candidateToken, 'echo ok');
      expect(result.exitCode).toBe(0);
    });

    it('9. command at exact deadline is rejected', async () => {
      const { candidateToken } = await setupActiveTimedSession();

      currentTime = '2026-09-20T10:15:00.000Z';
      await expect(
        service.executeCommand(candidateToken, 'npm test'),
      ).rejects.toThrowError(
        new SessionError(
          'SESSION_DEADLINE_EXCEEDED',
          'The assessment time limit has been reached. New modifications are no longer permitted.',
        ),
      );
    });

    it('10. command after deadline is rejected', async () => {
      const { candidateToken } = await setupActiveTimedSession();

      currentTime = '2026-09-20T10:15:01.000Z';
      await expect(
        service.executeCommand(candidateToken, 'ls -la'),
      ).rejects.toThrowError(
        new SessionError(
          'SESSION_DEADLINE_EXCEEDED',
          'The assessment time limit has been reached. New modifications are no longer permitted.',
        ),
      );
    });

    it('11. rejected command never invokes adapter exec', async () => {
      const { candidateToken } = await setupActiveTimedSession();
      const execSpy = vi.spyOn(sandboxAdapter, 'exec');

      currentTime = '2026-09-20T10:15:10.000Z';
      await expect(
        service.executeCommand(candidateToken, 'npm test'),
      ).rejects.toThrowError(SessionError);

      expect(execSpy).not.toHaveBeenCalled();
    });

    it('12. rejected command emits no command evidence', async () => {
      const { candidateToken, session } = await setupActiveTimedSession();

      currentTime = '2026-09-20T10:15:10.000Z';
      await expect(
        service.executeCommand(candidateToken, 'npm test'),
      ).rejects.toThrowError(SessionError);

      const events = eventStore.getEvents(session.id);
      const commandEvents = events.filter(
        (e) => e.type === 'COMMAND_STARTED' || e.type === 'COMMAND_FINISHED',
      );
      expect(commandEvents).toHaveLength(0);
    });
  });

  describe('3. AI Interaction Deadline Cutoff & Idempotent Replay', () => {
    it('13. new AI request before deadline admits and executes normally', async () => {
      const { session } = await setupActiveTimedSession();

      currentTime = '2026-09-20T10:14:00.000Z';
      const result = await aiService.executeInteraction(session.id, {
        clientRequestId: 'req-pre-deadline-1',
        candidatePromptText: 'Help me understand the greeting format.',
      });

      expect(result.status).toBe('COMPLETED');
      expect(result.interactionId).toBeDefined();
    });

    it('14. new AI request at/after deadline is rejected', async () => {
      const { session } = await setupActiveTimedSession();

      currentTime = '2026-09-20T10:15:00.000Z';
      await expect(
        aiService.executeInteraction(session.id, {
          clientRequestId: 'req-at-deadline-1',
          candidatePromptText: 'Help me after deadline.',
        }),
      ).rejects.toThrowError(
        new AiInteractionError(
          'SESSION_DEADLINE_EXCEEDED',
          'The assessment time limit has been reached. New modifications are no longer permitted.',
        ),
      );

      currentTime = '2026-09-20T10:15:30.000Z';
      await expect(
        aiService.executeInteraction(session.id, {
          clientRequestId: 'req-after-deadline-1',
          candidatePromptText: 'Help me after deadline 2.',
        }),
      ).rejects.toThrowError(
        new AiInteractionError(
          'SESSION_DEADLINE_EXCEEDED',
          'The assessment time limit has been reached. New modifications are no longer permitted.',
        ),
      );
    });

    it('15. rejected AI request creates no interaction row, no event, and no provider call', async () => {
      const { session } = await setupActiveTimedSession();
      const providerSpy = vi.spyOn(mockAiProvider, 'execute');

      currentTime = '2026-09-20T10:15:01.000Z';
      await expect(
        aiService.executeInteraction(session.id, {
          clientRequestId: 'req-rejected-audit',
          candidatePromptText: 'Denied prompt.',
        }),
      ).rejects.toThrowError(AiInteractionError);

      expect(providerSpy).not.toHaveBeenCalled();

      // No interaction in store
      const interactionStore = new SqliteAiInteractionStore(databasePath);
      const existing = interactionStore.findByClientRequestId(
        session.id,
        'req-rejected-audit',
      );
      expect(existing).toBeNull();

      // No AI event in store
      const events = eventStore.getEvents(session.id);
      const aiEvents = events.filter((e) => e.type.startsWith('AI_'));
      expect(aiEvents).toHaveLength(0);
    });

    it('16. existing clientRequestId replay still works after deadline', async () => {
      const { session } = await setupActiveTimedSession();

      // Admitted and completed before deadline
      currentTime = '2026-09-20T10:05:00.000Z';
      const original = await aiService.executeInteraction(session.id, {
        clientRequestId: 'idempotent-key-1',
        candidatePromptText: 'First prompt.',
      });
      expect(original.status).toBe('COMPLETED');
      expect(original.responseText).toBeDefined();

      // After deadline: replay with same clientRequestId
      currentTime = '2026-09-20T10:20:00.000Z'; // 5 minutes overdue
      const replay = await aiService.executeInteraction(session.id, {
        clientRequestId: 'idempotent-key-1',
        candidatePromptText: 'First prompt.',
      });

      expect(replay.status).toBe('COMPLETED');
      expect(replay.interactionId).toBe(original.interactionId);
      expect(replay.responseText).toBe(original.responseText);
    });

    it('17. replay check occurs before deadline rejection', async () => {
      const { session } = await setupActiveTimedSession();

      currentTime = '2026-09-20T10:00:10.000Z';
      const original = await aiService.executeInteraction(session.id, {
        clientRequestId: 'replay-first-check',
        candidatePromptText: 'Test replay first check.',
      });

      // At exact deadline
      currentTime = '2026-09-20T10:15:00.000Z';
      const replayAtDeadline = await aiService.executeInteraction(session.id, {
        clientRequestId: 'replay-first-check',
        candidatePromptText: 'Ignored new text.',
      });
      expect(replayAtDeadline.interactionId).toBe(original.interactionId);

      // Past deadline
      currentTime = '2026-09-20T11:00:00.000Z';
      const replayFarPastDeadline = await aiService.executeInteraction(
        session.id,
        {
          clientRequestId: 'replay-first-check',
          candidatePromptText: 'Ignored new text.',
        },
      );
      expect(replayFarPastDeadline.interactionId).toBe(original.interactionId);
    });

    it('18. existing in-flight AI provider execution remains unaffected by deadline crossing', async () => {
      const { session } = await setupActiveTimedSession();

      // Admit before deadline
      currentTime = '2026-09-20T10:14:59.000Z';
      const admission = aiService.admitInteraction(session.id, {
        clientRequestId: 'in-flight-ai-1',
        candidatePromptText: 'Admitted before zero.',
      });
      expect(admission.wasAdmitted).toBe(true);

      const claim = aiService.claimDispatch(admission.interaction.id);
      expect(claim.claimed).toBe(true);

      // Server clock crosses deadline while provider is executing
      currentTime = '2026-09-20T10:15:05.000Z';

      // Provider completes after deadline
      const completed = aiService.recordCompletion(admission.interaction.id, {
        responseText: 'Provider completed successfully after zero.',
        durationMs: 6000,
      });

      expect(completed.status).toBe('COMPLETED');
      expect(completed.capturedResponseText).toBe(
        'Provider completed successfully after zero.',
      );
    });
  });

  describe('4. Legacy Untimed Sessions Compatibility', () => {
    it('19. legacy ACTIVE session with null duration still admits save, command, and AI', async () => {
      createLegacySessionDatabase(databasePath);
      await sandboxAdapter.createAndVerify('hist-active-untimed', {
        'src/file.ts': 'export const original = 1;\n',
      });

      // Use service with the legacy DB
      currentTime = '2026-09-25T12:00:00.000Z'; // Far in the future
      const legacySession = store.findById('hist-active-untimed');
      expect(legacySession).not.toBeNull();
      expect(legacySession?.durationSeconds).toBeNull();
      expect(deriveSessionDeadline(legacySession!)).toBeNull();

      // 1. Save admitted
      const saved = await service.save(
        'legacy-candidate-token',
        'legacy edit\n',
      );
      expect(saved.workingContent).toBe('legacy edit\n');

      // 2. Command admitted
      const cmdResult = await service.executeCommand(
        'legacy-candidate-token',
        'echo legacy',
      );
      expect(cmdResult.exitCode).toBe(0);

      // 3. AI interaction admitted
      const aiResult = await aiService.executeInteraction(
        'hist-active-untimed',
        {
          clientRequestId: 'legacy-ai-req',
          candidatePromptText: 'Prompt for legacy session.',
        },
      );
      expect(aiResult.status).toBe('COMPLETED');
    });
  });

  describe('5. Closure Reason Security Check', () => {
    it('20. candidate submit API cannot select closureReason = timeout', async () => {
      // Create a session with a deadline far in the future so the route's real wall-clock
      // now() still sees the session as pre-deadline. The security invariant is that the
      // route body cannot force closureReason = 'timeout'; session timing is orthogonal.
      const farFuture = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000,
      ).toISOString();
      currentTime = farFuture;
      const { candidateToken } = service.createSession({
        scenario: {
          ...sliceOneScenario,
          durationSeconds: 2 * 365 * 24 * 60 * 60, // 2 years from farFuture
          type: 'single_file',
        },
        aiCapability: defaultAiCapabilitySnapshot,
      });
      await service.activate(candidateToken);

      // Set environment variable so route handlers pointing to HIREARCHY_DB_PATH use our test database
      process.env.HIREARCHY_DB_PATH = databasePath;

      // A malicious or crafted candidate request attempts to send closureReason = 'timeout'
      const maliciousPayload = JSON.stringify({ closureReason: 'timeout' });
      const request = new Request(
        `http://localhost/api/candidate/sessions/${candidateToken}/submit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: maliciousPayload,
        },
      );

      const response = await submitRoutePost(request, {
        params: Promise.resolve({ token: candidateToken }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.status).toBe('SUBMITTED');
      expect(json.closureReason).toBe('candidate_submission');

      // Double check in database via service
      const reloaded = service.getCandidateSession(candidateToken);
      expect(reloaded.status).toBe('SUBMITTED');
      expect(reloaded.closureReason).toBe('candidate_submission');
    });
  });

  describe('6. Intermediate State & Truthful HTTP Error Mapping', () => {
    it('21. overdue session remains status = ACTIVE and closureReason = null after deadline rejection', async () => {
      const { candidateToken, session } = await setupActiveTimedSession();

      currentTime = '2026-09-20T10:15:30.000Z';
      await expect(
        service.save(candidateToken, 'illegal write\n'),
      ).rejects.toThrowError(SessionError);

      await expect(
        service.executeCommand(candidateToken, 'npm test'),
      ).rejects.toThrowError(SessionError);

      await expect(
        aiService.executeInteraction(session.id, {
          clientRequestId: 'new-denied-req',
          candidatePromptText: 'illegal ai\n',
        }),
      ).rejects.toThrowError(AiInteractionError);

      // Verify intermediate state integrity:
      const persisted = store.findById(session.id);
      expect(persisted?.status).toBe('ACTIVE');
      expect(persisted?.closureReason).toBeNull();
    });

    it('22. errorResponse maps SESSION_DEADLINE_EXCEEDED to HTTP 409 Conflict with truthful message', async () => {
      const sessionErr = new SessionError(
        'SESSION_DEADLINE_EXCEEDED',
        'The assessment time limit has been reached. New modifications are no longer permitted.',
      );
      const res1 = errorResponse(sessionErr);
      expect(res1.status).toBe(409);
      const json1 = await res1.json();
      expect(json1).toEqual({
        error: {
          code: 'SESSION_DEADLINE_EXCEEDED',
          message:
            'The assessment time limit has been reached. New modifications are no longer permitted.',
        },
      });

      const aiErr = new AiInteractionError(
        'SESSION_DEADLINE_EXCEEDED',
        'The assessment time limit has been reached. New modifications are no longer permitted.',
      );
      const res2 = errorResponse(aiErr);
      expect(res2.status).toBe(409);
      const json2 = await res2.json();
      expect(json2).toEqual({
        error: {
          code: 'SESSION_DEADLINE_EXCEEDED',
          message:
            'The assessment time limit has been reached. New modifications are no longer permitted.',
        },
      });
    });
  });
});
