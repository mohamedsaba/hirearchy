import type {
  R213RecordedOperation,
  R213CandidateExecutionView,
} from '../../../apps/web/src/r213-execution/contract';
import type {
  R213AdmissionParams,
  R213CompleteParams,
  R213FailParams,
  R213ExecutionAdmissionResult,
} from './contract.d.mts';

export declare function installR213ExecutionFixture(
  clientOrPool: unknown,
): Promise<void>;

export declare function admitCandidateExecution(
  clientOrPool: unknown,
  params: R213AdmissionParams,
): Promise<R213ExecutionAdmissionResult>;

export declare function completeCandidateExecution(
  clientOrPool: unknown,
  params: R213CompleteParams,
): Promise<R213RecordedOperation>;

export declare function failCandidateExecution(
  clientOrPool: unknown,
  params: R213FailParams,
): Promise<R213RecordedOperation>;

export declare function getCandidateExecutionsView(
  clientOrPool: unknown,
  params: {
    tokenHash: string;
    sessionId: string;
  },
): Promise<R213CandidateExecutionView>;

export declare function getEvaluatorExecutions(
  clientOrPool: unknown,
  params: {
    organizationId: string;
    sessionId: string;
    reviewerPrincipalId?: string | null;
  },
): Promise<readonly R213RecordedOperation[]>;
