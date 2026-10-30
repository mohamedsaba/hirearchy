import type { R27Evidence, R27EvidenceQuery } from './contract.d.mts';

export declare class R27EvidenceIntegrityError extends Error {
  readonly code: 'EVIDENCE_STORAGE_UNAVAILABLE';
}

export declare function mapR27Evidence(
  value: unknown,
  query?: R27EvidenceQuery,
): R27Evidence | null;

export declare function installR27EvidenceFixture(clientOrPool: {
  query(sql: string): Promise<unknown>;
}): Promise<void>;
