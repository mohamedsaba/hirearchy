import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type {
  AiInteraction,
  AiInteractionStatus,
  CandidateContextAttachment,
  HirearchyContextMetadata,
} from './ai-interaction';

export const aiInteractionsSchema = `
  CREATE TABLE IF NOT EXISTS ai_interactions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('ADMITTED', 'DISPATCH_STARTED', 'COMPLETED', 'CANCELLED', 'FAILED')
    ),
    configured_provider_id TEXT NOT NULL,
    configured_model_id TEXT NOT NULL,
    candidate_prompt_text TEXT NOT NULL,
    candidate_context_json TEXT,
    hirearchy_context_json TEXT,
    captured_response_text TEXT,
    terminal_reason TEXT,
    error_message TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL,
    terminal_at TEXT,
    started_sequence INTEGER,
    terminal_sequence INTEGER,
    UNIQUE(session_id, client_request_id)
  );
`;

type AiInteractionRow = Readonly<{
  id: string;
  session_id: string;
  client_request_id: string;
  status: AiInteractionStatus;
  configured_provider_id: string;
  configured_model_id: string;
  candidate_prompt_text: string;
  candidate_context_json: string | null;
  hirearchy_context_json: string | null;
  captured_response_text: string | null;
  terminal_reason: string | null;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
  terminal_at: string | null;
  started_sequence: number | null;
  terminal_sequence: number | null;
}>;

const toAiInteraction = (row: AiInteractionRow): AiInteraction => ({
  id: row.id,
  sessionId: row.session_id,
  clientRequestId: row.client_request_id,
  status: row.status,
  configuredProviderId: row.configured_provider_id,
  configuredModelId: row.configured_model_id,
  candidatePromptText: row.candidate_prompt_text,
  candidateContext: row.candidate_context_json
    ? (JSON.parse(
        row.candidate_context_json,
      ) as readonly CandidateContextAttachment[])
    : undefined,
  hirearchyContext: row.hirearchy_context_json
    ? (JSON.parse(row.hirearchy_context_json) as HirearchyContextMetadata)
    : undefined,
  capturedResponseText: row.captured_response_text,
  terminalReason: row.terminal_reason,
  errorMessage: row.error_message,
  durationMs: row.duration_ms,
  createdAt: row.created_at,
  terminalAt: row.terminal_at,
  startedSequence: row.started_sequence,
  terminalSequence: row.terminal_sequence,
});

export type UpdateAiInteractionStatusParams = Readonly<{
  id: string;
  status: AiInteractionStatus;
  capturedResponseText?: string | null;
  terminalReason?: string | null;
  errorMessage?: string | null;
  durationMs?: number | null;
  terminalAt?: string | null;
  terminalSequence?: number | null;
}>;

export class SqliteAiInteractionStore {
  constructor(private readonly databasePath: string) {}

  static ensureSchema(database: Database.Database): void {
    database.exec(aiInteractionsSchema);
  }

