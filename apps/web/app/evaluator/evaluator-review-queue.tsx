'use client';

import Link from 'next/link';
import { formatEvaluatorClosureReason } from '../../src/evaluator/evaluator-review-presentation';
import { useEffect, useState } from 'react';

import type {
  EvaluatorReviewEntry,
  EvaluatorReviewQueue as EvaluatorReviewQueuePayload,
} from '../../src/evaluator/evaluator-review-entry';

export type QueueState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; sessions: readonly QueueEntryWithReviewStatus[] }>
  | Readonly<{ kind: 'access-error' }>
  | Readonly<{ kind: 'service-error' }>;

type QueueEntryWithReviewStatus = EvaluatorReviewEntry &
  Readonly<{
    reviewProcessStatus?:
      | 'not_started'
      | 'in_progress'
      | 'waiting_for_response'
      | 'next_step_recorded';
  }>;
const reviewStatusLabel: Record<
  NonNullable<QueueEntryWithReviewStatus['reviewProcessStatus']>,
  string
> = {
  not_started: 'Review not started',
  in_progress: 'Review in progress',
  waiting_for_response: 'Waiting for candidate response',
  next_step_recorded: 'Next step recorded',
};

const formatSubmissionTime = (submittedAt: string) =>
  new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(submittedAt));

const formatDuration = (durationSeconds: number | null) => {
  if (durationSeconds === null) return null;
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

const isReviewQueue = (value: unknown): value is EvaluatorReviewQueuePayload =>
  Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray((value as EvaluatorReviewQueuePayload).sessions),
  );

export const EvaluatorReviewQueueContent = ({
  state,
}: {
  state: QueueState;
}) => {
  if (state.kind === 'loading')
    return <p role="status">Loading submitted assessments…</p>;

  if (state.kind === 'access-error')
    return (
      <p className="form-error" role="alert">
        Evaluator access is required to load submitted assessments.
      </p>
    );

  if (state.kind === 'service-error')
    return (
      <p className="form-error" role="alert">
        Submitted assessments could not be loaded. Reload the page to try again.
      </p>
    );

  if (state.sessions.length === 0)
    return <p>No submitted assessments are available for review.</p>;

  return <ReviewQueueList sessions={state.sessions} />;
};

const ReviewQueueList = ({
  sessions,
}: Readonly<{ sessions: readonly QueueEntryWithReviewStatus[] }>) => {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredSessions = sessions.filter((session) =>
    `${session.scenarioTitle} ${session.sessionId}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );

  return (
    <>
      <label className="evaluator-queue-search">
        <span>Filter by task or session reference</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search submitted assessments"
        />
      </label>
      {filteredSessions.length === 0 ? (
        <p role="status">No submitted assessments match that search.</p>
      ) : null}
      <ul className="evaluator-review-list">
        {filteredSessions.map((session) => (
          <li key={session.sessionId}>
            <Link
              className="evaluator-review-link"
              href={`/evaluator/sessions/${encodeURIComponent(session.sessionId)}`}
              prefetch={false}
              aria-label={`Review ${session.scenarioTitle}, session ${session.sessionId}`}
            >
              <span className="evaluator-review-title">
                {session.scenarioTitle}
              </span>
              <span className="evaluator-review-reference">
                Session {session.sessionId}
              </span>
              <span>
                Submitted{' '}
                <time dateTime={session.submittedAt}>
                  {formatSubmissionTime(session.submittedAt)} UTC
                </time>
              </span>
              {formatDuration(session.durationSeconds) ? (
                <span>
                  {formatDuration(session.durationSeconds)} assessment
                </span>
              ) : null}
              <span>{formatEvaluatorClosureReason(session.closureReason)}</span>
              <span className="evaluator-review-process-status">
                {
                  reviewStatusLabel[
                    session.reviewProcessStatus ?? 'not_started'
                  ]
                }
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
};

export const EvaluatorReviewQueue = () => {
  const [state, setState] = useState<QueueState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;

    void fetch('/api/evaluator/sessions', { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) {
          if (active) setState({ kind: 'access-error' });
          return;
        }
        if (!response.ok) throw new Error('Evaluator discovery failed.');

        const queue: unknown = await response.json();
        if (!isReviewQueue(queue)) throw new Error('Invalid evaluator queue.');
        if (active) setState({ kind: 'ready', sessions: queue.sessions });
      })
      .catch(() => {
        if (active) setState({ kind: 'service-error' });
      });

    return () => {
      active = false;
    };
  }, []);

  return <EvaluatorReviewQueueContent state={state} />;
};
