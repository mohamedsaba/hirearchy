import {
  cloneAiCapabilitySnapshot,
  type AiCapabilitySnapshot,
  disabledAiCapabilitySnapshot,
} from '../ai/ai-interaction';
import { AiInteractionService } from '../ai/ai-interaction-service';
import { SqliteAiInteractionStore } from '../ai/sqlite-ai-interaction-store';
import { cloneTaskRubric } from '../assessments/task-rubric';
import type { TaskRubricSnapshot } from '../assessments/task-rubric';
import { cloneScenarioSemanticSnapshot } from '../scenarios/scenario-semantic-snapshot';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { getApplicationDatabasePath } from '../database/database-path';
import { loadValidatedGeneratedAssessment } from '../scenarios/generated-assessment';

import { SqliteTransactionRunner } from '../database/sqlite-transaction-runner';
import {
  createSubmittedDiff,
  normalizeLineEndings,
} from '../evidence/unified-diff';
import type { WorkspaceChangedPayload } from '../events/session-event';
import { SqliteEventStore } from '../events/sqlite-event-store';
import { DockerSandboxAdapter } from '../sandbox/docker-sandbox-adapter';
import {
  type CommandExecResult,
  type SandboxAdapter,
  MAX_COMMAND_LENGTH,
  MAX_WORKSPACE_FILE_READ_BYTES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  SandboxError,
} from '../sandbox/sandbox';
import { scenario001 } from '../scenarios/scenario-001';
import { cloneScenarioEvaluationContext } from '../scenarios/scenario-evaluation-context';
import {
  type ScenarioSnapshot,
  sliceOneScenario,
} from '../scenarios/slice-one-scenario';
import {
  type AssessmentSession,
  requireSubmittedSession,
  SessionError,
} from './session';
import {
  getSessionOperationCoordinator,
  SessionOperationCoordinator,
} from './session-operation-coordinator';
import {
  type CandidateTimingProjection,
  deriveSessionDeadline,
  isDeadlineExceeded,
  toCandidateTimingProjection,
} from './session-timing';
import {
  type AssessmentIssuanceIdentity,
  type AssessmentIssuanceWriteResult,
  type AssessmentLifecycleEntry,
  SqliteSessionStore,
  type StoredAssessmentIssuance,
} from './sqlite-session-store';
import {
  evaluatorReviewLimit,
  type EvaluatorReviewEntry,
} from '../evaluator/evaluator-review-entry';
import { assertApplicationStartupReady } from '../startup-status';

const maximumContentLength = MAX_WORKSPACE_FILE_READ_BYTES;

const hashCandidateToken = (candidateToken: string) =>
  createHash('sha256').update(candidateToken).digest('hex');

type SessionCreationOptions = Readonly<{
  scenarioId?: string;
  scenario?: ScenarioSnapshot;
  aiCapability?: AiCapabilitySnapshot | null;
  taskRubricSnapshot?: TaskRubricSnapshot | null;
  terminalEnabled?: boolean;
}>;

export type SessionServiceOptions = Readonly<{
  now?: () => string;
  createId?: () => string;
  createToken?: () => string;
  eventStore?: SqliteEventStore;
  sandboxAdapter?: SandboxAdapter;
  coordinator?: SessionOperationCoordinator;
  transactionRunner?: SqliteTransactionRunner;
  aiInteractionService?: AiInteractionService;
  commandTimeoutMs?: number;
  onSessionFinalized?: (sessionId: string) => void | Promise<void>;
}>;

export class SessionReconciliationError extends Error {
  constructor() {
    super('Session reconciliation is incomplete.');
    this.name = 'SessionReconciliationError';
  }
}

export class SessionService {
  readonly now: () => string;
  private readonly createId: () => string;
  private readonly createToken: () => string;
  private readonly eventStore?: SqliteEventStore;
  private readonly sandboxAdapter?: SandboxAdapter;
  private readonly coordinator: SessionOperationCoordinator;
  private readonly transactionRunner: SqliteTransactionRunner;
  private readonly aiInteractionService: AiInteractionService;
  private readonly commandTimeoutMs: number;
  private readonly onSessionFinalized?: (
    sessionId: string,
  ) => void | Promise<void>;

  private async withSessionLock<T>(
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.coordinator.run(sessionId, fn);
  }

  private async detectAndRecordDrift(
    sessionId: string,
    source: 'server' = 'server',
  ): Promise<{ currentTree: string; driftDetected: boolean }> {
    if (!this.sandboxAdapter) {
      return { currentTree: '', driftDetected: false };
    }

    const currentTree =
      await this.sandboxAdapter.captureWorkspaceTree(sessionId);

    let lastKnownTree: string;
    if (this.eventStore) {
      const events = this.eventStore.getEvents(sessionId);
      const workspaceEvents = events.filter(
        (e) => e.type === 'WORKSPACE_CHANGED',
      );
      if (workspaceEvents.length > 0) {
        lastKnownTree = (
          workspaceEvents[workspaceEvents.length - 1]
            .payload as WorkspaceChangedPayload
        ).afterTree;
      } else {
        lastKnownTree = await this.sandboxAdapter.getBaselineTree(sessionId);
      }
    } else {
      lastKnownTree = await this.sandboxAdapter.getBaselineTree(sessionId);
    }

    if (currentTree !== lastKnownTree) {
      const diffResult = await this.sandboxAdapter.captureTreeDiff(
        sessionId,
        lastKnownTree,
        currentTree,
      );

      if (this.eventStore) {
        this.eventStore.append({
          id: `evt_${this.createId()}`,
          sessionId,
          type: 'WORKSPACE_CHANGED',
          timestamp: this.now(),
          source,
          payload: {
            changeId: `chg_${this.createId()}`,
            origin: 'out_of_band',
            beforeTree: lastKnownTree,
            afterTree: currentTree,
            files: diffResult.files,
            totalAdditions: diffResult.totalAdditions,
            totalDeletions: diffResult.totalDeletions,
          },
        });
      }
      return { currentTree, driftDetected: true };
    }

    return { currentTree, driftDetected: false };
  }