  createWithDatabase(
    database: Database.Database,
    interaction: AiInteraction,
  ): AiInteraction {
    database
      .prepare(
        `INSERT INTO ai_interactions (
          id, session_id, client_request_id, status, configured_provider_id,
          configured_model_id, candidate_prompt_text, candidate_context_json,
          hirearchy_context_json, captured_response_text, terminal_reason,
          error_message, duration_ms, created_at, terminal_at, started_sequence,
          terminal_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        interaction.id,
        interaction.sessionId,
        interaction.clientRequestId,
        interaction.status,
        interaction.configuredProviderId,
        interaction.configuredModelId,
        interaction.candidatePromptText,
        interaction.candidateContext
          ? JSON.stringify(interaction.candidateContext)
          : null,
        interaction.hirearchyContext
          ? JSON.stringify(interaction.hirearchyContext)
          : null,
        interaction.capturedResponseText ?? null,
        interaction.terminalReason ?? null,
        interaction.errorMessage ?? null,
        interaction.durationMs ?? null,
        interaction.createdAt,
        interaction.terminalAt ?? null,
        interaction.startedSequence ?? null,
        interaction.terminalSequence ?? null,
      );

    return interaction;
  }

  create(interaction: AiInteraction): AiInteraction {
    return this.withDatabase((database) =>
      this.createWithDatabase(database, interaction),
    );
  }

  updateStartedSequenceWithDatabase(
    database: Database.Database,
    id: string,
    startedSequence: number,
  ): void {
    database
      .prepare('UPDATE ai_interactions SET started_sequence = ? WHERE id = ?')
      .run(startedSequence, id);
  }

  updateStatusWithDatabase(
    database: Database.Database,
    params: UpdateAiInteractionStatusParams,
  ): AiInteraction {
    database
      .prepare(
        `UPDATE ai_interactions SET
          status = ?,
          captured_response_text = COALESCE(?, captured_response_text),
          terminal_reason = COALESCE(?, terminal_reason),
          error_message = COALESCE(?, error_message),
          duration_ms = COALESCE(?, duration_ms),
          terminal_at = COALESCE(?, terminal_at),
          terminal_sequence = COALESCE(?, terminal_sequence)
        WHERE id = ?`,
      )
      .run(
        params.status,
        params.capturedResponseText ?? null,
        params.terminalReason ?? null,
        params.errorMessage ?? null,
        params.durationMs ?? null,
        params.terminalAt ?? null,
        params.terminalSequence ?? null,
        params.id,
      );

    const updated = this.findByIdWithDatabase(database, params.id);
    if (!updated) {
      throw new Error(
        `AI interaction with id ${params.id} not found after update`,
      );
    }
    return updated;
  }

  updateStatus(params: UpdateAiInteractionStatusParams): AiInteraction {
    return this.withDatabase((database) =>
      this.updateStatusWithDatabase(database, params),
    );
  }

  findByIdWithDatabase(
    database: Database.Database,
    id: string,
  ): AiInteraction | null {
    const row = database
      .prepare('SELECT * FROM ai_interactions WHERE id = ?')
      .get(id) as AiInteractionRow | undefined;

    return row ? toAiInteraction(row) : null;
  }

  findById(id: string): AiInteraction | null {
    return this.withDatabase((database) =>
      this.findByIdWithDatabase(database, id),
    );
  }

  findByClientRequestIdWithDatabase(
    database: Database.Database,
    sessionId: string,
    clientRequestId: string,
  ): AiInteraction | null {
    const row = database
      .prepare(
        'SELECT * FROM ai_interactions WHERE session_id = ? AND client_request_id = ?',
      )
      .get(sessionId, clientRequestId) as AiInteractionRow | undefined;

    return row ? toAiInteraction(row) : null;
  }

  findByClientRequestId(
    sessionId: string,
    clientRequestId: string,
  ): AiInteraction | null {
    return this.withDatabase((database) =>
      this.findByClientRequestIdWithDatabase(
        database,
        sessionId,
        clientRequestId,
      ),
    );
  }

  findBySessionId(sessionId: string): readonly AiInteraction[] {
    return this.withDatabase((database) => {
      const rows = database
        .prepare(
          'SELECT * FROM ai_interactions WHERE session_id = ? ORDER BY created_at ASC',
        )
        .all(sessionId) as AiInteractionRow[];

      return rows.map(toAiInteraction);
    });
  }

  findOpenBySessionIdWithDatabase(
    database: Database.Database,
    sessionId: string,
  ): readonly AiInteraction[] {
    const rows = database
      .prepare(
        `SELECT * FROM ai_interactions
         WHERE session_id = ? AND status IN ('ADMITTED', 'DISPATCH_STARTED')
         ORDER BY started_sequence ASC, id ASC`,
      )
      .all(sessionId) as AiInteractionRow[];

    return rows.map(toAiInteraction);
  }

  findOpenBySessionId(sessionId: string): readonly AiInteraction[] {
    return this.withDatabase((database) =>
      this.findOpenBySessionIdWithDatabase(database, sessionId),
    );
  }

  countCompletedBySessionIdWithDatabase(
    database: Database.Database,
    sessionId: string,
  ): number {
    const row = database
      .prepare(
        "SELECT COUNT(*) as count FROM ai_interactions WHERE session_id = ? AND status = 'COMPLETED'",
      )
      .get(sessionId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  countCompletedBySessionId(sessionId: string): number {
    return this.withDatabase((database) =>
      this.countCompletedBySessionIdWithDatabase(database, sessionId),
    );
  }

  countTotalBySessionIdWithDatabase(
    database: Database.Database,
    sessionId: string,
  ): number {
    const row = database
      .prepare(
        'SELECT COUNT(*) as count FROM ai_interactions WHERE session_id = ?',
      )
      .get(sessionId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  countTotalBySessionId(sessionId: string): number {
    return this.withDatabase((database) =>
      this.countTotalBySessionIdWithDatabase(database, sessionId),
    );
  }

  countRecentBySessionIdWithDatabase(
    database: Database.Database,
    sessionId: string,
    windowSeconds: number,
    nowIso: string,
  ): number {
    const cutoffTime = new Date(
      new Date(nowIso).getTime() - windowSeconds * 1000,
    ).toISOString();
    const row = database
      .prepare(
        'SELECT COUNT(*) as count FROM ai_interactions WHERE session_id = ? AND created_at >= ?',
      )
      .get(sessionId, cutoffTime) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  countRecentBySessionId(
    sessionId: string,
    windowSeconds: number,
    nowIso = new Date().toISOString(),
  ): number {
    return this.withDatabase((database) =>
      this.countRecentBySessionIdWithDatabase(
        database,
        sessionId,
        windowSeconds,
        nowIso,
      ),
    );
  }

  private withDatabase<T>(operation: (database: Database.Database) => T): T {
    if (this.databasePath !== ':memory:') {
      mkdirSync(path.dirname(this.databasePath), { recursive: true });
    }

    const database = new Database(this.databasePath);
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');
    database.exec(aiInteractionsSchema);

    try {
      return operation(database);
    } finally {
      database.close();
    }
  }
}
