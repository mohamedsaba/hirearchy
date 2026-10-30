'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import './evaluator-assessment-list.css';

export type SessionStatus = 'CREATED' | 'ACTIVE' | 'SUBMITTED';
export type SessionClosureReason = 'candidate_submission' | 'timeout';
export type ReviewProcessStatus =
  'not_started' | 'in_progress' | 'waiting_for_response' | 'next_step_recorded';

export type AssessmentLifecycleItem = Readonly<{
  sessionId: string;
  candidatePath: string | null;
  candidateBearerAvailabilityStatus?:
    'runtime_not_activated' | 'activated' | 'unavailable' | null;
  scenarioTitle: string;
  scenarioId?: string;
  scenarioVersion?: string;
  status: SessionStatus;
  createdAt: string;
  activatedAt: string | null;
  submittedAt: string | null;
  durationSeconds: number | null;
  closureReason: SessionClosureReason | null;
  reviewProcessStatus: ReviewProcessStatus | null;
  visibilityScope?:
    'issued_by_recruiter' | 'assigned_to_reviewer' | 'restricted_role';
}>;

export interface EvaluatorAssessmentListProps {
  readonly endpoint?: string;
  readonly initialItems?: readonly AssessmentLifecycleItem[];
  readonly initialTotalCount?: number;
  readonly initialNextCursor?: string | null;
  readonly sessionSummaryHrefPrefix?: string;
  readonly readOnlyMode?: boolean;
  readonly visibilityScope?:
    'issued_by_recruiter' | 'assigned_to_reviewer' | 'restricted_role';
  readonly membershipRole?: string;
  readonly refreshTrigger?: number | string;
  readonly onRefresh?: () => void;
}

type LifecycleFilter = 'all' | 'issued' | 'active' | 'submitted' | 'timed_out';
type ReviewFilter =
  | 'all'
  | 'not_started'
  | 'in_progress'
  | 'waiting_for_response'
  | 'next_step_recorded'
  | 'unavailable';

const reviewStatusLabels: Record<
  Exclude<ReviewFilter, 'all' | 'unavailable'>,
  string
> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  waiting_for_response: 'Waiting for response',
  next_step_recorded: 'Next step recorded',
};

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

const formatTime = (isoString: string) =>
  timeFormatter.format(new Date(isoString));
const formatBudget = (seconds: number | null) =>
  seconds === null ? 'Untimed (legacy)' : `${Math.round(seconds / 60)} min`;

