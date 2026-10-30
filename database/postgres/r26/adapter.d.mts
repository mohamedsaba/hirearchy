export type R26CandidateAction = 'read' | 'activate' | 'save' | 'submit';

export type R26CandidateClosureReason = 'candidate_submission' | 'timeout';

export type R26CandidateSaveInput = Readonly<{
  requestId: string;
  path: string;
  content: string;
  expectedVersion: string;
}>;

export type R26CandidateSubmitInput = Readonly<{
  requestId: string;
  expectedWorkspaceDigest: string;
}>;

export type R26CandidateScenario = Readonly<{
  id: string;
  version: string;
  title: string;
  brief: string;
  acceptanceCriteria: readonly string[];
  filePath: string;
  durationSeconds?: number;
  type?: 'single_file' | 'multi_file';
  [key: string]: unknown;
}>;

export type R26CandidateFileView = Readonly<{
  path: string;
  content: string;
  version: string;
  digest: string;
}>;

export type R26CandidateEvent = Readonly<{
  sequence: string;
  type:
    | 'SESSION_ACTIVATED'
    | 'WORKSPACE_CHANGED'
    | 'SESSION_SUBMITTED'
    | 'AI_REQUEST_STARTED'
    | 'AI_RESPONSE_COMPLETED'
    | 'AI_REQUEST_FAILED'
    | 'EXECUTION_REQUESTED'
    | 'EXECUTION_COMPLETED'
    | 'EXECUTION_FAILED';
  timestamp: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type R26CandidateSubmission = Readonly<{
  submittedAt: string;
  closureReason: R26CandidateClosureReason;
  workspaceDigest: string;
  manifestDigest: string;
  files: readonly R26CandidateFileView[];
}>;

export type R26CandidateView = Readonly<{
  sessionId: string;
  status: 'CREATED' | 'ACTIVE' | 'SUBMITTED';
  scenario: R26CandidateScenario;
  scenarioDigest: string;
  activatedAt: string | null;
  deadline: string | null;
  durationSeconds: number | null;
  submittedAt: string | null;
  closureReason: R26CandidateClosureReason | null;
  serverNow: string;
  files: readonly R26CandidateFileView[];
  workspaceDigest: string | null;
  events: readonly R26CandidateEvent[];
  submission: R26CandidateSubmission | null;
  operation?: Readonly<{ requestId: string; replayed: boolean }>;
}>;

export type R26CandidateCommandBase = Readonly<{
  tokenHash: string;
  sessionId: string;
}>;

export type R26CandidateCommand =
  | (R26CandidateCommandBase & {
      action: 'read';
      input?: never;
    })
  | (R26CandidateCommandBase & {
      action: 'activate';
      input: Readonly<Record<string, never>>;
    })
  | (R26CandidateCommandBase & {
      action: 'save';
      input: R26CandidateSaveInput;
    })
  | (R26CandidateCommandBase & {
      action: 'submit';
      input: R26CandidateSubmitInput;
    });

export type R26CandidateAdapter = Readonly<{
  command(input: R26CandidateCommand): Promise<R26CandidateView>;
  close(): Promise<void>;
}>;

export declare class R26CandidateError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string);
}

export declare function createR26CandidateAdapter(
  options: Readonly<{
    connectionString: string;
  }>,
): R26CandidateAdapter;
