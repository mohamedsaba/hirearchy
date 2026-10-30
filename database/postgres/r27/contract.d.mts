import type {
  R26CandidateEvent,
  R26CandidateSubmission,
} from '../r26/adapter.mjs';

export interface R27EvidenceAiInteraction {
  interactionId: string;
  requestId: string;
  sequenceStart: string;
  sequenceCompleted: string | null;
  candidatePrompt: string;
  assistantResponse: string | null;
  status: 'ADMITTED' | 'COMPLETED' | 'FAILED';
  failureReason: string | null;
  errorMessage: string | null;
  providerId: string;
  modelId: string;
  createdAt: string;
  completedAt: string | null;
}

export interface R27EvidenceExecution {
  organizationId: string;
  sessionId: string;
  operationId: string;
  requestId: string;
  sequenceStart: string;
  sequenceCompleted: string | null;
  workspaceDigest: string;
  workspaceVersion: string;
  recipeId: string;
  recipeVersion: string;
  recipeDigest: string;
  generation: number;
  fence: number;
  status: 'ADMITTED' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'UNKNOWN';
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  stdoutDigest: string | null;
  stderrDigest: string | null;
  truncatedStdout: boolean;
  truncatedStderr: boolean;
  durationMs: number | null;
  failureReason: string | null;
  errorMessage: string | null;
  cleanupStatus: 'CLEAN' | 'RESOURCE_LEAK' | 'UNKNOWN';
  isUnknown: boolean;
  provenance: string;
  isSynthetic: true;
  createdAt: string;
  completedAt: string | null;
}

/** Authorized, read-only projection; sequence/version values remain lossless. */
export type R27Evidence = Readonly<{
  permission: 'assigned_reviewer';
  reviewer: Readonly<{ subjectId: string; principalId: string }>;
  organizationId: string;
  sessionId: string;
  assignment: Readonly<{ id: string; version: string; assignedAt: string }>;
  scenario: Readonly<{
    id: string;
    version: string;
    title: string;
    snapshotText: string;
    snapshotDigest: string;
    starterFiles: Readonly<Record<string, string>> | null;
  }>;
  status: 'SUBMITTED';
  createdAt: string;
  activatedAt: string;
  submittedAt: string;
  closureReason: 'candidate_submission' | 'timeout';
  submission: R26CandidateSubmission;
  revisions: readonly Readonly<{
    path: string;
    version: string;
    digest: string;
    content: string | null;
    source: 'starter' | 'submitted' | 'event_metadata';
  }>[];
  events: readonly (R26CandidateEvent & {
    provenance: 'hirearchy.candidate_session_events';
  })[];
  aiInteractions?: readonly R27EvidenceAiInteraction[];
  executions?: readonly R27EvidenceExecution[];
  pagination: Readonly<{ limit: number; nextAfterSequence: string | null }>;
  availability: Readonly<{
    terminal: 'available' | 'unavailable';
    ai: 'available' | 'unavailable';
    verification: 'unavailable';
    history: 'metadata_only';
    limitations: readonly string[];
  }>;
}>;

export type R27EvidenceQuery = Readonly<{
  afterSequence?: string;
  limit?: number;
}>;
