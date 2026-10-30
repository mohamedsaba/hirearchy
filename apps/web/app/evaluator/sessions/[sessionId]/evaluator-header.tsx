import type { BriefingSessionDuration } from '../../../../src/evaluator/evaluator-briefing';
import type { SessionClosureReason } from '../../../../src/sessions/session';
import { formatEvaluatorClosureReason } from '../../../../src/evaluator/evaluator-review-presentation';
import Link from 'next/link';

type EvaluatorHeaderProps = Readonly<{
  sessionId: string;
  scenarioTitle: string;
  sessionDuration?: BriefingSessionDuration;
  submittedAt: string;
  closureReason: SessionClosureReason;
}>;

export const EvaluatorHeader = ({
  sessionId,
  scenarioTitle,
  sessionDuration,
  submittedAt,
  closureReason,
}: EvaluatorHeaderProps) => (
  <header className="evaluator-report-heading">
    <Link className="evaluator-back-link" href="/evaluator">
      ← Back to reviews
    </Link>
    <h1>{scenarioTitle}</h1>
    <div className="evaluator-report-metadata">
      <span className="evaluator-report-status">Submitted</span>
      <span>{formatEvaluatorClosureReason(closureReason)}</span>
      {sessionDuration?.status === 'available' ? (
        <span>{sessionDuration.text} recorded</span>
      ) : null}
      <span title={`Candidate session reference: ${sessionId}`}>
        Session {sessionId.slice(0, 8)}…
      </span>
      <time dateTime={submittedAt}>
        {new Date(submittedAt).toLocaleString('en-US', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'UTC',
        })}{' '}
        UTC
      </time>
    </div>
  </header>
);
