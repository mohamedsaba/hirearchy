import {
  createHmac,
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const keyVariable = 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY';
const oldKeyVariable = 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_OLD_KEY';
const storageMarkerTable = 'candidate_token_storage_meta';
const storageMarkerVersion = 1;
const aadFor = (sessionId) =>
  Buffer.from(`hirearchy:candidate-token:${sessionId}`);

export class CandidateTokenStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CandidateTokenStorageError';
    this.code = code;
  }
}

export const loadCandidateTokenEncryptionKey = (
  value = process.env[keyVariable],
) => {
  if (!value) {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_KEY_MISSING',
      `${keyVariable} must be configured before candidate links can be issued or recovered.`,
    );
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_KEY_INVALID',
      `${keyVariable} must be canonical base64 for exactly 32 bytes.`,
    );
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_KEY_INVALID',
      `${keyVariable} must be canonical base64 for exactly 32 bytes.`,
    );
  }
  return key;
};

const validKey = (key) => {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_KEY_INVALID',
      'Candidate token encryption requires a 32-byte key.',
    );
  }
};

export const candidateTokenHash = (token) =>
  createHash('sha256').update(token).digest('hex');

const schemaTables = (database) =>
  database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => row.name);

const storageMarkerExists = (database) =>
  schemaTables(database).includes(storageMarkerTable);

const keyCheckFor = (databaseId, key) =>
  createHmac('sha256', key)
    .update(`hirearchy:candidate-token-storage:v${storageMarkerVersion}:`)
    .update(databaseId)
    .digest('base64url');

const readStorageMarker = (database) => {
  if (!storageMarkerExists(database)) return null;
  let rows;
  try {
    rows = database
      .prepare(
        `SELECT version, database_id, key_check FROM ${storageMarkerTable}`,
      )
      .all();
  } catch {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_STORAGE_MARKER_INVALID',
      'Candidate-link storage metadata is invalid or unsupported.',
    );
  }
  if (rows.length !== 1 || rows[0].version !== storageMarkerVersion) {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_STORAGE_MARKER_INVALID',
      'Candidate-link storage metadata is invalid or unsupported.',
    );
  }
  return rows[0];
};

const verifyStorageMarker = (database, key) => {
  const marker = readStorageMarker(database);
  if (!marker) {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_STORAGE_UNBOUND',
      'This existing database needs explicit candidate-link storage adoption.',
    );
  }
  if (
    typeof marker.database_id !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(marker.database_id) ||
    typeof marker.key_check !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(marker.key_check)
  ) {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_STORAGE_MARKER_INVALID',
      'Candidate-link storage metadata is invalid or unsupported.',
    );
  }
  const expected = Buffer.from(keyCheckFor(marker.database_id, key));
  const actual = Buffer.from(marker.key_check);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_KEY_MISMATCH',
      'The configured candidate-link key does not match this database.',
    );
  }
  return marker;
};

export const assertCandidateTokenStorage = (
  database,
  { key = loadCandidateTokenEncryptionKey(), allowNewDatabase = false } = {},
) => {
  validKey(key);
  if (storageMarkerExists(database)) {
    verifyStorageMarker(database, key);
    return true;
  }
  if (allowNewDatabase && schemaTables(database).length === 0) return false;
  throw new CandidateTokenStorageError(
    'CANDIDATE_TOKEN_STORAGE_UNBOUND',
    'This existing database needs explicit candidate-link storage adoption.',
  );
};

export const createCandidateTokenStorageMarker = (
  database,
  key = loadCandidateTokenEncryptionKey(),
) => {
  validKey(key);
  if (storageMarkerExists(database)) {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_STORAGE_MARKER_INVALID',
      'Candidate-link storage metadata is invalid or unsupported.',
    );
  }
  writeStorageMarker(database, key);
};

