export type R214ExecutionStatus =
  'ADMITTED' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'UNKNOWN';

export type R214CleanupStatus = 'CLEAN' | 'RESOURCE_LEAK' | 'UNKNOWN';

export type R214AdmissionParams = Readonly<{
  tokenHash: string;
  sessionId: string;
  requestId: string;
  expectedWorkspaceDigest: string;
  recipeId: string;
  recipeVersion: string;
  recipeDigest: string;
  provenance?: string;
}>;

export type R214ExecutionBudgets = Readonly<{
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxExecutionCount: number;
}>;

export type R214ExecutionIntent = Readonly<{
  organizationId: string;
  sessionId: string;
  operationId: string;
  requestId: string;
  assessmentVersion: string;
  persistedWorkspaceVersion: string;
  canonicalWorkspaceSnapshotDigest: string;
  approvedRecipeId: string;
  approvedRecipeVersion: string;
  approvedRecipeDigest: string;
  admittedAt: string;
  sessionDeadline: string;
  budgets: R214ExecutionBudgets;
  generation: number;
  fence: number;
  protocolVersion: string;
}>;

export type R214RecordedOperation = Readonly<{
  organizationId: string;
  sessionId: string;
  operationId: string;
  requestId: string;
  sequenceStart: number;
  sequenceCompleted: number | null;
  workspaceDigest: string;
  workspaceVersion: string;
  recipeId: string;
  recipeVersion: string;
  recipeDigest: string;
  generation: number;
  fence: number;
  status: R214ExecutionStatus;
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
  cleanupStatus: R214CleanupStatus;
  isUnknown: boolean;
  provenance: string;
  isSynthetic: boolean;
  createdAt: string;
  completedAt: string | null;
}>;

export type R214ExecutionAdmissionResult =
  | Readonly<{
      status: 'ADMITTED';
      intent: R214ExecutionIntent;
      operation: R214RecordedOperation;
      remainingExecutions?: number;
    }>
  | Readonly<{
      status: 'REPLAY';
      intent: R214ExecutionIntent;
      operation: R214RecordedOperation;
      remainingExecutions?: number;
    }>
  | Readonly<{
      status: 'CONFLICT';
      reason: string;
    }>
  | Readonly<{
      status: 'DENIED';
      reason:
        | 'TERMINAL_DISABLED'
        | 'BUDGET_EXHAUSTED'
        | 'SESSION_CLOSED'
        | 'DEADLINE_EXCEEDED'
        | 'INVALID_RECIPE'
        | 'SCENARIO_INCOMPATIBLE'
        | 'STALE_WORKSPACE'
        | 'FORBIDDEN';
      message: string;
    }>;

export type R214CompleteExecutionParams = Readonly<{
  tokenHash: string;
  sessionId: string;
  operationId: string;
  fence: number;
  generation?: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  stdoutDigest?: string;
  stderrDigest?: string;
  truncatedStdout?: boolean;
  truncatedStderr?: boolean;
  durationMs?: number;
  cleanupStatus?: R214CleanupStatus;
}>;

export type R214FailExecutionParams = Readonly<{
  tokenHash: string;
  sessionId: string;
  operationId: string;
  fence: number;
  generation?: number;
  status?: 'FAILED' | 'TIMED_OUT' | 'UNKNOWN';
  failureReason?: string;
  errorMessage?: string;
  stdout?: string;
  stderr?: string;
  stdoutDigest?: string;
  stderrDigest?: string;
  truncatedStdout?: boolean;
  truncatedStderr?: boolean;
  durationMs?: number;
  cleanupStatus?: R214CleanupStatus;
  isUnknown?: boolean;
}>;

export type R214CandidateExecutionView = Readonly<{
  terminalEnabled: boolean;
  remainingExecutions: number;
  maxExecutions: number;
  currentWorkspaceDigest: string;
  operations: readonly R214RecordedOperation[];
}>;

export type R214EvaluatorExecutionsView = Readonly<{
  sessionId: string;
  operations: readonly R214RecordedOperation[];
}>;