export const EvaluatorAssessmentList = ({
  endpoint,
  initialItems,
  initialTotalCount,
  initialNextCursor,
  sessionSummaryHrefPrefix,
  readOnlyMode,
  visibilityScope,
  membershipRole,
  refreshTrigger,
  onRefresh,
}: EvaluatorAssessmentListProps = {}) => {
  const isTenantScoped = Boolean(
    endpoint ||
    readOnlyMode ||
    visibilityScope ||
    membershipRole ||
    sessionSummaryHrefPrefix,
  );
  const [assessments, setAssessments] = useState<
    readonly AssessmentLifecycleItem[]
  >(initialItems ?? []);
  const [loading, setLoading] = useState(initialItems === undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(
    initialNextCursor ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lifecycleFilter, setLifecycleFilter] =
    useState<LifecycleFilter>('all');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [search, setSearch] = useState('');
  const [copyFeedback, setCopyFeedback] = useState<{
    sessionId: string;
    message: string;
  } | null>(null);

  const initialTriggerRef = useRef(refreshTrigger);

  const refreshAssessments = useCallback(() => {
    if (loading) return;
    setLoading(true);
    setError(null);
    onRefresh?.();
    setRefreshKey((current) => current + 1);
  }, [loading, onRefresh]);

  useEffect(() => {
    if (
      refreshTrigger !== undefined &&
      refreshTrigger !== initialTriggerRef.current
    ) {
      initialTriggerRef.current = refreshTrigger;
      refreshAssessments();
    }
  }, [refreshTrigger, refreshAssessments]);

  useEffect(() => {
    if (initialItems !== undefined && refreshKey === 0) return;

    let active = true;
    const fetchEndpoint = endpoint ?? '/api/evaluator/assessments';

    void fetch(fetchEndpoint, { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) {
          throw new Error('Evaluator access is required to view assessments.');
        }
        if (response.status === 403) {
          throw new Error('Access denied to organization sessions.');
        }
        if (!response.ok) throw new Error('Assessment list request failed.');

        const data = (await response.json()) as {
          assessments?: readonly AssessmentLifecycleItem[];
          nextCursor?: string | null;
        };
        if (!Array.isArray(data.assessments)) {
          throw new Error('Assessment list response was incomplete.');
        }
        if (active) {
          setAssessments(data.assessments);
          if (data.nextCursor !== undefined) {
            setNextCursor(data.nextCursor ?? null);
          }
        }
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        setError(
          requestError instanceof Error &&
            (requestError.message.includes('access') ||
              requestError.message.includes('denied'))
            ? requestError.message
            : 'Assessments could not be loaded. Try again.',
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [refreshKey, endpoint, initialItems]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const baseEndpoint = endpoint ?? '/api/evaluator/assessments';
      const separator = baseEndpoint.includes('?') ? '&' : '?';
      const url = `${baseEndpoint}${separator}cursor=${encodeURIComponent(nextCursor)}`;
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error('Failed to load more sessions');
      const data = (await response.json()) as {
        assessments?: readonly AssessmentLifecycleItem[];
        nextCursor?: string | null;
      };
      if (Array.isArray(data.assessments)) {
        setAssessments((current) => {
          const existingIds = new Set(current.map((item) => item.sessionId));
          const newItems = (data.assessments ?? []).filter(
            (item) => !existingIds.has(item.sessionId),
          );
          return [...current, ...newItems];
        });
        setNextCursor(data.nextCursor ?? null);
      }
    } catch {
      // Keep nextCursor so user can retry
    } finally {
      setLoadingMore(false);
    }
  };

  const copyCandidateLink = async (
    candidatePath: string,
    sessionId: string,
  ) => {
    try {
      const fullUrl = new URL(candidatePath, window.location.origin).toString();
      await navigator.clipboard.writeText(fullUrl);
      setCopyFeedback({ sessionId, message: 'Candidate link copied.' });
    } catch {
      setCopyFeedback({
        sessionId,
        message:
          'Copy did not work. Open the candidate link and copy its address from your browser.',
      });
    }
  };

  const submitted = assessments.filter((item) => item.status === 'SUBMITTED');
  const lifecycleCounts: Record<LifecycleFilter, number> = {
    all: assessments.length,
    issued: assessments.filter((item) => item.status === 'CREATED').length,
    active: assessments.filter((item) => item.status === 'ACTIVE').length,
    submitted: submitted.length,
    timed_out: submitted.filter((item) => item.closureReason === 'timeout')
      .length,
  };
  const reviewCounts: Record<ReviewFilter, number> = {
    all: assessments.length,
    not_started: submitted.filter(
      (item) => item.reviewProcessStatus === 'not_started',
    ).length,
    in_progress: submitted.filter(
      (item) => item.reviewProcessStatus === 'in_progress',
    ).length,
    waiting_for_response: submitted.filter(
      (item) => item.reviewProcessStatus === 'waiting_for_response',
    ).length,
    next_step_recorded: submitted.filter(
      (item) => item.reviewProcessStatus === 'next_step_recorded',
    ).length,
    unavailable: submitted.filter((item) => item.reviewProcessStatus === null)
      .length,
  };

  const normalizedSearch = search.trim().toLowerCase();
  const filtered = assessments.filter((item) => {
    const lifecycleMatches =
      lifecycleFilter === 'all' ||
      (lifecycleFilter === 'issued' && item.status === 'CREATED') ||
      (lifecycleFilter === 'active' && item.status === 'ACTIVE') ||
      (lifecycleFilter === 'submitted' && item.status === 'SUBMITTED') ||
      (lifecycleFilter === 'timed_out' &&
        item.status === 'SUBMITTED' &&
        item.closureReason === 'timeout');
    const reviewMatches =
      reviewFilter === 'all' ||
      (item.status === 'SUBMITTED' &&
        (reviewFilter === 'unavailable'
          ? item.reviewProcessStatus === null
          : item.reviewProcessStatus === reviewFilter));
    const searchMatches =
      !normalizedSearch ||
      item.scenarioTitle.toLowerCase().includes(normalizedSearch) ||
      item.sessionId.toLowerCase().includes(normalizedSearch);
    return lifecycleMatches && reviewMatches && searchMatches;
  });

  const clearFilters = () => {
    setLifecycleFilter('all');
    setReviewFilter('all');
    setSearch('');
  };

  return (
    <section
      className="evaluator-lifecycle-panel"
      aria-labelledby="lifecycle-list-title"
    >
      <h2 id="lifecycle-list-title" className="lifecycle-visually-hidden">
        Assessment sessions
      </h2>

      {visibilityScope || membershipRole ? (
        <div
          className="lifecycle-scope-banner"
          role="region"
          aria-label="Authorized visibility scope"
        >
          <p>
            {membershipRole === 'admin' || visibilityScope === 'restricted_role'
              ? 'Organization admin scope: session access blocked pending P2 ratification'
              : membershipRole === 'recruiter' ||
                  visibilityScope === 'issued_by_recruiter'
                ? 'Recruiter scope: sessions issued by your account'
                : membershipRole === 'reviewer' ||
                    visibilityScope === 'assigned_to_reviewer'
                  ? 'Reviewer scope: submitted sessions actively assigned to you'
                  : 'Authorized scope: organization sessions'}
          </p>
        </div>
      ) : null}

      <div className="lifecycle-results-summary">
        <p role="status">
          {loading
            ? assessments.length > 0
              ? 'Refreshing sessions…'
              : 'Loading sessions…'
            : error
              ? 'Could not load sessions.'
              : assessments.length > 0
                ? `Showing ${filtered.length} of ${initialTotalCount ?? assessments.length} sessions`
                : 'No sessions yet'}
        </p>
        <button
          className="lifecycle-refresh-button"
          type="button"
          aria-disabled={loading}
          onClick={refreshAssessments}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {loading ? (
        <div className="lifecycle-loading-placeholder" aria-hidden="true" />
      ) : error ? (
        <div className="lifecycle-state-message lifecycle-state-error">
          <p role="alert">{error}</p>
        </div>
      ) : (
        <>
          <div className="evaluator-lifecycle-controls">
            <label className="evaluator-lifecycle-search">
              <span>Search assessment title or session reference</span>
              <input
                type="search"
                aria-label="Search by assessment title or session reference"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Assessment title or session reference"
              />
            </label>
            <label className="evaluator-lifecycle-select">
              <span>Session lifecycle</span>
              <select
                value={lifecycleFilter}
                onChange={(event) =>
                  setLifecycleFilter(event.target.value as LifecycleFilter)
                }
              >
                <option value="all">
                  All sessions ({lifecycleCounts.all})
                </option>
                <option value="issued">
                  Issued ({lifecycleCounts.issued})
                </option>
                <option value="active">
                  Active ({lifecycleCounts.active})
                </option>
                <option value="submitted">
                  Submitted ({lifecycleCounts.submitted})
                </option>
                <option value="timed_out">
                  Timed out submissions ({lifecycleCounts.timed_out})
                </option>
              </select>
            </label>
            <label className="evaluator-lifecycle-select">
              <span>Review progress</span>
              <select
                value={reviewFilter}
                onChange={(event) =>
                  setReviewFilter(event.target.value as ReviewFilter)
                }
              >
                <option value="all">
                  All review progress ({reviewCounts.all})
                </option>
                <option value="not_started">
                  Not started ({reviewCounts.not_started})
                </option>
                <option value="in_progress">
                  In progress ({reviewCounts.in_progress})
                </option>
                <option value="waiting_for_response">
                  Waiting for response ({reviewCounts.waiting_for_response})
                </option>
                <option value="next_step_recorded">
                  Next step recorded ({reviewCounts.next_step_recorded})
                </option>
                <option value="unavailable">
                  Status not recorded ({reviewCounts.unavailable})
                </option>
              </select>
            </label>
            <p className="lifecycle-filter-hint">
              Review states apply after submission; a next step still needs
              follow-through.
            </p>
          </div>

          {assessments.length === 0 ? (
            isTenantScoped ? (
              <div className="lifecycle-state-message">
                <h3>No authorized sessions in this organization</h3>
                <p>
                  {membershipRole === 'admin' ||
                  visibilityScope === 'restricted_role'
                    ? 'Organization admin session access remains blocked until P2 access policies are ratified.'
                    : membershipRole === 'recruiter' ||
                        visibilityScope === 'issued_by_recruiter'
                      ? 'No assessment sessions issued by your recruiter account were found in this organization.'
                      : membershipRole === 'reviewer' ||
                          visibilityScope === 'assigned_to_reviewer'
                        ? 'No submitted assessment sessions are currently assigned to your reviewer account in this organization.'
                        : 'No candidate sessions yet'}
                </p>
                {!readOnlyMode ? (
                  <Link
                    className="software-button software-button-primary"
                    href="/evaluator/assessments/new"
                  >
                    Create assessment
                  </Link>
                ) : null}
              </div>
            ) : (
              <div className="lifecycle-state-message">
                <h3>No candidate sessions yet</h3>
                <p>
                  Create an assessment to issue the first candidate session.
                </p>
                <Link
                  className="software-button software-button-primary"
                  href="/evaluator/assessments/new"
                >
                  Create assessment
                </Link>
              </div>
            )
          ) : filtered.length === 0 ? (
            <div className="lifecycle-state-message" role="status">
              <h3>No sessions match these filters</h3>
              <p>
                Clear the filters or search a different assessment or reference.
              </p>
              <button
                className="software-button software-button-secondary"
                type="button"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <>
              <div className="evaluator-lifecycle-columns" aria-hidden="true">
                <span>Assessment</span>
                <span>Lifecycle</span>
                <span>Time budget</span>
                <span>Review progress</span>
                <span>Action</span>
              </div>
              <ul className="evaluator-lifecycle-list">
                {filtered.map((item) => {
                  const isTimedOut =
                    item.status === 'SUBMITTED' &&
                    item.closureReason === 'timeout';
                  const lifecycleLabel =
                    item.status === 'CREATED'
                      ? 'Issued'
                      : item.status === 'ACTIVE'
                        ? 'Active'
                        : 'Submitted';
                  const reviewLabel =
                    item.status !== 'SUBMITTED'
                      ? 'Available after submission'
                      : item.reviewProcessStatus
                        ? reviewStatusLabels[item.reviewProcessStatus]
                        : 'Not recorded';
                  const currentTimestampLabel =
                    item.status === 'CREATED'
                      ? 'Issued'
                      : item.status === 'ACTIVE'
                        ? 'Started'
                        : 'Submitted';
                  const currentTimestamp =
                    item.status === 'CREATED'
                      ? item.createdAt
                      : item.status === 'ACTIVE'
                        ? item.activatedAt
                        : item.submittedAt;

                  return (
                    <li
                      key={item.sessionId}
                      className="evaluator-lifecycle-item"
                    >
                      <div className="lifecycle-row-assessment">
                        <h3>{item.scenarioTitle}</h3>
                        <p>
                          Session <code>{item.sessionId.slice(0, 8)}</code>
                        </p>
                      </div>

                      <div className="lifecycle-row-state">
                        <span className="lifecycle-field-label">Lifecycle</span>
                        <span
                          className={`lifecycle-status lifecycle-status-${item.status.toLowerCase()}`}
                        >
                          {lifecycleLabel}
                        </span>
                        {isTimedOut ? (
                          <span className="lifecycle-closure-status">
                            Timed out
                          </span>
                        ) : null}
                        <p className="lifecycle-current-timestamp">
                          <span>{currentTimestampLabel}</span>
                          {currentTimestamp ? (
                            <time dateTime={currentTimestamp}>
                              {formatTime(currentTimestamp)} UTC
                            </time>
                          ) : (
                            <span>Not recorded</span>
                          )}
                        </p>
                      </div>

                      <div className="lifecycle-row-budget">
                        <span className="lifecycle-field-label">
                          Time budget
                        </span>
                        <strong>{formatBudget(item.durationSeconds)}</strong>
                      </div>

                      <div className="lifecycle-row-review">
                        <span className="lifecycle-field-label">
                          Review progress
                        </span>
                        <span className="lifecycle-review-status">
                          {reviewLabel}
                        </span>
                      </div>

                      <div className="lifecycle-row-actions">
                        {item.status === 'SUBMITTED' ? (
                          <Link
                            className="software-button software-button-primary lifecycle-primary-action"
                            href={
                              sessionSummaryHrefPrefix
                                ? `${sessionSummaryHrefPrefix}/${encodeURIComponent(item.sessionId)}`
                                : `/evaluator/sessions/${encodeURIComponent(item.sessionId)}`
                            }
                          >
                            {sessionSummaryHrefPrefix
                              ? 'Inspect authorized session summary'
                              : 'Open evaluator review'}
                          </Link>
                        ) : item.candidatePath ? (
                          <a
                            className="software-button software-button-primary lifecycle-primary-action"
                            href={item.candidatePath}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {item.status === 'CREATED'
                              ? 'Open invitation'
                              : 'Open active session'}
                          </a>
                        ) : sessionSummaryHrefPrefix ? (
                          <Link
                            className="software-button software-button-primary lifecycle-primary-action"
                            href={`${sessionSummaryHrefPrefix}/${encodeURIComponent(item.sessionId)}`}
                          >
                            Inspect authorized session summary
                          </Link>
                        ) : (
                          <span className="lifecycle-action-unavailable">
                            Candidate link unavailable
                          </span>
                        )}

                        <details className="evaluator-lifecycle-details">
                          <summary
                            aria-label={`Session details for ${item.scenarioTitle}`}
                          >
                            Details
                          </summary>
                          <div className="lifecycle-details-panel">
                            {item.status === 'SUBMITTED' ? (
                              <p>
                                This candidate submission is frozen. Use the
                                candidate session link for reviewer-requested
                                follow-up.
                              </p>
                            ) : (
                              <p>
                                The candidate link can be reopened or copied for
                                manual sharing.
                              </p>
                            )}
                            <dl className="lifecycle-details-metadata">
                              <div>
                                <dt>Full session reference</dt>
                                <dd>
                                  <code>{item.sessionId}</code>
                                </dd>
                              </div>
                              {item.scenarioId ? (
                                <div>
                                  <dt>Scenario</dt>
                                  <dd>
                                    <code>{item.scenarioId}</code>{' '}
                                    {item.scenarioVersion
                                      ? `(v${item.scenarioVersion})`
                                      : ''}
                                  </dd>
                                </div>
                              ) : null}
                              <div>
                                <dt>Issued</dt>
                                <dd>
                                  <time dateTime={item.createdAt}>
                                    {formatTime(item.createdAt)} UTC
                                  </time>
                                </dd>
                              </div>
                              <div>
                                <dt>Started</dt>
                                <dd>
                                  {item.activatedAt ? (
                                    <time dateTime={item.activatedAt}>
                                      {formatTime(item.activatedAt)} UTC
                                    </time>
                                  ) : (
                                    'Not recorded'
                                  )}
                                </dd>
                              </div>
                              <div>
                                <dt>Submitted</dt>
                                <dd>
                                  {item.submittedAt ? (
                                    <time dateTime={item.submittedAt}>
                                      {formatTime(item.submittedAt)} UTC
                                    </time>
                                  ) : item.status === 'SUBMITTED' ? (
                                    'Not recorded'
                                  ) : (
                                    'Not submitted'
                                  )}
                                </dd>
                              </div>
                              {item.candidateBearerAvailabilityStatus ===
                              'runtime_not_activated' ? (
                                <div>
                                  <dt>Candidate runtime:</dt>
                                  <dd>
                                    <span>Runtime not activated</span>
                                  </dd>
                                </div>
                              ) : null}
                            </dl>
                            {item.candidatePath ? (
                              <>
                                <a
                                  className="lifecycle-detail-link"
                                  href={item.candidatePath}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {item.status === 'SUBMITTED'
                                    ? 'Open submitted candidate session'
                                    : 'Open candidate session'}
                                </a>
                                <button
                                  className="lifecycle-detail-link lifecycle-copy-button"
                                  type="button"
                                  onClick={() =>
                                    void copyCandidateLink(
                                      item.candidatePath!,
                                      item.sessionId,
                                    )
                                  }
                                >
                                  {copyFeedback?.sessionId === item.sessionId &&
                                  copyFeedback.message ===
                                    'Candidate link copied.'
                                    ? 'Link copied'
                                    : 'Copy candidate link'}
                                </button>
                                {copyFeedback?.sessionId === item.sessionId ? (
                                  <p
                                    className="lifecycle-copy-feedback"
                                    role="status"
                                  >
                                    {copyFeedback.message}
                                  </p>
                                ) : null}
                              </>
                            ) : sessionSummaryHrefPrefix ? (
                              <>
                                <Link
                                  className="lifecycle-detail-link"
                                  href={`${sessionSummaryHrefPrefix}/${encodeURIComponent(item.sessionId)}`}
                                >
                                  Inspect authorized session summary
                                </Link>
                                {item.candidateBearerAvailabilityStatus ===
                                'runtime_not_activated' ? (
                                  <p
                                    className="candidate-bearer-notice"
                                    role="status"
                                  >
                                    Candidate runtime not activated
                                  </p>
                                ) : null}
                              </>
                            ) : item.candidateBearerAvailabilityStatus ===
                              'runtime_not_activated' ? (
                              <p
                                className="candidate-bearer-notice"
                                role="status"
                              >
                                Candidate runtime not activated
                              </p>
                            ) : (
                              <p>Candidate invitation link is unavailable.</p>
                            )}
                          </div>
                        </details>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {nextCursor ? (
                <div className="lifecycle-pagination">
                  <button
                    className="software-button software-button-secondary lifecycle-load-more-button"
                    type="button"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading more…' : 'Load more sessions'}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  );
};
