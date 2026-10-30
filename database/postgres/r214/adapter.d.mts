import type {
  R214RecordedOperation,
  R214CandidateExecutionView,
  R214AdmissionParams,
  R214CompleteExecutionParams,
  R214FailExecutionParams,
  R214ExecutionAdmissionResult,
} from './contract.d.mts';

export declare class R213ExecutionSecurityError extends Error {
  code: string;
}

export declare class R213ExecutionConflictError extends Error {
  code: string;
}

export declare function installR214ExecutionFixture(
  clientOrPool: unknown,
): Promise<void>;

export declare function admitCandidateExecution(
  clientOrPool: unknown,
  params: R214AdmissionParams,
): Promise<R214ExecutionAdmissionResult>;

export declare const admitExecution: typeof admitCandidateExecution;

export declare function completeCandidateExecution(
  clientOrPool: unknown,
  params: R214CompleteExecutionParams,
): Promise<R214RecordedOperation>;

export declare const completeExecution: typeof completeCandidateExecution;

export declare function failCandidateExecution(
  clientOrPool: unknown,
  params: R214FailExecutionParams,
): Promise<R214RecordedOperation>;

export declare const failExecution: typeof failCandidateExecution;

export declare function getCandidateExecutionsView(
  clientOrPool: unknown,
  params: {
    tokenHash: string;
    sessionId: string;
  },
): Promise<R214CandidateExecutionView>;

export declare function getEvaluatorExecutions(
  clientOrPool: unknown,
  params: {
    organizationId: string;
    sessionId: string;
    reviewerPrincipalId?: string | null;
  },
): Promise<readonly R214RecordedOperation[]>;

export interface R214ExecutionAdapterInstance {
  pool: unknown;
  getCandidateExecutionsView(params: {
    tokenHash: string;
    sessionId: string;
  }): Promise<R214CandidateExecutionView>;
  admitCandidateExecution(
    params: R214AdmissionParams,
  ): Promise<R214ExecutionAdmissionResult>;
  admitExecution(
    params: R214AdmissionParams,
  ): Promise<R214ExecutionAdmissionResult>;
  completeCandidateExecution(
    params: R214CompleteExecutionParams,
  ): Promise<R214RecordedOperation>;
  completeExecution(
    params: R214CompleteExecutionParams,
  ): Promise<R214RecordedOperation>;
  failCandidateExecution(
    params: R214FailExecutionParams,
  ): Promise<R214RecordedOperation>;
  failExecution(
    params: R214FailExecutionParams,
  ): Promise<R214RecordedOperation>;
  getEvaluatorExecutions(params: {
    organizationId: string;
    sessionId: string;
    reviewerPrincipalId?: string | null;
  }): Promise<readonly R214RecordedOperation[]>;
  close(): Promise<void>;
}

export declare function createR214ExecutionAdapter(options?: {
  pool?: unknown;
  connectionString?: string;
  query?: (...args: unknown[]) => unknown;
}): R214ExecutionAdapterInstance;
