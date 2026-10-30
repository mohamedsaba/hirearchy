import {
  cloneScenarioSemanticSnapshot,
  decodeStoredSemanticSnapshot,
} from '../scenarios/scenario-semantic-snapshot';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  activateSession,
  type AssessmentSession,
  editSession,
  type SessionClosureReason,
  SessionError,
  submitSession,
  type SubmittedSession,
} from './session';
import type { EvaluatorReviewEntry } from '../evaluator/evaluator-review-entry';
import { cloneTaskRubric } from '../assessments/task-rubric';
import { hashPersistedAssessmentIdentity } from './assessment-issuance-idempotency';
import {
  CandidateTokenStorageError,
  assertCandidateTokenStorage,
  candidateTokenHash,
  createCandidateTokenStorageMarker,
  decryptCandidateToken,
  encryptCandidateToken,
  ensureCandidateTokenStorageSchema,
  loadCandidateTokenEncryptionKey,
  verifyCandidateTokenStorageRows,
} from './candidate-token-storage.mjs';

type SessionRow = Readonly<{
  id: string;
  candidate_token_hash: string;
  scenario_id: string;
  scenario_version: string;
  scenario_title: string;
  scenario_brief: string;
  acceptance_criteria: string;
  file_path: string;
  original_content: string;
  status: AssessmentSession['status'];
  working_content: string;
  submitted_content: string | null;
  created_at: string;
  activated_at: string | null;
  submitted_at: string | null;
  duration_seconds: number | null;
  closure_reason: AssessmentSession['closureReason'];
  scenario_type: 'single_file' | 'multi_file' | null;
  scenario_image_name: string | null;
  submitted_diff: string | null;
  scenario_evaluation_context: string | null;
  scenario_semantic_snapshot: string | null;
  ai_capability_snapshot: string | null;
  task_rubric_snapshot: string | null;
  terminal_enabled: number | null;
  candidate_token: string | null;
  candidate_token_ciphertext: string | null;
  issuance_key: string | null;
  issuance_request_hash: string | null;
  issuance_payload_hash: string | null;
}>;

export type AssessmentIssuanceIdentity = Readonly<{
  key: string;
  requestHash: string;
  payloadHash: string;
}>;

export type StoredAssessmentIssuance = Readonly<{
  session: AssessmentSession;
  requestHash: string;
  payloadHash: string;
}>;

export type AssessmentIssuanceWriteResult = Readonly<{
  created: boolean;
  issuance: StoredAssessmentIssuance;
}>;

type EvaluatorReviewRow = Readonly<{
  session_id: string;
  scenario_title: string;
  submitted_at: string;
  duration_seconds: number | null;
  closure_reason: SessionClosureReason;
}>;

export type AssessmentLifecycleEntry = Readonly<{
  sessionId: string;
  scenarioTitle: string;
  status: AssessmentSession['status'];
  createdAt: string;
  activatedAt: string | null;
  submittedAt: string | null;
  durationSeconds: number | null;
  closureReason: AssessmentSession['closureReason'];
  candidateToken: string | null;
  candidatePath: string | null;
  terminalEnabled: boolean;
}>;

const schema = `
  CREATE TABLE IF NOT EXISTS assessment_sessions (
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
    duration_seconds INTEGER CHECK (duration_seconds IS NULL OR (duration_seconds > 0 AND duration_seconds = CAST(duration_seconds AS INTEGER))),
    closure_reason TEXT CHECK (closure_reason IS NULL OR closure_reason IN ('candidate_submission', 'timeout')),
    scenario_type TEXT DEFAULT 'single_file',
    scenario_image_name TEXT,
    submitted_diff TEXT,
    scenario_evaluation_context TEXT,
    scenario_semantic_snapshot TEXT,
    ai_capability_snapshot TEXT,
    task_rubric_snapshot TEXT,
    terminal_enabled INTEGER NOT NULL DEFAULT 1 CHECK (terminal_enabled IN (0, 1)),
    candidate_token TEXT,
    candidate_token_ciphertext TEXT,
    issuance_key TEXT,
    issuance_request_hash TEXT,
    issuance_payload_hash TEXT
  );
`;