  constructor(
    private readonly store: SqliteSessionStore,
    options: SessionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
    this.createToken =
      options.createToken ?? (() => randomBytes(32).toString('base64url'));
    this.eventStore = options.eventStore;
    this.sandboxAdapter = options.sandboxAdapter;
    this.coordinator = options.coordinator ?? getSessionOperationCoordinator();
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.onSessionFinalized = options.onSessionFinalized;
    this.transactionRunner =
      options.transactionRunner ??
      new SqliteTransactionRunner(store.databasePath);
    this.transactionRunner.registerInitializer((database, allowNewDatabase) =>
      SqliteSessionStore.ensureSchema(database, { allowNewDatabase }),
    );
    this.transactionRunner.registerInitializer(SqliteEventStore.ensureSchema);
    this.transactionRunner.registerInitializer(
      SqliteAiInteractionStore.ensureSchema,
    );
    this.aiInteractionService =
      options.aiInteractionService ??
      new AiInteractionService({
        sessionStore: store,
        eventStore:
          options.eventStore ?? new SqliteEventStore(store.databasePath),
        aiInteractionStore: new SqliteAiInteractionStore(store.databasePath),
        transactionRunner: this.transactionRunner,
        createId: this.createId,
        now: this.now,
      });
  }

  createSession(options?: SessionCreationOptions) {
    const issuance = this.buildSession(options);
    this.store.create(issuance.session);
    return issuance;
  }

  verifyStorageForStartup() {
    this.store.verifyStorageForStartup();
  }

  createAssessmentSession(
    options: SessionCreationOptions,
    identity: Pick<AssessmentIssuanceIdentity, 'key' | 'requestHash'>,
  ): AssessmentIssuanceWriteResult & { candidateToken: string | null } {
    const issuance = this.buildSession(options);
    const written = this.store.createIdempotently(issuance.session, identity);
    return {
      ...written,
      candidateToken: written.created ? issuance.candidateToken : null,
    };
  }

  findAssessmentIssuanceByKey(key: string): StoredAssessmentIssuance | null {
    return this.store.findAssessmentIssuanceByKey(key);
  }

  recoverCandidateTokenForAssessment(sessionId: string): string | null {
    return this.store.recoverCandidateTokenForAssessment(sessionId);
  }

  private buildSession(options?: SessionCreationOptions) {
    const candidateToken = this.createToken();
    const scenario =
      options?.scenario ??
      (options?.scenarioId === scenario001.id ||
      options?.scenarioId === 'scenario-001'
        ? scenario001
        : sliceOneScenario);

    const durationSeconds = scenario.durationSeconds;
    if (
      typeof durationSeconds !== 'number' ||
      !Number.isInteger(durationSeconds) ||
      durationSeconds <= 0
    ) {
      throw new SessionError(
        'INVALID_SCENARIO_DURATION',
        'Scenario duration must be a positive integer.',
      );
    }

    const originalContent = normalizeLineEndings(scenario.originalContent);
    const session: AssessmentSession = {
      id: this.createId(),
      candidateToken,
      candidateTokenHash: hashCandidateToken(candidateToken),
      scenario: {
        ...scenario,
        durationSeconds,
        originalContent,
        semanticSnapshot: cloneScenarioSemanticSnapshot(
          scenario.semanticSnapshot,
        ),
        evaluationContext: cloneScenarioEvaluationContext(
          scenario.evaluationContext,
        ),
      },
      status: 'CREATED',
      workingContent: originalContent,
      submittedContent: null,
      createdAt: this.now(),
      activatedAt: null,
      submittedAt: null,
      durationSeconds,
      closureReason: null,
      scenarioType: scenario.type ?? 'single_file',
      submittedDiff: null,
      aiCapabilitySnapshot:
        options?.aiCapability !== undefined
          ? cloneAiCapabilitySnapshot(options.aiCapability)
          : cloneAiCapabilitySnapshot(disabledAiCapabilitySnapshot),
      taskRubricSnapshot: cloneTaskRubric(options?.taskRubricSnapshot),
      terminalEnabled: options?.terminalEnabled ?? true,
    };

    return { candidateToken, session };
  }

  getCandidateTiming(candidateToken: string): CandidateTimingProjection {
    const session = this.getCandidateSession(candidateToken);
    return toCandidateTimingProjection(session, this.now());
  }

  getCandidateSession(candidateToken: string) {
    const session = this.store.findByCandidateTokenHash(
      hashCandidateToken(candidateToken),
    );

    if (!session) {
      throw new SessionError(
        'SESSION_NOT_FOUND',
        'The candidate session was not found.',
      );
    }

    return session;
  }

