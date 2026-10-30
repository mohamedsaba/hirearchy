import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type {
  TaskAssessmentScoreReport,
  TaskAssessmentScoreStatus,
  TaskCriterionAssessment,
} from './task-assessment-scoring';

const schema = `
  CREATE TABLE IF NOT EXISTS task_assessment_scores (
    session_id TEXT PRIMARY KEY,
    rubric_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('PENDING', 'AVAILABLE', 'INCOMPLETE', 'FAILED')
    ),
    total_score REAL,
    applicable_weight REAL,
    scored_weight REAL,
    provider_id TEXT,
    model TEXT,
    analyzed_at TEXT,
    criteria_json TEXT NOT NULL DEFAULT '[]',
    attempt_token TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

type ScoreRow = Readonly<{
  session_id: string;
  rubric_version: string;
  status: 'PENDING' | 'AVAILABLE' | 'INCOMPLETE' | 'FAILED';
  total_score: number | null;
  applicable_weight: number | null;
  scored_weight: number | null;
  provider_id: string | null;
  model: string | null;
  analyzed_at: string | null;
  criteria_json: string;
  attempt_token: string;
  updated_at: string;
}>;

export type StoredTaskAssessmentScore = Readonly<{
  sessionId: string;
  rubricVersion: string;
  status: TaskAssessmentScoreStatus;
  totalScore: number | null;
  applicableWeight: number | null;
  scoredWeight: number | null;
  providerId: string | null;
  model: string | null;
  analyzedAt: string | null;
  criteria: readonly TaskCriterionAssessment[];
  attemptToken: string;
  updatedAt: string;
}>;

const toStoredReport = (row: ScoreRow): StoredTaskAssessmentScore => {
  let criteria: readonly TaskCriterionAssessment[] = [];
  try {
    const value: unknown = JSON.parse(row.criteria_json);
    if (Array.isArray(value)) {
      criteria = value as TaskCriterionAssessment[];
    }
  } catch {
    criteria = [];
  }
  return {
    sessionId: row.session_id,
    rubricVersion: row.rubric_version,
    status: row.status.toLowerCase() as StoredTaskAssessmentScore['status'],
    totalScore: row.total_score,
    applicableWeight: row.applicable_weight,
    scoredWeight: row.scored_weight,
    providerId: row.provider_id,
    model: row.model,
    analyzedAt: row.analyzed_at,
    criteria,
    attemptToken: row.attempt_token,
    updatedAt: row.updated_at,
  };
};

export class SqliteTaskAssessmentScoreStore {
  constructor(private readonly databasePath: string) {}

  get(sessionId: string): StoredTaskAssessmentScore | null {
    return this.withDatabase((database) => {
      const row = database
        .prepare('SELECT * FROM task_assessment_scores WHERE session_id = ?')
        .get(sessionId) as ScoreRow | undefined;
      return row ? toStoredReport(row) : null;
    });
  }

  begin(
    input: Readonly<{
      sessionId: string;
      rubricVersion: string;
      attemptToken: string;
      now: string;
      retryFailed?: boolean;
    }>,
  ): Readonly<{ claimed: boolean; report: StoredTaskAssessmentScore }> {
    return this.withDatabase((database) => {
      const transaction = database.transaction(() => {
        const existing = database
          .prepare('SELECT * FROM task_assessment_scores WHERE session_id = ?')
          .get(input.sessionId) as ScoreRow | undefined;
        if (existing) {
          if (
            input.retryFailed &&
            existing.status === 'FAILED' &&
            existing.rubric_version === input.rubricVersion
          ) {
            database
              .prepare(
                `UPDATE task_assessment_scores SET
                  status = 'PENDING', total_score = NULL, applicable_weight = NULL,
                  scored_weight = NULL, provider_id = NULL, model = NULL,
                  analyzed_at = NULL, criteria_json = '[]', attempt_token = ?, updated_at = ?
                WHERE session_id = ? AND status = 'FAILED' AND rubric_version = ?`,
              )
              .run(
                input.attemptToken,
                input.now,
                input.sessionId,
                input.rubricVersion,
              );
            const row = database
              .prepare(
                'SELECT * FROM task_assessment_scores WHERE session_id = ?',
              )
              .get(input.sessionId) as ScoreRow;
            return {
              claimed: row.status === 'PENDING',
              report: toStoredReport(row),
            };
          }
          return { claimed: false, report: toStoredReport(existing) };
        }
        database
          .prepare(
            `INSERT INTO task_assessment_scores (
              session_id, rubric_version, status, attempt_token, updated_at
            ) VALUES (?, ?, 'PENDING', ?, ?)`,
          )
          .run(
            input.sessionId,
            input.rubricVersion,
            input.attemptToken,
            input.now,
          );
        const row = database
          .prepare('SELECT * FROM task_assessment_scores WHERE session_id = ?')
          .get(input.sessionId) as ScoreRow;
        return { claimed: true, report: toStoredReport(row) };
      });
      return transaction.immediate();
    });
  }

  complete(
    input: Readonly<{
      sessionId: string;
      rubricVersion: string;
      attemptToken: string;
      report: TaskAssessmentScoreReport;
      now: string;
    }>,
  ): boolean {
    return this.withDatabase((database) => {
      const result = database
        .prepare(
          `UPDATE task_assessment_scores SET
            status = ?, total_score = ?, applicable_weight = ?, scored_weight = ?,
            provider_id = ?, model = ?, analyzed_at = ?, criteria_json = ?, updated_at = ?
          WHERE session_id = ? AND rubric_version = ? AND attempt_token = ? AND status = 'PENDING'`,
        )
        .run(
          input.report.status.toUpperCase(),
          input.report.totalScore,
          input.report.applicableWeight,
          input.report.scoredWeight,
          input.report.providerId,
          input.report.model,
          input.report.analyzedAt,
          JSON.stringify(input.report.criteria),
          input.now,
          input.sessionId,
          input.rubricVersion,
          input.attemptToken,
        );
      return result.changes === 1;
    });
  }

  private withDatabase<T>(operation: (database: Database.Database) => T): T {
    if (this.databasePath !== ':memory:') {
      mkdirSync(path.dirname(this.databasePath), { recursive: true });
    }
    const database = new Database(this.databasePath);
    try {
      database.pragma('journal_mode = WAL');
      database.pragma('busy_timeout = 5000');
      database.exec(schema);
      const columns = database
        .prepare('PRAGMA table_info(task_assessment_scores)')
        .all() as ReadonlyArray<{ name: string }>;
      if (!columns.some((column) => column.name === 'provider_id')) {
        database.exec(
          'ALTER TABLE task_assessment_scores ADD COLUMN provider_id TEXT',
        );
      }
      return operation(database);
    } finally {
      database.close();
    }
  }
}
