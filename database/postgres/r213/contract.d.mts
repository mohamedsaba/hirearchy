export type R213ExecutionStatus =
  'ADMITTED' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'UNKNOWN';

export type R213CleanupStatus = 'CLEAN' | 'RESOURCE_LEAK' | 'UNKNOWN';

export interface R213RecordedOperation {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly sequenceStart: string | number;
  readonly sequenceCompleted: string | number | null;
  readonly workspaceDigest: string;
  readonly workspaceVersion: string;
  readonly recipeId: string;
  readonly recipeVersion: string;
  readonly recipeDigest: string;
  readonly generation: number;
  readonly fence: string | number;
  readonly status: R213ExecutionStatus;
  readonly exitCode: number | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly stdoutDigest: string | null;
  readonly stderrDigest: string | null;
  readonly truncatedStdout: boolean;
  readonly truncatedStderr: boolean;
  readonly durationMs: number | null;
  readonly failureReason: string | null;
  readonly errorMessage: string | null;
  readonly cleanupStatus: R213CleanupStatus;
  readonly isUnknown: boolean;
  readonly provenance: string;
  readonly isSynthetic: boolean;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface R213AdmissionParams {
  readonly tokenHash: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly expectedWorkspaceDigest: string;
  readonly recipeId?: string;
  readonly recipeVersion?: string;
  readonly recipeDigest?: string;
  readonly provenance?: string;
}

export interface R213CompleteParams {
  readonly tokenHash: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly fence: string | number;
  readonly generation?: number;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutDigest?: string;
  readonly stderrDigest?: string;
  readonly truncatedStdout?: boolean;
  readonly truncatedStderr?: boolean;
  readonly durationMs?: number | null;
  readonly cleanupStatus?: R213CleanupStatus;
  readonly provenance?: string | null;
}

export interface R213FailParams {
  readonly tokenHash: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly fence: string | number;
  readonly generation?: number;
  readonly status?: 'FAILED' | 'TIMED_OUT' | 'UNKNOWN';
  readonly failureReason: string;
  readonly errorMessage: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs?: number | null;
  readonly cleanupStatus?: R213CleanupStatus;
  readonly isUnknown?: boolean;
  readonly provenance?: string | null;
}

export interface R213ExecutionAdmissionResult {
  readonly status: 'ADMITTED' | 'REPLAY' | 'CONFLICT' | 'DENIED';
  readonly reason?: string;
  readonly message?: string;
  readonly remainingExecutions?: number;
  readonly operation?: R213RecordedOperation;
  readonly intent?: Record<string, unknown>;
}

export interface R213CandidateExecutionView {
  readonly terminalEnabled: boolean;
  readonly remainingExecutions: number;
  readonly maxExecutions: number;
  readonly currentWorkspaceDigest: string;
  readonly operations: readonly R213RecordedOperation[];
}
