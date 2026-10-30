import type { R27Evidence, R27EvidenceQuery } from '../r27/contract.d.mts';
import type { R28CandidateRevision } from '../r28/contract.d.mts';
import type {
  R29EvaluatorObservation,
  R29CreateObservationInput,
  R29UpdateObservationInput,
} from '../r29/contract.d.mts';
import type {
  R210ReviewPacket,
  R210SaveDraftInput,
  R210FinalizePacketInput,
} from '../r210/contract.d.mts';
import type {
  R211AssessmentDraft,
  R211AssessmentDraftInput,
  R211ValidatedVersion,
} from '../r211/contract.d.mts';

export interface R23VerifiedIdentity {
  readonly subjectId: string;
  readonly sessionId: string;
  readonly assurance: 'aal1' | 'aal2';
  readonly expiresAt: number;
}

export interface R23Session {
  readonly handleHash: string;
  readonly subjectId: string;
  readonly authSessionId: string;
  readonly principalId: string;
  readonly assurance: 'aal1' | 'aal2';
  readonly selectedOrganizationId: string | null;
  readonly callbackPending: boolean;
  readonly credentialEnvelope: Buffer;
  readonly expiresAt: Date;
  readonly accessExpiresAt: Date;
}

export interface R23Membership {
  readonly organizationId: string;
  readonly role: string;
  readonly membershipVersion: string;
}

export interface EvaluatorSessionSummary {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly issuerPrincipalId: string;
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly scenarioTitle: string;
  readonly status: 'CREATED' | 'ACTIVE' | 'SUBMITTED';
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly submittedAt: string | null;
  readonly durationSeconds: number | null;
  readonly closureReason: 'candidate_submission' | 'timeout' | null;
  readonly reviewProcessStatus:
    'not_started' | 'waiting_for_response' | 'next_step_recorded' | null;
  readonly visibilityScope:
    'issued_by_recruiter' | 'assigned_to_reviewer' | 'restricted_role' | null;
}

export interface SessionListQueryOptions {
  lifecycleFilter?: 'all' | 'CREATED' | 'ACTIVE' | 'SUBMITTED' | 'timed_out';
  reviewStatusFilter?:
    | 'all'
    | 'not_applicable'
    | 'not_started'
    | 'waiting_for_response'
    | 'next_step_recorded'
    | 'unavailable';
  search?: string;
  cursor?: string | null;
  limit?: number;
}

export interface SessionListResult {
  readonly organizationId: string;
  readonly role: string;
  readonly membershipVersion: string;
  readonly visibilityScope:
    'issued_by_recruiter' | 'assigned_to_reviewer' | 'restricted_role' | null;
  readonly sessions: readonly EvaluatorSessionSummary[];
  readonly totalAuthorizedCount: number;
  readonly filteredAuthorizedCount: number;
  readonly nextCursor: string | null;
}

export interface SessionSummaryResult {
  readonly organizationId: string;
  readonly role: string;
  readonly membershipVersion: string;
  readonly visibilityScope:
    'issued_by_recruiter' | 'assigned_to_reviewer' | 'restricted_role' | null;
  readonly session: EvaluatorSessionSummary | null;
}