  async activate(candidateToken: string) {
    const tokenHash = hashCandidateToken(candidateToken);
    const session = this.store.findByCandidateTokenHash(tokenHash);

    if (!session) {
      throw new SessionError(
        'SESSION_NOT_FOUND',
        'The candidate session was not found.',
      );
    }

    return this.withSessionLock(session.id, async () => {
      const current = this.store.findByCandidateTokenHash(tokenHash);
      if (!current) {
        throw new SessionError(
          'SESSION_NOT_FOUND',
          'The candidate session was not found.',
        );
      }

      if (current.status === 'ACTIVE') {
        return current;
      }

      if (current.status !== 'CREATED') {
        throw new SessionError(
          'SESSION_NOT_ACTIVE',
          'A submitted session cannot be activated.',
        );
      }

      // Readiness gate: Sandbox must be created and verified before session transitions to ACTIVE
      if (this.sandboxAdapter) {
        if (
          current.scenarioType === 'multi_file' ||
          current.scenario.type === 'multi_file'
        ) {
          const generated = current.scenario.id.startsWith('generated-')
            ? await loadValidatedGeneratedAssessment(
                path.dirname(getApplicationDatabasePath()),
                current.scenario.id,
              )
            : null;
          if (current.scenario.id.startsWith('generated-') && !generated) {
            throw new SessionError(
              'SCENARIO_UNAVAILABLE',
              'The validated assessment files are unavailable.',
            );
          }
          await this.sandboxAdapter.createAndVerify(current.id, {
            imageName:
              current.scenario.imageName ?? 'hirearchy-scenario-001:latest',
            scenarioType: 'multi_file',
            ...(generated ? { generatedWorkspace: true } : {}),
            ...(generated
              ? {
                  initialFiles: Object.fromEntries(
                    [
                      ...generated.assessment.starterFiles,
                      ...generated.assessment.targetTests,
                    ].map((file) => [file.path, file.content]),
                  ),
                }
              : {}),
          });
        } else {
          await this.sandboxAdapter.createAndVerify(current.id, {
            [current.scenario.filePath]: current.workingContent,
          });
        }
      }

      // Only after readiness succeeds, transition to ACTIVE and record activatedAt
      return this.store.activate(tokenHash, this.now());
    });
  }

  async save(candidateToken: string, content: string) {
    if (content.length > maximumContentLength) {
      throw new SessionError(
        'CONTENT_TOO_LARGE',
        'The file exceeds the 100 KB limit for this scenario.',
      );
    }

    const tokenHash = hashCandidateToken(candidateToken);
    const session = this.store.findByCandidateTokenHash(tokenHash);

    if (!session) {
      throw new SessionError(
        'SESSION_NOT_FOUND',
        'The candidate session was not found.',
      );
    }

    return this.withSessionLock(session.id, async () => {
      const current = this.store.findByCandidateTokenHash(tokenHash);
      if (!current) {
        throw new SessionError(
          'SESSION_NOT_FOUND',
          'The candidate session was not found.',
        );
      }

      if (current.status !== 'ACTIVE') {
        throw new SessionError(
          'SESSION_NOT_ACTIVE',
          'Editing is allowed only while the session is active.',
        );
      }

      if (current.closureReason !== null) {
        throw new SessionError(
          'SESSION_FINALIZATION_STARTED',
          'Finalization has already started. Candidate mutations are no longer permitted.',
        );
      }

      const deadline = deriveSessionDeadline(current);
      const now = this.now();
      if (deadline !== null && isDeadlineExceeded(deadline, now)) {
        throw new SessionError(
          'SESSION_DEADLINE_EXCEEDED',
          'The assessment time limit has been reached. New modifications are no longer permitted.',
        );
      }

      const previousContent = current.workingContent;
      const normalized = normalizeLineEndings(content);
      const updated = this.store.save(tokenHash, normalized);

      if (this.sandboxAdapter && updated.status === 'ACTIVE') {
        try {
          await this.sandboxAdapter.writeFile(
            updated.id,
            updated.scenario.filePath,
            normalized,
          );
        } catch (error) {
          try {
            this.store.save(tokenHash, previousContent);
          } catch {
            console.error(
              'Failed to rollback session working content [SESSION_ROLLBACK_FAILED]',
            );
          }
          throw error;
        }
      }

      return updated;
    });
  }

