'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EvidenceCatalogEntry } from '../../../../src/reconstruction/evidence-reference-catalog';
import type { SubmittedStateSummary } from '../../../../src/evaluator/evaluator-briefing';
import type { TaskRubricSnapshot } from '../../../../src/assessments/task-rubric';
import { EvidenceItemCard } from './evidence-item-card';
import { SubmittedDiff } from './submitted-diff';
import './task-review.css';

type TaskRubric = TaskRubricSnapshot;
type CriterionAssessment = Readonly<{
  criterionId: string;
  status: 'scored' | 'not_applicable' | 'insufficient_evidence';
  score: number | null;
  reason: string;
  evidenceRefs: readonly string[];
}>;
type AssessmentScore = Readonly<{
  status:
    | 'pending'
    | 'available'
    | 'incomplete'
    | 'unavailable'
    | 'failed'
    | 'rubric_unavailable';
  rubric: TaskRubric | null;
  totalScore: number | null;
  applicableWeight: number | null;
  scoredWeight: number | null;
  providerId: string | null;
  model: string | null;
  analyzedAt: string | null;
  criteria: readonly CriterionAssessment[];
}>;
type ReportState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'error' }>
  | Readonly<{ kind: 'ready'; report: AssessmentScore }>;

const endpoint = (sessionId: string) =>
  `/api/evaluator/sessions/${encodeURIComponent(sessionId)}/assessment-score`;

const statusCopy: Record<AssessmentScore['status'], string> = {
  pending: 'Analysis has not been run for this submission.',
  available: 'All applicable criteria have enough linked evidence.',
  incomplete:
    'Some criteria could not be assessed from the available evidence. The total is withheld.',
  unavailable: 'Analysis is unavailable for this assessment.',
  failed:
    'Analysis could not be completed. The submitted work is still available.',
  rubric_unavailable:
    'This session has no saved task rubric, so no score can be produced.',
};

const isAssessmentScore = (value: unknown): value is AssessmentScore => {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<AssessmentScore>;
  const statuses: readonly AssessmentScore['status'][] = [
    'pending',
    'available',
    'incomplete',
    'unavailable',
    'failed',
    'rubric_unavailable',
  ];
  const validNumber = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === 'number' && Number.isFinite(candidate));
  const rubric = report.rubric;
  return (
    statuses.includes(report.status as AssessmentScore['status']) &&
    validNumber(report.totalScore) &&
    validNumber(report.applicableWeight) &&
    validNumber(report.scoredWeight) &&
    (report.providerId === null || typeof report.providerId === 'string') &&
    (report.model === null || typeof report.model === 'string') &&
    (report.analyzedAt === null || typeof report.analyzedAt === 'string') &&
    Array.isArray(report.criteria) &&
    report.criteria.every((candidate: unknown) => {
      if (!candidate || typeof candidate !== 'object') return false;
      const criterion = candidate as Partial<CriterionAssessment>;
      return (
        typeof criterion.criterionId === 'string' &&
        (criterion.status === 'scored' ||
          criterion.status === 'not_applicable' ||
          criterion.status === 'insufficient_evidence') &&
        validNumber(criterion.score) &&
        typeof criterion.reason === 'string' &&
        Array.isArray(criterion.evidenceRefs) &&
        criterion.evidenceRefs.every(
          (reference: unknown) => typeof reference === 'string',
        )
      );
    }) &&
    (rubric === null ||
      (typeof rubric === 'object' &&
        typeof rubric.version === 'string' &&
        Array.isArray(rubric.criteria) &&
        rubric.criteria.every(
          (criterion) =>
            typeof criterion.id === 'string' &&
            typeof criterion.label === 'string' &&
            typeof criterion.description === 'string' &&
            Number.isFinite(criterion.weight) &&
            typeof criterion.applicability?.rule === 'string' &&
            (criterion.applicability.kind === 'always' ||
              criterion.applicability.kind ===
                'recorded_integrated_ai_interaction'),
        )))
  );
};

const readAssessmentScore = async (
  response: Response,
): Promise<AssessmentScore> => {
  if (!response.ok) throw new Error('Assessment report unavailable.');
  const value: unknown = await response.json();
  if (!isAssessmentScore(value))
    throw new Error('Assessment report response was incomplete.');
  return value;
};

