import type { AiCapabilitySnapshot } from '../ai/ai-interaction';
import type { ScenarioSnapshot } from '../scenarios/slice-one-scenario';
import type { TaskRubricSnapshot } from '../assessments/task-rubric';

export {
  type CandidateTimingProjection,
  deriveSessionDeadline,
  isDeadlineExceeded,
  toCandidateTimingProjection,
} from './session-timing';

export type SessionStatus = 'CREATED' | 'ACTIVE' | 'SUBMITTED';

export type SessionClosureReason = 'candidate_submission' | 'timeout';

export type AssessmentSession = Readonly<{
  id: string;
  candidateTokenHash: string;
  scenario: ScenarioSnapshot;
  status: SessionStatus;
  workingContent: string;
  submittedContent: string | null;
  createdAt: string;
  activatedAt: string | null;
  submittedAt: string | null;
  durationSeconds: number | null;
  closureReason: SessionClosureReason | null;
  scenarioType?: 'single_file' | 'multi_file';
  submittedDiff?: string | null;
  aiCapabilitySnapshot?: AiCapabilitySnapshot | null;
  taskRubricSnapshot?: TaskRubricSnapshot | null;
  terminalEnabled?: boolean;
  candidateToken?: string | null;
}>;

export type SubmittedSession = AssessmentSession &
  Readonly<{
    status: 'SUBMITTED';
    submittedContent: string;
    submittedAt: string;
    closureReason: SessionClosureReason;
  }>;

export class SessionError extends Error {
  constructor(
    readonly code:
      | 'SESSION_NOT_FOUND'
      | 'SESSION_NOT_ACTIVE'
      | 'SESSION_FINALIZATION_STARTED'
      | 'SESSION_DEADLINE_EXCEEDED'
      | 'TERMINAL_NOT_ENABLED'
      | 'EVIDENCE_NOT_READY'
      | 'CONTENT_TOO_LARGE'
      | 'COMMAND_TOO_LARGE'
      | 'PLATFORM_CAPTURE_FAILED'
      | 'INVALID_SCENARIO_DURATION'
      | 'SCENARIO_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export const activateSession = (
  session: AssessmentSession,
  activatedAt: string,
): AssessmentSession => {
  if (session.status === 'ACTIVE') {
    return session;
  }

  if (session.status !== 'CREATED') {
    throw new SessionError(
      'SESSION_NOT_ACTIVE',
      'A submitted session cannot be activated.',
    );
  }

  return { ...session, status: 'ACTIVE', activatedAt };
};

export const editSession = (
  session: AssessmentSession,
  workingContent: string,
): AssessmentSession => {
  if (session.status !== 'ACTIVE') {
    throw new SessionError(
      'SESSION_NOT_ACTIVE',
      'Editing is allowed only while the session is active.',
    );
  }

  if (session.closureReason !== null) {
    throw new SessionError(
      'SESSION_FINALIZATION_STARTED',
      'Finalization has already started. Candidate mutations are no longer permitted.',
    );
  }

  return { ...session, workingContent };
};

export const submitSession = (
  session: AssessmentSession,
  submittedAt: string,
  submittedDiff?: string | null,
  closureReason: SessionClosureReason = 'candidate_submission',
): SubmittedSession => {
  if (session.status === 'SUBMITTED') {
    return session as SubmittedSession;
  }

  if (session.status !== 'ACTIVE') {
    throw new SessionError(
      'SESSION_NOT_ACTIVE',
      'The session must be active before it can be submitted.',
    );
  }

  return {
    ...session,
    status: 'SUBMITTED',
    submittedContent: session.workingContent,
    submittedAt,
    submittedDiff: submittedDiff ?? session.submittedDiff ?? null,
    closureReason: session.closureReason ?? closureReason,
  };
};

export const requireSubmittedSession = (
  session: AssessmentSession,
): SubmittedSession => {
  if (
    session.status !== 'SUBMITTED' ||
    session.submittedContent === null ||
    session.submittedAt === null
  ) {
    throw new SessionError(
      'EVIDENCE_NOT_READY',
      'Evidence is available only after submission.',
    );
  }

  return session as SubmittedSession;
};
