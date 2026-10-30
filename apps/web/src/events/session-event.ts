import type { HirearchyContextMetadata } from '../ai/ai-interaction';

export type SessionEventType =
  | 'COMMAND_STARTED'
  | 'COMMAND_FINISHED'
  | 'WORKSPACE_CHANGED'
  | 'WORKSPACE_CAPTURE_FAILED'
  | 'SANDBOX_CLEANUP_FAILED'
  | 'AI_REQUEST_STARTED'
  | 'AI_RESPONSE_COMPLETED'
  | 'AI_REQUEST_CANCELLED'
  | 'AI_REQUEST_FAILED';

export type CommandStartedPayload = Readonly<{
  commandId: string;
  command: string;
  cwd: string;
}>;

export type CommandFinishedPayload = Readonly<{
  commandId: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutPreview: string;
  stdoutBytes: number;
  stdoutTruncated: boolean;
  stderrPreview: string;
  stderrBytes: number;
  stderrTruncated: boolean;
}>;

export type WorkspaceFileChange = Readonly<{
  path: string;
  status: 'modified' | 'added' | 'deleted';
  additions: number;
  deletions: number;
  patchPreview: string;
  patchPreviewBytes: number;
  patchBytes: number;
  patchTruncated: boolean;
}>;

export type WorkspaceChangedPayload = Readonly<{
  changeId: string;
  origin: 'browser_save' | 'command_execution' | 'out_of_band';
  commandId?: string;
  interactionId?: string;
  applicationRequestId?: string;
  beforeTree: string;
  afterTree: string;
  files: readonly WorkspaceFileChange[];
  totalAdditions: number;
  totalDeletions: number;
}>;

export type WorkspaceCaptureFailedPayload = Readonly<{
  commandId?: string;
  phase:
    | 'pre_command'
    | 'post_command'
    | 'browser_save'
    | 'submission'
    | 'submission_pre_freeze'
    | 'submission_freeze'
    | 'submission_frozen_capture'
    | 'reconciliation';
  beforeTree?: string | null;
  errorMessage: string;
}>;

export type SandboxCleanupFailedPayload = Readonly<{
  phase: 'submission';
  errorMessage: string;
}>;

export type AiRequestStartedPayload = Readonly<{
  interactionId: string;
  clientRequestId: string;
  configuredProviderId: string;
  configuredModelId: string;
  candidateInputExcerpt: string;
  candidateInputBytes: number;
  candidateContext?: readonly Readonly<{
    filePath: string;
    startLine?: number;
    endLine?: number;
  }>[];
  hirearchyContext?: HirearchyContextMetadata;
}>;

export type AiResponseCompletedPayload = Readonly<{
  interactionId: string;
  durationMs: number;
  reportedModelId: string;
  providerRequestId?: string;
  responseExcerpt: string;
  responseBytes: number;
  finishReason?: string;
  tokenUsage?: Readonly<{
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }>;
}>;

export type AiRequestCancelledPayload = Readonly<{
  interactionId: string;
  durationMs: number;
  cancelReason:
    | 'candidate_requested_cancel'
    | 'session_ended'
    | 'platform_policy_abort'
    | string;
}>;

export type AiRequestFailedPayload = Readonly<{
  interactionId: string;
  durationMs: number;
  failureReason:
    | 'provider_error'
    | 'provider_disconnected'
    | 'server_timeout'
    | 'server_error'
    | string;
  errorMessageExcerpt: string;
}>;

export type SessionEventPayload =
  | CommandStartedPayload
  | CommandFinishedPayload
  | WorkspaceChangedPayload
  | WorkspaceCaptureFailedPayload
  | SandboxCleanupFailedPayload
  | AiRequestStartedPayload
  | AiResponseCompletedPayload
  | AiRequestCancelledPayload
  | AiRequestFailedPayload;

export type SessionEvent = Readonly<{
  id: string;
  sessionId: string;
  sequence: number;
  type: SessionEventType;
  timestamp: string;
  source: 'server' | 'sandbox';
  payload: SessionEventPayload;
}>;

export type NewSessionEvent = Readonly<{
  id: string;
  sessionId: string;
  type: SessionEventType;
  timestamp: string;
  source: 'server' | 'sandbox';
  payload: SessionEventPayload;
}>;