const toSession = (row: SessionRow): AssessmentSession => ({
  id: row.id,
  candidateTokenHash: row.candidate_token_hash,
  scenario: {
    id: row.scenario_id,
    version: row.scenario_version,
    title: row.scenario_title,
    brief: row.scenario_brief,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria) as string[],
    filePath: row.file_path,
    originalContent: row.original_content,
    ...(row.duration_seconds !== null && row.duration_seconds !== undefined
      ? { durationSeconds: row.duration_seconds }
      : {}),
    ...(row.scenario_semantic_snapshot
      ? {
          semanticSnapshot: decodeStoredSemanticSnapshot(
            row.scenario_semantic_snapshot,
          ),
        }
      : {}),
    type: row.scenario_type ?? 'single_file',
    ...(row.scenario_image_name ? { imageName: row.scenario_image_name } : {}),
    ...(row.scenario_evaluation_context
      ? {
          evaluationContext: JSON.parse(
            row.scenario_evaluation_context,
          ) as AssessmentSession['scenario']['evaluationContext'],
        }
      : {}),
  },
  status: row.status,
  workingContent: row.working_content,
  submittedContent: row.submitted_content,
  createdAt: row.created_at,
  activatedAt: row.activated_at,
  submittedAt: row.submitted_at,
  durationSeconds: row.duration_seconds,
  closureReason: row.closure_reason,
  scenarioType: row.scenario_type ?? 'single_file',
  submittedDiff: row.submitted_diff,
  aiCapabilitySnapshot: row.ai_capability_snapshot
    ? (JSON.parse(
        row.ai_capability_snapshot,
      ) as AssessmentSession['aiCapabilitySnapshot'])
    : null,
  taskRubricSnapshot: row.task_rubric_snapshot
    ? cloneTaskRubric(
        JSON.parse(
          row.task_rubric_snapshot,
        ) as AssessmentSession['taskRubricSnapshot'],
      )
    : null,
  terminalEnabled: row.terminal_enabled !== 0,
  // Generic row reads deliberately remain hash-only. Link recovery is an
  // explicit evaluator operation performed after route authorization.
  candidateToken: null,
});

export class SqliteSessionStore {
  constructor(public readonly databasePath: string) {}

