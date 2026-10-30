import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type {
  NewSessionEvent,
  SessionEvent,
  SessionEventType,
} from './session-event';

type EventRow = Readonly<{
  id: string;
  session_id: string;
  sequence: number;
  type: string;
  timestamp: string;
  source: string;
  payload: string;
}>;

export const eventsSchema = `
  CREATE TABLE IF NOT EXISTS assessment_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    source TEXT NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE(session_id, sequence)
  );

  CREATE INDEX IF NOT EXISTS idx_events_session_sequence
    ON assessment_events(session_id, sequence);
`;

export class SqliteEventStore {
  constructor(private readonly databasePath: string) {}

  static ensureSchema(database: Database.Database): void {
    database.exec(eventsSchema);
  }

  appendWithDatabase(
    database: Database.Database,
    event: NewSessionEvent,
  ): SessionEvent {
    const row = database
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM assessment_events WHERE session_id = ?',
      )
      .get(event.sessionId) as { next_seq: number };

    const sequence = row.next_seq;

    database
      .prepare(
        `INSERT INTO assessment_events (
          id, session_id, sequence, type, timestamp, source, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.sessionId,
        sequence,
        event.type,
        event.timestamp,
        event.source,
        JSON.stringify(event.payload),
      );

    return {
      ...event,
      sequence,
    };
  }

  append(event: NewSessionEvent): SessionEvent {
    return this.withDatabase((database) => {
      const transaction = database.transaction(() => {
        return this.appendWithDatabase(database, event);
      });

      return transaction.immediate();
    });
  }

  getEvents(sessionId: string): readonly SessionEvent[] {
    return this.withDatabase((database) => {
      const rows = database
        .prepare(
          'SELECT * FROM assessment_events WHERE session_id = ? ORDER BY sequence ASC',
        )
        .all(sessionId) as EventRow[];

      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        sequence: row.sequence,
        type: row.type as SessionEventType,
        timestamp: row.timestamp,
        source: row.source as 'server' | 'sandbox',
        payload: JSON.parse(row.payload),
      }));
    });
  }

  getRecentEvents(sessionId: string, limit: number): readonly SessionEvent[] {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('Event limit must be a positive integer.');
    }
    return this.withDatabase((database) => {
      const rows = database
        .prepare(
          'SELECT * FROM assessment_events WHERE session_id = ? ORDER BY sequence DESC LIMIT ?',
        )
        .all(sessionId, limit) as EventRow[];
      return rows.reverse().map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        sequence: row.sequence,
        type: row.type as SessionEventType,
        timestamp: row.timestamp,
        source: row.source as 'server' | 'sandbox',
        payload: JSON.parse(row.payload),
      }));
    });
  }

  private withDatabase<T>(operation: (database: Database.Database) => T): T {
    if (this.databasePath !== ':memory:') {
      mkdirSync(path.dirname(this.databasePath), { recursive: true });
    }

    const database = new Database(this.databasePath);
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');
    database.exec(eventsSchema);

    try {
      return operation(database);
    } finally {
      database.close();
    }
  }
}