export interface R23Authorization {
  saveCredentialEnvelope(
    envelope: Buffer,
    accessExpiresAt: Date,
  ): Promise<void>;
  consumeCallback(callbackHash: string): Promise<void>;
  listMemberships(identity: R23VerifiedIdentity): Promise<R23Membership[]>;
  selectOrganization(
    identity: R23VerifiedIdentity,
    organizationId: string,
  ): Promise<R23Membership>;
  authorizeOrganization(
    identity: R23VerifiedIdentity,
    organizationId: string,
  ): Promise<R23Membership>;
  listOrganizationSessions(
    identity: R23VerifiedIdentity,
    organizationId: string,
    options?: SessionListQueryOptions,
  ): Promise<SessionListResult>;
  getOrganizationSessionSummary(
    identity: R23VerifiedIdentity,
    organizationId: string,
    sessionId: string,
  ): Promise<SessionSummaryResult>;
  getSubmittedEvidence(
    identity: R23VerifiedIdentity,
    organizationId: string,
    sessionId: string,
    query?: R27EvidenceQuery,
  ): Promise<R27Evidence | null>;
  getFileRevision(
    identity: R23VerifiedIdentity,
    organizationId: string,
    sessionId: string,
    sequence: string,
  ): Promise<R28CandidateRevision | null>;
  createObservation(
    identity: R23VerifiedIdentity,
    organizationId: string,
    sessionId: string,
    input: R29CreateObservationInput,
  ): Promise<R29EvaluatorObservation>;
  updateObservation(
    identity: R23VerifiedIdentity,
    organizationId: string,
    sessionId: string,
    observationId: string,
    input: R29UpdateObservationInput,
  ): Promise<R29EvaluatorObservation>;
  listObservations(
    identity: R23VerifiedIdentity,
    organizationId: string,
    sessionId: string,
  ): Promise<readonly R29EvaluatorObservation[]>;
  getObservation(
    identity: R23VerifiedIdentity,
    organizationId: string,
    sessionId: string,
    observationId: string,
  ): Promise<R29EvaluatorObservation | null>;
  getReviewPacket(
    identity: R23VerifiedIdentity,
    organizationId: string,
    sessionId: string,
  ): Promise<R210ReviewPacket | null>;
  saveReviewPacketDraft(
    identity: R23VerifiedIdentity,
    organizationId: string,
    sessionId: string,
    input: R210SaveDraftInput,
  ): Promise<R210ReviewPacket>;
  finalizeReviewPacket(
    identity: R23VerifiedIdentity,
    organizationId: string,
    sessionId: string,
    input: R210FinalizePacketInput,
  ): Promise<R210ReviewPacket>;
  saveAssessmentDraft(
    identity: R23VerifiedIdentity,
    organizationId: string,
    input: R211AssessmentDraftInput,
  ): Promise<R211AssessmentDraft>;
  getAssessmentDraft(
    identity: R23VerifiedIdentity,
    organizationId: string,
    definitionId?: string | null,
  ): Promise<R211AssessmentDraft | null>;
  listAssessmentDefinitions(
    identity: R23VerifiedIdentity,
    organizationId: string,
  ): Promise<
    Array<{
      id: string;
      title: string;
      draftVersion: number;
      updatedAt: string;
    }>
  >;
  createValidatedVersion(
    identity: R23VerifiedIdentity,
    organizationId: string,
    definitionId: string,
    expectedDraftVersion?: number,
  ): Promise<R211ValidatedVersion>;
  getValidatedVersion(
    identity: R23VerifiedIdentity,
    organizationId: string,
    versionId: string,
  ): Promise<R211ValidatedVersion | null>;
  validateIssuanceIntent(
    identity: R23VerifiedIdentity,
    organizationId: string,
    input: { idempotencyKey: string | null; requestHash: string | null },
  ): Promise<void>;
  assertCandidateTokenStorage(
    identity: R23VerifiedIdentity,
    organizationId: string,
    key: Buffer,
  ): Promise<unknown>;
  issueAssessment(
    identity: R23VerifiedIdentity,
    organizationId: string,
    input: {
      sessionId: string;
      scenarioId: string;
      scenarioVersion: string;
      scenarioTitle: string;
      durationSeconds?: number | null;
      candidateTokenHash: string;
      candidateTokenCiphertext: string;
      idempotencyKey?: string | null;
      requestHash?: string | null;
      payloadHash?: string | null;
      terminalEnabled?: boolean;
      taskRubricSnapshot?: unknown;
      aiCapabilitySnapshot?: unknown;
      scenarioSnapshot?: string | null;
    },
  ): Promise<{
    sessionId: string;
    organizationId: string;
    issuerPrincipalId: string;
    scenarioId: string;
    scenarioVersion: string;
    scenarioTitle: string;
    status: string;
    createdAt: Date | string;
    durationSeconds: number | null;
    isReplay: boolean;
  }>;
  recoverCandidateToken(
    identity: R23VerifiedIdentity,
    organizationId: string,
    sessionId: string,
  ): Promise<{
    candidateTokenCiphertext: string;
    candidateTokenHash: string;
    sessionId: string;
    organizationId: string;
    issuerPrincipalId: string;
  } | null>;
  listOrganizationReviewers(
    identity: R23VerifiedIdentity,
    organizationId: string,
  ): Promise<
    Array<{
      principalId: string;
      role: string;
      joinedAt: Date | string;
    }>
  >;
  assignReviewer(
    identity: R23VerifiedIdentity,
    organizationId: string,
    input: {
      sessionId: string;
      reviewerPrincipalId: string;
      assignmentId: string;
    },
  ): Promise<{
    assignmentId: string;
    sessionId: string;
    organizationId: string;
    reviewerPrincipalId: string;
    assignedByPrincipalId: string;
    assignedAt: Date | string;
    revokedAt: Date | string | null;
    version: number;
    isReplay: boolean;
  }>;
  revokeReviewerAssignment(
    identity: R23VerifiedIdentity,
    organizationId: string,
    input: {
      sessionId: string;
      assignmentId?: string | null;
      reviewerPrincipalId?: string | null;
    },
  ): Promise<{
    assignmentId: string;
    sessionId: string;
    organizationId: string;
    reviewerPrincipalId: string;
    assignedByPrincipalId: string;
    assignedAt: Date | string;
    revokedAt: Date | string;
    version: number;
    revoked: boolean;
  }>;
  listSessionReviewerAssignments(
    identity: R23VerifiedIdentity,
    organizationId: string,
    sessionId: string,
  ): Promise<
    Array<{
      assignmentId: string;
      sessionId: string;
      organizationId: string;
      reviewerPrincipalId: string;
      assignedByPrincipalId: string;
      assignedAt: Date | string;
      revokedAt: Date | string | null;
      version: number;
      isActive: boolean;
    }>
  >;
}

