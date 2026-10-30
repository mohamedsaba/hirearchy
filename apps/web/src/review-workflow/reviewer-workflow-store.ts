import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { getApplicationDatabasePath } from '../database/database-path';
import { assertApplicationStartupReady } from '../startup-status';

export type ReviewNote = Readonly<{
  body: string;
  updatedAt: string;
  version: number;
}>;
export type Clarification = Readonly<{
  id: string;
  prompt: string;
  requestedAt: string;
  reply: string | null;
  repliedAt: string | null;
  closedAt: string | null;
}>;
export type ReviewNextStep = Readonly<{
  action:
    | 'continue_review'
    | 'technical_review'
    | 'candidate_conversation'
    | 'closeout';
  note: string;
  updatedAt: string;
  version: number;
}>;
export type ReviewWorkflow = Readonly<{
  note: ReviewNote | null;
  clarifications: readonly Clarification[];
  nextStep: ReviewNextStep | null;
}>;

const schema = `
  CREATE TABLE IF NOT EXISTS reviewer_notes (
    session_id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS reviewer_clarifications (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    request_key TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    reply TEXT,
    replied_at TEXT,
    closed_at TEXT,
    UNIQUE(session_id, request_key)
  );
  CREATE INDEX IF NOT EXISTS reviewer_clarifications_session
    ON reviewer_clarifications(session_id, requested_at);
  CREATE TABLE IF NOT EXISTS reviewer_next_steps (
    session_id TEXT PRIMARY KEY,
    action TEXT NOT NULL CHECK (action IN ('continue_review', 'technical_review', 'candidate_conversation', 'closeout')),
    note TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
`;

type ClarificationRow = {
  id: string;
  prompt: string;
  requested_at: string;
  request_key: string;
  reply: string | null;
  replied_at: string | null;
  closed_at: string | null;
};

export class ReviewerWorkflowStore {
  constructor(private readonly databasePath: string) {}

  get(sessionId: string): ReviewWorkflow {
    return this.withDatabase((database) => {
      const noteRow = database
        .prepare(
          'SELECT body, updated_at, version FROM reviewer_notes WHERE session_id = ?',
        )
        .get(sessionId) as
        { body: string; updated_at: string; version: number } | undefined;
      const clarificationRows = database
        .prepare(
          'SELECT * FROM reviewer_clarifications WHERE session_id = ? ORDER BY requested_at ASC',
        )
        .all(sessionId) as ClarificationRow[];
      const nextStepRow = database
        .prepare(
          'SELECT action, note, updated_at, version FROM reviewer_next_steps WHERE session_id = ?',
        )
        .get(sessionId) as
        | {
            action: ReviewNextStep['action'];
            note: string;
            updated_at: string;
            version: number;
          }
        | undefined;

      return {
        note: noteRow
          ? {
              body: noteRow.body,
              updatedAt: noteRow.updated_at,
              version: noteRow.version,
            }
          : null,
        clarifications: clarificationRows.map((row) => ({
          id: row.id,
          prompt: row.prompt,
          requestedAt: row.requested_at,
          reply: row.reply,
          repliedAt: row.replied_at,
          closedAt: row.closed_at,
        })),
        nextStep: nextStepRow
          ? {
              action: nextStepRow.action,
              note: nextStepRow.note,
              updatedAt: nextStepRow.updated_at,
              version: nextStepRow.version,
            }
          : null,
      };
    });
  }

  saveNote(
    sessionId: string,
    body: string,
    expectedVersion: number,
    now = new Date().toISOString(),
  ): ReviewNote | null {
    return this.withDatabase((database) => {
      const transaction = database.transaction(() => {
        const existing = database
          .prepare('SELECT version FROM reviewer_notes WHERE session_id = ?')
          .get(sessionId) as { version: number } | undefined;
        if ((existing?.version ?? 0) !== expectedVersion) return null;
        const version = expectedVersion + 1;
        database
          .prepare(
            `INSERT INTO reviewer_notes (session_id, body, updated_at, version)
          VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at, version = excluded.version`,
          )
          .run(sessionId, body, now, version);
        return { body, updatedAt: now, version };
      });
      return transaction.immediate();
    });
  }

