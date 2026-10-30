import type Database from 'better-sqlite3';

export class CandidateTokenStorageError extends Error {
  constructor(code: string, message: string);
  readonly code: string;
}

export const loadCandidateTokenEncryptionKey: (value?: string) => Buffer;
export const candidateTokenHash: (token: string) => string;
export const assertCandidateTokenStorage: (
  database: Database.Database,
  options?: { key?: Buffer; allowNewDatabase?: boolean },
) => boolean;
export const createCandidateTokenStorageMarker: (
  database: Database.Database,
  key?: Buffer,
) => void;
export const verifyCandidateTokenStorageRows: (
  database: Database.Database,
  key?: Buffer,
) => void;
export const encryptCandidateToken: (
  token: string,
  sessionId: string,
  key?: Buffer,
) => string;
export const decryptCandidateToken: (
  ciphertext: unknown,
  sessionId: string,
  key?: Buffer,
) => string;
export const ensureCandidateTokenStorageSchema: (
  database: Database.Database,
) => void;
export const migrateLegacyCandidateTokens: (
  database: Database.Database,
  options?: { oldKey?: Buffer; adoptExisting?: boolean },
) => { converted: number; rotated: number };
export const candidateTokenEncryptionEnvironment: Readonly<{
  key: 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY';
  oldKey: 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_OLD_KEY';
}>;