export interface R23PostgresAdapter {
  createSession(input: {
    handleHash: string;
    csrfHash: string;
    callbackHash: string;
    credentialEnvelope: Buffer;
    identity: R23VerifiedIdentity;
    expiresAt: Date;
    accessExpiresAt: Date;
  }): Promise<{ principalId: string }>;
  withActiveSession<T>(
    input: { handleHash: string; csrfHash?: string },
    operation: (session: R23Session, authz: R23Authorization) => Promise<T>,
  ): Promise<T>;
  closeSession(
    handleHash: string,
    csrfHash: string,
  ): Promise<{
    credentialEnvelope: Buffer;
    subjectId: string;
    authSessionId: string;
  } | null>;
  close(): Promise<void>;
}

export class R23SessionDenied extends Error {
  readonly code: 'SESSION_DENIED';
}

export class R23ScopeDenied extends Error {
  readonly code: 'SCOPE_DENIED';
}

export class R23PersistenceError extends Error {
  readonly code: 'SESSION_STORAGE_UNAVAILABLE';
}

export class R25IdempotencyConflict extends Error {
  readonly code: 'IDEMPOTENCY_KEY_CONFLICT';
}

export function loadCandidateTokenEncryptionKey(value?: string): Buffer;
export function candidateTokenKeyCheck(databaseId: string, key: Buffer): string;
export function readCandidateTokenStorageMeta(clientOrPool: {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}): Promise<{
  slot: number;
  version: number;
  database_id: string;
  key_check: string;
} | null>;
export function assertCandidateTokenStorage(
  clientOrPool: {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  },
  options?: { key?: Buffer },
): Promise<{
  slot: number;
  version: number;
  database_id: string;
  key_check: string;
}>;
export function initializeCandidateTokenStorage(
  clientOrPool: {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  },
  options?: { key?: Buffer; databaseId?: string | null },
): Promise<{ version: number; databaseId: string; keyCheck: string }>;

