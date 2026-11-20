import type { BriefingSessionDuration } from '../../../../src/evaluator/evaluator-briefing';
import type { SessionClosureReason } from '../../../../src/sessions/session';
import { formatEvaluatorClosureReason } from '../../../../src/evaluator/evaluator-review-presentation';
import Link from 'next/link';
import { ThemeToggle } from '../../../_components/theme-toggle';

type EvaluatorHeaderProps = Readonly<{
  sessionId: string;
  scenarioTitle: string;
  sessionDuration?: BriefingSessionDuration;
  submittedAt: string;
  closureReason: SessionClosureReason;
  backHref?: string;
  backLabel?: string;
  showTheme?: boolean;
}>;

export const EvaluatorHeader = ({
  sessionId,
  scenarioTitle,
  sessionDuration,
  submittedAt,
  closureReason,
  backHref = '/evaluator',
  backLabel = '← Back to reviews',
  showTheme,
}: EvaluatorHeaderProps) => (
  <header className="evaluator-report-heading">
    <div className="evaluator-report-toolbar">
      <Link className="evaluator-back-link" href={backHref}>
        {backLabel}
      </Link>
      {showTheme ? <ThemeToggle /> : null}
    </div>
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
      <time dateTime={submittedAt} title={`Submitted ${submittedAt}`}>
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
