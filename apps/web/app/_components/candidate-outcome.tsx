import type { CandidatePublishedOutcome } from '../../src/hiring/types';

export function CandidateOutcome({
  outcome,
}: Readonly<{ outcome: Omit<CandidatePublishedOutcome, 'publishedAt'> }>) {
  const accepted = outcome.decision === 'accepted';
  return (
    <div className="hiring-outcome-box hiring-mt-md">
      <div className="hiring-candidate-name">
        <strong>
          {accepted
            ? `Next step · ${outcome.nextStageLabel || 'Next interview'}`
            : 'Feedback'}
        </strong>
        <span
          className={`hiring-pill ${accepted ? 'hiring-pill-success' : 'hiring-pill-danger'}`}
        >
          {accepted ? 'Accepted' : 'Rejected'}
        </span>
      </div>

      {outcome.feedbackNote ? (
        <p className="hiring-outcome-note">{outcome.feedbackNote}</p>
      ) : null}

      {outcome.strengths.length || outcome.weaknesses.length ? (
        <div className="hiring-two-col">
          {(
            [
              ['Strengths noted', outcome.strengths],
              ['Areas for growth', outcome.weaknesses],
            ] as const
          ).map(([label, entries]) =>
            entries.length ? (
              <div key={label}>
                <strong>{label}</strong>
                <ul className="hiring-bullet-list">
                  {entries.map((entry, index) => (
                    <li key={index}>{entry}</li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}
