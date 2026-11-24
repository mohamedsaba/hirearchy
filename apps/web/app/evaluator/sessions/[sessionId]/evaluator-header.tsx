import type { BriefingSessionDuration } from '../../../../src/evaluator/evaluator-briefing';
import type { SessionClosureReason } from '../../../../src/sessions/session';
import { formatEvaluatorClosureReason } from '../../../../src/evaluator/evaluator-review-presentation';
import Link from 'next/link';
import { LocalTime } from '../../../_components/local-time';
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
  candidateName?: string | null;
  candidateEmail?: string | null;
  candidateCode?: string | null;
  targetRole?: string | null;
  testSummary?: string | null;
  diffSummary?: string | null;
}>;

function candidateInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export const EvaluatorHeader = ({
  sessionId,
  scenarioTitle,
  sessionDuration,
  submittedAt,
  closureReason,
  backHref = '/evaluator',
  backLabel = '← Back to reviews',
  showTheme,
  candidateName,
  candidateEmail,
  candidateCode,
  targetRole,
  testSummary,
  diffSummary,
}: EvaluatorHeaderProps) => {
  const displayName = candidateName?.trim() || candidateEmail?.trim() || null;

  return (
    <header className="evaluator-report-heading">
      <div className="evaluator-report-toolbar">
        <Link className="evaluator-back-link" href={backHref}>
          {backLabel}
        </Link>
        {showTheme ? <ThemeToggle /> : null}
      </div>

      {displayName ? (
        <div className="evaluator-candidate-hero">
          <span className="evaluator-avatar-pill" aria-hidden="true">
            {candidateInitials(displayName)}
          </span>
          <div className="evaluator-candidate-hero-text">
            <div className="evaluator-candidate-hero-top">
              <h1>{displayName}</h1>
              {candidateCode ? (
                <span className="evaluator-candidate-code">
                  {candidateCode}
                </span>
              ) : null}
              {targetRole ? (
                <span className="evaluator-candidate-role">{targetRole}</span>
              ) : null}
            </div>
            <p className="evaluator-candidate-sub">
              <span>{scenarioTitle}</span>
              {candidateEmail && candidateEmail !== displayName ? (
                <span> · {candidateEmail}</span>
              ) : null}
            </p>
          </div>
        </div>
      ) : (
        <h1>{scenarioTitle}</h1>
      )}

      <div className="evaluator-report-metadata">
        <span className="evaluator-report-status">Submitted</span>
        {testSummary ? (
          <span className="evaluator-meta-pill">{testSummary}</span>
        ) : null}
        {diffSummary ? (
          <span className="evaluator-meta-pill">{diffSummary}</span>
        ) : null}
        {!displayName ? (
          <span>{formatEvaluatorClosureReason(closureReason)}</span>
        ) : null}
        {sessionDuration?.status === 'available' ? (
          <span>{sessionDuration.text} recorded</span>
        ) : null}
        <LocalTime timestamp={submittedAt} />
        {!displayName ? (
          <span title={`Candidate session reference: ${sessionId}`}>
            Session {sessionId.slice(0, 8)}…
          </span>
        ) : null}
      </div>
    </header>
  );
};