const criterionStatus = (status: CriterionAssessment['status']) => {
  if (status === 'scored') return 'Scored';
  if (status === 'not_applicable') return 'Not applicable';
  return 'Insufficient evidence';
};

const numberText = (value: number) =>
  new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value);

const sourceLabel = (entry: EvidenceCatalogEntry) => {
  if (entry.kind === 'final_diff') return 'Submitted changes';
  if (entry.kind === 'workspace_change') return 'Workspace change';
  if (entry.kind === 'command_execution') return 'Terminal activity';
  if (entry.kind === 'evidence_gap') return 'Capture limitation';
  if (entry.kind === 'ai_request_started') return 'Recorded AI request';
  if (entry.kind === 'ai_response_completed') return 'Recorded AI response';
  if (entry.kind === 'ai_request_cancelled') return 'Cancelled AI request';
  return 'Failed AI request';
};

const excerptBytes = (text: string) => new TextEncoder().encode(text).length;

export const TaskAssessmentReport = ({
  sessionId,
  evidenceEntries,
  submittedDiff,
  submittedState,
}: Readonly<{
  sessionId: string;
  evidenceEntries: readonly EvidenceCatalogEntry[];
  submittedDiff: string;
  submittedState: SubmittedStateSummary;
}>) => {
  const [state, setState] = useState<ReportState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [startRequested, setStartRequested] = useState(false);
  const [sourceRef, setSourceRef] = useState<string | null>(null);
  const [sourceCriterionId, setSourceCriterionId] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState('');
  const sourceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sourceHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const reportHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const evidenceByRef = useMemo(
    () =>
      new Map(
        evidenceEntries
          .filter((entry) => entry.sessionId === sessionId)
          .map((entry) => [entry.evidenceRef, entry]),
      ),
    [evidenceEntries, sessionId],
  );
  const load = useCallback(async () => {
    const response = await fetch(endpoint(sessionId), { cache: 'no-store' });
    const report = await readAssessmentScore(response);
    setState({ kind: 'ready', report });
    return report;
  }, [sessionId]);

  useEffect(() => {
    let active = true;
    void fetch(endpoint(sessionId), { cache: 'no-store' })
      .then(async (response) => {
        const report = await readAssessmentScore(response);
        if (active) setState({ kind: 'ready', report });
      })
      .catch(() => {
        if (active) setState({ kind: 'error' });
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  const refresh = async () => {
    setBusy(true);
    setNotice('');
    try {
      await load();
      setNotice('Analysis status refreshed.');
    } catch {
      setNotice('Analysis status could not be refreshed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const startAnalysis = async (retryFailed = false) => {
    if (startRequested && !retryFailed) return;
    setStartRequested(true);
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch(endpoint(sessionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(retryFailed ? { retryFailed: true } : {}),
      });
      const report = await readAssessmentScore(response);
      setState({ kind: 'ready', report });
      setNotice('Analysis request recorded.');
    } catch {
      try {
        const current = await load();
        if (current.status === 'pending') {
          setStartRequested(false);
          setNotice('No analysis result is recorded yet. You can try again.');
        } else {
          setNotice('The latest analysis status is shown below.');
        }
      } catch {
        setNotice(
          'The analysis request could not be confirmed. Refresh status before retrying.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const report = state.kind === 'ready' ? state.report : null;
  const rubric = report?.rubric;
  const selectedEntry = sourceRef ? evidenceByRef.get(sourceRef) : undefined;
  const hasAuthorizedSources =
    report?.criteria.some((criterion) =>
      criterion.evidenceRefs.some((reference) => evidenceByRef.has(reference)),
    ) ?? false;
  const selectedCriterion =
    sourceRef && sourceCriterionId
      ? report?.criteria.find(
          (criterion) =>
            criterion.criterionId === sourceCriterionId &&
            criterion.evidenceRefs.includes(sourceRef),
        )
      : undefined;
  const criteriaById = new Map(
    report?.criteria.map((criterion) => [criterion.criterionId, criterion]) ??
      [],
  );

  return (
    <section
      className="software-product task-assessment-report"
      aria-labelledby="task-assessment-title"
      id="task-report"
    >
      <header className="task-assessment-heading">
        <div>
          <p className="section-kicker">Submitted work · task criteria</p>
          <h2 id="task-assessment-title" ref={reportHeadingRef} tabIndex={-1}>
            How the task was handled
          </h2>
          <p>Task-specific evidence; interpretation remains yours.</p>
        </div>
      </header>

      {state.kind === 'loading' ? (
        <p className="task-report-state" role="status">
          Loading task analysis…
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <div className="task-report-state" role="alert">
          <p>
            The task analysis could not be loaded. Submitted work and reviewer
            notes remain available.
          </p>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Try again
          </button>
        </div>
      ) : null}
      {report ? (
        <>
          <div
            className={`task-report-state task-report-state-${report.status}`}
            role="status"
          >
            <div className="task-report-status-copy">
              <p>{statusCopy[report.status]}</p>
            </div>
            {report.status === 'unavailable' ? (
              <button
                className="button button-secondary task-report-inline-refresh"
                type="button"
                disabled={busy}
                onClick={() => void refresh()}
              >
                {busy ? 'Refreshing…' : 'Refresh'}
              </button>
            ) : null}
          </div>

          {report.status === 'pending' ? (
            <div className="task-report-actions">
              {!startRequested ? (
                <button
                  className="button button-primary"
                  type="button"
                  disabled={busy}
                  onClick={() => void startAnalysis()}
                >
                  {busy ? 'Starting analysis…' : 'Analyze submitted work'}
                </button>
              ) : null}
              <button
                className="button button-secondary"
                type="button"
                disabled={busy}
                onClick={() => void refresh()}
              >
                Refresh status
              </button>
            </div>
          ) : null}
          {report.status === 'failed' ? (
            <div className="task-report-actions">
              <button
                className="button button-primary"
                type="button"
                disabled={busy}
                onClick={() => void startAnalysis(true)}
              >
                {busy ? 'Retrying analysis…' : 'Retry analysis'}
              </button>
            </div>
          ) : null}

          <div
            className={`task-report-grid${selectedEntry ? ' task-report-grid-sources' : ''}`}
          >
            <section
              className="task-report-results"
              aria-labelledby="task-criteria-title"
            >
              {report.status === 'available' && report.totalScore !== null ? (
                <div
                  className="task-total"
                  aria-label={`Task score ${numberText(report.totalScore)} out of 100`}
                >
                  <span>Overall task score</span>
                  <strong>
                    {numberText(report.totalScore)} <small>/ 100</small>
                  </strong>
                </div>
              ) : null}
              <div className="task-report-results-heading">
                <h3 id="task-criteria-title">Requirement checks</h3>
              </div>

              {rubric?.criteria.length ? (
                <ol className="task-criterion-list">
                  {rubric.criteria.map((criterion) => {
                    const assessment = criteriaById.get(criterion.id);
                    const authorizedRefs =
                      assessment?.evidenceRefs.filter((reference) =>
                        evidenceByRef.has(reference),
                      ) ?? [];
                    const sourceSelected = sourceCriterionId === criterion.id;
                    return (
                      <li
                        key={criterion.id}
                        className={`task-criterion${sourceSelected ? ' task-criterion-source-selected' : ''}`}
                      >
                        <div className="task-criterion-main">
                          <div className="task-criterion-description">
                            <h4>{criterion.label}</h4>
                            <p>{assessment?.reason ?? criterion.description}</p>
                          </div>
                          <div className="task-criterion-rating">
                            {assessment?.status === 'scored' &&
                            assessment.score !== null ? (
                              <strong>
                                {numberText(assessment.score)}{' '}
                                <small>/ 100</small>
                              </strong>
                            ) : (
                              <span
                                className={`task-criterion-state${assessment?.status === 'insufficient_evidence' ? ' task-criterion-state-limited' : ''}`}
                              >
                                {assessment
                                  ? criterionStatus(assessment.status)
                                  : report.status === 'pending'
                                    ? 'Not assessed yet'
                                    : 'Not assessed'}
                              </span>
                            )}
                            <span className="task-criterion-weight">
                              {numberText(criterion.weight)}% weight
                            </span>
                          </div>
                          <div
                            className="task-criterion-sources"
                            aria-label={`Sources for ${criterion.label}`}
                          >
                            {authorizedRefs.length ? (
                              authorizedRefs.map((reference, index) => {
                                const entry = evidenceByRef.get(reference)!;
                                return (
                                  <button
                                    type="button"
                                    className="task-evidence-link"
                                    key={reference}
                                    aria-pressed={
                                      sourceCriterionId === criterion.id &&
                                      sourceRef === reference
                                    }
                                    aria-controls="task-evidence-detail"
                                    onClick={(event) => {
                                      sourceTriggerRef.current =
                                        event.currentTarget;
                                      setSourceRef(reference);
                                      setSourceCriterionId(criterion.id);
                                      requestAnimationFrame(() =>
                                        sourceHeadingRef.current?.focus(),
                                      );
                                    }}
                                  >
                                    {sourceLabel(entry)} {index + 1}
                                  </button>
                                );
                              })
                            ) : assessment?.status === 'scored' ? (
                              <span className="task-evidence-empty">
                                No linked source
                              </span>
                            ) : null}
                          </div>
                        </div>
                        {assessment ? (
                          <>
                            {assessment.evidenceRefs.some(
                              (reference) => !evidenceByRef.has(reference),
                            ) ? (
                              <p className="task-source-limitation">
                                A referenced source is unavailable in this
                                authorized session record.
                              </p>
                            ) : null}
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              ) : report.status === 'rubric_unavailable' || !rubric ? (
                <p className="task-report-empty">
                  This session has no saved task rubric. No criteria or score
                  are available.
                </p>
              ) : (
                <p className="task-report-empty">
                  This task has no criteria to display.
                </p>
              )}
            </section>

            {hasAuthorizedSources || selectedEntry ? (
              <section
                className="task-evidence-inspector"
                hidden={!selectedEntry}
                aria-labelledby="task-evidence-title"
                id="task-evidence-detail"
              >
                <div className="task-evidence-inspector-heading">
                  <div>
                    <p className="section-kicker">Source record</p>
                    <h3
                      id="task-evidence-title"
                      ref={sourceHeadingRef}
                      tabIndex={-1}
                    >
                      {selectedEntry
                        ? sourceLabel(selectedEntry)
                        : 'Requirement checks'}
                    </h3>
                    {selectedCriterion ? (
                      <p>
                        Linked to{' '}
                        {
                          rubric?.criteria.find(
                            (item) => item.id === selectedCriterion.criterionId,
                          )?.label
                        }
                        .
                      </p>
                    ) : null}
                    {selectedEntry?.kind === 'final_diff' ? (
                      <p>Entire submitted diff</p>
                    ) : null}
                    {selectedEntry?.kind === 'workspace_change' &&
                    selectedEntry.item?.kind === 'WORKSPACE_CHANGE' ? (
                      <p>
                        {selectedEntry.item.files
                          .map((file) => file.path)
                          .join(' · ')}
                      </p>
                    ) : null}
                  </div>
                  {selectedEntry ? (
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={() => {
                        setSourceRef(null);
                        setSourceCriterionId(null);
                        requestAnimationFrame(() => {
                          if (sourceTriggerRef.current?.isConnected)
                            sourceTriggerRef.current.focus();
                          else reportHeadingRef.current?.focus();
                        });
                      }}
                    >
                      Close source
                    </button>
                  ) : null}
                </div>
                {selectedEntry?.kind === 'final_diff' ? (
                  <>
                    <p className="task-source-limitation">
                      The submitted diff records code changes. Test outcomes are
                      shown only when they were recorded separately.
                    </p>
                    <div className="submitted-diff-container">
                      <SubmittedDiff diff={submittedDiff} />
                    </div>
                  </>
                ) : selectedEntry?.item?.kind === 'AI_REQUEST_STARTED' ? (
                  <>
                    <div className="task-ai-source-meta">
                      <span>Recorded request</span>
                      <span>
                        {selectedEntry.item.candidateInputBytes.toLocaleString()}{' '}
                        bytes
                      </span>
                    </div>
                    <pre
                      className="task-ai-source-excerpt"
                      tabIndex={0}
                      aria-label="Recorded AI prompt excerpt"
                    >
                      {selectedEntry.item.candidateInputExcerpt}
                    </pre>
                    {excerptBytes(selectedEntry.item.candidateInputExcerpt) <
                    selectedEntry.item.candidateInputBytes ? (
                      <p className="task-source-limitation">
                        The recorded prompt excerpt is partial.
                      </p>
                    ) : null}
                  </>
                ) : selectedEntry?.item?.kind === 'AI_RESPONSE_COMPLETED' ? (
                  <>
                    <div className="task-ai-source-meta">
                      <span>Recorded response</span>
                      <span>
                        {selectedEntry.item.responseBytes.toLocaleString()}{' '}
                        bytes
                      </span>
                    </div>
                    <pre
                      className="task-ai-source-excerpt"
                      tabIndex={0}
                      aria-label="Recorded AI response excerpt"
                    >
                      {selectedEntry.item.responseExcerpt}
                    </pre>
                    {excerptBytes(selectedEntry.item.responseExcerpt) <
                    selectedEntry.item.responseBytes ? (
                      <p className="task-source-limitation">
                        The recorded response excerpt is partial.
                      </p>
                    ) : null}
                  </>
                ) : selectedEntry?.item?.kind === 'AI_REQUEST_CANCELLED' ? (
                  <p className="task-source-copy">
                    Request cancelled: {selectedEntry.item.cancelReason}
                  </p>
                ) : selectedEntry?.item?.kind === 'AI_REQUEST_FAILED' ? (
                  <p className="task-source-copy">
                    Request failed:{' '}
                    {selectedEntry.item.errorMessageExcerpt ||
                      selectedEntry.item.failureReason}
                  </p>
                ) : selectedEntry?.item ? (
                  <EvidenceItemCard
                    item={selectedEntry.item}
                    showConfiguredModel={false}
                    showTechnicalDetails={false}
                  />
                ) : selectedEntry ? (
                  <p className="task-report-empty">
                    This source is not available in the authorized submitted
                    record.
                  </p>
                ) : (
                  <p className="task-source-empty">
                    Choose a linked source to inspect recorded evidence.
                  </p>
                )}
              </section>
            ) : (
              <p className="task-report-source-note">
                No assessment-linked sources are available yet. Recorded session
                activity remains available in the evidence timeline.
              </p>
            )}
            {hasAuthorizedSources && !selectedEntry ? (
              <p className="task-report-source-note">
                Select a linked source to inspect the recorded evidence.
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {notice ? (
        <p className="task-report-status" role="status">
          {notice}
        </p>
      ) : null}
      <div className="task-report-disclosures">
        {rubric ? (
          <details className="task-rubric-version">
            <summary>Analysis details and rubric guidance</summary>
            <p>
              Rubric version {rubric.version}. Task scope only; test results and
              evaluator judgment remain separate.
            </p>
            {(report?.status === 'available' ||
              report?.status === 'incomplete') &&
            report.scoredWeight !== null &&
            report.applicableWeight !== null ? (
              <p>
                Evidence supports {numberText(report.scoredWeight)} of{' '}
                {numberText(report.applicableWeight)} applicable rubric weight.
                Not-applicable criteria are excluded.
              </p>
            ) : null}
            {report?.analyzedAt ? (
              <p>Updated {new Date(report.analyzedAt).toLocaleString()}.</p>
            ) : null}
            <ol>
              {rubric.criteria.map((criterion) => (
                <li key={criterion.id}>
                  <strong>{criterion.label}</strong> ·{' '}
                  {numberText(criterion.weight)}% weight
                  <p>{criterion.description}</p>
                  <p>{criterion.applicability.rule}</p>
                  {criteriaById.get(criterion.id) ? (
                    <p>
                      Assessment detail:{' '}
                      {criteriaById.get(criterion.id)?.reason}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
        <details className="task-submitted-context">
          <summary>Submitted scope</summary>
          <p>{submittedState.text}</p>
          {submittedState.changedPaths.length ? (
            <ul>
              {submittedState.changedPaths.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {evidenceEntries.some(
            (entry) =>
              entry.sessionId === sessionId && entry.kind === 'evidence_gap',
          ) ? (
            <p>
              The session record includes capture limitations. Review the linked
              source records where available; absence of a record does not
              establish that an action did not occur.
            </p>
          ) : null}
        </details>
      </div>
    </section>
  );
};