export function createR23PostgresAdapter(options: {
  connectionString?: string;
  pool?: { connect(): Promise<unknown>; end?(): Promise<void> };
  assertVerifiedIdentity(identity: unknown): R23VerifiedIdentity;
}): R23PostgresAdapter;

export function encodeSessionCursor(
  cursor?: {
    createdAt?: string | Date;
    sessionId?: string;
  } | null,
): string | null;

export function decodeSessionCursor(
  cursorToken?: string | null,
): { createdAt: string; sessionId: string } | null;

export const FIXTURE_IDS: {
  readonly orgA: string;
  readonly orgB: string;
  readonly userA: {
    readonly principalId: string;
    readonly subjectId: string;
    readonly email: string;
  };
  readonly userB: {
    readonly principalId: string;
    readonly subjectId: string;
    readonly email: string;
  };
  readonly userAB: {
    readonly principalId: string;
    readonly subjectId: string;
    readonly email: string;
  };
  readonly userRevoked: {
    readonly principalId: string;
    readonly subjectId: string;
    readonly email: string;
  };
  readonly recruiterA2: {
    readonly principalId: string;
    readonly subjectId: string;
    readonly email: string;
  };
  readonly recruiterAEmpty: {
    readonly principalId: string;
    readonly subjectId: string;
    readonly email: string;
  };
  readonly adminA: {
    readonly principalId: string;
    readonly subjectId: string;
    readonly email: string;
  };
  readonly recruiterB: {
    readonly principalId: string;
    readonly subjectId: string;
    readonly email: string;
  };
  readonly sessions: {
    readonly a001Created: string;
    readonly a002Active: string;
    readonly a003SubmittedAssigned: string;
    readonly a004TimeoutAssigned: string;
    readonly a005SubmittedUnassigned: string;
    readonly a006OtherRecruiter: string;
    readonly b001Created: string;
    readonly b002Active: string;
    readonly b003SubmittedAssigned: string;
    readonly b004SubmittedUnassigned: string;
  };
  readonly assignments: {
    readonly a001: string;
    readonly a002: string;
    readonly a003: string;
    readonly a004Revoked: string;
    readonly b001: string;
    readonly b002: string;
  };
};

export function applyR23DisposableSchema(clientOrPool: {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}): Promise<void>;

export function resolveAuthenticatedMemberships(
  pool: {
    connect(): Promise<unknown>;
    query(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }>;
  },
  input: { supabaseUserId: string },
): Promise<R23Membership[]>;

export function resolveScopedOrganizationMembership(
  pool: {
    connect(): Promise<unknown>;
    query(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }>;
  },
  input: { supabaseUserId: string; organizationId: string },
): Promise<{
  organizationId: string;
  principalId: string;
  role: string;
  status: string;
  joinedAt: Date;
  membershipVersion: string | number;
} | null>;