  async executeCommand(
    candidateToken: string,
    command: string,
  ): Promise<CommandExecResult> {
    const tokenHash = hashCandidateToken(candidateToken);
    const session = this.store.findByCandidateTokenHash(tokenHash);

    if (!session) {
      throw new SessionError(
        'SESSION_NOT_FOUND',
        'The candidate session was not found.',
      );
    }

    return this.withSessionLock(session.id, async () => {
      const current = this.store.findByCandidateTokenHash(tokenHash);
      if (!current) {
        throw new SessionError(
          'SESSION_NOT_FOUND',
          'The candidate session was not found.',
        );
      }

      if (current.status !== 'ACTIVE') {
        throw new SessionError(
          'SESSION_NOT_ACTIVE',
          'Commands can be executed only while the session is active.',
        );
      }

      if (current.closureReason !== null) {
        throw new SessionError(
          'SESSION_FINALIZATION_STARTED',
          'Finalization has already started. Candidate mutations are no longer permitted.',
        );
      }

      if (current.terminalEnabled === false) {
        throw new SessionError(
          'TERMINAL_NOT_ENABLED',
          'Terminal access is not enabled for this assessment.',
        );
      }

      const deadline = deriveSessionDeadline(current);
      const now = this.now();
      if (deadline !== null && isDeadlineExceeded(deadline, now)) {
        throw new SessionError(
          'SESSION_DEADLINE_EXCEEDED',
          'The assessment time limit has been reached. New modifications are no longer permitted.',
        );
      }

      const effectiveTimeoutMs =
        deadline === null
          ? this.commandTimeoutMs
          : Math.min(
              this.commandTimeoutMs,
              Date.parse(deadline) - Date.parse(now),
            );

      if (command.length > MAX_COMMAND_LENGTH) {
        throw new SessionError(
          'COMMAND_TOO_LARGE',
          `Command exceeds the maximum limit of ${MAX_COMMAND_LENGTH} characters.`,
        );
      }

      if (!this.sandboxAdapter) {
        throw new SandboxError(
          'SANDBOX_NOT_FOUND',
          'No sandbox runtime is configured for this environment.',
        );
      }

      const isMultiFile =
        current.scenarioType === 'multi_file' ||
        current.scenario.type === 'multi_file';

      let beforeTree: string | null = null;
      if (isMultiFile) {
        try {
          const driftResult = await this.detectAndRecordDrift(current.id);
          beforeTree = driftResult.currentTree;
        } catch {
          throw new SessionError(
            'PLATFORM_CAPTURE_FAILED',
            'Pre-command workspace capture failed.',
          );
        }
      }

      const commandId = `cmd_${this.createId()}`;

      // 1. Authoritatively record COMMAND_STARTED
      if (this.eventStore) {
        this.eventStore.append({
          id: `evt_${this.createId()}`,
          sessionId: current.id,
          type: 'COMMAND_STARTED',
          timestamp: this.now(),
          source: 'server',
          payload: {
            commandId,
            command,
            cwd: '/workspace',
          },
        });
      }

      // 2. Execute command in sandbox
      const result = await this.sandboxAdapter.exec(
        current.id,
        commandId,
        command,
        '/workspace',
        effectiveTimeoutMs,
      );

      // 3. Authoritatively record COMMAND_FINISHED
      if (this.eventStore) {
        this.eventStore.append({
          id: `evt_${this.createId()}`,
          sessionId: current.id,
          type: 'COMMAND_FINISHED',
          timestamp: this.now(),
          source: 'server',
          payload: {
            commandId,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            stdoutPreview: result.stdoutPreview,
            stdoutBytes: result.stdoutBytes,
            stdoutTruncated: result.stdoutTruncated,
            stderrPreview: result.stderrPreview,
            stderrBytes: result.stderrBytes,
            stderrTruncated: result.stderrTruncated,
          },
        });
      }

      // 4. Post-command tree capture
      if (isMultiFile && beforeTree !== null) {
        try {
          const afterTree = await this.sandboxAdapter.captureWorkspaceTree(
            current.id,
          );

          if (beforeTree !== afterTree) {
            const diffResult = await this.sandboxAdapter.captureTreeDiff(
              current.id,
              beforeTree,
              afterTree,
            );

            if (this.eventStore) {
              this.eventStore.append({
                id: `evt_${this.createId()}`,
                sessionId: current.id,
                type: 'WORKSPACE_CHANGED',
                timestamp: this.now(),
                source: 'server',
                payload: {
                  changeId: `chg_${this.createId()}`,
                  origin: 'command_execution',
                  commandId,
                  beforeTree,
                  afterTree,
                  files: diffResult.files,
                  totalAdditions: diffResult.totalAdditions,
                  totalDeletions: diffResult.totalDeletions,
                },
              });
            }
          }
        } catch (error) {
          if (this.eventStore) {
            this.eventStore.append({
              id: `evt_${this.createId()}`,
              sessionId: current.id,
              type: 'WORKSPACE_CAPTURE_FAILED',
              timestamp: this.now(),
              source: 'server',
              payload: {
                commandId,
                phase: 'post_command',
                beforeTree,
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
      }

      return result;
    });
  }

  async listWorkspaceFiles(candidateToken: string) {
    const session = this.getCandidateSession(candidateToken);
    if (session.status !== 'ACTIVE') {
      throw new SessionError(
        'SESSION_NOT_ACTIVE',
        'Workspace files are only available for active sessions.',
      );
    }
    if (!this.sandboxAdapter) {
      return [];
    }
    return this.sandboxAdapter.listFiles(session.id);
  }

  async readWorkspaceFile(candidateToken: string, filePath: string) {
    const session = this.getCandidateSession(candidateToken);
    if (session.status !== 'ACTIVE') {
      throw new SessionError(
        'SESSION_NOT_ACTIVE',
        'Workspace files are only available for active sessions.',
      );
    }
    if (!this.sandboxAdapter) {
      return '';
    }
    try {
      return await this.sandboxAdapter.readFile(session.id, filePath);
    } catch (error) {
      if (
        error instanceof SandboxError &&
        (error.message.includes('100 KB') || error.message.includes('exceeds'))
      ) {
        throw new SessionError(
          'CONTENT_TOO_LARGE',
          'The file exceeds the 100 KB limit for this scenario.',
        );
      }
      throw error;
    }
  }

  async saveWorkspaceFile(
    candidateToken: string,
    filePath: string,
    content: string,
  ) {
    if (content.length > maximumContentLength) {
      throw new SessionError(
        'CONTENT_TOO_LARGE',
        'The file exceeds the 100 KB limit for this scenario.',
      );
    }
    const tokenHash = hashCandidateToken(candidateToken);
    const session = this.store.findByCandidateTokenHash(tokenHash);

    if (!session) {
      throw new SessionError(
        'SESSION_NOT_FOUND',
        'The candidate session was not found.',
      );
    }

    return this.withSessionLock(session.id, async () => {
      const current = this.store.findByCandidateTokenHash(tokenHash);
      if (!current) {
        throw new SessionError(
          'SESSION_NOT_FOUND',
          'The candidate session was not found.',
        );
      }

      if (current.status !== 'ACTIVE') {
        throw new SessionError(
          'SESSION_NOT_ACTIVE',
          'Workspace files can only be edited during active sessions.',
        );
      }

      if (current.closureReason !== null) {
        throw new SessionError(
          'SESSION_FINALIZATION_STARTED',
          'Finalization has already started. Candidate mutations are no longer permitted.',
        );
      }

      const deadline = deriveSessionDeadline(current);
      const now = this.now();
      if (deadline !== null && isDeadlineExceeded(deadline, now)) {
        throw new SessionError(
          'SESSION_DEADLINE_EXCEEDED',
          'The assessment time limit has been reached. New modifications are no longer permitted.',
        );
      }

      const normalized = normalizeLineEndings(content);

      if (!this.sandboxAdapter) {
        return { ok: true, path: filePath, content: normalized };
      }

      const isMultiFile =
        current.scenarioType === 'multi_file' ||
        current.scenario.type === 'multi_file';

      let beforeTree: string | null = null;
      if (isMultiFile) {
        try {
          const driftResult = await this.detectAndRecordDrift(current.id);
          beforeTree = driftResult.currentTree;
        } catch (error) {
          throw new SessionError(
            'PLATFORM_CAPTURE_FAILED',
            `Failed to capture workspace before file save: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      await this.sandboxAdapter.writeFile(current.id, filePath, normalized);

      let afterTree: string | null = null;
      if (isMultiFile) {
        try {
          afterTree = await this.sandboxAdapter.captureWorkspaceTree(
            current.id,
          );
        } catch (error) {
          if (this.eventStore) {
            this.eventStore.append({
              id: `evt_${this.createId()}`,
              sessionId: current.id,
              type: 'WORKSPACE_CAPTURE_FAILED',
              timestamp: this.now(),
              source: 'server',
              payload: {
                phase: 'browser_save',
                beforeTree,
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              },
            });
          }
          throw new SessionError(
            'PLATFORM_CAPTURE_FAILED',
            `Workspace file was written, but post-save capture failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (
        isMultiFile &&
        beforeTree !== null &&
        afterTree !== null &&
        beforeTree !== afterTree
      ) {
        try {
          const diffResult = await this.sandboxAdapter.captureTreeDiff(
            current.id,
            beforeTree,
            afterTree,
          );

          if (this.eventStore) {
            this.eventStore.append({
              id: `evt_${this.createId()}`,
              sessionId: current.id,
              type: 'WORKSPACE_CHANGED',
              timestamp: this.now(),
              source: 'server',
              payload: {
                changeId: `chg_${this.createId()}`,
                origin: 'browser_save',
                beforeTree,
                afterTree,
                files: diffResult.files,
                totalAdditions: diffResult.totalAdditions,
                totalDeletions: diffResult.totalDeletions,
              },
            });
          }
        } catch (error) {
          if (this.eventStore) {
            this.eventStore.append({
              id: `evt_${this.createId()}`,
              sessionId: current.id,
              type: 'WORKSPACE_CAPTURE_FAILED',
              timestamp: this.now(),
              source: 'server',
              payload: {
                phase: 'browser_save',
                beforeTree,
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              },
            });
          }
          throw new SessionError(
            'PLATFORM_CAPTURE_FAILED',
            `Workspace file was saved, but diff capture failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return { ok: true, path: filePath, content: normalized };
    });
  }

  submit(candidateToken: string) {
    const admittedAt = this.now();
    return this.finalizeByTokenHash(
      hashCandidateToken(candidateToken),
      admittedAt,
      'candidate_submission',
      true,
    );
  }

  private async finalizeByTokenHash(
    tokenHash: string,
    admittedAt: string,
    requestedClosureReason: 'candidate_submission' | 'timeout',
    resumeAdmitted = true,
  ) {
    const session = this.store.findByCandidateTokenHash(tokenHash);

    if (!session) {
      throw new SessionError(
        'SESSION_NOT_FOUND',
        'The candidate session was not found.',
      );
    }

    return this.withSessionLock(session.id, async () => {
      const current = this.store.findByCandidateTokenHash(tokenHash);
      if (!current) {
        throw new SessionError(
          'SESSION_NOT_FOUND',
          'The candidate session was not found.',
        );
      }

      if (current.status === 'SUBMITTED') {
        return current;
      }

      if (current.status !== 'ACTIVE') {
        throw new SessionError(
          'SESSION_NOT_ACTIVE',
          'The session must be active before it can be submitted.',
        );
      }

      const alreadyAdmitted = current.closureReason !== null;
      if (alreadyAdmitted && !resumeAdmitted) {
        return current;
      }

      const deadline = deriveSessionDeadline(current);
      if (
        !alreadyAdmitted &&
        requestedClosureReason === 'timeout' &&
        !isDeadlineExceeded(deadline, admittedAt)
      ) {
        return current;
      }
      let closureReason =
        current.closureReason ??
        (requestedClosureReason === 'candidate_submission' &&
        !isDeadlineExceeded(deadline, admittedAt)
          ? 'candidate_submission'
          : 'timeout');

      let submittedDiff: string | null = null;
      const isMultiFile =
        current.scenarioType === 'multi_file' ||
        current.scenario.type === 'multi_file';

      if (this.sandboxAdapter && isMultiFile) {
        // Phase 1: Record any in-flight drift as authoritative workspace event
        // before the freeze boundary. This preserves the audit trail of
        // candidate mutations that occurred before submission was admitted.
        // Failures here abort submission; the session remains ACTIVE.
        let baselineTree: string | undefined;
        try {
          const alreadyFrozen = await this.sandboxAdapter.isFrozen(current.id);
          if (!alreadyAdmitted && !alreadyFrozen) {
            await this.detectAndRecordDrift(current.id);
            baselineTree = await this.sandboxAdapter.getBaselineTree(
              current.id,
            );
          }
        } catch (error) {
          if (this.eventStore) {
            this.eventStore.append({
              id: `evt_${this.createId()}`,
              sessionId: current.id,
              type: 'WORKSPACE_CAPTURE_FAILED',
              timestamp: this.now(),
              source: 'server',
              payload: {
                phase: 'submission_pre_freeze',
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              },
            });
          }
          throw new SessionError(
            'PLATFORM_CAPTURE_FAILED',
            `Failed to capture workspace state before finalization: ${error instanceof Error ? error.message : String(error)}. Session remains active.`,
          );
        }

        if (!alreadyAdmitted) {
          const admitted = this.store.admitFinalization(
            current.id,
            closureReason,
          );
          closureReason = admitted.closureReason!;
        }

        // Phase 2: Freeze the primary sandbox container.
        //
        // This is the authoritative final workspace boundary:
        //   candidate submission admitted
        //     -> freeze primary sandbox (docker pause)
        //     -> freeze confirmed (docker inspect State.Paused == true)
        //     -> frozen workspace is authoritative
        //
        // Failure: session stays ACTIVE, no submission committed, no teardown.
        // The sandbox is NOT unpaused if pause partially succeeded — we cannot
        // know whether the kernel freeze took effect.
        try {
          await this.sandboxAdapter.freeze(current.id);
        } catch (error) {
          // Freeze failed after durable finalization admission. The candidate's
          // workspace is preserved intact in the named volume.
          if (this.eventStore) {
            this.eventStore.append({
              id: `evt_${this.createId()}`,
              sessionId: current.id,
              type: 'WORKSPACE_CAPTURE_FAILED',
              timestamp: this.now(),
              source: 'server',
              payload: {
                phase: 'submission_freeze',
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              },
            });
          }
          throw new SessionError(
            'PLATFORM_CAPTURE_FAILED',
            `Failed to freeze sandbox for finalization: ${error instanceof Error ? error.message : String(error)}. Finalization remains admitted.`,
          );
        }

        // Phase 3: Capture frozen evidence via trusted ephemeral helper.
        //
        // The primary sandbox remains paused throughout. The helper mounts
        // the workspace volume read-only and runs authoritative tree/diff
        // scripts. Do NOT unpause on failure — workspace must remain frozen
        // to prevent new candidate mutations.
        //
        // Failure: session stays ACTIVE with admitted closure reason. Primary
        // stays paused and no submission is fabricated.
        let submittedTree: string | null = null;
        try {
          const generated = current.scenario.id.startsWith('generated-')
            ? await loadValidatedGeneratedAssessment(
                path.dirname(getApplicationDatabasePath()),
                current.scenario.id,
              )
            : null;
          if (current.scenario.id.startsWith('generated-') && !generated) {
            throw new Error(
              'Validated generated starter files are unavailable.',
            );
          }
          const generatedStarterFiles = generated
            ? Object.fromEntries(
                [
                  ...generated.assessment.starterFiles,
                  ...generated.assessment.targetTests,
                ].map((file) => [file.path, file.content]),
              )
            : undefined;
          const frozen = await this.sandboxAdapter.captureFrozenEvidence(
            current.id,
            baselineTree,
            generatedStarterFiles,
          );
          submittedTree = frozen.currentTree;
          submittedDiff = frozen.rawDiff;

          // Preserve Slice 4 integrity: after pre-freeze drift reconciliation,
          // the frozen tree must match the last authoritative WORKSPACE_CHANGED
          // afterTree (or baseline when no workspace transitions exist).
          if (this.eventStore) {
            const events = this.eventStore.getEvents(current.id);
            const workspaceEvents = events.filter(
              (e) => e.type === 'WORKSPACE_CHANGED',
            );
            const lastWorkspaceEvent =
              workspaceEvents.length > 0
                ? workspaceEvents[workspaceEvents.length - 1]
                : null;
            if (lastWorkspaceEvent) {
              const expectedTree = (
                lastWorkspaceEvent.payload as { afterTree?: string }
              ).afterTree;
              if (expectedTree && submittedTree !== expectedTree) {
                throw new Error(
                  `Submitted tree ${submittedTree} does not match the last authoritative workspace tree ${expectedTree}.`,
                );
              }
            } else if (
              baselineTree !== undefined &&
              submittedTree !== baselineTree
            ) {
              throw new Error(
                `Submitted tree ${submittedTree} differs from baseline ${baselineTree} without an authoritative workspace transition.`,
              );
            }
          }
        } catch (error) {
          // Capture failed after freeze. Primary remains paused.
          // Do NOT unpause. Do NOT commit fake evidence.
          // If retry is possible it must operate against the same frozen state.
          if (this.eventStore) {
            this.eventStore.append({
              id: `evt_${this.createId()}`,
              sessionId: current.id,
              type: 'WORKSPACE_CAPTURE_FAILED',
              timestamp: this.now(),
              source: 'server',
              payload: {
                phase: 'submission_frozen_capture',
                beforeTree: submittedTree,
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              },
            });
          }
          throw new SessionError(
            'PLATFORM_CAPTURE_FAILED',
            `Failed to capture frozen workspace evidence: ${error instanceof Error ? error.message : String(error)}. Finalization remains admitted; sandbox is frozen.`,
          );
        }
      }

      if (!alreadyAdmitted && !(this.sandboxAdapter && isMultiFile)) {
        const admitted = this.store.admitFinalization(
          current.id,
          closureReason,
        );
        closureReason = admitted.closureReason!;
      }

      // Phase 4: Atomic SQLite finalization.
      //
      // status = SUBMITTED with the closure reason fixed by trusted admission.
      //
      // If this fails after freeze/capture: primary remains paused, volume
      // intact, and ACTIVE retains its admitted closure reason. Do NOT unpause.
      const submitted = this.transactionRunner.run((database) => {
        const fresh = this.store.findByIdWithDatabase(database, current.id);
        if (!fresh) {
          throw new SessionError(
            'SESSION_NOT_FOUND',
            'The candidate session was not found.',
          );
        }

        if (fresh.status === 'SUBMITTED') {
          return fresh;
        }

        if (fresh.status !== 'ACTIVE') {
          throw new SessionError(
            'SESSION_NOT_ACTIVE',
            'The session must be active before it can be submitted.',
          );
        }

        const closureTimestamp = this.now();

        this.aiInteractionService.cancelOpenForSessionEndWithDatabase(
          database,
          current.id,
          closureTimestamp,
        );

        return this.store.submitWithDatabase(
          database,
          current.id,
          closureTimestamp,
          submittedDiff,
          closureReason,
        );
      });

      // Phase 5: Teardown — remove container and workspace volume.
      //
      // Teardown occurs ONLY after successful SQLite finalization.
      // On failure: session remains SUBMITTED; error is logged and recorded
      // as SANDBOX_CLEANUP_FAILED. The session is NOT reopened.
      // Volume cleanup is independently idempotent.
      if (this.sandboxAdapter) {
        try {
          await this.sandboxAdapter.teardown(current.id);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error(
            'Sandbox cleanup failed after submission [SANDBOX_CLEANUP_FAILED]',
          );
          if (this.eventStore) {
            this.eventStore.append({
              id: `evt_${this.createId()}`,
              sessionId: current.id,
              type: 'SANDBOX_CLEANUP_FAILED',
              timestamp: this.now(),
              source: 'server',
              payload: {
                phase: 'submission',
                errorMessage,
              },
            });
          }
        }
      }

      if (this.onSessionFinalized) {
        try {
          await this.onSessionFinalized(submitted.id);
        } catch {
          console.error(
            'Post-submission reconstruction failed [POST_SUBMISSION_RECONSTRUCTION_FAILED]',
          );
        }
      }

      return submitted;
    });
  }

  async finalizeTimedOutSession(sessionId: string, observedAt = this.now()) {
    const session = this.store.findById(sessionId);
    if (!session) {
      throw new SessionError(
        'SESSION_NOT_FOUND',
        'The candidate session was not found.',
      );
    }
    return this.finalizeByTokenHash(
      session.candidateTokenHash,
      observedAt,
      session.closureReason ?? 'timeout',
      session.closureReason !== null,
    );
  }

  async reconcileSessions(observedAt = this.now()) {
    if (!this.sandboxAdapter || !this.sandboxAdapter.inspectResources) return;

    const sessions = this.store.findAllActiveAndSubmitted();
    const tasks: Promise<unknown>[] = [];
    let incomplete = false;
    const inspectResources = async (sessionId: string) => {
      try {
        return await this.sandboxAdapter!.inspectResources!(sessionId);
      } catch {
        console.error(
          'Sandbox resource inspection failed during startup reconciliation [RESOURCE_INSPECTION_FAILED]',
        );
        incomplete = true;
        return null;
      }
    };

    for (const session of sessions) {
      if (session.status === 'SUBMITTED') {
        const resources = await inspectResources(session.id);
        if (!resources) continue;
        const { containerStatus, volumeExists } = resources;
        if (containerStatus !== 'missing' || volumeExists) {
          tasks.push(
            this.withSessionLock(session.id, async () => {
              const current = this.store.findById(session.id);
              if (current?.status === 'SUBMITTED') {
                try {
                  await this.sandboxAdapter!.teardown(session.id);
                } catch (error) {
                  const errorMessage =
                    error instanceof Error ? error.message : String(error);
                  console.error(
                    'Sandbox cleanup failed during startup reconciliation [SANDBOX_CLEANUP_FAILED]',
                  );
                  incomplete = true;
                  this.eventStore?.append({
                    id: `evt_${this.createId()}`,
                    sessionId: session.id,
                    type: 'SANDBOX_CLEANUP_FAILED',
                    timestamp: this.now(),
                    source: 'server',
                    payload: {
                      phase: 'reconciliation',
                      errorMessage,
                    },
                  });
                }
              }
              return current;
            }),
          );
        }
      } else if (session.status === 'ACTIVE') {
        const deadline = deriveSessionDeadline(session);
        if (
          session.closureReason !== null ||
          (deadline !== null && isDeadlineExceeded(deadline, observedAt))
        ) {
          const resources = await inspectResources(session.id);
          if (!resources) continue;
          const { containerStatus, volumeExists } = resources;

          if (containerStatus === 'missing' && volumeExists) {
            // Case R3: missing container but volume exists -> fail closed, preserve volume, do not finalize
            if (this.eventStore) {
              this.eventStore.append({
                id: `evt_${this.createId()}`,
                sessionId: session.id,
                type: 'WORKSPACE_CAPTURE_FAILED',
                timestamp: this.now(),
                source: 'server',
                payload: {
                  phase: 'reconciliation',
                  errorMessage:
                    'Primary container is missing while workspace volume exists. Failing closed to preserve volume for recovery.',
                },
              });
            }
            incomplete = true;
            continue;
          }

          if (!volumeExists) {
            // Case R4 and complete missing state: fail closed, do not recreate empty workspace
            if (this.eventStore) {
              this.eventStore.append({
                id: `evt_${this.createId()}`,
                sessionId: session.id,
                type: 'WORKSPACE_CAPTURE_FAILED',
                timestamp: this.now(),
                source: 'server',
                payload: {
                  phase: 'reconciliation',
                  errorMessage:
                    'Session workspace volume is missing. Failing closed to prevent empty submission.',
                },
              });
            }
            incomplete = true;
            continue;
          }

          tasks.push(this.finalizeTimedOutSession(session.id, observedAt));
        }
      }
    }

    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error(
          'Session reconciliation task failed [RECONCILIATION_TASK_FAILED]',
        );
        incomplete = true;
      }
    }
    if (incomplete) throw new SessionReconciliationError();
  }

  async sweepTimedOutSessions(observedAt = this.now()) {
    const overdue = this.store
      .findAllActiveAndSubmitted()
      .filter(
        (session) =>
          session.status === 'ACTIVE' &&
          (session.closureReason !== null ||
            isDeadlineExceeded(deriveSessionDeadline(session), observedAt)),
      );
    return Promise.allSettled(
      overdue.map((session) =>
        this.finalizeTimedOutSession(session.id, observedAt),
      ),
    );
  }

  getSubmittedEvidence(sessionId: string) {
    const session = this.store.findById(sessionId);
    if (!session) {
      throw new SessionError(
        'SESSION_NOT_FOUND',
        'The evaluator session was not found.',
      );
    }

    const submitted = requireSubmittedSession(session);
    const events = this.eventStore ? this.eventStore.getEvents(sessionId) : [];

    const isMultiFile =
      submitted.scenarioType === 'multi_file' ||
      submitted.scenario.type === 'multi_file';

    const diff =
      isMultiFile &&
      submitted.submittedDiff !== null &&
      submitted.submittedDiff !== undefined
        ? submitted.submittedDiff
        : createSubmittedDiff(
            submitted.scenario.filePath,
            submitted.scenario.originalContent,
            submitted.submittedContent,
          );

    return {
      sessionId: submitted.id,
      scenario: submitted.scenario,
      scenarioType:
        submitted.scenarioType ?? submitted.scenario.type ?? 'single_file',
      activatedAt: submitted.activatedAt,
      submittedAt: submitted.submittedAt,
      durationSeconds: submitted.durationSeconds,
      closureReason: submitted.closureReason,
      originalContent: submitted.scenario.originalContent,
      submittedContent: submitted.submittedContent,
      diff,
      events,
      aiCapabilitySnapshot: submitted.aiCapabilitySnapshot ?? null,
      taskRubricSnapshot: submitted.taskRubricSnapshot ?? null,
    };
  }

  listSubmittedReviewEntries(): readonly EvaluatorReviewEntry[] {
    return this.store.findSubmittedReviewEntries(evaluatorReviewLimit);
  }

  listAssessmentLifecycleEntries(
    limit?: number,
  ): readonly AssessmentLifecycleEntry[] {
    return this.store.findAssessmentLifecycleEntries(limit);
  }

  getSessionEvents(candidateToken: string) {
    const session = this.getCandidateSession(candidateToken);
    const events = this.eventStore ? this.eventStore.getEvents(session.id) : [];
    return events.map((event) =>
      event.type === 'SANDBOX_CLEANUP_FAILED'
        ? {
            ...event,
            payload: {
              phase: (event.payload as { phase: string }).phase,
              errorMessage: 'Sandbox cleanup failed.',
            },
          }
        : event,
    );
  }

  getRecentSessionEvents(candidateToken: string, limit: number) {
    const session = this.getCandidateSession(candidateToken);
    return this.eventStore
      ? this.eventStore.getRecentEvents(session.id, limit)
      : [];
  }
}

const createSessionService = () => {
  const databasePath = getApplicationDatabasePath();

  const store = new SqliteSessionStore(databasePath);
  const eventStore = new SqliteEventStore(databasePath);
  const sandboxAdapter = new DockerSandboxAdapter();
  const coordinator = getSessionOperationCoordinator();

  return new SessionService(store, {
    eventStore,
    sandboxAdapter,
    coordinator,
    onSessionFinalized: async (sessionId) => {
      const { ensurePostSubmissionReconstruction } =
        await import('../reconstruction/evidence-reconstruction-runtime');
      await ensurePostSubmissionReconstruction(sessionId);
    },
  });
};

export const getSessionServiceForStartup = () => createSessionService();

export const getSessionService = () => {
  assertApplicationStartupReady();
  const service = createSessionService();
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        assertApplicationStartupReady();
        return Reflect.apply(value, target, args);
      };
    },
  });
};
