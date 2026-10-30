import type {
  R211Adapter,
  R211AssessmentDraft,
  R211AssessmentDraftInput,
  R211ValidatedVersion,
} from './contract.d.mts';

export class R211ConcurrencyConflict extends Error {
  readonly code: 'DRAFT_CONCURRENCY_CONFLICT';
  readonly sqlState: '23505';
  readonly status: 409;
}

export function installR211AuthoringFixture(clientOrPool: {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}): Promise<void>;

export function createR211PostgresAdapter(options: {
  pool: { query(sql: string, params?: unknown[]): Promise<unknown> };
  assertVerifiedIdentity?: (identity: unknown) => unknown;
}): R211Adapter;

export function createR211Adapter(clientOrPool: {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}): R211Adapter;

export function saveAssessmentDraft(
  client: { query(sql: string, params?: unknown[]): Promise<unknown> },
  identityInput: unknown,
  organizationId: string,
  input: R211AssessmentDraftInput,
): Promise<R211AssessmentDraft>;

export function getAssessmentDraft(
  client: { query(sql: string, params?: unknown[]): Promise<unknown> },
  identityInput: unknown,
  organizationId: string,
  definitionId?: string,
): Promise<R211AssessmentDraft | null>;

export function createValidatedVersion(
  client: { query(sql: string, params?: unknown[]): Promise<unknown> },
  identityInput: unknown,
  organizationId: string,
  definitionId: string,
  expectedDraftVersion: number,
): Promise<R211ValidatedVersion>;

export function getValidatedVersion(
  client: { query(sql: string, params?: unknown[]): Promise<unknown> },
  identityInput: unknown,
  organizationId: string,
  versionId: string,
): Promise<R211ValidatedVersion | null>;

export function listAssessmentDefinitions(
  client: { query(sql: string, params?: unknown[]): Promise<unknown> },
  identityInput: unknown,
  organizationId: string,
): Promise<unknown[]>;
