import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertCandidateTokenStorage,
  CandidateTokenStorageError,
  decryptCandidateToken,
  encryptCandidateToken,
  loadCandidateTokenEncryptionKey,
  migrateLegacyCandidateTokens,
} from '../../apps/web/src/sessions/candidate-token-storage.mjs';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { migrateCandidateTokenDatabase } from '../../scripts/migrate-candidate-token-storage.mjs';

const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

describe('candidate token encrypted storage', () => {
  const key = loadCandidateTokenEncryptionKey();

  it('uses fresh AES-GCM nonces and binds authenticated ciphertext to a session', () => {
    const first = encryptCandidateToken('synthetic-token-a', 'session-a', key);
    const second = encryptCandidateToken('synthetic-token-a', 'session-a', key);
    expect(first).toMatch(/^v1\./);
    expect(second).not.toBe(first);
    expect(decryptCandidateToken(first, 'session-a', key)).toBe(
      'synthetic-token-a',
    );
    expect(() => decryptCandidateToken(first, 'session-b', key)).toThrow(
      CandidateTokenStorageError,
    );
    expect(() =>
      decryptCandidateToken(first, 'session-a', Buffer.alloc(32, 0x53)),
    ).toThrow(CandidateTokenStorageError);
    expect(() => decryptCandidateToken(42, 'session-a', key)).toThrow(
      CandidateTokenStorageError,
    );

    const parts = first.split('.');
    const lastTagCharacter = parts[3].at(-1) === 'A' ? 'B' : 'A';
    parts[3] = `${parts[3].slice(0, -1)}${lastTagCharacter}`;
    expect(() =>
      decryptCandidateToken(parts.join('.'), 'session-a', key),
    ).toThrow(CandidateTokenStorageError);
  });

  it('rejects missing, malformed, and wrong-length encryption keys without generating replacements', () => {
    const keyVariable = 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY';
    const configuredKey = process.env[keyVariable];
    delete process.env[keyVariable];
    try {
      expect(() => loadCandidateTokenEncryptionKey()).toThrow(
        /must be configured/,
      );
    } finally {
      if (configuredKey === undefined) delete process.env[keyVariable];
      else process.env[keyVariable] = configuredKey;
    }
    expect(() => loadCandidateTokenEncryptionKey('not-base64')).toThrow(
      /canonical base64 for exactly 32 bytes/,
    );
    expect(() =>
      loadCandidateTokenEncryptionKey(Buffer.alloc(31).toString('base64')),
    ).toThrow(/canonical base64 for exactly 32 bytes/);
  });

  it('requires explicit adoption for an existing hash-only schema and preserves those rows', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE assessment_sessions (
        id TEXT PRIMARY KEY,
        candidate_token_hash TEXT NOT NULL
      );
    `);
    database
      .prepare(
        'INSERT INTO assessment_sessions (id, candidate_token_hash) VALUES (?, ?)',
      )
      .run('hash-only-session', tokenHash('hash-only-token'));

    expect(() => assertCandidateTokenStorage(database, { key })).toThrow(
      CandidateTokenStorageError,
    );
    expect(() => migrateLegacyCandidateTokens(database)).toThrow(
      CandidateTokenStorageError,
    );
    expect(
      migrateLegacyCandidateTokens(database, { adoptExisting: true }),
    ).toEqual({ converted: 0, rotated: 0 });
    expect(assertCandidateTokenStorage(database, { key })).toBe(true);
    const row = database
      .prepare(
        'SELECT candidate_token_hash, candidate_token_ciphertext FROM assessment_sessions WHERE id = ?',
      )
      .get('hash-only-session');
    expect(row).toEqual({
      candidate_token_hash: tokenHash('hash-only-token'),
      candidate_token_ciphertext: null,
    });
    database.close();
  });

  it('converts legacy plaintext only after token hash and decrypt verification, and is repeatable', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE assessment_sessions (
        id TEXT PRIMARY KEY,
        candidate_token_hash TEXT NOT NULL,
        candidate_token TEXT,
        candidate_token_ciphertext TEXT
      );
    `);
    const token = 'synthetic-legacy-token';
    database
      .prepare(
        'INSERT INTO assessment_sessions (id, candidate_token_hash, candidate_token) VALUES (?, ?, ?)',
      )
      .run('legacy-a', tokenHash(token), token);

    try {
      expect(
        migrateLegacyCandidateTokens(database, { adoptExisting: true }),
      ).toEqual({
        converted: 1,
        rotated: 0,
      });
      const converted = database
        .prepare(
          'SELECT candidate_token, candidate_token_hash, candidate_token_ciphertext FROM assessment_sessions WHERE id = ?',
        )
        .get('legacy-a') as {
        candidate_token: string | null;
        candidate_token_hash: string;
        candidate_token_ciphertext: string;
      };
      expect(converted.candidate_token).toBeNull();
      expect(
        decryptCandidateToken(
          converted.candidate_token_ciphertext,
          'legacy-a',
          key,
        ),
      ).toBe(token);
      expect(tokenHash(token)).toBe(converted.candidate_token_hash);
      expect(
        migrateLegacyCandidateTokens(database, { adoptExisting: true }),
      ).toEqual({
        converted: 0,
        rotated: 0,
      });
    } finally {
      database.close();
    }
  });

  it('rotates encrypted links from the old key to the current key without changing lookup hashes', () => {
    const oldKey = Buffer.alloc(32, 0x31);
    const newKey = Buffer.alloc(32, 0x54);
    const token = 'synthetic-rotation-token';
    const sessionId = 'rotation-session';
    const oldCiphertext = encryptCandidateToken(token, sessionId, oldKey);
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE assessment_sessions (
        id TEXT PRIMARY KEY,
        candidate_token_hash TEXT NOT NULL,
        candidate_token TEXT,
        candidate_token_ciphertext TEXT
      );
    `);
    database
      .prepare(
        `INSERT INTO assessment_sessions (
          id, candidate_token_hash, candidate_token_ciphertext
        ) VALUES (?, ?, ?)`,
      )
      .run(sessionId, tokenHash(token), oldCiphertext);

    const variable = 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY';
    const configuredKey = process.env[variable];
    process.env[variable] = newKey.toString('base64');
    try {
      expect(
        migrateLegacyCandidateTokens(database, {
          oldKey,
          adoptExisting: true,
        }),
      ).toEqual({
        converted: 0,
        rotated: 1,
      });
      const migrated = database
        .prepare(
          'SELECT candidate_token, candidate_token_hash, candidate_token_ciphertext FROM assessment_sessions WHERE id = ?',
        )
        .get(sessionId) as {
        candidate_token: string | null;
        candidate_token_hash: string;
        candidate_token_ciphertext: string;
      };
      expect(migrated.candidate_token).toBeNull();
      expect(migrated.candidate_token_ciphertext).not.toBe(oldCiphertext);
      expect(
        decryptCandidateToken(
          migrated.candidate_token_ciphertext,
          sessionId,
          newKey,
        ),
      ).toBe(token);
      expect(tokenHash(token)).toBe(migrated.candidate_token_hash);
      expect(() =>
        decryptCandidateToken(
          migrated.candidate_token_ciphertext,
          sessionId,
          oldKey,
        ),
      ).toThrow(CandidateTokenStorageError);
    } finally {
      if (configuredKey === undefined) delete process.env[variable];
      else process.env[variable] = configuredKey;
      database.close();
    }
  });

  it('preserves the bound database identity when rotation uses the wrong old key', () => {
    const oldKey = Buffer.alloc(32, 0x31);
    const newKey = Buffer.alloc(32, 0x54);
    const token = 'synthetic-bound-rotation-token';
    const sessionId = 'bound-rotation-session';
    const database = new Database(':memory:');
    const variable = 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY';
    const configuredKey = process.env[variable];
    database.exec(`
      CREATE TABLE assessment_sessions (
        id TEXT PRIMARY KEY,
        candidate_token_hash TEXT NOT NULL,
        candidate_token TEXT,
        candidate_token_ciphertext TEXT
      );
    `);
    database
      .prepare(
        `INSERT INTO assessment_sessions (
          id, candidate_token_hash, candidate_token_ciphertext
        ) VALUES (?, ?, ?)`,
      )
      .run(
        sessionId,
        tokenHash(token),
        encryptCandidateToken(token, sessionId, oldKey),
      );

    try {
      process.env[variable] = oldKey.toString('base64');
      migrateLegacyCandidateTokens(database, { adoptExisting: true });
      const markerBefore = database
        .prepare(
          'SELECT version, database_id, key_check FROM candidate_token_storage_meta',
        )
        .get();
      const ciphertextBefore = database
        .prepare(
          'SELECT candidate_token_ciphertext FROM assessment_sessions WHERE id = ?',
        )
        .get(sessionId);

      process.env[variable] = newKey.toString('base64');
      expect(() =>
        migrateLegacyCandidateTokens(database, {
          oldKey: Buffer.alloc(32, 0x32),
        }),
      ).toThrow(CandidateTokenStorageError);
      expect(
        database
          .prepare(
            'SELECT version, database_id, key_check FROM candidate_token_storage_meta',
          )
          .get(),
      ).toEqual(markerBefore);
      expect(
        database
          .prepare(
            'SELECT candidate_token_ciphertext FROM assessment_sessions WHERE id = ?',
          )
          .get(sessionId),
      ).toEqual(ciphertextBefore);

      expect(
        migrateLegacyCandidateTokens(database, {
          oldKey,
        }),
      ).toEqual({ converted: 0, rotated: 1 });
      const markerAfter = database
        .prepare(
          'SELECT version, database_id, key_check FROM candidate_token_storage_meta',
        )
        .get();
      expect(markerAfter.database_id).toBe(markerBefore.database_id);
      expect(markerAfter.key_check).not.toBe(markerBefore.key_check);
      expect(assertCandidateTokenStorage(database, { key: newKey })).toBe(true);
      expect(() =>
        assertCandidateTokenStorage(database, { key: oldKey }),
      ).toThrow(CandidateTokenStorageError);
    } finally {
      if (configuredKey === undefined) delete process.env[variable];
      else process.env[variable] = configuredKey;
      database.close();
    }
  });

  it('rolls back conversion on hash mismatch and explicitly refuses a NOT NULL legacy column', () => {
    const mismatched = new Database(':memory:');
    mismatched.exec(`
      CREATE TABLE assessment_sessions (
        id TEXT PRIMARY KEY,
        candidate_token_hash TEXT NOT NULL,
        candidate_token TEXT,
        candidate_token_ciphertext TEXT
      );
    `);
    mismatched
      .prepare(
        'INSERT INTO assessment_sessions (id, candidate_token_hash, candidate_token) VALUES (?, ?, ?)',
      )
      .run(
        'mismatch',
        tokenHash('different-synthetic-token'),
        'synthetic-unverified-token',
      );
    expect(() =>
      migrateLegacyCandidateTokens(mismatched, { adoptExisting: true }),
    ).toThrow(/does not match its lookup hash/);
    expect(
      mismatched
        .prepare(
          'SELECT candidate_token, candidate_token_ciphertext FROM assessment_sessions',
        )
        .get(),
    ).toEqual({
      candidate_token: 'synthetic-unverified-token',
      candidate_token_ciphertext: null,
    });
    mismatched.close();

    const constrained = new Database(':memory:');
    constrained.exec(`
      CREATE TABLE assessment_sessions (
        id TEXT PRIMARY KEY,
        candidate_token_hash TEXT NOT NULL,
        candidate_token TEXT NOT NULL
      )
    `);
    constrained
      .prepare(
        'INSERT INTO assessment_sessions (id, candidate_token_hash, candidate_token) VALUES (?, ?, ?)',
      )
      .run(
        'not-null-session',
        tokenHash('synthetic-not-null-token'),
        'synthetic-not-null-token',
      );
    expect(() =>
      migrateLegacyCandidateTokens(constrained, { adoptExisting: true }),
    ).toThrow(/candidate_token column is NOT NULL/);
    expect(
      constrained
        .prepare('SELECT candidate_token FROM assessment_sessions')
        .get(),
    ).toEqual({ candidate_token: 'synthetic-not-null-token' });
    constrained.close();
  });
});

describe('candidate token storage association and guarded writes', () => {
  let directory = '';

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  const snapshot = (databasePath: string) => {
    const database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return {
        schema: database
          .prepare(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all(),
        marker: database
          .prepare(
            'SELECT version, database_id, key_check FROM candidate_token_storage_meta',
          )
          .all(),
        rows: database
          .prepare('SELECT * FROM assessment_sessions ORDER BY id')
          .all(),
      };
    } finally {
      database.close();
    }
  };

  it('rejects an existing empty database without adding schema', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-existing-empty-'));
    const databasePath = path.join(directory, 'sessions.sqlite');
    new Database(databasePath).close();

    expect(() =>
      new SqliteSessionStore(databasePath).findById('missing'),
    ).toThrow(
      expect.objectContaining({ code: 'CANDIDATE_TOKEN_STORAGE_UNBOUND' }),
    );
    const database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('rejects a wrong associated key before issuance changes schema or rows', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-wrong-key-'));
    const databasePath = path.join(directory, 'sessions.sqlite');
    const service = new SessionService(new SqliteSessionStore(databasePath));
    service.createSession();
    const before = snapshot(databasePath);
    const keyVariable = 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY';
    const configuredKey = process.env[keyVariable];
    process.env[keyVariable] = Buffer.alloc(32, 0x37).toString('base64');
    try {
      expect(() => service.createSession()).toThrow(
        expect.objectContaining({ code: 'CANDIDATE_TOKEN_KEY_MISMATCH' }),
      );
    } finally {
      if (configuredKey === undefined) delete process.env[keyVariable];
      else process.env[keyVariable] = configuredKey;
    }
    expect(snapshot(databasePath)).toEqual(before);
  });

  it('creates a fresh database identity and fails closed if its key is removed', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-missing-key-'));
    const databasePath = path.join(directory, 'sessions.sqlite');
    const service = new SessionService(new SqliteSessionStore(databasePath));
    service.createSession();
    const before = snapshot(databasePath);
    expect(before.marker).toHaveLength(1);
    expect(before.marker[0]).toMatchObject({ version: 1 });

    const keyVariable = 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY';
    const configuredKey = process.env[keyVariable];
    delete process.env[keyVariable];
    try {
      expect(() => service.createSession()).toThrow(CandidateTokenStorageError);
    } finally {
      if (configuredKey === undefined) delete process.env[keyVariable];
      else process.env[keyVariable] = configuredKey;
    }
    expect(snapshot(databasePath)).toEqual(before);
  });

  it('scans every stored link before encrypted writes and rolls back before additive schema repair', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-row-scan-'));
    const databasePath = path.join(directory, 'sessions.sqlite');
    let nextId = 0;
    const service = new SessionService(new SqliteSessionStore(databasePath), {
      createId: () => `session-${++nextId}`,
      createToken: () => `synthetic-token-${nextId + 1}`,
    });
    const first = service.createSession();
    const second = service.createSession();

    const raw = new Database(databasePath);
    raw.exec(
      'ALTER TABLE assessment_sessions DROP COLUMN scenario_semantic_snapshot',
    );
    raw
      .prepare(
        `UPDATE assessment_sessions
       SET status = 'SUBMITTED', submitted_content = working_content,
           submitted_at = created_at, closure_reason = NULL,
           candidate_token_ciphertext = 'v1.invalid.invalid.invalid'
       WHERE id = ?`,
      )
      .run(first.session.id);
    raw.close();
    const before = snapshot(databasePath);

    expect(() => service.createSession()).toThrow(CandidateTokenStorageError);
    expect(snapshot(databasePath)).toEqual(before);
    expect(() =>
      new SqliteSessionStore(databasePath).findAssessmentLifecycleEntries(1),
    ).toThrow(CandidateTokenStorageError);
    expect(snapshot(databasePath)).toEqual(before);
    expect(first.session.candidateTokenHash).not.toBe(
      second.session.candidateTokenHash,
    );
  });

  it('rejects mixed plaintext and encrypted rows before inserting another link', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-mixed-tokens-'));
    const databasePath = path.join(directory, 'sessions.sqlite');
    let nextId = 0;
    const service = new SessionService(new SqliteSessionStore(databasePath), {
      createId: () => `session-${++nextId}`,
      createToken: () => `synthetic-token-${nextId + 1}`,
    });
    const first = service.createSession();
    const second = service.createSession();
    const raw = new Database(databasePath);
    raw
      .prepare(
        'UPDATE assessment_sessions SET candidate_token = ? WHERE id = ?',
      )
      .run('synthetic-plaintext-token', second.session.id);
    raw.close();
    const before = snapshot(databasePath);

    expect(() => service.createSession()).toThrow(CandidateTokenStorageError);
    expect(snapshot(databasePath)).toEqual(before);
    expect(first.session.candidateTokenHash).not.toBe(
      second.session.candidateTokenHash,
    );
  });

  it('rejects encrypted rows written under a different key before another write', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-mixed-key-'));
    const databasePath = path.join(directory, 'sessions.sqlite');
    let nextId = 0;
    const service = new SessionService(new SqliteSessionStore(databasePath), {
      createId: () => `session-${++nextId}`,
      createToken: () => `synthetic-token-${nextId + 1}`,
    });
    const first = service.createSession();
    const second = service.createSession();
    const token = 'synthetic-token-from-another-key';
    const wrongKey = Buffer.alloc(32, 0x66);
    const raw = new Database(databasePath);
    raw
      .prepare(
        `UPDATE assessment_sessions
       SET candidate_token_hash = ?, candidate_token_ciphertext = ?
       WHERE id = ?`,
      )
      .run(
        tokenHash(token),
        encryptCandidateToken(token, second.session.id, wrongKey),
        second.session.id,
      );
    raw.close();
    const before = snapshot(databasePath);

    expect(() => service.createSession()).toThrow(CandidateTokenStorageError);
    expect(snapshot(databasePath)).toEqual(before);
    expect(first.session.candidateTokenHash).not.toBe(
      second.session.candidateTokenHash,
    );
  });
});

describe('candidate token staged SQLite migration command', () => {
  let directory = '';

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const createLegacyDatabase = (
    databasePath: string,
    token: string,
    hash: string,
  ) => {
    const database = new Database(databasePath);
    database.pragma('journal_mode = WAL');
    database.exec(`
      CREATE TABLE assessment_sessions (
        id TEXT PRIMARY KEY,
        candidate_token_hash TEXT NOT NULL,
        candidate_token TEXT,
        candidate_token_ciphertext TEXT
      );
    `);
    database
      .prepare(
        'INSERT INTO assessment_sessions (id, candidate_token_hash, candidate_token) VALUES (?, ?, ?)',
      )
      .run('legacy-session', hash, token);
    database.close();
  };

  it('requires explicit adoption for a truly empty existing database', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-empty-adoption-'));
    const databasePath = path.join(directory, 'empty.sqlite');
    const backupPath = path.join(directory, 'empty-before.sqlite');
    new Database(databasePath).close();

    await expect(
      migrateCandidateTokenDatabase({ databasePath, backupPath }),
    ).rejects.toThrow(
      /empty database can be adopted only with --adopt-existing/,
    );
    expect(existsSync(backupPath)).toBe(false);

    const result = await migrateCandidateTokenDatabase({
      databasePath,
      backupPath,
      adoptExisting: true,
    });
    expect(result).toMatchObject({
      converted: 0,
      rotated: 0,
      backupVerified: true,
    });
    const store = new SqliteSessionStore(databasePath);
    expect(store.findById('missing')).toBeNull();
  });

  it('refuses to adopt an unrelated schema even when explicitly requested', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-unknown-adoption-'));
    const databasePath = path.join(directory, 'unknown.sqlite');
    const backupPath = path.join(directory, 'unknown-before.sqlite');
    const database = new Database(databasePath);
    database.exec('CREATE TABLE unrelated_records (value TEXT)');
    database
      .prepare('INSERT INTO unrelated_records (value) VALUES (?)')
      .run('preserve-me');
    database.close();

    await expect(
      migrateCandidateTokenDatabase({
        databasePath,
        backupPath,
        adoptExisting: true,
      }),
    ).rejects.toThrow(/unknown schemas are not supported/);
    expect(existsSync(backupPath)).toBe(false);
    const preserved = new Database(databasePath, { readonly: true });
    expect(
      preserved.prepare('SELECT value FROM unrelated_records').get(),
    ).toEqual({ value: 'preserve-me' });
    preserved.close();
  });

  it('creates and verifies a private WAL-aware backup before converting the source', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-token-migration-'));
    const databasePath = path.join(directory, 'legacy.sqlite');
    const backupPath = path.join(directory, 'legacy-before.sqlite');
    const token = 'synthetic-staged-migration-token';
    createLegacyDatabase(databasePath, token, tokenHash(token));

    const result = await migrateCandidateTokenDatabase({
      databasePath,
      backupPath,
      adoptExisting: true,
    });
    expect(result).toMatchObject({
      converted: 1,
      rotated: 0,
      backupVerified: true,
    });
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(existsSync(backupPath)).toBe(true);

    const source = new Database(databasePath, { readonly: true });
    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(source.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(
        source.prepare('SELECT candidate_token FROM assessment_sessions').get(),
      ).toEqual({ candidate_token: null });
      expect(
        backup.prepare('SELECT candidate_token FROM assessment_sessions').get(),
      ).toEqual({ candidate_token: token });
    } finally {
      source.close();
      backup.close();
    }
  });

  it('keeps the plaintext source unchanged and restores the original link from the retained backup', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-token-rollback-'));
    const databasePath = path.join(directory, 'legacy.sqlite');
    const backupPath = path.join(directory, 'legacy-before.sqlite');
    const token = 'synthetic-rollback-token';
    const hash = tokenHash(token);
    createLegacyDatabase(databasePath, token, hash);
    const sourceSetup = new Database(databasePath);
    sourceSetup.exec(`
      CREATE TRIGGER synthetic_conversion_failure
      BEFORE UPDATE ON assessment_sessions
      BEGIN
        SELECT RAISE(ABORT, 'synthetic staged conversion failure');
      END;
    `);
    sourceSetup.close();

    await expect(
      migrateCandidateTokenDatabase({
        databasePath,
        backupPath,
        adoptExisting: true,
      }),
    ).rejects.toThrow(/synthetic staged conversion failure/);
    expect(existsSync(backupPath)).toBe(true);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);

    const source = new Database(databasePath, { readonly: true });
    try {
      expect(
        source
          .prepare(
            'SELECT candidate_token, candidate_token_ciphertext FROM assessment_sessions',
          )
          .get(),
      ).toEqual({
        candidate_token: 'synthetic-rollback-token',
        candidate_token_ciphertext: null,
      });
    } finally {
      source.close();
    }

    const restoredPath = path.join(directory, 'restored.sqlite');
    copyFileSync(backupPath, restoredPath);
    const restored = new Database(restoredPath, { readonly: true });
    try {
      const row = restored
        .prepare(
          'SELECT candidate_token, candidate_token_hash FROM assessment_sessions',
        )
        .get() as { candidate_token: string; candidate_token_hash: string };
      expect(row.candidate_token).toBe(token);
      expect(row.candidate_token_hash).toBe(hash);
      expect(tokenHash(row.candidate_token)).toBe(row.candidate_token_hash);
    } finally {
      restored.close();
    }
  });

  it('refuses NOT NULL plaintext before creating a backup', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-token-not-null-'));
    const databasePath = path.join(directory, 'legacy.sqlite');
    const backupPath = path.join(directory, 'legacy-before.sqlite');
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE assessment_sessions (
        id TEXT PRIMARY KEY,
        candidate_token_hash TEXT NOT NULL,
        candidate_token TEXT NOT NULL
      );
    `);
    database.close();

    await expect(
      migrateCandidateTokenDatabase({
        databasePath,
        backupPath,
        adoptExisting: true,
      }),
    ).rejects.toThrow(/candidate_token column is NOT NULL/);
    expect(existsSync(backupPath)).toBe(false);
  });
});