const writeStorageMarker = (database, key, databaseId = null) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${storageMarkerTable} (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      version INTEGER NOT NULL,
      database_id TEXT NOT NULL,
      key_check TEXT NOT NULL
    )
  `);
  const id = databaseId ?? randomBytes(16).toString('base64url');
  const result = database
    .prepare(
      `INSERT INTO ${storageMarkerTable} (slot, version, database_id, key_check)
       VALUES (1, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET
         version = excluded.version,
         database_id = excluded.database_id,
         key_check = excluded.key_check`,
    )
    .run(storageMarkerVersion, id, keyCheckFor(id, key));
  return result;
};

const tokenColumns = (database) => {
  const columns = database
    .prepare('PRAGMA table_info(assessment_sessions)')
    .all();
  return new Set(columns.map((column) => column.name));
};

const requireSessionTable = (database) => {
  const columns = tokenColumns(database);
  if (
    columns.size === 0 ||
    !columns.has('id') ||
    !columns.has('candidate_token_hash')
  ) {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_SCHEMA_UNSUPPORTED',
      'The assessment session schema is missing required candidate-link fields.',
    );
  }
  return columns;
};

const readTokenRows = (database, columns) => {
  const plaintext = columns.has('candidate_token')
    ? 'candidate_token'
    : 'NULL AS candidate_token';
  const ciphertext = columns.has('candidate_token_ciphertext')
    ? 'candidate_token_ciphertext'
    : 'NULL AS candidate_token_ciphertext';
  return database
    .prepare(
      `SELECT id, candidate_token_hash, ${plaintext}, ${ciphertext}
       FROM assessment_sessions ORDER BY id`,
    )
    .all();
};

export const verifyCandidateTokenStorageRows = (
  database,
  key = loadCandidateTokenEncryptionKey(),
) => {
  validKey(key);
  const columns = requireSessionTable(database);
  if (!columns.has('candidate_token_ciphertext')) {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_MIGRATION_REQUIRED',
      'Candidate-link storage requires explicit migration before use.',
    );
  }
  for (const row of readTokenRows(database, columns)) {
    if (
      typeof row.candidate_token_hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.candidate_token_hash)
    ) {
      throw new CandidateTokenStorageError(
        'CANDIDATE_TOKEN_HASH_MISMATCH',
        'A stored candidate-link hash is invalid.',
      );
    }
    if (row.candidate_token !== null) {
      throw new CandidateTokenStorageError(
        'CANDIDATE_TOKEN_MIGRATION_REQUIRED',
        'Plaintext candidate links require explicit migration before use.',
      );
    }
    if (row.candidate_token_ciphertext === null) continue;
    const token = decryptCandidateToken(
      row.candidate_token_ciphertext,
      row.id,
      key,
    );
    if (candidateTokenHash(token) !== row.candidate_token_hash) {
      throw new CandidateTokenStorageError(
        'CANDIDATE_TOKEN_HASH_MISMATCH',
        'A stored candidate link does not match its lookup hash.',
      );
    }
  }
};

export const encryptCandidateToken = (
  token,
  sessionId,
  key = loadCandidateTokenEncryptionKey(),
) => {
  validKey(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(aadFor(sessionId));
  const ciphertext = Buffer.concat([
    cipher.update(token, 'utf8'),
    cipher.final(),
  ]);
  return `v1.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
};

export const decryptCandidateToken = (
  value,
  sessionId,
  key = loadCandidateTokenEncryptionKey(),
) => {
  validKey(key);
  if (typeof value !== 'string') {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_CIPHERTEXT_INVALID',
      'Stored candidate link data is invalid or unsupported.',
    );
  }
  const parts = value.split('.');
  if (
    parts.length !== 4 ||
    parts[0] !== 'v1' ||
    !parts.slice(1).every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  ) {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_CIPHERTEXT_INVALID',
      'Stored candidate link data is invalid or unsupported.',
    );
  }
  const [nonce, ciphertext, tag] = parts
    .slice(1)
    .map((part) => Buffer.from(part, 'base64url'));
  if (
    nonce.length !== 12 ||
    ciphertext.length === 0 ||
    tag.length !== 16 ||
    nonce.toString('base64url') !== parts[1] ||
    ciphertext.toString('base64url') !== parts[2] ||
    tag.toString('base64url') !== parts[3]
  ) {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_CIPHERTEXT_INVALID',
      'Stored candidate link data is invalid or unsupported.',
    );
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(aadFor(sessionId));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new CandidateTokenStorageError(
      'CANDIDATE_TOKEN_CIPHERTEXT_INVALID',
      'Stored candidate link data could not be authenticated.',
    );
  }
};

