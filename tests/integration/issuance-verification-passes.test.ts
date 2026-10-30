import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as candidateTokenStorage from '../../apps/web/src/sessions/candidate-token-storage.mjs';
import type { AssessmentSession } from '../../apps/web/src/sessions/session';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

describe('issuance verification passes and fail-closed persistence guarantees', () => {
  let directory: string;
  let databasePath: string;
  let originalKey: string | undefined;

  const validKeyA = randomBytes(32).toString('base64');
  const validKeyB = randomBytes(32).toString('base64');

  beforeEach(() => {
    directory = mkdtempSync(
      path.join(tmpdir(), 'hirearchy-verification-passes-'),
    );
    databasePath = path.join(directory, 'sessions.sqlite');
    originalKey = process.env.HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY;
    process.env.HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY = validKeyA;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalKey === undefined) {
      delete process.env.HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY = originalKey;
    }
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const makeSession = (id: string, token: string): AssessmentSession => ({
    id,
    candidateTokenHash: candidateTokenStorage.candidateTokenHash(token),
    candidateToken: token,
    scenario: {
      id: 'slice-one',
      version: '1.0.0',
      title: 'Slice One Scenario',
      brief: 'Implementation brief',
      acceptanceCriteria: ['Pass test 1', 'Pass test 2'],
      filePath: 'src/solution.js',
      originalContent: '// initial',
    },
    status: 'CREATED',
    workingContent: '// initial',
    submittedContent: null,
    createdAt: '2026-10-24T10:00:00.000Z',
    activatedAt: null,
    submittedAt: null,
    durationSeconds: 3600,
    closureReason: null,
    terminalEnabled: true,
  });

  const captureDatabaseState = (targetPath: string) => {
    const db = new Database(targetPath, { readonly: true });
    try {
      const master = db
        .prepare(
          'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
        )
        .all();
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row: unknown) => (row as { name: string }).name);
      const rowsByTable: Record<string, unknown[]> = {};
      for (const table of tables) {
        rowsByTable[table] = db
          .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
          .all();
      }
      return { master, rowsByTable };
    } finally {
      db.close();
    }
  };

  describe('verification pass counts', () => {
    it('executes exactly 2 verification passes on fresh DB issuance', () => {
      const spy = vi.spyOn(
        candidateTokenStorage,
        'verifyCandidateTokenStorageRows',
      );
      const store = new SqliteSessionStore(databasePath);
      const session = makeSession('fresh-session-1', 'fresh-token-1');

      store.createIdempotently(session, {
        key: 'fresh-key-1',
        requestHash: 'req-hash-1',
      });

      // Pass 1: post-DDL scan in ensureSchema for empty DB marker initialization (!transactionBound)
      // Pass 2: inside write transaction in createIdempotently
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('executes exactly 2 verification passes on already-bound DB issuance (1 redundant scan eliminated)', () => {
      const store = new SqliteSessionStore(databasePath);
      const session1 = makeSession('bound-session-1', 'bound-token-1');
      store.createIdempotently(session1, {
        key: 'bound-key-1',
        requestHash: 'req-hash-1',
      });

      const spy = vi.spyOn(
        candidateTokenStorage,
        'verifyCandidateTokenStorageRows',
      );
      const session2 = makeSession('bound-session-2', 'bound-token-2');

      store.createIdempotently(session2, {
        key: 'bound-key-2',
        requestHash: 'req-hash-2',
      });

      // Pass 1: pre-DDL scan in ensureSchema (line 242)
      // Pass 2: inside write transaction in createIdempotently (line 325)
      // Redundant post-DDL scan in ensureSchema (formerly line 295) is omitted!
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('executes exactly 1 verification pass on already-bound startup verification (1 redundant scan eliminated)', () => {
      const store = new SqliteSessionStore(databasePath);
      const session1 = makeSession('startup-session-1', 'startup-token-1');
      store.createIdempotently(session1, {
        key: 'startup-key-1',
        requestHash: 'req-hash-1',
      });

      const spy = vi.spyOn(
        candidateTokenStorage,
        'verifyCandidateTokenStorageRows',
      );

      store.verifyStorageForStartup();

      // Pass 1: pre-DDL scan in ensureSchema (line 242)
      // Redundant post-DDL scan in ensureSchema (formerly line 295) is omitted!
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('executes exactly 2 verification passes on legacy create()', () => {
      const store = new SqliteSessionStore(databasePath);
      const session1 = makeSession('legacy-session-1', 'legacy-token-1');
      store.createIdempotently(session1, {
        key: 'legacy-key-1',
        requestHash: 'req-hash-1',
      });

      const spy = vi.spyOn(
        candidateTokenStorage,
        'verifyCandidateTokenStorageRows',
      );
      const session2 = makeSession('legacy-session-2', 'legacy-token-2');

      store.create(session2);

      // Pass 1: pre-DDL scan in ensureSchema
      // Pass 2: inside write transaction in create
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('executes exactly 2 verification passes on replay', () => {
      const store = new SqliteSessionStore(databasePath);
      const session1 = makeSession('replay-session-1', 'replay-token-1');
      store.createIdempotently(session1, {
        key: 'replay-key-1',
        requestHash: 'req-hash-1',
      });

      const spy = vi.spyOn(
        candidateTokenStorage,
        'verifyCandidateTokenStorageRows',
      );

      const replayResult = store.createIdempotently(session1, {
        key: 'replay-key-1',
        requestHash: 'req-hash-1',
      });

      expect(replayResult.created).toBe(false);
      // Pass 1: pre-DDL scan in ensureSchema
      // Pass 2: inside write transaction before finding existing key
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('rejection and byte-identical persistence invariants', () => {
    describe('wrong key', () => {
      it('rejects fresh issuance, replay, legacy create, and startup leaving persisted state byte-identical', () => {
        const storeA = new SqliteSessionStore(databasePath);
        const session1 = makeSession('wrong-key-sess-1', 'wrong-key-tok-1');
        storeA.createIdempotently(session1, {
          key: 'issuance-key-1',
          requestHash: 'req-hash-1',
        });

        // Switch to wrong key (valid base64, but mismatched HMAC marker check)
        process.env.HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY = validKeyB;
        const storeB = new SqliteSessionStore(databasePath);

        // 1. Fresh issuance
        const beforeFresh = captureDatabaseState(databasePath);
        const freshSession = makeSession(
          'wrong-key-fresh',
          'wrong-key-fresh-tok',
        );
        expect(() =>
          storeB.createIdempotently(freshSession, {
            key: 'fresh-key-new',
            requestHash: 'req-hash-fresh',
          }),
        ).toThrow(candidateTokenStorage.CandidateTokenStorageError);
        const afterFresh = captureDatabaseState(databasePath);
        expect(afterFresh).toEqual(beforeFresh);

        // 2. Replay
        const beforeReplay = captureDatabaseState(databasePath);
        expect(() =>
          storeB.createIdempotently(session1, {
            key: 'issuance-key-1',
            requestHash: 'req-hash-1',
          }),
        ).toThrow(candidateTokenStorage.CandidateTokenStorageError);
        const afterReplay = captureDatabaseState(databasePath);
        expect(afterReplay).toEqual(beforeReplay);

        // 3. Legacy create()
        const beforeLegacy = captureDatabaseState(databasePath);
        const legacySession = makeSession('wrong-key-leg', 'wrong-key-leg-tok');
        expect(() => storeB.create(legacySession)).toThrow(
          candidateTokenStorage.CandidateTokenStorageError,
        );
        const afterLegacy = captureDatabaseState(databasePath);
        expect(afterLegacy).toEqual(beforeLegacy);

        // 4. Startup verification
        const beforeStartup = captureDatabaseState(databasePath);
        expect(() => storeB.verifyStorageForStartup()).toThrow(
          candidateTokenStorage.CandidateTokenStorageError,
        );
        const afterStartup = captureDatabaseState(databasePath);
        expect(afterStartup).toEqual(beforeStartup);
      });
    });

    describe('mixed-key (marker matches key A, but one row ciphertext encrypted with key B)', () => {
      it('rejects fresh issuance, replay, legacy create, and startup leaving persisted state byte-identical', () => {
        const store = new SqliteSessionStore(databasePath);
        const session1 = makeSession('mixed-sess-1', 'mixed-tok-1');
        store.createIdempotently(session1, {
          key: 'mixed-key-1',
          requestHash: 'req-hash-1',
        });

        // Inject row encrypted with key B
        const keyBBytes = Buffer.from(validKeyB, 'base64');
        const token2 = 'mixed-tok-2';
        const hash2 = candidateTokenStorage.candidateTokenHash(token2);
        const ciphertext2 = candidateTokenStorage.encryptCandidateToken(
          token2,
          'mixed-sess-2',
          keyBBytes,
        );

        const db = new Database(databasePath);
        db.prepare(
          `INSERT INTO assessment_sessions (
            id, candidate_token_hash, scenario_id, scenario_version,
            scenario_title, scenario_brief, acceptance_criteria, file_path,
            original_content, status, working_content, created_at,
            candidate_token_ciphertext, issuance_key, issuance_request_hash, issuance_payload_hash
          ) VALUES (?, ?, 'slice-one', '1.0.0', 'T', 'B', '[]', 'f.js', '', 'CREATED', '', '2026-10-24T00:00:00.000Z', ?, ?, ?, ?)`,
        ).run(
          'mixed-sess-2',
          hash2,
          ciphertext2,
          'mixed-key-2',
          'req-2',
          'payload-2',
        );
        db.close();

        // 1. Fresh issuance
        const beforeFresh = captureDatabaseState(databasePath);
        const freshSession = makeSession('mixed-fresh', 'mixed-fresh-tok');
        expect(() =>
          store.createIdempotently(freshSession, {
            key: 'fresh-key-new',
            requestHash: 'req-hash-fresh',
          }),
        ).toThrow(candidateTokenStorage.CandidateTokenStorageError);
        const afterFresh = captureDatabaseState(databasePath);
        expect(afterFresh).toEqual(beforeFresh);

        // 2. Replay
        const beforeReplay = captureDatabaseState(databasePath);
        expect(() =>
          store.createIdempotently(session1, {
            key: 'mixed-key-1',
            requestHash: 'req-hash-1',
          }),
        ).toThrow(candidateTokenStorage.CandidateTokenStorageError);
        const afterReplay = captureDatabaseState(databasePath);
        expect(afterReplay).toEqual(beforeReplay);

        // 3. Legacy create()
        const beforeLegacy = captureDatabaseState(databasePath);
        const legacySession = makeSession('mixed-leg', 'mixed-leg-tok');
        expect(() => store.create(legacySession)).toThrow(
          candidateTokenStorage.CandidateTokenStorageError,
        );
        const afterLegacy = captureDatabaseState(databasePath);
        expect(afterLegacy).toEqual(beforeLegacy);

        // 4. Startup verification
        const beforeStartup = captureDatabaseState(databasePath);
        expect(() => store.verifyStorageForStartup()).toThrow(
          candidateTokenStorage.CandidateTokenStorageError,
        );
        const afterStartup = captureDatabaseState(databasePath);
        expect(afterStartup).toEqual(beforeStartup);
      });
    });

    describe('corrupt ciphertext', () => {
      it('rejects fresh issuance, replay, legacy create, and startup leaving persisted state byte-identical', () => {
        const store = new SqliteSessionStore(databasePath);
        const session1 = makeSession('corrupt-sess-1', 'corrupt-tok-1');
        store.createIdempotently(session1, {
          key: 'corrupt-key-1',
          requestHash: 'req-hash-1',
        });

        // Corrupt ciphertext in session 1
        const db = new Database(databasePath);
        db.prepare(
          `UPDATE assessment_sessions
           SET candidate_token_ciphertext = 'v1.0123456789ab.c29tZXRoaW5n.0123456789abcdef'
           WHERE id = ?`,
        ).run(session1.id);
        db.close();

        // 1. Fresh issuance
        const beforeFresh = captureDatabaseState(databasePath);
        const freshSession = makeSession('corrupt-fresh', 'corrupt-fresh-tok');
        expect(() =>
          store.createIdempotently(freshSession, {
            key: 'fresh-key-new',
            requestHash: 'req-hash-fresh',
          }),
        ).toThrow(candidateTokenStorage.CandidateTokenStorageError);
        const afterFresh = captureDatabaseState(databasePath);
        expect(afterFresh).toEqual(beforeFresh);

        // 2. Replay
        const beforeReplay = captureDatabaseState(databasePath);
        expect(() =>
          store.createIdempotently(session1, {
            key: 'corrupt-key-1',
            requestHash: 'req-hash-1',
          }),
        ).toThrow(candidateTokenStorage.CandidateTokenStorageError);
        const afterReplay = captureDatabaseState(databasePath);
        expect(afterReplay).toEqual(beforeReplay);

        // 3. Legacy create()
        const beforeLegacy = captureDatabaseState(databasePath);
        const legacySession = makeSession('corrupt-leg', 'corrupt-leg-tok');
        expect(() => store.create(legacySession)).toThrow(
          candidateTokenStorage.CandidateTokenStorageError,
        );
        const afterLegacy = captureDatabaseState(databasePath);
        expect(afterLegacy).toEqual(beforeLegacy);

        // 4. Startup verification
        const beforeStartup = captureDatabaseState(databasePath);
        expect(() => store.verifyStorageForStartup()).toThrow(
          candidateTokenStorage.CandidateTokenStorageError,
        );
        const afterStartup = captureDatabaseState(databasePath);
        expect(afterStartup).toEqual(beforeStartup);
      });
    });
  });
});