  static ensureSchema(
    database: Database.Database,
    options:
      | {
          allowNewDatabase?: boolean;
          verifyAllRows?: boolean;
          key?: Buffer;
        }
      | boolean = {},
  ): void {
    const settings =
      typeof options === 'boolean' ? { allowNewDatabase: options } : options;
    const allowNewDatabase =
      settings.allowNewDatabase ?? database.name === ':memory:';
    const verifyAllRows = settings.verifyAllRows ?? false;
    const key = settings.key ?? loadCandidateTokenEncryptionKey();
    const bound = assertCandidateTokenStorage(database, {
      key,
      allowNewDatabase,
    });

    const migrate = database.transaction(() => {
      const transactionBound = assertCandidateTokenStorage(database, {
        key,
        allowNewDatabase,
      });
      const concurrentlyInitialized =
        !bound && transactionBound && allowNewDatabase;
      if (transactionBound !== bound && !concurrentlyInitialized) {
        throw new CandidateTokenStorageError(
          'CANDIDATE_TOKEN_STORAGE_UNBOUND',
          'Candidate-link storage changed during initialization.',
        );
      }
      if (transactionBound && verifyAllRows) {
        const sessionTable = database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assessment_sessions'",
          )
          .get();
        if (sessionTable) verifyCandidateTokenStorageRows(database, key);
      }
      database.exec(schema);
      const columns = database
        .prepare('PRAGMA table_info(assessment_sessions)')
        .all() as Array<{ name: string }>;
      const additions = [
        [
          'duration_seconds',
          'INTEGER CHECK (duration_seconds IS NULL OR (duration_seconds > 0 AND duration_seconds = CAST(duration_seconds AS INTEGER)))',
        ],
        [
          'closure_reason',
          "TEXT CHECK (closure_reason IS NULL OR closure_reason IN ('candidate_submission', 'timeout'))",
        ],
        ['scenario_type', "TEXT DEFAULT 'single_file'"],
        ['scenario_image_name', 'TEXT'],
        ['submitted_diff', 'TEXT'],
        ['scenario_evaluation_context', 'TEXT'],
        ['scenario_semantic_snapshot', 'TEXT'],
        ['ai_capability_snapshot', 'TEXT'],
        ['task_rubric_snapshot', 'TEXT'],
        [
          'terminal_enabled',
          'INTEGER NOT NULL DEFAULT 1 CHECK (terminal_enabled IN (0, 1))',
        ],
        ['candidate_token', 'TEXT'],
        ['candidate_token_ciphertext', 'TEXT'],
        ['issuance_key', 'TEXT'],
        ['issuance_request_hash', 'TEXT'],
        ['issuance_payload_hash', 'TEXT'],
      ] as const;
      for (const [name, definition] of additions) {
        if (!columns.some((column) => column.name === name)) {
          database.exec(
            `ALTER TABLE assessment_sessions ADD COLUMN ${name} ${definition}`,
          );
        }
      }

      ensureCandidateTokenStorageSchema(database);

      database.exec(`
        UPDATE assessment_sessions
        SET closure_reason = 'candidate_submission'
        WHERE status = 'SUBMITTED' AND closure_reason IS NULL;
      `);
      if (!transactionBound) {
        // The database identity becomes durable only after the empty-schema
        // provenance was rechecked and application storage was initialized.
        verifyCandidateTokenStorageRows(database, key);
        createCandidateTokenStorageMarker(database, key);
      }
    });
    migrate.immediate();
  }

  verifyStorageForStartup(): void {
    this.withDatabase(() => undefined, { verifyAllRows: true });
  }

  create(session: AssessmentSession) {
    return this.withDatabase(
      (database) => {
        const transaction = database.transaction(() => {
          verifyCandidateTokenStorageRows(database);
          return this.insertSession(database, session);
        });
        return transaction.immediate();
      },
      { verifyAllRows: true },
    );
  }

  createIdempotently(
    session: AssessmentSession,
    identity: Pick<AssessmentIssuanceIdentity, 'key' | 'requestHash'>,
  ): AssessmentIssuanceWriteResult {
    return this.withDatabase(
      (database) => {
        const transaction = database.transaction(() => {
          verifyCandidateTokenStorageRows(database);
          const existing = this.findAssessmentIssuanceWithDatabase(
            database,
            identity.key,
          );
          if (existing) return { created: false, issuance: existing };

          try {
            this.insertSession(database, session, identity);
          } catch (error) {
            // Only reinterpret a uniqueness failure when the exact issuance key
            // exists. Other constraints remain visible as errors.
            const raced = this.findAssessmentIssuanceWithDatabase(
              database,
              identity.key,
            );
            if (!raced) throw error;
            return { created: false, issuance: raced };
          }

          const persistedSession = this.findByIdWithDatabase(
            database,
            session.id,
          );
          if (!persistedSession) {
            throw new CandidateTokenStorageError(
              'ASSESSMENT_ISSUANCE_IDENTITY_INVALID',
              'The newly issued assessment could not be verified after storage.',
            );
          }
          const payloadHash = hashPersistedAssessmentIdentity(persistedSession);
          database
            .prepare(
              `UPDATE assessment_sessions SET issuance_payload_hash = ?
             WHERE id = ? AND issuance_key = ?`,
            )
            .run(payloadHash, session.id, identity.key);
          return {
            created: true,
            issuance: {
              session: persistedSession,
              requestHash: identity.requestHash,
              payloadHash,
            },
          };
        });
        return transaction.immediate();
      },
      { verifyAllRows: true },
    );
  }

  findAssessmentIssuanceByKey(key: string): StoredAssessmentIssuance | null {
    return this.withDatabase(
      (database) => this.findAssessmentIssuanceWithDatabase(database, key),
      { verifyAllRows: true },
    );
  }

  private findAssessmentIssuanceWithDatabase(
    database: Database.Database,
    key: string,
  ): StoredAssessmentIssuance | null {
    const row = database
      .prepare('SELECT * FROM assessment_sessions WHERE issuance_key = ?')
      .get(key) as SessionRow | undefined;
    if (!row) return null;
    if (!row.issuance_request_hash || !row.issuance_payload_hash) {
      throw new CandidateTokenStorageError(
        'ASSESSMENT_ISSUANCE_IDENTITY_INVALID',
        'The stored assessment issuance identity is incomplete.',
      );
    }
    return {
      session: toSession(row),
      requestHash: row.issuance_request_hash,
      payloadHash: row.issuance_payload_hash,
    };
  }

  private insertSession(
    database: Database.Database,
    session: AssessmentSession,
    identity?: Pick<AssessmentIssuanceIdentity, 'key' | 'requestHash'>,
  ) {
    const candidateToken = session.candidateToken;
    if (!candidateToken) {
      throw new CandidateTokenStorageError(
        'CANDIDATE_TOKEN_REQUIRED',
        'A candidate link is required to create a session.',
      );
    }
    const candidateTokenCiphertext = encryptCandidateToken(
      candidateToken,
      session.id,
    );
    database
      .prepare(
        `INSERT INTO assessment_sessions (
          id, candidate_token_hash, scenario_id, scenario_version,
          scenario_title, scenario_brief, acceptance_criteria, file_path,
          original_content, status, working_content, submitted_content,
          created_at, activated_at, submitted_at, duration_seconds,
          closure_reason, scenario_type, scenario_image_name, submitted_diff,
          scenario_evaluation_context, scenario_semantic_snapshot,
          ai_capability_snapshot, task_rubric_snapshot, terminal_enabled,
          candidate_token, candidate_token_ciphertext, issuance_key,
          issuance_request_hash, issuance_payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
      )
      .run(
        session.id,
        session.candidateTokenHash,
        session.scenario.id,
        session.scenario.version,
        session.scenario.title,
        session.scenario.brief,
        JSON.stringify(session.scenario.acceptanceCriteria),
        session.scenario.filePath,
        session.scenario.originalContent,
        session.status,
        session.workingContent,
        session.submittedContent,
        session.createdAt,
        session.activatedAt,
        session.submittedAt,
        session.durationSeconds,
        session.closureReason,
        session.scenarioType ?? session.scenario.type ?? 'single_file',
        session.scenario.imageName ?? null,
        session.submittedDiff ?? null,
        session.scenario.evaluationContext
          ? JSON.stringify(session.scenario.evaluationContext)
          : null,
        session.scenario.semanticSnapshot === undefined
          ? null
          : JSON.stringify(
              cloneScenarioSemanticSnapshot(session.scenario.semanticSnapshot),
            ),
        session.aiCapabilitySnapshot
          ? JSON.stringify(session.aiCapabilitySnapshot)
          : null,
        session.taskRubricSnapshot
          ? JSON.stringify(cloneTaskRubric(session.taskRubricSnapshot))
          : null,
        session.terminalEnabled === false ? 0 : 1,
        candidateTokenCiphertext,
        identity?.key ?? null,
        identity?.requestHash ?? null,
      );
    return session;
  }

  findByCandidateTokenHash(candidateTokenHash: string) {
    return this.withDatabase((database) =>
      this.findByToken(database, candidateTokenHash),
    );
  }

  findByIdWithDatabase(
    database: Database.Database,
    id: string,
  ): AssessmentSession | null {
    const row = database
      .prepare('SELECT * FROM assessment_sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;

    return row ? toSession(row) : null;
  }

  findById(id: string) {
    return this.withDatabase((database) =>
      this.findByIdWithDatabase(database, id),
    );
  }

  recoverCandidateTokenForAssessment(sessionId: string): string | null {
    return this.withDatabase(
      (database) => this.recoverCandidateTokenWithDatabase(database, sessionId),
      { verifyAllRows: true },
    );
  }

  private recoverCandidateTokenWithDatabase(
    database: Database.Database,
    sessionId: string,
  ): string | null {
    const row = database
      .prepare(
        `SELECT candidate_token_hash, candidate_token_ciphertext
         FROM assessment_sessions WHERE id = ?`,
      )
      .get(sessionId) as
      | {
          candidate_token_hash: string;
          candidate_token_ciphertext: string | null;
        }
      | undefined;
    if (!row?.candidate_token_ciphertext) return null;
    const token = decryptCandidateToken(
      row.candidate_token_ciphertext,
      sessionId,
    );
    if (candidateTokenHash(token) !== row.candidate_token_hash) {
      throw new CandidateTokenStorageError(
        'CANDIDATE_TOKEN_HASH_MISMATCH',
        'The recovered candidate link does not match its stored lookup hash.',
      );
    }
    return token;
  }

  findAllActiveAndSubmitted() {
    return this.withDatabase((database) => {
      const rows = database
        .prepare(
          `SELECT * FROM assessment_sessions
           WHERE status IN ('ACTIVE', 'SUBMITTED')`,
        )
        .all() as SessionRow[];
      return rows.map(toSession);
    });
  }

  findSubmittedReviewEntries(limit: number): readonly EvaluatorReviewEntry[] {
    return this.withDatabase((database) => {
      const rows = database
        .prepare(
          `SELECT id AS session_id, scenario_title, submitted_at,
                  duration_seconds, closure_reason
           FROM assessment_sessions
           WHERE status = 'SUBMITTED'
             AND submitted_content IS NOT NULL
             AND submitted_at IS NOT NULL
             AND closure_reason IS NOT NULL
           ORDER BY submitted_at DESC, id DESC
           LIMIT ?`,
        )
        .all(limit) as EvaluatorReviewRow[];

      return rows.map((row) => ({
        sessionId: row.session_id,
        scenarioTitle: row.scenario_title,
        submittedAt: row.submitted_at,
        durationSeconds: row.duration_seconds,
        closureReason: row.closure_reason,
      }));
    });
  }

  findAssessmentLifecycleEntries(
    limit: number = 100,
  ): readonly AssessmentLifecycleEntry[] {
    return this.withDatabase(
      (database) => {
        const rows = database
          .prepare(
            `SELECT id AS session_id, scenario_title, status, created_at,
                  activated_at, submitted_at, duration_seconds, closure_reason,
                  candidate_token_ciphertext, candidate_token_hash,
                  terminal_enabled
           FROM assessment_sessions
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
          )
          .all(limit) as Array<{
          session_id: string;
          scenario_title: string;
          status: AssessmentSession['status'];
          created_at: string;
          activated_at: string | null;
          submitted_at: string | null;
          duration_seconds: number | null;
          closure_reason: AssessmentSession['closureReason'];
          candidate_token_ciphertext: string | null;
          candidate_token_hash: string;
          terminal_enabled: number | null;
        }>;

        return rows.map((row) => {
          const token = row.candidate_token_ciphertext
            ? decryptCandidateToken(
                row.candidate_token_ciphertext,
                row.session_id,
              )
            : null;
          if (token && candidateTokenHash(token) !== row.candidate_token_hash) {
            throw new CandidateTokenStorageError(
              'CANDIDATE_TOKEN_HASH_MISMATCH',
              'A recovered candidate link does not match its stored lookup hash.',
            );
          }
          return {
            sessionId: row.session_id,
            scenarioTitle: row.scenario_title,
            status: row.status,
            createdAt: row.created_at,
            activatedAt: row.activated_at,
            submittedAt: row.submitted_at,
            durationSeconds: row.duration_seconds,
            closureReason: row.closure_reason,
            candidateToken: token,
            candidatePath: token ? `/candidate/${token}` : null,
            terminalEnabled: row.terminal_enabled !== 0,
          };
        });
      },
      { verifyAllRows: true },
    );
  }

  activate(candidateTokenHash: string, activatedAt: string) {
    return this.mutate(candidateTokenHash, (session) =>
      activateSession(session, activatedAt),
    );
  }

  save(candidateTokenHash: string, content: string) {
    return this.mutate(candidateTokenHash, (session) =>
      editSession(session, content),
    );
  }

  admitFinalization(
    sessionId: string,
    closureReason: SessionClosureReason,
  ): AssessmentSession {
    return this.withDatabase((database) => {
      const transaction = database.transaction(() => {
        const current = this.findByIdWithDatabase(database, sessionId);
        if (!current) {
          throw new SessionError(
            'SESSION_NOT_FOUND',
            'The candidate session was not found.',
          );
        }
        if (current.status !== 'ACTIVE') {
          throw new SessionError(
            'SESSION_NOT_ACTIVE',
            'Finalization can only be admitted for an active session.',
          );
        }
        if (current.closureReason !== null) {
          return current;
        }

        database
          .prepare(
            `UPDATE assessment_sessions
             SET closure_reason = ?
             WHERE id = ? AND status = 'ACTIVE' AND closure_reason IS NULL`,
          )
          .run(closureReason, sessionId);

        return this.findByIdWithDatabase(database, sessionId)!;
      });

      return transaction.immediate();
    });
  }

  submitWithDatabase(
    database: Database.Database,
    sessionId: string,
    submittedAt: string,
    submittedDiff?: string | null,
    closureReason: SessionClosureReason = 'candidate_submission',
  ): SubmittedSession {
    const current = this.findByIdWithDatabase(database, sessionId);
    if (!current) {
      throw new SessionError(
        'SESSION_NOT_FOUND',
        'The candidate session was not found.',
      );
    }

    const updated = submitSession(
      current,
      submittedAt,
      submittedDiff,
      closureReason,
    );
    database
      .prepare(
        `UPDATE assessment_sessions SET
          status = ?, working_content = ?, submitted_content = ?,
          activated_at = ?, submitted_at = ?, submitted_diff = ?,
          closure_reason = ?
        WHERE id = ?`,
      )
      .run(
        updated.status,
        updated.workingContent,
        updated.submittedContent,
        updated.activatedAt,
        updated.submittedAt,
        updated.submittedDiff ?? null,
        updated.closureReason,
        updated.id,
      );

    return updated as SubmittedSession;
  }

  submit(
    candidateTokenHash: string,
    submittedAt: string,
    submittedDiff?: string | null,
    closureReason: SessionClosureReason = 'candidate_submission',
  ) {
    return this.mutate(candidateTokenHash, (session) =>
      submitSession(session, submittedAt, submittedDiff, closureReason),
    ) as SubmittedSession;
  }

  private mutate(
    candidateTokenHash: string,
    change: (session: AssessmentSession) => AssessmentSession,
  ) {
    return this.withDatabase((database) => {
      const transaction = database.transaction(() => {
        const current = this.findByToken(database, candidateTokenHash);
        if (!current) {
          throw new SessionError(
            'SESSION_NOT_FOUND',
            'The candidate session was not found.',
          );
        }

        const updated = change(current);
        database
          .prepare(
            `UPDATE assessment_sessions SET
              status = ?, working_content = ?, submitted_content = ?,
              activated_at = ?, submitted_at = ?, submitted_diff = ?,
              closure_reason = ?
            WHERE id = ?`,
          )
          .run(
            updated.status,
            updated.workingContent,
            updated.submittedContent,
            updated.activatedAt,
            updated.submittedAt,
            updated.submittedDiff ?? null,
            updated.closureReason ?? null,
            updated.id,
          );

        return updated;
      });

      return transaction.immediate();
    });
  }

  private findByToken(database: Database.Database, candidateTokenHash: string) {
    const row = database
      .prepare(
        'SELECT * FROM assessment_sessions WHERE candidate_token_hash = ?',
      )
      .get(candidateTokenHash) as SessionRow | undefined;

    return row ? toSession(row) : null;
  }

  private withDatabase<T>(
    operation: (database: Database.Database) => T,
    { verifyAllRows = false }: { verifyAllRows?: boolean } = {},
  ) {
    const key = loadCandidateTokenEncryptionKey();
    const allowNewDatabase =
      this.databasePath === ':memory:' || !existsSync(this.databasePath);
    if (this.databasePath !== ':memory:') {
      mkdirSync(path.dirname(this.databasePath), { recursive: true });
    }

    const database = new Database(this.databasePath);
    database.pragma('busy_timeout = 5000');
    try {
      SqliteSessionStore.ensureSchema(database, {
        allowNewDatabase,
        key,
        verifyAllRows,
      });
      database.pragma('journal_mode = WAL');
      return operation(database);
    } finally {
      database.close();
    }
  }
}