export const ensureCandidateTokenStorageSchema = (database) => {
  const columns = database
    .prepare('PRAGMA table_info(assessment_sessions)')
    .all();
  if (columns.length === 0) {
    throw new Error('Assessment session schema must be initialized first.');
  }
  const existing = new Set(columns.map((column) => column.name));
  for (const [name, definition] of [
    ['candidate_token_ciphertext', 'TEXT'],
    ['issuance_key', 'TEXT'],
    ['issuance_request_hash', 'TEXT'],
    ['issuance_payload_hash', 'TEXT'],
  ]) {
    if (!existing.has(name)) {
      database.exec(
        `ALTER TABLE assessment_sessions ADD COLUMN ${name} ${definition}`,
      );
    }
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS assessment_sessions_issuance_key_unique
    ON assessment_sessions(issuance_key)
    WHERE issuance_key IS NOT NULL
  `);
};

export const migrateLegacyCandidateTokens = (
  database,
  { oldKey, adoptExisting = false } = {},
) => {
  const newKey = loadCandidateTokenEncryptionKey();
  if (oldKey !== undefined) validKey(oldKey);
  const migrate = database.transaction(() => {
    const marker = storageMarkerExists(database)
      ? verifyStorageMarker(database, oldKey ?? newKey)
      : null;
    if (!marker && !adoptExisting) {
      throw new CandidateTokenStorageError(
        'CANDIDATE_TOKEN_STORAGE_UNBOUND',
        'This existing database needs explicit candidate-link storage adoption.',
      );
    }

    if (!schemaTables(database).includes('assessment_sessions')) {
      const existingObjects = schemaTables(database).filter(
        (name) => name !== storageMarkerTable,
      );
      if (!adoptExisting || existingObjects.length > 0) {
        throw new CandidateTokenStorageError(
          'CANDIDATE_TOKEN_SCHEMA_UNSUPPORTED',
          'Only an empty database can be explicitly adopted without an assessment session table.',
        );
      }
      writeStorageMarker(database, newKey, marker?.database_id ?? null);
      return { converted: 0, rotated: 0 };
    }

    const columns = requireSessionTable(database);
    const tokenColumn = columns.has('candidate_token')
      ? database
          .prepare('PRAGMA table_info(assessment_sessions)')
          .all()
          .find((column) => column.name === 'candidate_token')
      : undefined;
    if (tokenColumn?.notnull) {
      throw new CandidateTokenStorageError(
        'CANDIDATE_TOKEN_SCHEMA_UNSUPPORTED',
        'The legacy candidate_token column is NOT NULL. Migration requires a staged table rebuild before any token conversion.',
      );
    }
    const rows = readTokenRows(database, columns);
    const updates = [];
    let converted = 0;
    let rotated = 0;
    for (const row of rows) {
      if (
        typeof row.candidate_token_hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row.candidate_token_hash)
      ) {
        throw new CandidateTokenStorageError(
          'CANDIDATE_TOKEN_HASH_MISMATCH',
          'A stored candidate-link hash is invalid.',
        );
      }
      let token = null;
      if (row.candidate_token_ciphertext !== null) {
        token = decryptCandidateToken(
          row.candidate_token_ciphertext,
          row.id,
          oldKey ?? newKey,
        );
      }
      if (row.candidate_token !== null && row.candidate_token !== token) {
        if (token !== null) {
          throw new CandidateTokenStorageError(
            'CANDIDATE_TOKEN_LEGACY_MISMATCH',
            'Legacy candidate link data does not match its encrypted value.',
          );
        }
        token = row.candidate_token;
      }
      if (token === null) continue;
      if (candidateTokenHash(token) !== row.candidate_token_hash) {
        throw new CandidateTokenStorageError(
          'CANDIDATE_TOKEN_HASH_MISMATCH',
          'A stored candidate link does not match its lookup hash; migration stopped without clearing plaintext.',
        );
      }
      if (row.candidate_token_ciphertext === null || oldKey !== undefined) {
        const encrypted = encryptCandidateToken(token, row.id, newKey);
        const recovered = decryptCandidateToken(encrypted, row.id, newKey);
        if (
          recovered !== token ||
          candidateTokenHash(recovered) !== row.candidate_token_hash
        ) {
          throw new CandidateTokenStorageError(
            'CANDIDATE_TOKEN_MIGRATION_VERIFY_FAILED',
            'Encrypted candidate link verification failed; migration stopped without clearing plaintext.',
          );
        }
        updates.push([row.id, encrypted]);
        if (row.candidate_token_ciphertext !== null) rotated += 1;
        else converted += 1;
      } else if (row.candidate_token !== null) {
        updates.push([row.id, row.candidate_token_ciphertext, true]);
      }
    }

    ensureCandidateTokenStorageSchema(database);
    const update = database.prepare(
      columns.has('candidate_token')
        ? `UPDATE assessment_sessions
           SET candidate_token_ciphertext = ?, candidate_token = NULL WHERE id = ?`
        : `UPDATE assessment_sessions SET candidate_token_ciphertext = ? WHERE id = ?`,
    );
    for (const [id, encrypted] of updates) {
      update.run(encrypted, id);
    }

    verifyCandidateTokenStorageRows(database, newKey);
    writeStorageMarker(database, newKey, marker?.database_id ?? null);
    return { converted, rotated };
  });
  return migrate.immediate();
};

export const candidateTokenEncryptionEnvironment = Object.freeze({
  key: keyVariable,
  oldKey: oldKeyVariable,
});
