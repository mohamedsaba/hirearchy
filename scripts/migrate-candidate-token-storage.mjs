import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import {
  candidateTokenEncryptionEnvironment,
  loadCandidateTokenEncryptionKey,
  migrateLegacyCandidateTokens,
} from '../apps/web/src/sessions/candidate-token-storage.mjs';

const requireColumn = (database, name) => {
  const columns = database
    .prepare('PRAGMA table_info(assessment_sessions)')
    .all();
  const column = columns.find((entry) => entry.name === name);
  if (!column) {
    throw new Error(
      `assessment_sessions.${name} is missing; initialize the supported application schema, then rerun this migration.`,
    );
  }
  return column;
};

const migrationCounts = (database) =>
  (() => {
    const sessionTable = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assessment_sessions'",
      )
      .get();
    if (!sessionTable) return { sessions: 0, plaintext: 0, encrypted: 0 };
    const columns = database
      .prepare('PRAGMA table_info(assessment_sessions)')
      .all();
    const hasPlaintext = columns.some(
      (column) => column.name === 'candidate_token',
    );
    const hasCiphertext = columns.some(
      (column) => column.name === 'candidate_token_ciphertext',
    );
    return database
      .prepare(
        `SELECT COUNT(*) AS sessions,
                ${hasPlaintext ? 'COALESCE(SUM(candidate_token IS NOT NULL), 0)' : '0'} AS plaintext,
                ${hasCiphertext ? 'COALESCE(SUM(candidate_token_ciphertext IS NOT NULL), 0)' : '0'} AS encrypted
         FROM assessment_sessions`,
      )
      .get();
  })();

const assertIntegrity = (database) => {
  const result = database.pragma('integrity_check', { simple: true });
  if (result !== 'ok') throw new Error('SQLite integrity check failed.');
};

export const migrateCandidateTokenDatabase = async ({
  databasePath,
  backupPath,
  adoptExisting = false,
} = {}) => {
  if (!databasePath || !backupPath) {
    throw new Error(
      'Pass explicit --database <path> and --backup <new-private-path> arguments; use --adopt-existing to bind an existing database.',
    );
  }
  const sourcePath = path.resolve(databasePath);
  const stagedBackupPath = path.resolve(backupPath);
  if (
    sourcePath === stagedBackupPath ||
    sourcePath === ':memory:' ||
    stagedBackupPath === ':memory:'
  ) {
    throw new Error('Database and backup must be separate filesystem paths.');
  }
  if (!existsSync(sourcePath)) {
    throw new Error('The selected source database does not exist.');
  }
  if (existsSync(stagedBackupPath)) {
    throw new Error(
      'The staged backup path already exists; choose a new path.',
    );
  }

  // Validate keys before opening the source for writes. Never print key data.
  loadCandidateTokenEncryptionKey();
  const oldKeyValue = process.env[candidateTokenEncryptionEnvironment.oldKey];
  const oldKey = oldKeyValue
    ? loadCandidateTokenEncryptionKey(oldKeyValue)
    : undefined;

  const source = new Database(sourcePath, { fileMustExist: true });
  source.pragma('busy_timeout = 5000');
  let transactionOpen = false;
  let backupCreated = false;
  try {
    const hasSessionTable = source
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assessment_sessions'",
      )
      .get();
    const existingObjects = source
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' AND name != 'candidate_token_storage_meta'",
      )
      .all();
    if (!hasSessionTable && (!adoptExisting || existingObjects.length > 0)) {
      throw new Error(
        'An empty database can be adopted only with --adopt-existing; unknown schemas are not supported.',
      );
    }
    const tokenColumn = hasSessionTable
      ? source
          .prepare('PRAGMA table_info(assessment_sessions)')
          .all()
          .find((entry) => entry.name === 'candidate_token')
      : undefined;
    if (hasSessionTable) requireColumn(source, 'candidate_token_hash');
    if (tokenColumn?.notnull) {
      throw new Error(
        'The legacy candidate_token column is NOT NULL. No backup or conversion was attempted; a separately reviewed staged table rebuild is required.',
      );
    }
    if (hasSessionTable) requireColumn(source, 'id');

    mkdirSync(path.dirname(stagedBackupPath), { recursive: true, mode: 0o700 });
    const previousUmask = process.umask(0o077);
    try {
      source.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
      const backupSource = new Database(sourcePath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        await backupSource.backup(stagedBackupPath);
      } finally {
        backupSource.close();
      }
      backupCreated = true;
      chmodSync(stagedBackupPath, 0o600);

      const sourceCounts = migrationCounts(source);
      const backup = new Database(stagedBackupPath, { readonly: true });
      let backupCounts;
      try {
        assertIntegrity(backup);
        backupCounts = migrationCounts(backup);
      } finally {
        backup.close();
      }
      if (
        sourceCounts.sessions !== backupCounts.sessions ||
        sourceCounts.plaintext !== backupCounts.plaintext ||
        sourceCounts.encrypted !== backupCounts.encrypted
      ) {
        throw new Error(
          'The staged SQLite backup does not match the source counts; conversion was not started.',
        );
      }
      const backupMode = statSync(stagedBackupPath).mode & 0o777;
      if (backupMode !== 0o600) {
        throw new Error('The staged backup permissions are not private.');
      }

      const result = migrateLegacyCandidateTokens(source, {
        oldKey,
        adoptExisting,
      });
      const hasPlaintextColumn = hasSessionTable && tokenColumn !== undefined;
      const remainingPlaintext = hasPlaintextColumn
        ? source
            .prepare(
              'SELECT COUNT(*) AS count FROM assessment_sessions WHERE candidate_token IS NOT NULL',
            )
            .get().count
        : 0;
      if (remainingPlaintext !== 0) {
        throw new Error('Plaintext candidate links remain after conversion.');
      }
      assertIntegrity(source);
      source.exec('COMMIT');
      transactionOpen = false;
      return {
        ...result,
        backupPath: stagedBackupPath,
        backupVerified: true,
      };
    } finally {
      process.umask(previousUmask);
    }
  } catch (error) {
    if (transactionOpen) {
      try {
        source.exec('ROLLBACK');
      } catch {
        // Preserve the original migration failure; no token or key is emitted.
      }
    }
    if (backupCreated) {
      try {
        chmodSync(stagedBackupPath, 0o600);
      } catch {
        // Retain the recoverable staged copy even if permission repair fails.
      }
    }
    throw error;
  } finally {
    source.close();
  }
};

const parseArgs = (args) => {
  const values = new Map();
  let adoptExisting = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--adopt-existing') {
      if (adoptExisting) throw new Error('Do not repeat --adopt-existing.');
      adoptExisting = true;
      continue;
    }
    if (flag !== '--database' && flag !== '--backup') {
      throw new Error(`Unsupported argument: ${flag}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--') || values.has(flag)) {
      throw new Error(`Expected one value after ${flag}.`);
    }
    values.set(flag, value);
    index += 1;
  }
  return {
    databasePath: values.get('--database'),
    backupPath: values.get('--backup'),
    adoptExisting,
  };
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  migrateCandidateTokenDatabase(parseArgs(process.argv.slice(2)))
    .then(({ converted, rotated, backupPath }) => {
      process.stdout.write(
        `Candidate token storage verified. Converted ${converted}; rotated ${rotated}. Staged backup: ${backupPath}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Migration failed.'}\n`,
      );
      process.exitCode = 1;
    });
}
