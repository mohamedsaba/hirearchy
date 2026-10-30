import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';

const { databasePath, key, barrier } = workerData;
const sharedBarrier = new Int32Array(barrier);
const database = new Database(databasePath);
database.pragma('busy_timeout = 5000');
parentPort.postMessage({ type: 'ready' });
Atomics.wait(sharedBarrier, 0, 0, 10_000);

try {
  const transaction = database.transaction(() => {
    const existing = database
      .prepare('SELECT id FROM assessment_sessions WHERE issuance_key = ?')
      .get(key);
    if (existing) return { created: false, id: existing.id };

    const id = `worker-session-${process.pid}-${Date.now()}-${Math.random()}`;
    database
      .prepare(
        `INSERT INTO assessment_sessions (
          id, candidate_token_hash, scenario_id, scenario_version,
          scenario_title, scenario_brief, acceptance_criteria, file_path,
          original_content, status, working_content, created_at,
          issuance_key, issuance_request_hash, issuance_payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `hash-${id}`,
        'scenario-worker',
        '1.0.0',
        'SQLite issuance contention proof',
        'synthetic scenario',
        '[]',
        'README.md',
        'synthetic content',
        'synthetic content',
        new Date().toISOString(),
        key,
        'a'.repeat(64),
        'b'.repeat(64),
      );
    // Hold the immediate transaction briefly so the other independent
    // connection contends on the same issuance key before commit.
    Atomics.wait(sharedBarrier, 1, 0, 100);
    return { created: true, id };
  });
  const result = transaction.immediate();
  parentPort.postMessage({ type: 'done', result });
} catch (error) {
  parentPort.postMessage({
    type: 'error',
    error: error instanceof Error ? error.message : 'unknown worker failure',
  });
} finally {
  database.close();
}