  requestClarification(
    sessionId: string,
    prompt: string,
    requestKey: string,
    now = new Date().toISOString(),
  ): Clarification | null {
    const clarification: Clarification = {
      id: randomUUID(),
      prompt,
      requestedAt: now,
      reply: null,
      repliedAt: null,
      closedAt: null,
    };
    return this.withDatabase((database) => {
      const transaction = database.transaction(() => {
        const existing = database
          .prepare(
            `SELECT * FROM reviewer_clarifications
          WHERE session_id = ? AND request_key = ?`,
          )
          .get(sessionId, requestKey) as ClarificationRow | undefined;
        if (existing) return existing.prompt === prompt ? existing : null;
        database
          .prepare(
            `INSERT INTO reviewer_clarifications
          (id, session_id, prompt, request_key, requested_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(clarification.id, sessionId, prompt, requestKey, now);
        return database
          .prepare(
            `SELECT * FROM reviewer_clarifications
          WHERE session_id = ? AND request_key = ?`,
          )
          .get(sessionId, requestKey) as ClarificationRow;
      });
      const row = transaction.immediate();
      if (!row) return null;
      return {
        id: row.id,
        prompt: row.prompt,
        requestedAt: row.requested_at,
        reply: row.reply,
        repliedAt: row.replied_at,
        closedAt: row.closed_at,
      };
    });
  }

  replyToClarification(
    sessionId: string,
    clarificationId: string,
    reply: string,
    now = new Date().toISOString(),
  ): Clarification | null | 'conflict' {
    return this.withDatabase((database) => {
      const result = database
        .prepare(
          `UPDATE reviewer_clarifications
        SET reply = ?, replied_at = ?
        WHERE id = ? AND session_id = ? AND reply IS NULL AND closed_at IS NULL`,
        )
        .run(reply, now, clarificationId, sessionId);
      const row = database
        .prepare(
          'SELECT * FROM reviewer_clarifications WHERE id = ? AND session_id = ?',
        )
        .get(clarificationId, sessionId) as ClarificationRow | undefined;
      if (!row) return null;
      if (result.changes !== 1 && row.reply !== reply) return 'conflict';
      return {
        id: row.id,
        prompt: row.prompt,
        requestedAt: row.requested_at,
        reply: row.reply,
        repliedAt: row.replied_at,
        closedAt: row.closed_at,
      };
    });
  }

  closeClarification(
    sessionId: string,
    clarificationId: string,
    now = new Date().toISOString(),
  ): boolean {
    return this.withDatabase(
      (database) =>
        database
          .prepare(
            `UPDATE reviewer_clarifications
      SET closed_at = ? WHERE id = ? AND session_id = ? AND closed_at IS NULL AND reply IS NOT NULL`,
          )
          .run(now, clarificationId, sessionId).changes === 1,
    );
  }

  saveNextStep(
    sessionId: string,
    action: ReviewNextStep['action'],
    note: string,
    expectedVersion: number,
    now = new Date().toISOString(),
  ): ReviewNextStep | null {
    return this.withDatabase((database) => {
      const transaction = database.transaction(() => {
        const existing = database
          .prepare(
            'SELECT version FROM reviewer_next_steps WHERE session_id = ?',
          )
          .get(sessionId) as { version: number } | undefined;
        if ((existing?.version ?? 0) !== expectedVersion) return null;
        const version = expectedVersion + 1;
        database
          .prepare(
            `INSERT INTO reviewer_next_steps (session_id, action, note, updated_at, version)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET action = excluded.action, note = excluded.note, updated_at = excluded.updated_at, version = excluded.version`,
          )
          .run(sessionId, action, note, now, version);
        return { action, note, updatedAt: now, version };
      });
      return transaction.immediate();
    });
  }

  private withDatabase<T>(operation: (database: Database.Database) => T): T {
    if (this.databasePath !== ':memory:')
      mkdirSync(path.dirname(this.databasePath), { recursive: true });
    const database = new Database(this.databasePath);
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');
    database.exec(schema);
    const columns = database
      .prepare('PRAGMA table_info(reviewer_next_steps)')
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'version')) {
      const migrate = database.transaction(() => {
        const currentColumns = database
          .prepare('PRAGMA table_info(reviewer_next_steps)')
          .all() as Array<{ name: string }>;
        if (!currentColumns.some((column) => column.name === 'version')) {
          database.exec(
            'ALTER TABLE reviewer_next_steps ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
          );
        }
      });
      migrate.immediate();
    }
    try {
      return operation(database);
    } finally {
      database.close();
    }
  }
}

export const getReviewerWorkflowStore = () => {
  assertApplicationStartupReady();
  const store = new ReviewerWorkflowStore(getApplicationDatabasePath());
  return new Proxy(store, {
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
