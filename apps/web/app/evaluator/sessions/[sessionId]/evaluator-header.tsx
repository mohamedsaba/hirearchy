import type { ReactNode } from 'react';
import type { BriefingSessionDuration } from '../../../../src/evaluator/evaluator-briefing';
import type { SessionClosureReason } from '../../../../src/sessions/session';
import { formatEvaluatorClosureReason } from '../../../../src/evaluator/evaluator-review-presentation';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
} from '@tabler/icons-react';
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
  desktopReview?: boolean;
  action?: ReactNode;
  candidateName?: string | null;
  candidateEmail?: string | null;
  candidateCode?: string | null;
  targetRole?: string | null;
  experienceLevel?: string | null;
  skills?: readonly string[];
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
  desktopReview = false,
  action,
  candidateName,
  candidateEmail,
  candidateCode,
  targetRole,
  experienceLevel,
  skills,
  testSummary,
  diffSummary,
}: EvaluatorHeaderProps) => {
  const displayName = candidateName?.trim() || candidateEmail?.trim() || null;

  if (desktopReview) {
    const name = displayName ?? scenarioTitle;
    const shouldShowTheme = showTheme ?? true;
    const testsPassed = testSummary ? /\bpassed\b/i.test(testSummary) : false;
    return (
      <header className="evaluator-report-heading review-desk-heading">
        <nav className="review-desk-breadcrumb" aria-label="Candidate review">
          <Link className="evaluator-back-link" href={backHref}>
            Candidates
          </Link>
          <IconChevronRight size={14} aria-hidden="true" />
          <span aria-current="page">{name}</span>
        </nav>
        <div className="review-desk-head-row">
          <div className="review-desk-person">
            <span className="evaluator-avatar-pill" aria-hidden="true">
              {candidateInitials(name)}
            </span>
            <div>
              <h1>{name}</h1>
              <p className="review-desk-subject">
                {[
                  displayName ? scenarioTitle : null,
                  targetRole,
                  experienceLevel,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <div className="review-desk-status">
                <span className="evaluator-report-status">Submitted</span>
                <LocalTime timestamp={submittedAt} absolute />
                {closureReason === 'timeout' ? <span>Time expired</span> : null}
                {candidateCode ? (
                  <span className="evaluator-meta-pill evaluator-meta-pill--mono">
                    {candidateCode}
                  </span>
                ) : null}
                {testSummary ? (
                  <span
                    className={`evaluator-meta-pill ${testsPassed ? 'evaluator-meta-pill--success' : 'evaluator-meta-pill--warning'}`}
                    data-testid="evaluator-header-test-summary"
                  >
                    {testsPassed ? (
                      <IconCheck size={13} aria-hidden="true" />
                    ) : (
                      <IconAlertTriangle size={13} aria-hidden="true" />
                    )}
                    {testSummary}
                  </span>
                ) : null}
                {diffSummary ? (
                  <span
                    className="evaluator-meta-pill evaluator-meta-pill--mono"
                    data-testid="evaluator-header-diff-summary"
                  >
                    {diffSummary}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="review-desk-head-actions">
            {shouldShowTheme ? <ThemeToggle variant="header" /> : null}
            {action}
          </div>
        </div>
      </header>
    );
  }

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
              {targetRole || experienceLevel ? (
                <span className="evaluator-candidate-role">
                  {[targetRole, experienceLevel].filter(Boolean).join(' · ')}
                </span>
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
        {skills?.length ? (
          <details className="software-tech-details">
            <summary>Skills</summary>
            <p>{skills.join(' · ')}</p>
          </details>
        ) : null}
        {!displayName ? (
          <span title={`Candidate session reference: ${sessionId}`}>
            Session {sessionId.slice(0, 8)}…
          </span>
        ) : null}
      </div>
    </header>
  );
};
