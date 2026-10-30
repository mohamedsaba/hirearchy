import { createHash } from 'node:crypto';

export const R213_PROTOCOL_VERSION = 'r213-execution-v1' as const;
export const R213_APPROVED_RECIPE_ID = 'recipe-python-check-v1' as const;
export const R213_APPROVED_RECIPE_VERSION = '1.0.0' as const;
export const R213_SYNTHETIC_PROVENANCE = 'synthetic-execution-adapter' as const;

export const R213_DEFAULT_TIMEOUT_MS = 10_000;
export const R213_MAX_STDOUT_BYTES = 64_000;
export const R213_MAX_STDERR_BYTES = 64_000;
export const R213_MAX_EXECUTIONS = 10;

export type R213ExecutionStatus =
  'ADMITTED' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'UNKNOWN';

export type R213CleanupStatus = 'CLEAN' | 'RESOURCE_LEAK' | 'UNKNOWN';

export type R213ExecutionRecipe = Readonly<{
  id: string;
  version: string;
  description: string;
  command: readonly string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}>;

export const DEFAULT_PYTHON_CHECK_RECIPE: R213ExecutionRecipe = Object.freeze({
  id: R213_APPROVED_RECIPE_ID,
  version: R213_APPROVED_RECIPE_VERSION,
  description:
    'Approved synthetic pytest test runner recipe for Python assessment tasks',
  command: ['pytest', '-v'],
  timeoutMs: R213_DEFAULT_TIMEOUT_MS,
  maxStdoutBytes: R213_MAX_STDOUT_BYTES,
  maxStderrBytes: R213_MAX_STDERR_BYTES,
});

export function computeRecipeDigest(recipe: R213ExecutionRecipe): string {
  const payload = JSON.stringify({
    id: recipe.id,
    version: recipe.version,
    command: recipe.command,
    timeoutMs: recipe.timeoutMs,
    maxStdoutBytes: recipe.maxStdoutBytes,
    maxStderrBytes: recipe.maxStderrBytes,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export const R213_DEFAULT_RECIPE_DIGEST = computeRecipeDigest(
  DEFAULT_PYTHON_CHECK_RECIPE,
);

export type R213ExecutionBudgets = Readonly<{
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxExecutionCount: number;
}>;

export type R213ExecutionIntent = Readonly<{
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
  budgets: R213ExecutionBudgets;
  generation: number;
  fence: number;
  protocolVersion: typeof R213_PROTOCOL_VERSION;
}>;

export type R213ExecutionOutcome = Readonly<{
  operationId: string;
  attemptId: string;
  generation: number;
  fence: number;
  snapshotDigest: string;
  recipeId: string;
  recipeDigest: string;
  status: R213ExecutionStatus;
  startedAt: string;
  completedAt: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputHashes: Readonly<{
    stdoutDigest: string;
    stderrDigest: string;
  }>;
  truncated: Readonly<{
    stdout: boolean;
    stderr: boolean;
  }>;
  resourceUsage: Readonly<{
    durationMs: number;
  }>;
  cleanupStatus: R213CleanupStatus;
  isUnknown: boolean;
  provenance: typeof R213_SYNTHETIC_PROVENANCE;
  isSynthetic: true;
}>;

export type R213RecordedOperation = Readonly<{
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
  status: R213ExecutionStatus;
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
  cleanupStatus: R213CleanupStatus;
  isUnknown: boolean;
  provenance: string;
  isSynthetic: true;
  createdAt: string;
  completedAt: string | null;
}>;

export type R213CandidateExecutionView = Readonly<{
  terminalEnabled: boolean;
  remainingExecutions: number;
  maxExecutions: number;
  currentWorkspaceDigest: string;
  operations: readonly R213RecordedOperation[];
}>;

export type R213ExecutionAdmissionResult =
  | Readonly<{
      status: 'ADMITTED';
      intent: R213ExecutionIntent;
      operation: R213RecordedOperation;
      remainingExecutions?: number;
    }>
  | Readonly<{
      status: 'REPLAY';
      intent: R213ExecutionIntent;
      operation: R213RecordedOperation;
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
        | 'STALE_WORKSPACE'
        | 'FORBIDDEN';
      message: string;
    }>;