export function revokeOrganizationMembership(
  adminPool: {
    query(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  },
  input: { organizationId: string; principalId: string },
): Promise<boolean>;

export function restoreOrganizationMembership(
  adminPool: {
    query(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  },
  input: { organizationId: string; principalId: string },
): Promise<boolean>;

export function revokeReviewerAssignment(
  adminPool: {
    query(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
    connect?(): Promise<unknown>;
  },
  input: {
    supabaseUserId?: string;
    organizationId: string;
    sessionId: string;
    assignmentId?: string | null;
    reviewerPrincipalId?: string | null;
  },
): Promise<boolean>;

export function restoreReviewerAssignment(
  adminPool: {
    query(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  },
  input: {
    organizationId: string;
    sessionId: string;
    reviewerPrincipalId: string;
  },
): Promise<boolean>;

export function issueAssessment(
  pool: { connect(): Promise<unknown> },
  input: {
    supabaseUserId: string;
    organizationId: string;
    sessionId: string;
    scenarioId: string;
    scenarioVersion: string;
    scenarioTitle: string;
    durationSeconds?: number | null;
    candidateTokenHash: string;
    candidateTokenCiphertext: string;
    idempotencyKey?: string | null;
    requestHash?: string | null;
    payloadHash?: string | null;
    terminalEnabled?: boolean;
    taskRubricSnapshot?: unknown;
    aiCapabilitySnapshot?: unknown;
  },
): Promise<{
  sessionId: string;
  organizationId: string;
  issuerPrincipalId: string;
  scenarioId: string;
  scenarioVersion: string;
  scenarioTitle: string;
  status: string;
  createdAt: Date | string;
  durationSeconds: number | null;
  isReplay: boolean;
}>;

export function recoverCandidateToken(
  pool: { connect(): Promise<unknown> },
  input: {
    supabaseUserId: string;
    organizationId: string;
    sessionId: string;
  },
): Promise<{
  candidateTokenCiphertext: string;
  candidateTokenHash: string;
  sessionId: string;
  organizationId: string;
  issuerPrincipalId: string;
} | null>;

export function listOrganizationReviewers(
  pool: { connect(): Promise<unknown> },
  input: {
    supabaseUserId: string;
    organizationId: string;
  },
): Promise<
  Array<{
    principalId: string;
    role: string;
    joinedAt: Date | string;
  }>
>;

export function assignReviewer(
  pool: { connect(): Promise<unknown> },
  input: {
    supabaseUserId: string;
    organizationId: string;
    sessionId: string;
    reviewerPrincipalId: string;
    assignmentId: string;
  },
): Promise<{
  assignmentId: string;
  sessionId: string;
  organizationId: string;
  reviewerPrincipalId: string;
  assignedByPrincipalId: string;
  assignedAt: Date | string;
  revokedAt: Date | string | null;
  version: number;
  isReplay: boolean;
}>;

export function listSessionReviewerAssignments(
  pool: { connect(): Promise<unknown> },
  input: {
    supabaseUserId: string;
    organizationId: string;
    sessionId: string;
  },
): Promise<
  Array<{
    assignmentId: string;
    sessionId: string;
    organizationId: string;
    reviewerPrincipalId: string;
    assignedByPrincipalId: string;
    assignedAt: Date | string;
    revokedAt: Date | string | null;
    version: number;
    isActive: boolean;
  }>
>;

export function listOrganizationSessions(
  pool: { connect(): Promise<unknown> },
  input: {
    supabaseUserId: string;
    organizationId: string;
    lifecycleFilter?: 'all' | 'CREATED' | 'ACTIVE' | 'SUBMITTED' | 'timed_out';
    reviewStatusFilter?:
      | 'all'
      | 'not_applicable'
      | 'not_started'
      | 'waiting_for_response'
      | 'next_step_recorded'
      | 'unavailable';
    search?: string;
    cursor?: string | null;
    limit?: number;
  },
): Promise<{
  authorized: boolean;
  membership: {
    organizationId: string;
    principalId: string;
    role: string;
    status: string;
    joinedAt: Date;
    membershipVersion: string | number;
  } | null;
  visibilityScope:
    'issued_by_recruiter' | 'assigned_to_reviewer' | 'restricted_role' | null;
  sessions: EvaluatorSessionSummary[];
  totalAuthorizedCount: number;
  filteredAuthorizedCount: number;
  nextCursor: string | null;
}>;

export function getOrganizationSessionSummary(
  pool: { connect(): Promise<unknown> },
  input: { supabaseUserId: string; organizationId: string; sessionId: string },
): Promise<{
  authorized: boolean;
  membership: {
    organizationId: string;
    principalId: string;
    role: string;
    status: string;
    joinedAt: Date;
    membershipVersion: string | number;
  } | null;
  visibilityScope:
    'issued_by_recruiter' | 'assigned_to_reviewer' | 'restricted_role' | null;
  session: EvaluatorSessionSummary | null;
}>;

export {
  installR211AuthoringFixture,
  saveAssessmentDraft,
  getAssessmentDraft,
  listAssessmentDefinitions,
  createValidatedVersion,
  getValidatedVersion,
  R211ConcurrencyConflict,
} from '../r211/adapter.mjs';
