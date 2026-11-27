'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import {
  IconArrowRight,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCode,
  IconCopy,
  IconFile,
  IconListDetails,
  IconMessages,
  IconTerminal2,
  IconTestPipe,
} from '@tabler/icons-react';
import type {
  BriefingDepthProfile,
  ProjectedBriefing,
} from '../../../../src/evaluator/project-evaluator-briefing';
import {
  formatElapsed,
  type EvaluatorReviewEvidence,
  type EvaluatorReviewPresentation,
} from '../../../../src/evaluator/evaluator-review-presentation';
import type { EvaluatorAiConversation } from '../../../../src/evaluator/evaluator-ai-conversations';
import type { R27Evidence } from '../../../../../../database/postgres/r27/contract.mjs';
import {
  buildR27Presentation,
  type R27Presentation,
} from '../../../../src/r27-evidence/presentation';
import type { R27AiReviewReport } from '../../../../src/r27-evidence/ai-review-contract';
import { experienceLevelLabel } from '../../../../src/hiring/catalogs';
import type { SessionHiringReviewContext } from '../../../../src/hiring/types';
import { hasPlanFeature } from '../../../../src/plans/entitlements';
import {
  readPersistedJson,
  removePersistedKey,
  writePersistedJson,
} from '../../../../src/ui/browser-state';
import { ScenarioBrief } from '../../../../src/ui/scenario-brief';
import { R27AiReviewPanel } from './ai-review-panel';
import {
  HiringDecisionPanel,
  hiringDecisionDraftKey,
  initialHiringDecisionDraft,
  restoreHiringDecisionDraft,
  type HiringDecisionDraft,
} from './hiring-decision-panel';
import { computeDiffStats } from './code-diff-viewer';
import { ArtifactAvailabilityCard } from './artifact-availability-card';
import { CompactAiSummary } from './compact-ai-summary';
import {
  buildEvidenceSources,
  buildR27EvidenceSources,
  evidenceFilters,
  EvidenceSourceInspector,
  formatEvidenceTime,
  preferredEvidenceSource,
  sourcesForFilter,
  verificationLabel,
  R210ReviewPacketPanel,
  type EvidenceFilter,
  type EvidenceSource,
} from './evidence-workbench';
import { r210IsEnabled } from '../../../../src/r210-review-packets/config';
import { EvaluatorHeader } from './evaluator-header';
import { PlatformNotice } from './platform-notice';
import { ReviewGuidance } from './review-guidance';
import { ReviewWorkflowPanel } from './review-workflow-panel';
import { TaskAssessmentReport } from './task-assessment-report';
import { TaskBrief } from './task-brief';
import './task-review.css';
import './desktop-review.css';

const modes = ['Summary', 'Evidence', 'Review'] as const;
type WorkbenchMode = (typeof modes)[number];
const emptyAiConversations: readonly EvaluatorAiConversation[] = [];

const reviewDeskDesktopQuery = '(min-width: 64rem)';

function subscribeReviewDeskDesktop(onChange: () => void) {
  const query = window.matchMedia(reviewDeskDesktopQuery);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

const modeId = (mode: WorkbenchMode) => `workbench-mode-${mode.toLowerCase()}`;
const modePanelId = 'evidence-workbench-panel';

const filterId = (filter: EvidenceFilter) =>
  `evidence-filter-${filter.toLowerCase().replaceAll(' ', '-')}`;

const iconForFilter = (filter: EvidenceFilter) => {
  if (filter === 'Code changes')
    return <IconCode size={17} aria-hidden="true" />;
  if (filter === 'Tests') return <IconTestPipe size={17} aria-hidden="true" />;
  if (filter === 'Terminal' || filter === 'Execution runs')
    return <IconTerminal2 size={17} aria-hidden="true" />;
  if (filter === 'AI conversations')
    return <IconMessages size={17} aria-hidden="true" />;
  return <IconListDetails size={17} aria-hidden="true" />;
};

const sourceLabel = (source: EvidenceSource) =>
  source.r27?.kind === 'event'
    ? 'Session chronology'
    : source.r27?.kind === 'file'
      ? 'Submitted file'
      : source.conversation
        ? 'AI conversation'
        : source.r27?.kind === 'execution' || Boolean(source.execution)
          ? 'Execution run'
          : source.verificationRun
            ? 'Test run'
            : source.entry?.kind === 'command_execution'
              ? 'Terminal capture'
              : source.entry?.kind === 'workspace_change' ||
                  source.entry?.kind === 'evidence_gap' ||
                  source.entry?.kind === 'final_diff'
                ? 'Code changes'
                : 'Session chronology';

const sourceTime = (source: EvidenceSource, activatedAt: string | null) =>
  formatEvidenceTime(source, activatedAt);

const SourceRow = ({
  source,
  activatedAt,
  selected,
  onSelect,
  register,
}: Readonly<{
  source: EvidenceSource;
  activatedAt: string | null;
  selected: boolean;
  onSelect: (source: EvidenceSource) => void;
  register: (key: string, element: HTMLButtonElement | null) => void;
}>) => (
  <li>
    <button
      ref={(element) => register(source.key, element)}
      className="evaluator-source-row"
      data-file={source.r27?.kind === 'file' || undefined}
      type="button"
      data-source-ref={source.evidenceRef ?? source.key}
      aria-pressed={selected}
      onClick={() => onSelect(source)}
    >
      <span className="evaluator-source-row-mark" aria-hidden="true" />
      <span className="evaluator-source-row-copy">
        <strong>
          {source.r27?.kind === 'file' ? source.r27.file.path : source.title}
        </strong>
        {source.r27?.kind === 'file' ? null : (
          <>
            <span>{source.summary}</span>
            <small>
              {sourceLabel(source)} · {sourceTime(source, activatedAt)}
            </small>
          </>
        )}
      </span>
    </button>
  </li>
);

const VerificationProgression = ({
  projection,
}: Readonly<{ projection: ProjectedBriefing }>) => {
  const runs = projection.briefing.recordedVerification.runs;
  return (
    <section
      className="evaluator-review-card workbench-verification"
      aria-labelledby="workbench-verification-title"
    >
      <header className="evaluator-review-section-heading">
        <span className="evaluator-review-title-icon" aria-hidden="true">
          <IconTestPipe size={21} stroke={1.8} />
        </span>
        <div>
          <p className="section-kicker">Captured executions</p>
          <h2 id="workbench-verification-title">Verification progression</h2>
        </div>
        <span>{runs.length} recorded</span>
      </header>
      <p className="evaluator-muted-copy">
        Execution outcomes describe only what was captured. They do not
        establish overall correctness or candidate competence.
      </p>
      {runs.length ? (
        <ol className="workbench-verification-list">
          {runs.map((run, index) => (
            <li key={run.id}>
              <div>
                <strong>
                  {runs.length > 1
                    ? index === 0
                      ? 'Earlier recorded run'
                      : 'Later recorded run'
                    : 'Recorded run'}
                </strong>
                <span>{verificationLabel(run)}</span>
              </div>
              <p>
                {run.result?.text ?? 'The recorded outcome is unavailable.'}
              </p>
              {run.laterWorkspaceEdits ? (
                <small>Later workspace changes were recorded.</small>
              ) : null}
              {run.laterCaptureGaps ? (
                <small>Later capture gaps were recorded.</small>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="evaluator-muted-copy">
          No recognized test executions are available. This does not establish
          that no verification occurred.
        </p>
      )}
    </section>
  );
};

const CoverageSummary = ({
  review,
  projection,
  conversations,
}: Readonly<{
  review: EvaluatorReviewPresentation;
  projection: ProjectedBriefing;
  conversations: readonly EvaluatorAiConversation[];
}>) => {
  const entries = review.evidenceEntries;
  const count = (kind: string) =>
    entries.filter((entry) => entry.kind === kind).length;
  const values = [
    ['Workspace records', count('workspace_change')],
    ['Capture gaps', count('evidence_gap')],
    ['Terminal captures', count('command_execution')],
    ['Test runs', projection.briefing.recordedVerification.runs.length],
    ['AI interactions', conversations.length],
  ] as const;
  return (
    <section
      className="evaluator-review-card workbench-coverage"
      aria-labelledby="workbench-coverage-title"
    >
      <header className="evaluator-review-section-heading">
        <span className="evaluator-review-title-icon" aria-hidden="true">
          <IconListDetails size={21} stroke={1.8} />
        </span>
        <div>
          <p className="section-kicker">Available session records</p>
          <h2 id="workbench-coverage-title">Evidence coverage</h2>
        </div>
      </header>
      <dl className="workbench-coverage-grid">
        {values.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="evaluator-muted-copy">
        Counts describe records available to this review, not the amount or
        quality of work completed.
      </p>
    </section>
  );
};

const R27SummaryView = ({
  evidence,
  presentation,
  sources,
  hiring = false,
  onOpenEvidence,
  onLoadMore,
  loadingMore,
  pageError,
  workflowSignalsOpen = false,
  onWorkflowSignalsToggle,
  verificationQuestionsOpen = false,
  onVerificationQuestionsToggle,
}: Readonly<{
  evidence: R27Evidence;
  presentation: R27Presentation;
  sources: readonly EvidenceSource[];
  hiring?: boolean;
  onOpenEvidence: (filter?: EvidenceFilter, source?: EvidenceSource) => void;
  onLoadMore: () => void;
  loadingMore: boolean;
  pageError: string | null;
  workflowSignalsOpen?: boolean;
  onWorkflowSignalsToggle?: (open: boolean) => void;
  verificationQuestionsOpen?: boolean;
  onVerificationQuestionsToggle?: (open: boolean) => void;
}>) => {
  const {
    termsPatternObservation,
    workflowSignals,
    liveVerificationQuestions,
  } = presentation;
  const [questionsCopied, setQuestionsCopied] = useState(false);

  const handleCopyVerificationQuestions = async () => {
    if (!liveVerificationQuestions.length) return;
    const text = liveVerificationQuestions
      .map((item, idx) => `${idx + 1}. ${item.question} (${item.focus})`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setQuestionsCopied(true);
      window.setTimeout(() => setQuestionsCopied(false), 2000);
    } catch {
      setQuestionsCopied(false);
    }
  };
  const fileSources = [...sources]
    .filter((source) => source.r27?.kind === 'file')
    .sort((left, right) => {
      const leftFile = left.r27?.kind === 'file' ? left.r27.file : null;
      const rightFile = right.r27?.kind === 'file' ? right.r27.file : null;
      const leftModified =
        leftFile !== null &&
        leftFile.starterContent !== leftFile.submittedContent;
      const rightModified =
        rightFile !== null &&
        rightFile.starterContent !== rightFile.submittedContent;
      if (leftModified !== rightModified) return leftModified ? -1 : 1;
      return left.title.localeCompare(right.title);
    });
  const eventSources = sources.filter((source) => source.r27?.kind === 'event');
  const conversationSources = sources.filter(
    (source) =>
      source.r27?.kind === 'conversation' || source.kind === 'conversation',
  );
  const executionSources = sources.filter(
    (source) => source.r27?.kind === 'execution' || Boolean(source.execution),
  );
  const duration =
    formatElapsed(evidence.activatedAt, evidence.submittedAt)?.slice(1) ??
    'Unavailable';

  const brief = presentation.scenarioContext.brief;
  const briefLead = brief
    ?.split(/\r?\n[ \t]*\r?\n/)
    .find((part) => part.trim() && !/^\s*(?:#|`{3}|[-*]\s|\d+\.\s)/.test(part));
  const ReferenceGroup = hiring ? 'details' : 'div';

  const scenarioSnapshot = (
    <details
      className="evaluator-source-details"
      style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}
    >
      <summary>Open immutable scenario snapshot</summary>
      <p style={{ overflowWrap: 'anywhere' }}>Scenario snapshot digest:</p>
      <code className="evaluator-integrity-digest">
        {evidence.scenario.snapshotDigest}
      </code>
      <pre
        tabIndex={0}
        aria-label="Immutable versioned scenario snapshot"
        style={{
          minWidth: 0,
          width: '100%',
          maxWidth: '100%',
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {evidence.scenario.snapshotText}
      </pre>
    </details>
  );

  const timeline = (
    <section
      className="evaluator-review-card workbench-session-timeline review-desk-activity"
      aria-labelledby="r27-timeline-title"
    >
      <header className="evaluator-review-section-heading">
        <h2 id="r27-timeline-title">{hiring ? 'Activity' : 'Timeline'}</h2>
        <div className="evaluator-timeline-head-actions">
          {hiring ? null : <span>{eventSources.length} events</span>}
          {hiring && eventSources.length > 0 ? (
            <button
              type="button"
              className="evaluator-text-link"
              onClick={() => onOpenEvidence('Chronology', eventSources[0])}
            >
              Open event log <IconArrowRight size={15} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>
      {eventSources.length ? (
        <ol className="workbench-progression-list">
          {eventSources.map((source) => {
            const event =
              source.r27?.kind === 'event' ? source.r27.event : null;
            if (!event) return null;
            return (
              <li key={source.key}>
                <time dateTime={event.timestamp} title={event.timestamp}>
                  {formatEvidenceTime(source, evidence.activatedAt)}
                </time>
                {hiring ? (
                  <button
                    type="button"
                    className="review-desk-event"
                    onClick={() => onOpenEvidence('Chronology', source)}
                  >
                    <span>{source.title}</span>
                    <IconArrowRight size={16} aria-hidden="true" />
                  </button>
                ) : (
                  <div>
                    <p className="workbench-timeline-title">
                      <code>#{event.sequence}</code> {source.title}
                    </p>
                    <small className="workbench-timeline-subtitle">
                      {source.summary}
                    </small>
                    <button
                      type="button"
                      className="evaluator-text-link"
                      onClick={() => onOpenEvidence('Chronology', source)}
                    >
                      View event →
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="evaluator-muted-copy">No recorded events.</p>
      )}
      {pageError ? <p role="alert">{pageError}</p> : null}
      {evidence.pagination.nextAfterSequence !== null ? (
        <button type="button" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading events…' : 'Load more recorded events'}
        </button>
      ) : null}
    </section>
  );

  const totalDiff = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    let modified = 0;
    for (const file of presentation.files) {
      const stats = computeDiffStats(file.diff);
      additions += stats.additions;
      deletions += stats.deletions;
      if (
        file.starterContent !== file.submittedContent ||
        stats.additions > 0 ||
        stats.deletions > 0
      ) {
        modified += 1;
      }
    }
    return { additions, deletions, modified };
  }, [presentation.files]);

  const saveCheckpointsCount = useMemo(
    () =>
      evidence.events.filter((event) => event.type === 'WORKSPACE_CHANGED')
        .length,
    [evidence.events],
  );

  return (
    <div className="workbench-summary-grid">
      <div className="workbench-summary-content">
        {hiring ? (
          <section
            className="review-desk-metrics-strip"
            aria-label="Session overview"
          >
            <div>
              <span>Duration</span>
              <strong>{duration}</strong>
            </div>
            <div>
              <span>Files changed</span>
              <strong>
                {totalDiff.modified} / {presentation.files.length}
                {totalDiff.additions > 0 || totalDiff.deletions > 0 ? (
                  <small>
                    +{totalDiff.additions} / -{totalDiff.deletions}
                  </small>
                ) : null}
              </strong>
            </div>
            <div>
              <span>Checkpoints</span>
              <strong>{saveCheckpointsCount}</strong>
            </div>
            <div>
              <span>Tests &amp; AI</span>
              <strong>
                {executionSources.length} runs · {conversationSources.length} AI
              </strong>
            </div>
          </section>
        ) : (
          timeline
        )}

        <section
          className="evaluator-review-card review-desk-brief"
          aria-labelledby="r27-snapshot-title"
        >
          <header className="evaluator-review-section-heading">
            {!hiring ? (
              <span className="evaluator-review-title-icon" aria-hidden="true">
                <IconFile size={21} stroke={1.8} />
              </span>
            ) : null}
            <h2 id="r27-snapshot-title">
              {hiring ? 'Task brief' : 'Task context'}
            </h2>
          </header>
          {hiring && briefLead ? (
            <div className="review-desk-brief-lead">
              <ScenarioBrief markdown={briefLead} />
            </div>
          ) : null}
          {hiring ? (
            <details className="evaluator-source-details review-desk-criteria">
              <summary>Acceptance criteria</summary>
              {presentation.scenarioContext.acceptanceCriteria.length ? (
                <ul>
                  {presentation.scenarioContext.acceptanceCriteria.map(
                    (criterion, index) => (
                      <li key={index}>{criterion}</li>
                    ),
                  )}
                </ul>
              ) : (
                <p className="evaluator-muted-copy">
                  Criteria are unavailable in this snapshot.
                </p>
              )}
            </details>
          ) : null}
          {termsPatternObservation ? (
            hiring ? (
              <details className="evaluator-source-details">
                <summary>Automated Python pattern notes</summary>
                <ul>
                  <li>
                    <code>snake_case</code> identifier{' '}
                    {termsPatternObservation.snakeCaseIdentifierFound
                      ? 'was observed'
                      : 'was not observed'}
                    .
                  </li>
                  <li>
                    Nested object return{' '}
                    {termsPatternObservation.nestedObjectReturnFound
                      ? 'was observed'
                      : 'was not observed'}
                    .
                  </li>
                </ul>
              </details>
            ) : (
              <section
                className="evaluator-source-details"
                aria-labelledby="r27-terms-pattern-title"
              >
                <h3 id="r27-terms-pattern-title">
                  Coding patterns in added Python lines
                </h3>
                <ul>
                  <li>
                    <code>snake_case</code> identifier{' '}
                    {termsPatternObservation.snakeCaseIdentifierFound
                      ? 'was observed'
                      : 'was not observed'}
                    .
                  </li>
                  <li>
                    Nested object return{' '}
                    {termsPatternObservation.nestedObjectReturnFound
                      ? 'was observed'
                      : 'was not observed'}
                    .
                  </li>
                </ul>
                <p className="evaluator-muted-copy">
                  These observations cannot establish external AI use,
                  authorship, intent, or competence.
                </p>
              </section>
            )
          ) : null}
          {workflowSignals.length > 0 ? (
            <details
              className="evaluator-source-details"
              data-testid="r27-workflow-signals"
              open={workflowSignalsOpen}
              onToggle={(event) => {
                onWorkflowSignalsToggle?.(event.currentTarget.open);
              }}
            >
              <summary>
                Recorded workflow signals ({workflowSignals.length})
              </summary>
              <ul>
                {workflowSignals.map((signal) => (
                  <li key={signal.id}>
                    <strong>{signal.label}:</strong> {signal.detail}
                  </li>
                ))}
              </ul>
              <p className="evaluator-muted-copy">
                Observable session facts only — they do not establish external
                AI use, authorship, or competence.
              </p>
            </details>
          ) : null}
          {liveVerificationQuestions.length > 0 ? (
            <details
              className="evaluator-source-details"
              data-testid="r27-verification-questions"
              open={verificationQuestionsOpen}
              onToggle={(event) => {
                onVerificationQuestionsToggle?.(event.currentTarget.open);
              }}
            >
              <summary>
                Live verification questions ({liveVerificationQuestions.length})
              </summary>
              <ol className="hiring-ol-list">
                {liveVerificationQuestions.map((item, index) => (
                  <li key={`${index}:${item.question}`}>
                    <span>{item.question}</span>{' '}
                    <span className="evaluator-muted-copy">({item.focus})</span>
                  </li>
                ))}
              </ol>
              <div className="hiring-header-actions hiring-mt-xs">
                <button
                  type="button"
                  className="hiring-btn hiring-btn-sm"
                  onClick={() => void handleCopyVerificationQuestions()}
                >
                  {questionsCopied ? (
                    <IconCheck size={14} aria-hidden="true" />
                  ) : (
                    <IconCopy size={14} aria-hidden="true" />
                  )}
                  {questionsCopied ? 'Copied' : 'Copy questions'}
                </button>
              </div>
            </details>
          ) : null}
          <details className="evaluator-source-details">
            <summary>
              {hiring
                ? 'Full task brief'
                : 'Read task brief and acceptance criteria'}
            </summary>
            <ScenarioBrief
              markdown={
                presentation.scenarioContext.brief ??
                'Scenario brief unavailable in this snapshot.'
              }
            />
            {hiring ? null : (
              <>
                <h3>Acceptance criteria</h3>
                {presentation.scenarioContext.acceptanceCriteria.length ? (
                  <ul>
                    {presentation.scenarioContext.acceptanceCriteria.map(
                      (criterion, index) => (
                        <li key={`${index}:${criterion}`}>{criterion}</li>
                      ),
                    )}
                  </ul>
                ) : (
                  <p className="evaluator-muted-copy">
                    Acceptance criteria unavailable in this snapshot.
                  </p>
                )}
              </>
            )}
          </details>
          {hiring ? null : scenarioSnapshot}
        </section>

        {hiring ? timeline : null}

        <ReferenceGroup
          className={
            hiring
              ? 'evaluator-source-details review-desk-reference-group'
              : 'review-desk-legacy-sections'
          }
        >
          {hiring ? <summary>Source records and digests</summary> : null}
          {hiring ? scenarioSnapshot : null}
          <section
            className="evaluator-review-card"
            aria-labelledby="r27-files-title"
          >
            <header className="evaluator-review-section-heading">
              <span className="evaluator-review-title-icon" aria-hidden="true">
                <IconCode size={21} stroke={1.8} />
              </span>
              <div>
                <p className="section-kicker">Starter and frozen submission</p>
                <h2 id="r27-files-title">File contents and derived diffs</h2>
              </div>
              <span>{presentation.files.length} file paths</span>
            </header>
            {fileSources.length ? (
              <ul className="evaluator-submitted-file-list">
                {fileSources.map((source) => {
                  const file =
                    source.r27?.kind === 'file' ? source.r27.file : null;
                  const stats = file
                    ? computeDiffStats(file.diff)
                    : { additions: 0, deletions: 0 };
                  const changed =
                    file !== null &&
                    (file.starterContent !== file.submittedContent ||
                      stats.additions > 0 ||
                      stats.deletions > 0);
                  return (
                    <li key={source.key}>
                      <div className="evaluator-submitted-file-meta">
                        <code>{file ? file.path : source.key}</code>
                        {file ? (
                          changed ? (
                            <span className="evaluator-file-diff-stats">
                              {stats.additions > 0 ? (
                                <span className="code-diff-stat-add">
                                  +{stats.additions}
                                </span>
                              ) : null}
                              {stats.deletions > 0 ? (
                                <span className="code-diff-stat-del">
                                  -{stats.deletions}
                                </span>
                              ) : null}
                              {stats.additions === 0 &&
                              stats.deletions === 0 ? (
                                <span className="code-diff-stat-neutral">
                                  Modified
                                </span>
                              ) : null}
                            </span>
                          ) : (
                            <span className="code-diff-stat-neutral">
                              Unchanged
                            </span>
                          )
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="evaluator-text-link"
                        onClick={() => onOpenEvidence('Code changes', source)}
                      >
                        Open contents and derived diff →
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="evaluator-muted-copy">
                No file paths are present in the authorized starter or submitted
                state.
              </p>
            )}
            {presentation.revisionMetadata.length ? (
              <details className="evaluator-source-details">
                <summary>Intermediate revision metadata only</summary>
                <p>
                  Save history includes version and digest metadata.
                  Intermediate file contents are unavailable.
                </p>
                <ul>
                  {presentation.revisionMetadata.map((revision, index) => (
                    <li key={`${revision.path}:${revision.version}:${index}`}>
                      <span style={{ overflowWrap: 'anywhere' }}>
                        <code>{revision.path}</code> · version{' '}
                        <code>{revision.version}</code> · digest{' '}
                        <code>{revision.digest}</code>
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>

          {conversationSources.length ? (
            <section
              className="evaluator-review-card"
              aria-labelledby="r27-ai-conversations-title"
            >
              <header className="evaluator-review-section-heading">
                <span
                  className="evaluator-review-title-icon"
                  aria-hidden="true"
                >
                  <IconMessages size={21} stroke={1.8} />
                </span>
                <div>
                  <p className="section-kicker">Candidate AI assistance</p>
                  <h2 id="r27-ai-conversations-title">
                    Recorded AI conversations
                  </h2>
                </div>
                <span>{conversationSources.length} recorded</span>
              </header>
              <ol className="workbench-progression-list">
                {conversationSources.map((source) => (
                  <li key={source.key}>
                    <time dateTime={source.timestamp ?? undefined}>
                      {source.timestamp ?? 'Recorded'}
                    </time>
                    <div>
                      <p>
                        {source.title} · {source.summary}
                      </p>
                      <button
                        type="button"
                        className="evaluator-text-link"
                        onClick={() =>
                          onOpenEvidence('AI conversations', source)
                        }
                      >
                        Inspect AI conversation →
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {executionSources.length ? (
            <section
              className="evaluator-review-card"
              aria-labelledby="r213-execution-runs-title"
              data-testid="summary-execution-runs-card"
            >
              <header className="evaluator-review-section-heading">
                <span
                  className="evaluator-review-title-icon"
                  aria-hidden="true"
                >
                  <IconTerminal2 size={21} stroke={1.8} />
                </span>
                <div>
                  <p className="section-kicker">Automated Verification</p>
                  <h2 id="r213-execution-runs-title">
                    Recorded execution runs
                  </h2>
                </div>
                <span data-testid="summary-execution-runs-count">
                  {executionSources.length} recorded
                </span>
              </header>
              <ol className="workbench-progression-list">
                {executionSources.map((source) => (
                  <li key={source.key}>
                    <time dateTime={source.timestamp ?? undefined}>
                      {source.timestamp ?? 'Recorded'}
                    </time>
                    <div>
                      <p>
                        {source.title} · {source.summary}
                      </p>
                      <button
                        type="button"
                        className="evaluator-text-link"
                        onClick={() => onOpenEvidence('Execution runs', source)}
                      >
                        Inspect execution receipt →
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <section
            className="evaluator-review-card"
            aria-labelledby="r27-digests-title"
          >
            <p className="section-kicker">
              Submitted workspace integrity metadata
            </p>
            <h2 id="r27-digests-title">Submission digests</h2>
            <details className="evaluator-source-details">
              <summary>Show workspace and manifest digests</summary>
              <dl className="evaluator-source-metadata">
                <div>
                  <dt>Workspace digest</dt>
                  <dd>
                    <code className="evaluator-integrity-digest">
                      {evidence.submission.workspaceDigest}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>Manifest digest</dt>
                  <dd>
                    <code className="evaluator-integrity-digest">
                      {evidence.submission.manifestDigest}
                    </code>
                  </dd>
                </div>
              </dl>
            </details>
          </section>
        </ReferenceGroup>
      </div>

      <aside
        className="workbench-summary-sidebar"
        aria-label="Evidence availability"
      >
        <section
          className="evaluator-review-card"
          aria-labelledby="r27-summary-title"
        >
          <h2 id="r27-summary-title">
            {hiring ? 'Submission' : 'Submitted evidence'}
          </h2>
          <dl className="evaluator-source-metadata">
            {hiring ? (
              <div>
                <dt>Files</dt>
                <dd>{evidence.submission.files.length}</dd>
              </div>
            ) : (
              <div>
                <dt>Scenario</dt>
                <dd>
                  {evidence.scenario.title} · v
                  {evidence.scenario.version.replace(/^v/i, '')}
                </dd>
              </div>
            )}
            <div>
              <dt>{hiring ? 'Time used' : 'Elapsed time'}</dt>
              <dd>{duration}</dd>
            </div>
            {!hiring || evidence.closureReason !== 'candidate_submission' ? (
              <div>
                <dt>Closure</dt>
                <dd>
                  {evidence.closureReason === 'candidate_submission'
                    ? 'Candidate submission'
                    : 'Timeout'}
                </dd>
              </div>
            ) : null}
          </dl>
          <details className="evaluator-source-details">
            <summary>{hiring ? 'Session metadata' : 'Session details'}</summary>
            <dl className="evaluator-source-metadata">
              <div>
                <dt>Session</dt>
                <dd>
                  <code>{evidence.sessionId}</code>
                </dd>
              </div>
              <div>
                <dt>Created from session record</dt>
                <dd>
                  <time dateTime={evidence.createdAt}>
                    {evidence.createdAt}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Activated</dt>
                <dd>
                  <time dateTime={evidence.activatedAt}>
                    {evidence.activatedAt}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Submitted</dt>
                <dd>
                  <time dateTime={evidence.submittedAt}>
                    {evidence.submittedAt}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Assignment</dt>
                <dd>
                  <code>{evidence.assignment.id}</code> · version{' '}
                  <code>{evidence.assignment.version}</code>
                </dd>
              </div>
            </dl>
          </details>
        </section>

        <section className="evaluator-review-card">
          <h2>{hiring ? 'Evidence availability' : 'Evidence limits'}</h2>
          {hiring ? (
            <>
              <p className="evaluator-muted-copy">
                {executionSources.length || conversationSources.length
                  ? `${executionSources.length} test or terminal runs · ${conversationSources.length} AI conversations`
                  : 'No test, terminal or AI activity was recorded.'}
              </p>
              <button
                type="button"
                className="evaluator-text-link"
                onClick={() => onOpenEvidence('Code changes')}
              >
                Inspect evidence <IconArrowRight size={15} aria-hidden="true" />
              </button>
            </>
          ) : null}
          {hiring ? (
            <details className="evaluator-source-details">
              <summary>Capture limits</summary>
              <EvidenceAvailability evidence={evidence} />
            </details>
          ) : (
            <EvidenceAvailability evidence={evidence} />
          )}
        </section>
      </aside>
    </div>
  );
};

const EvidenceAvailability = ({
  evidence,
}: Readonly<{ evidence: R27Evidence }>) => (
  <>
    <dl className="evaluator-source-metadata">
      <div>
        <dt>Terminal</dt>
        <dd>{evidence.availability.terminal}</dd>
      </div>
      <div>
        <dt>AI interactions</dt>
        <dd>{evidence.availability.ai}</dd>
      </div>
      <div>
        <dt>Verification</dt>
        <dd>{evidence.availability.verification}</dd>
      </div>
      <div>
        <dt>Save history</dt>
        <dd>
          {evidence.availability.history === 'metadata_only'
            ? 'Version and digest metadata only'
            : evidence.availability.history}
        </dd>
      </div>
    </dl>
    {evidence.availability.limitations.length ? (
      <ul>
        {evidence.availability.limitations.map((limitation, index) => (
          <li key={`${index}:${limitation}`}>{limitation}</li>
        ))}
      </ul>
    ) : null}
  </>
);

const SummaryView = ({
  sessionId,
  evidence,
  review,
  projection,
  conversations,
  sources,
  selectedSource,
  onSelectSource,
  onOpenEvidence,
}: Readonly<{
  sessionId: string;
  evidence: EvaluatorReviewEvidence;
  review: EvaluatorReviewPresentation;
  projection: ProjectedBriefing;
  conversations: readonly EvaluatorAiConversation[];
  sources: readonly EvidenceSource[];
  selectedSource: EvidenceSource | null;
  onSelectSource: (source: EvidenceSource) => void;
  onOpenEvidence: (filter?: EvidenceFilter, source?: EvidenceSource) => void;
}>) => {
  const { briefing, defaultDepth } = projection;
  const submittedFileCount =
    briefing.submittedState.fileCount ??
    (briefing.submittedState.parsing === 'complete'
      ? briefing.submittedState.changedPaths.length
      : null);
  const entriesByReference = new Map(
    review.evidenceEntries.map((entry) => [entry.evidenceRef, entry]),
  );

  return (
    <div className="workbench-summary-grid">
      <div className="workbench-summary-content">
        <section
          className="evaluator-review-card workbench-orientation-summary"
          aria-label="Task orientation and submitted work"
        >
          <div className="workbench-task-orientation">
            <p className="section-kicker">Task orientation</p>
            <TaskBrief
              taskContext={briefing.taskContext}
              showScenarioReference={defaultDepth.scenarioReference}
              contextAvailable={
                briefing.artifactAvailability.context === 'available'
              }
            />
            {defaultDepth.evidenceLimitations ? (
              <PlatformNotice limitations={briefing.evidenceLimitations} />
            ) : null}
          </div>

          <aside
            className="workbench-submission"
            aria-labelledby="workbench-submission-title"
          >
            <header className="evaluator-submitted-work-heading">
              <span className="evaluator-review-title-icon" aria-hidden="true">
                <IconFile size={21} stroke={1.8} />
              </span>
              <div>
                <p className="section-kicker">Frozen candidate submission</p>
                <h2 id="workbench-submission-title">Submitted work</h2>
                <span>
                  {submittedFileCount === null
                    ? 'File count unavailable'
                    : `${submittedFileCount} file${submittedFileCount === 1 ? '' : 's'} changed`}
                </span>
              </div>
            </header>
            {briefing.submittedState.changedPaths.length ? (
              <ul className="evaluator-submitted-file-list">
                {briefing.submittedState.changedPaths
                  .slice(0, 3)
                  .map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="evaluator-muted-copy">
                {submittedFileCount === 0
                  ? 'No changed files were recorded.'
                  : 'The submitted file list is unavailable.'}
              </p>
            )}
            <button
              type="button"
              className="evaluator-text-link"
              onClick={() => onOpenEvidence('Code changes')}
            >
              Open submitted diff →
            </button>
          </aside>
        </section>

        <VerificationProgression projection={projection} />

        <section
          className="evaluator-review-card workbench-progression"
          aria-labelledby="workbench-progression-title"
        >
          <header className="evaluator-review-section-heading">
            <span className="evaluator-review-title-icon" aria-hidden="true">
              <IconListDetails size={21} stroke={1.8} />
            </span>
            <div>
              <p className="section-kicker">Session record</p>
              <h2 id="workbench-progression-title">Observed progression</h2>
            </div>
            <span>{briefing.observedActivity.length} entries</span>
          </header>
          {briefing.observedActivity.length ? (
            <ol className="workbench-progression-list">
              {briefing.observedActivity.slice(0, 4).map((activity) => {
                const source = activity.evidenceRefs
                  .map((ref) =>
                    sources.find((candidate) => candidate.evidenceRef === ref),
                  )
                  .find((candidate) => candidate !== undefined);
                const timestampEntry = activity.evidenceRefs
                  .map((ref) => entriesByReference.get(ref))
                  .find((entry) => entry !== undefined);
                const timestamp = timestampEntry?.item
                  ? timestampEntry.item.kind === 'COMMAND_EXECUTION'
                    ? timestampEntry.item.finishedAt
                    : 'timestamp' in timestampEntry.item
                      ? timestampEntry.item.timestamp
                      : null
                  : null;
                return (
                  <li key={activity.id}>
                    {timestamp ? (
                      <time dateTime={timestamp}>
                        {source
                          ? formatEvidenceTime(source, evidence.activatedAt)
                          : new Date(timestamp).toLocaleString(undefined, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })}
                      </time>
                    ) : (
                      <span className="workbench-time-unavailable">
                        Time unavailable
                      </span>
                    )}
                    <div>
                      <p>{activity.text}</p>
                      {source ? (
                        <button
                          type="button"
                          className="evaluator-text-link"
                          onClick={() => {
                            onSelectSource(source);
                            onOpenEvidence(undefined, source);
                          }}
                        >
                          Inspect source →
                        </button>
                      ) : (
                        <span className="evaluator-muted-copy">
                          Source unavailable
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="evaluator-muted-copy">
              No summarized activity is available in the authorized session
              record.
            </p>
          )}
        </section>

        <CoverageSummary
          review={review}
          projection={projection}
          conversations={conversations}
        />

        {defaultDepth.reviewGuidance ? (
          <ReviewGuidance guidance={briefing.reviewGuidance} />
        ) : null}
        {defaultDepth.artifactAvailability ? (
          <ArtifactAvailabilityCard
            availability={briefing.artifactAvailability}
            provenance={briefing.provenance}
            showTechnicalDetails={defaultDepth.technicalRecord}
          />
        ) : null}

        <details className="evaluator-analysis-disclosure">
          <summary>Task-scoped analysis report</summary>
          <p>
            This task-scoped report is an aid for review. The evaluator owns the
            decision.
          </p>
          <TaskAssessmentReport
            sessionId={sessionId}
            evidenceEntries={review.evidenceEntries}
            submittedDiff={review.submittedDiff}
            submittedState={briefing.submittedState}
          />
        </details>
      </div>

      <aside
        className="workbench-summary-inspector"
        aria-label="Selected evidence"
      >
        <div className="workbench-summary-inspector-heading">
          <p className="section-kicker">Evidence in context</p>
          <span>Current selection</span>
        </div>
        <EvidenceSourceInspector
          key={
            selectedSource?.evidenceRef ??
            selectedSource?.key ??
            'summary-empty'
          }
          source={selectedSource}
          evidence={evidence}
          review={review}
          projection={projection}
        />
        <button
          type="button"
          className="evaluator-text-link"
          onClick={() => onOpenEvidence(undefined, selectedSource ?? undefined)}
        >
          Browse all evidence →
        </button>
      </aside>
    </div>
  );
};

const EvidenceView = ({
  evidence,
  review,
  projection,
  r27Evidence,
  sources,
  filter,
  selectedSource,
  selectedSourceKey,
  onFilterChange,
  onSelectSource,
  registerRow,
  onLoadMoreR27,
  loadingMoreR27,
  r27PageError,
  hasHiringContext = false,
  hiringDraft,
  onHiringDraftChange,
  onBackToTimeline,
}: Readonly<{
  evidence?: EvaluatorReviewEvidence;
  review?: EvaluatorReviewPresentation;
  projection?: ProjectedBriefing;
  r27Evidence?: R27Evidence;
  sources: readonly EvidenceSource[];
  filter: EvidenceFilter;
  selectedSource: EvidenceSource | null;
  selectedSourceKey: string | null;
  onFilterChange: (filter: EvidenceFilter) => void;
  onSelectSource: (source: EvidenceSource) => void;
  registerRow: (key: string, element: HTMLButtonElement | null) => void;
  onLoadMoreR27?: () => void;
  loadingMoreR27?: boolean;
  r27PageError?: string | null;
  hasHiringContext?: boolean;
  hiringDraft?: HiringDecisionDraft | null;
  onHiringDraftChange?: (patch: Partial<HiringDecisionDraft>) => void;
  onBackToTimeline?: () => void;
}>) => {
  const [fileEvidenceOpen, setFileEvidenceOpen] = useState(false);
  const usesReviewDesk = Boolean(r27Evidence && hasHiringContext);
  const desktopLayout = useSyncExternalStore(
    subscribeReviewDeskDesktop,
    () => window.matchMedia(reviewDeskDesktopQuery).matches,
    () => false,
  );
  const verticalNavigation = usesReviewDesk && desktopLayout;
  const filters =
    r27Evidence && hasHiringContext
      ? ([
          'Code changes',
          'Execution runs',
          'AI conversations',
          'Chronology',
        ] as const)
      : evidenceFilters;
  const filterLabel = (item: EvidenceFilter) => {
    if (!hasHiringContext) return item;
    if (item === 'Code changes') return 'Files';
    if (item === 'Execution runs') return 'Tests';
    if (item === 'Chronology') return 'Event log';
    return item;
  };
  const visibleSources = sourcesForFilter(
    sources,
    filter,
    projection?.briefing.recordedVerification.runs ?? [],
  );
  const activatedAt = evidence?.activatedAt ?? r27Evidence?.activatedAt ?? null;
  const selectedIsVisible = visibleSources.some(
    (source) => source.key === selectedSourceKey,
  );
  const suppressStaleSourceInEmptyR27View = Boolean(
    r27Evidence &&
    hasHiringContext &&
    visibleSources.length === 0 &&
    (filter === 'Execution runs' || filter === 'AI conversations'),
  );
  const noCodeChanges =
    filter === 'Code changes' &&
    visibleSources.length > 0 &&
    visibleSources.every(
      (source) =>
        source.r27?.kind === 'file' &&
        source.r27.file.starterContent === source.r27.file.submittedContent,
    );

  const hasRecordedRuns =
    sourcesForFilter(sources, 'Execution runs', []).length > 0;

  const evidenceNavigation = (
    <div
      className="evaluator-evidence-filter-bar"
      role="tablist"
      aria-label="Evidence filters"
      aria-orientation={verticalNavigation ? 'vertical' : 'horizontal'}
    >
      {filters.map((item, index) => (
        <button
          key={item}
          id={filterId(item)}
          type="button"
          role="tab"
          aria-selected={filter === item}
          aria-controls="evidence-filter-panel"
          tabIndex={filter === item ? 0 : -1}
          onClick={() => onFilterChange(item)}
          onKeyDown={(event) => {
            const next =
              event.key === (verticalNavigation ? 'ArrowDown' : 'ArrowRight')
                ? (index + 1) % filters.length
                : event.key === (verticalNavigation ? 'ArrowUp' : 'ArrowLeft')
                  ? (index + filters.length - 1) % filters.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? filters.length - 1
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            onFilterChange(filters[next]);
            document.getElementById(filterId(filters[next]))?.focus();
          }}
        >
          {iconForFilter(item)}
          <span>{filterLabel(item)}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="evaluator-evidence-workbench">
      {filter === 'AI conversations' && projection ? (
        <CompactAiSummary
          summary={projection.briefing.aiSummary}
          showConfiguredModel={false}
          showInterleaving={projection.defaultDepth.technicalRecord}
        />
      ) : null}
      {usesReviewDesk ? null : evidenceNavigation}

      <div
        className="evaluator-evidence-browser"
        id={usesReviewDesk ? undefined : 'evidence-filter-panel'}
        role={usesReviewDesk ? undefined : 'tabpanel'}
        aria-labelledby={usesReviewDesk ? undefined : filterId(filter)}
        tabIndex={usesReviewDesk ? undefined : 0}
      >
        <section
          className="evaluator-evidence-list-panel"
          aria-label={`${filter} source list`}
        >
          <header>
            <h2>{filterLabel(filter)}</h2>
            <span>
              {visibleSources.length}{' '}
              {filter === 'Code changes' && hasHiringContext
                ? 'file'
                : 'record'}
              {visibleSources.length === 1 ? '' : 's'}
            </span>
          </header>
          {noCodeChanges ? (
            <p className="evaluator-empty-sources">
              Matches the starter repository.
            </p>
          ) : null}
          {hasHiringContext && filter === 'Chronology' && onBackToTimeline ? (
            <p className="evaluator-empty-sources">
              Chronological events matching the{' '}
              <button
                type="button"
                className="evaluator-text-link"
                onClick={onBackToTimeline}
              >
                Timeline
              </button>{' '}
              overview.
            </p>
          ) : null}
          {!selectedIsVisible &&
          selectedSource &&
          !suppressStaleSourceInEmptyR27View ? (
            <div className="evaluator-pinned-source">
              <p className="section-kicker">Selected outside this filter</p>
              <ol
                className="evaluator-source-list"
                aria-label="Selected source"
              >
                <SourceRow
                  source={selectedSource}
                  activatedAt={activatedAt}
                  selected
                  onSelect={onSelectSource}
                  register={registerRow}
                />
              </ol>
            </div>
          ) : null}
          {visibleSources.length ? (
            <ol
              className="evaluator-source-list"
              aria-label={`${filter} evidence`}
            >
              {visibleSources.map((source) => (
                <SourceRow
                  key={source.rowKey ?? source.key}
                  source={source}
                  activatedAt={activatedAt}
                  selected={selectedSourceKey === source.key}
                  onSelect={onSelectSource}
                  register={registerRow}
                />
              ))}
            </ol>
          ) : (
            <p className="evaluator-empty-sources">
              {r27Evidence && filter === 'AI conversations'
                ? r27Evidence.availability.ai === 'available'
                  ? 'Candidate AI assistance was enabled; 0 conversations were recorded.'
                  : 'Candidate AI assistance was disabled or unavailable for this assessment.'
                : r27Evidence && filter === 'Execution runs'
                  ? 'No test runs were recorded for this assessment.'
                  : r27Evidence && filter === 'Terminal'
                    ? 'Terminal evidence is unavailable in this read-only source.'
                    : r27Evidence && filter === 'Tests'
                      ? 'Verification evidence is unavailable in this read-only source.'
                      : filter === 'Tests'
                        ? 'No recognized test executions are available in this session record.'
                        : filter === 'AI conversations'
                          ? 'No linked AI conversation records are available. This does not establish that no external AI occurred.'
                          : `No ${filter.toLowerCase()} records are available in this session.`}
            </p>
          )}
          {usesReviewDesk ? evidenceNavigation : null}
        </section>
        <div
          className={
            usesReviewDesk
              ? 'review-desk-evidence-content'
              : 'review-desk-legacy-sections'
          }
          id={usesReviewDesk ? 'evidence-filter-panel' : undefined}
          role={usesReviewDesk ? 'tabpanel' : undefined}
          aria-labelledby={usesReviewDesk ? filterId(filter) : undefined}
          tabIndex={usesReviewDesk ? 0 : undefined}
        >
          {suppressStaleSourceInEmptyR27View ? (
            <section
              className="evaluator-source-inspector evaluator-empty-inspector-card"
              aria-live="polite"
              aria-label={`${filterLabel(filter)} empty details`}
            >
              <p className="section-kicker">{filterLabel(filter)}</p>
              <h3>
                {filter === 'Execution runs'
                  ? 'No test runs recorded'
                  : 'No AI conversations recorded'}
              </h3>
              <p className="evaluator-muted-copy">
                {filter === 'Execution runs'
                  ? 'The assessment record does not establish whether the test runner was available.'
                  : r27Evidence?.availability.ai === 'available'
                    ? 'The AI assistant was available in the workspace, and 0 prompts were sent.'
                    : 'The candidate AI assistant was disabled or unavailable in this assessment workspace.'}
              </p>
              <div>
                <button
                  type="button"
                  className="hiring-btn"
                  onClick={() => onFilterChange('Code changes')}
                >
                  ← Return to Files
                </button>
              </div>
            </section>
          ) : r27Evidence ? (
            <EvidenceSourceInspector
              key={selectedSource?.key ?? 'evidence-empty'}
              source={selectedSource}
              r27Evidence={r27Evidence}
              fileEvidencePanel={
                usesReviewDesk
                  ? {
                      open: fileEvidenceOpen,
                      onOpenChange: setFileEvidenceOpen,
                    }
                  : undefined
              }
            />
          ) : evidence && review && projection ? (
            <EvidenceSourceInspector
              key={
                selectedSource?.evidenceRef ??
                selectedSource?.key ??
                'evidence-empty'
              }
              source={selectedSource}
              evidence={evidence}
              review={review}
              projection={projection}
            />
          ) : null}
        </div>
      </div>
      {hasHiringContext &&
      filter === 'Code changes' &&
      hiringDraft &&
      onHiringDraftChange ? (
        <details
          className="evaluator-scratchpad-card evaluator-source-details"
          aria-label="Private review notes"
        >
          <summary>Private review notes</summary>
          <textarea
            rows={2}
            aria-label="Private review scratchpad notes"
            placeholder="Notes for your hiring team"
            value={hiringDraft.internalNotes}
            onChange={(event) =>
              onHiringDraftChange({ internalNotes: event.target.value })
            }
          />
        </details>
      ) : null}
      {r27Evidence?.pagination.nextAfterSequence !== null && r27Evidence ? (
        <button type="button" onClick={onLoadMoreR27} disabled={loadingMoreR27}>
          {loadingMoreR27 ? 'Loading events…' : 'Load more recorded events'}
        </button>
      ) : null}
      {r27Evidence && r27PageError ? <p role="alert">{r27PageError}</p> : null}
      {(review?.notices ?? []).map((notice) => (
        <p className="evaluator-evidence-notice" key={notice.title}>
          {notice.message}
        </p>
      ))}
    </div>
  );
};

const ReviewContext = ({
  source,
  evidence,
  onOpenSource,
}: Readonly<{
  source: EvidenceSource | null;
  evidence: EvaluatorReviewEvidence;
  onOpenSource: (source: EvidenceSource) => void;
}>) => (
  <section
    className="workbench-review-context"
    aria-labelledby="review-context-title"
  >
    <p className="section-kicker">Selected source</p>
    <h2 id="review-context-title">{source?.title ?? 'No source selected'}</h2>
    <p>Review notes are session-level and are not linked to this source.</p>
    {source ? (
      <>
        <p className="workbench-review-context-summary">{source.summary}</p>
        <dl className="workbench-review-context-metadata">
          <div>
            <dt>Recorded</dt>
            <dd>{sourceTime(source, evidence.activatedAt)}</dd>
          </div>
        </dl>
        <button
          type="button"
          className="evaluator-text-link"
          id="review-context-open-source"
          onClick={() => onOpenSource(source)}
        >
          Open source in Evidence →
        </button>
      </>
    ) : null}
  </section>
);

type LegacyEvaluatorReviewWorkspaceProps = Readonly<{
  sessionId: string;
  evidence: EvaluatorReviewEvidence;
  review: EvaluatorReviewPresentation;
  projection: ProjectedBriefing;
  activeRole: BriefingDepthProfile;
  aiConversations: readonly EvaluatorAiConversation[];
  readOnly?: false;
}>;

type R27EvaluatorReviewWorkspaceProps = Readonly<{
  sessionId: string;
  readOnly: true;
  r27Evidence: R27Evidence;
  hiringReviewContext?: SessionHiringReviewContext | null;
  initialTab?: WorkbenchMode;
  initialPeerReviewId?: string | null;
}>;

export const EvaluatorReviewWorkspace = (
  props: LegacyEvaluatorReviewWorkspaceProps | R27EvaluatorReviewWorkspaceProps,
) => {
  const { sessionId } = props;
  const initialHiringReviewContext =
    'hiringReviewContext' in props ? (props.hiringReviewContext ?? null) : null;
  const [hiringReviewContext, setHiringReviewContext] =
    useState<SessionHiringReviewContext | null>(initialHiringReviewContext);
  const initialTab: WorkbenchMode =
    'initialTab' in props && props.initialTab ? props.initialTab : 'Summary';
  const initialPeerReviewId =
    'initialPeerReviewId' in props ? (props.initialPeerReviewId ?? null) : null;
  const pendingPeerReviewsForMeCount = useMemo(
    () =>
      (hiringReviewContext?.secondOpinions ?? []).filter(
        (opinion) =>
          opinion.status === 'pending' &&
          opinion.requestedReviewerPrincipalId ===
            hiringReviewContext?.currentPrincipalId,
      ).length,
    [hiringReviewContext],
  );
  const aiReviewPlanLocked = Boolean(
    hiringReviewContext &&
    !hasPlanFeature(hiringReviewContext.plan.planTier, 'aiCandidateReview'),
  );
  const initialR27Evidence = 'r27Evidence' in props ? props.r27Evidence : null;
  const [r27Evidence, setR27Evidence] = useState<R27Evidence | null>(
    initialR27Evidence,
  );
  const [loadingMoreR27, setLoadingMoreR27] = useState(false);
  const [r27PageError, setR27PageError] = useState<string | null>(null);
  const [aiReviewReport, setAiReviewReportState] =
    useState<R27AiReviewReport | null>(null);
  const [aiReviewLoading, setAiReviewLoading] = useState(false);
  const aiReportStorageKey = `hirearchy:eval:ai-report:v1:${sessionId}`;
  const setAiReviewReport = (next: R27AiReviewReport | null) => {
    setAiReviewReportState(next);
    if (next) {
      writePersistedJson(aiReportStorageKey, next, 'durable');
    } else {
      removePersistedKey(aiReportStorageKey);
    }
  };
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const parsed = readPersistedJson<R27AiReviewReport>(
        aiReportStorageKey,
        'durable',
      );
      if (parsed && typeof parsed === 'object' && parsed.headline) {
        setAiReviewReportState(parsed);
      }
    });
    return () => {
      active = false;
    };
  }, [aiReportStorageKey]);

  const decisionDraftStorageKey = hiringDecisionDraftKey(sessionId);
  const [hiringDecisionDraft, setHiringDecisionDraft] =
    useState<HiringDecisionDraft | null>(() =>
      initialHiringReviewContext
        ? initialHiringDecisionDraft(initialHiringReviewContext)
        : null,
    );

  useEffect(() => {
    if (!initialHiringReviewContext) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const restored = restoreHiringDecisionDraft(
          sessionId,
          initialHiringDecisionDraft(initialHiringReviewContext),
        );
        setHiringDecisionDraft(restored);
      } catch {
        // Ignore malformed local drafts.
      }
    });
    return () => {
      active = false;
    };
  }, [sessionId, initialHiringReviewContext]);

  const updateHiringDecisionDraft = (patch: Partial<HiringDecisionDraft>) => {
    setHiringDecisionDraft((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      writePersistedJson(decisionDraftStorageKey, next, 'durable');
      return next;
    });
  };

  const evidence = 'evidence' in props ? props.evidence : null;
  const review = 'review' in props ? props.review : null;
  const projection = 'projection' in props ? props.projection : null;
  const activeRole = 'activeRole' in props ? props.activeRole : 'ENGINEER';
  const aiConversations =
    'aiConversations' in props ? props.aiConversations : emptyAiConversations;
  const readOnly = r27Evidence !== null;
  const r27Presentation = useMemo(
    () => (r27Evidence ? buildR27Presentation(r27Evidence) : null),
    [r27Evidence],
  );
  const sources = useMemo(
    () =>
      r27Evidence && r27Presentation
        ? buildR27EvidenceSources(r27Evidence, r27Presentation)
        : buildEvidenceSources(review!, projection!, aiConversations),
    [aiConversations, projection, r27Evidence, r27Presentation, review],
  );
  const [mode, setModeState] = useState<WorkbenchMode>(initialTab);
  const [visitedModes, setVisitedModes] = useState<ReadonlySet<WorkbenchMode>>(
    () => new Set([initialTab]),
  );
  const setMode = (nextMode: WorkbenchMode) => {
    setModeState(nextMode);
    setVisitedModes((current) => {
      if (current.has(nextMode)) return current;
      const next = new Set(current);
      next.add(nextMode);
      return next;
    });
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', nextMode.toLowerCase());
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}`,
      );
    }
  };
  const [filter, setFilter] = useState<EvidenceFilter>(() =>
    initialR27Evidence &&
    (initialR27Evidence.revisions.length > 0 ||
      Boolean(initialR27Evidence.submission))
      ? 'Code changes'
      : 'Chronology',
  );
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(
    () =>
      (initialHiringReviewContext
        ? sourcesForFilter(sources, filter, [])[0]?.key
        : preferredEvidenceSource(sources)?.key) ?? null,
  );
  const [workflowSignalsOpen, setWorkflowSignalsOpen] = useState(false);
  const [verificationQuestionsOpen, setVerificationQuestionsOpen] =
    useState(false);
  const viewStateStorageKey = `hirearchy:eval:workbench-view:v1:${sessionId}`;
  const [viewStateHydrated, setViewStateHydrated] = useState(false);
  const sourcesRef = useRef(sources);
  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const params = new URLSearchParams(window.location.search);
      const hasUrlTab = params.has('tab') || params.has('peerReview');
      const savedView = readPersistedJson<{
        mode?: string;
        filter?: string;
        selectedSourceKey?: string | null;
        workflowSignalsOpen?: boolean;
        verificationQuestionsOpen?: boolean;
      }>(viewStateStorageKey, 'durable');
      if (savedView && typeof savedView === 'object') {
        if (
          !hasUrlTab &&
          savedView.mode &&
          (modes as readonly string[]).includes(savedView.mode)
        ) {
          const restoredMode = savedView.mode as WorkbenchMode;
          setModeState(restoredMode);
          setVisitedModes((current) => {
            if (current.has(restoredMode)) return current;
            const next = new Set(current);
            next.add(restoredMode);
            return next;
          });
        }
        if (
          savedView.filter &&
          (evidenceFilters as readonly string[]).includes(savedView.filter)
        ) {
          setFilter(savedView.filter as EvidenceFilter);
        }
        if (
          typeof savedView.selectedSourceKey === 'string' &&
          sourcesRef.current.some((s) => s.key === savedView.selectedSourceKey)
        ) {
          setSelectedSourceKey(savedView.selectedSourceKey);
        }
        if (typeof savedView.workflowSignalsOpen === 'boolean') {
          setWorkflowSignalsOpen(savedView.workflowSignalsOpen);
        }
        if (typeof savedView.verificationQuestionsOpen === 'boolean') {
          setVerificationQuestionsOpen(savedView.verificationQuestionsOpen);
        }
      }
      setViewStateHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [viewStateStorageKey]);

  useEffect(() => {
    if (!viewStateHydrated) return;
    writePersistedJson(
      viewStateStorageKey,
      {
        mode,
        filter,
        selectedSourceKey,
        workflowSignalsOpen,
        verificationQuestionsOpen,
      },
      'durable',
    );
  }, [
    filter,
    mode,
    selectedSourceKey,
    verificationQuestionsOpen,
    viewStateHydrated,
    viewStateStorageKey,
    workflowSignalsOpen,
  ]);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [quickNoteOpen, setQuickNoteOpen] = useState(false);
  const pendingQuickNoteFocus = useRef(false);
  const modeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const sourceRows = useRef(new Map<string, HTMLButtonElement>());
  const inspectorHeading = useRef<HTMLHeadingElement | null>(null);
  const inspectorDialog = useRef<HTMLDivElement | null>(null);
  const wasMobileInspectorOpen = useRef(false);

  const selectedSource =
    sources.find((source) => source.key === selectedSourceKey) ??
    preferredEvidenceSource(sources);
  const effectiveSelectedSourceKey = selectedSource?.key ?? null;
  const activeFilterSources = sourcesForFilter(
    sources,
    filter,
    projection?.briefing.recordedVerification.runs ?? [],
  );

  const loadMoreR27Events = async () => {
    const current = r27Evidence;
    const afterSequence = current?.pagination.nextAfterSequence;
    if (
      !current ||
      afterSequence === null ||
      afterSequence === undefined ||
      loadingMoreR27
    )
      return;
    setLoadingMoreR27(true);
    setR27PageError(null);
    try {
      const query = new URLSearchParams();
      query.set('afterSequence', afterSequence);
      query.set('limit', String(current.pagination.limit));
      const response = await fetch(
        `/r27/api/organizations/${encodeURIComponent(current.organizationId)}/sessions/${encodeURIComponent(current.sessionId)}/evidence?${query}`,
        {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        },
      );
      if (!response.ok) throw new Error('Additional evidence page unavailable');
      const nextPage = (await response.json()) as R27Evidence;
      if (
        nextPage.organizationId !== current.organizationId ||
        nextPage.sessionId !== current.sessionId ||
        !Array.isArray(nextPage.events) ||
        !Array.isArray(nextPage.revisions) ||
        !nextPage.pagination ||
        typeof nextPage.pagination.limit !== 'number' ||
        !(
          nextPage.pagination.nextAfterSequence === null ||
          typeof nextPage.pagination.nextAfterSequence === 'string'
        )
      ) {
        throw new Error('Additional evidence page shape unavailable');
      }
      setR27Evidence((latest) => {
        if (!latest) return nextPage;
        const knownSequences = new Set(
          latest.events.map((event) => event.sequence),
        );
        const revisions = new Map(
          [...latest.revisions, ...nextPage.revisions].map((revision) => [
            `${revision.source}:${revision.path}:${revision.version}:${revision.digest}`,
            revision,
          ]),
        );
        return {
          ...latest,
          events: [
            ...latest.events,
            ...nextPage.events.filter(
              (event) => !knownSequences.has(event.sequence),
            ),
          ],
          revisions: [...revisions.values()],
          pagination: nextPage.pagination,
        };
      });
    } catch {
      setR27PageError('Additional evidence could not be loaded. Retry.');
    } finally {
      setLoadingMoreR27(false);
    }
  };

  useEffect(() => {
    if (!pendingQuickNoteFocus.current && !quickNoteOpen) return;
    pendingQuickNoteFocus.current = false;
    requestAnimationFrame(() =>
      document.getElementById('reviewer-note-body')?.focus(),
    );
  }, [mode, quickNoteOpen]);

  useEffect(() => {
    if (mobileInspectorOpen) {
      wasMobileInspectorOpen.current = true;
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      requestAnimationFrame(() => inspectorHeading.current?.focus());
      return () => {
        document.body.style.overflow = previousOverflow;
      };
    }
    if (wasMobileInspectorOpen.current) {
      wasMobileInspectorOpen.current = false;
      requestAnimationFrame(() => {
        if (effectiveSelectedSourceKey)
          sourceRows.current.get(effectiveSelectedSourceKey)?.focus();
      });
    }
  }, [effectiveSelectedSourceKey, mobileInspectorOpen]);

  useEffect(() => {
    if (!mobileInspectorOpen) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileInspectorOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !inspectorDialog.current) return;
      const focusableSelector =
        'button:not(:disabled), a[href], area[href], input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, iframe, object, embed, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';
      const focusable = Array.from(
        inspectorDialog.current.querySelectorAll<HTMLElement>(
          focusableSelector,
        ),
      ).filter((element) => {
        if (element.closest('[hidden], [inert], [aria-hidden="true"]'))
          return false;

        if (
          element.tagName === 'SUMMARY' &&
          element.parentElement?.tagName === 'DETAILS' &&
          Array.from(element.parentElement.children).find(
            (child) => child.tagName === 'SUMMARY',
          ) !== element
        )
          return false;

        for (
          let ancestor = element.parentElement;
          ancestor && ancestor !== inspectorDialog.current;
          ancestor = ancestor.parentElement
        ) {
          if (ancestor.tagName !== 'DETAILS' || ancestor.hasAttribute('open'))
            continue;
          const summary = Array.from(ancestor.children).find(
            (child) => child.tagName === 'SUMMARY',
          );
          if (!summary?.contains(element)) return false;
        }

        for (
          let ancestor: HTMLElement | null = element;
          ancestor && ancestor !== inspectorDialog.current;
          ancestor = ancestor.parentElement
        ) {
          const style = window.getComputedStyle(ancestor);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.visibility === 'collapse'
          )
            return false;
        }

        return true;
      });
      if (!focusable.length) {
        event.preventDefault();
        inspectorHeading.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeIndex = focusable.indexOf(
        document.activeElement as HTMLElement,
      );
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
        event.preventDefault();
        first.focus();
      } else if (!event.shiftKey && activeIndex < 0) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileInspectorOpen]);

  const selectSource = (source: EvidenceSource) => {
    setSelectedSourceKey(source.key);
    setQuickNoteOpen(false);
    if (window.matchMedia('(max-width: 767px)').matches)
      setMobileInspectorOpen(true);
  };

  const handleFilterChange = (nextFilter: EvidenceFilter) => {
    setFilter(nextFilter);
    const nextVisible = sourcesForFilter(
      sources,
      nextFilter,
      projection?.briefing.recordedVerification.runs ?? [],
    );
    if (
      nextVisible.length > 0 &&
      !nextVisible.some((source) => source.key === effectiveSelectedSourceKey)
    ) {
      setSelectedSourceKey(nextVisible[0].key);
    }
  };

  const openEvidence = (
    nextFilter?: EvidenceFilter,
    source?: EvidenceSource,
  ) => {
    if (nextFilter) {
      if (source) setFilter(nextFilter);
      else handleFilterChange(nextFilter);
    }
    if (source) setSelectedSourceKey(source.key);
    setMode('Evidence');
    setQuickNoteOpen(false);
  };

  const openSelectedSource = (source: EvidenceSource) => {
    setSelectedSourceKey(source.key);
    setMode('Evidence');
    setQuickNoteOpen(false);
    if (window.matchMedia('(max-width: 767px)').matches)
      setMobileInspectorOpen(true);
  };

  const navigateFilteredSource = (direction: -1 | 1) => {
    const currentIndex = activeFilterSources.findIndex(
      (source) => source.key === effectiveSelectedSourceKey,
    );
    if (currentIndex < 0) return;
    const target = activeFilterSources[currentIndex + direction];
    if (target) setSelectedSourceKey(target.key);
  };

  const onModeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % modes.length
        : event.key === 'ArrowLeft'
          ? (index + modes.length - 1) % modes.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? modes.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setMode(modes[next]);
    modeRefs.current[next]?.focus();
    setQuickNoteOpen(false);
  };

  const showQuickNote = () => {
    if (readOnly) return;
    if (window.matchMedia('(max-width: 1199px)').matches) {
      pendingQuickNoteFocus.current = true;
      setMode('Review');
      setQuickNoteOpen(false);
      return;
    }
    setQuickNoteOpen((current) => !current);
  };

  const focusedSource = selectedSource;
  const currentIndex = activeFilterSources.findIndex(
    (source) => source.key === effectiveSelectedSourceKey,
  );
  const canPrevious = currentIndex > 0;
  const canNext =
    currentIndex >= 0 && currentIndex < activeFilterSources.length - 1;

  const headerStats = useMemo(() => {
    if (!r27Presentation) {
      return { testSummary: null, diffSummary: null };
    }
    const execSources = sources.filter(
      (s) => s.r27?.kind === 'execution' && s.execution,
    );
    let testSummary: string | null = null;
    if (execSources.length > 0) {
      const latestExec = execSources[execSources.length - 1].execution;
      if (latestExec) {
        testSummary =
          latestExec.exitCode === 0
            ? `Tests passed (${execSources.length} run${execSources.length === 1 ? '' : 's'})`
            : `Tests exit ${latestExec.exitCode ?? '—'} (${execSources.length} run${execSources.length === 1 ? '' : 's'})`;
      }
    }
    let totalAdd = 0;
    let totalDel = 0;
    for (const file of r27Presentation.files) {
      const stats = computeDiffStats(file.diff);
      totalAdd += stats.additions;
      totalDel += stats.deletions;
    }
    const diffSummary =
      totalAdd > 0 || totalDel > 0 ? `+${totalAdd} / -${totalDel} lines` : null;
    return { testSummary, diffSummary };
  }, [r27Presentation, sources]);

  const tabDisplayLabel = (item: WorkbenchMode) => {
    if (!hiringReviewContext) return item;
    if (item === 'Summary') return 'Overview';
    if (item === 'Evidence') return 'Code & Tests';
    return 'Decision';
  };

  const reviewNextMode = mode === 'Summary' ? 'Evidence' : 'Review';

  const reviewNextAction =
    hiringReviewContext && mode !== 'Review' ? (
      <button
        type="button"
        className="evaluator-review-next"
        onClick={() => {
          setMode(reviewNextMode);
          modeRefs.current[modes.indexOf(reviewNextMode)]?.focus();
        }}
      >
        {mode === 'Summary' ? 'Review code & tests' : 'Go to decision'}
        <IconArrowRight size={17} aria-hidden="true" />
      </button>
    ) : null;

  const advisoryPanel = r27Evidence ? (
    <R27AiReviewPanel
      organizationId={r27Evidence.organizationId}
      sessionId={r27Evidence.sessionId}
      evidence={r27Evidence}
      report={aiReviewReport}
      onReportChange={setAiReviewReport}
      onLoadingChange={setAiReviewLoading}
      planLocked={aiReviewPlanLocked}
      hiring={Boolean(hiringReviewContext)}
      planSettingsHref={`/r23/organizations/${encodeURIComponent(r27Evidence.organizationId)}/plan`}
    />
  ) : null;

  return (
    <div
      className="evaluator-review-layout evaluator-workbench"
      data-hiring-review={Boolean(hiringReviewContext)}
      data-role-lens={activeRole}
      data-workbench-mode={mode.toLowerCase()}
    >
      <div
        className="evaluator-workbench-shell"
        inert={mobileInspectorOpen}
        aria-hidden={mobileInspectorOpen || undefined}
      >
        <EvaluatorHeader
          sessionId={sessionId}
          desktopReview={Boolean(hiringReviewContext)}
          action={reviewNextAction}
          scenarioTitle={
            r27Evidence?.scenario.title ?? evidence!.scenario.title
          }
          sessionDuration={projection?.briefing.sessionDuration}
          submittedAt={review?.session.submittedAt ?? r27Evidence!.submittedAt}
          closureReason={
            review?.session.closureReason ?? r27Evidence!.closureReason
          }
          candidateName={hiringReviewContext?.candidateName ?? null}
          candidateEmail={hiringReviewContext?.candidateEmail ?? null}
          candidateCode={hiringReviewContext?.candidateCode ?? null}
          targetRole={hiringReviewContext?.targetRole ?? null}
          experienceLevel={
            hiringReviewContext
              ? experienceLevelLabel(hiringReviewContext.experienceLevel)
              : null
          }
          skills={hiringReviewContext?.skills}
          testSummary={headerStats.testSummary}
          diffSummary={headerStats.diffSummary}
          backHref={
            hiringReviewContext
              ? `/r23/organizations/${encodeURIComponent(hiringReviewContext.organizationId.toLowerCase())}/candidates`
              : r27Evidence
                ? `/r23/organizations/${encodeURIComponent(r27Evidence.organizationId.toLowerCase())}/sessions/${encodeURIComponent(r27Evidence.sessionId)}`
                : undefined
          }
          backLabel={
            hiringReviewContext
              ? '← Back to Candidates'
              : r27Evidence
                ? '← Back to session summary'
                : undefined
          }
        />
        <div className="evaluator-workbench-topline">
          <nav
            className="evaluator-workbench-modes"
            role="tablist"
            aria-label="Review workspace"
          >
            {modes.map((item, index) => (
              <button
                key={item}
                id={modeId(item)}
                ref={(element) => {
                  modeRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                aria-selected={mode === item}
                aria-controls={modePanelId}
                tabIndex={mode === item ? 0 : -1}
                data-workbench-mode-tab={item.toLowerCase()}
                onClick={() => {
                  setMode(item);
                  setQuickNoteOpen(false);
                }}
                onKeyDown={(event) => onModeKeyDown(event, index)}
              >
                <span>{tabDisplayLabel(item)}</span>
                {item === 'Review' && aiReviewLoading ? (
                  <span
                    className="evaluator-tab-weaving-dot"
                    aria-label="AI review running"
                    title="AI review running"
                  />
                ) : null}
                {item === 'Review' && pendingPeerReviewsForMeCount > 0 ? (
                  <span
                    className="evaluator-tab-badge"
                    aria-label={`${pendingPeerReviewsForMeCount} peer review requested`}
                  >
                    {pendingPeerReviewsForMeCount}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>
          {mode !== 'Review' && !readOnly ? (
            <button
              type="button"
              id="open-quick-note"
              className="evaluator-quick-note-trigger"
              aria-expanded={quickNoteOpen}
              aria-controls="review-workflow"
              onClick={showQuickNote}
            >
              {quickNoteOpen ? 'Close quick note' : 'Quick note'}
            </button>
          ) : null}
        </div>

        <div
          className="evaluator-workbench-columns"
          id={modePanelId}
          role="tabpanel"
          aria-labelledby={modeId(mode)}
          data-workbench-mode={mode.toLowerCase()}
          data-quick-note-open={quickNoteOpen}
          tabIndex={0}
        >
          <section className="evaluator-workbench-main">
            {visitedModes.has('Summary') ? (
              <div hidden={mode !== 'Summary'}>
                {r27Evidence ? (
                  <R27SummaryView
                    evidence={r27Evidence}
                    presentation={r27Presentation!}
                    sources={sources}
                    hiring={Boolean(hiringReviewContext)}
                    onOpenEvidence={openEvidence}
                    onLoadMore={loadMoreR27Events}
                    loadingMore={loadingMoreR27}
                    pageError={r27PageError}
                    workflowSignalsOpen={workflowSignalsOpen}
                    onWorkflowSignalsToggle={setWorkflowSignalsOpen}
                    verificationQuestionsOpen={verificationQuestionsOpen}
                    onVerificationQuestionsToggle={setVerificationQuestionsOpen}
                  />
                ) : evidence && review && projection ? (
                  <SummaryView
                    sessionId={sessionId}
                    evidence={evidence}
                    review={review}
                    projection={projection}
                    conversations={aiConversations}
                    sources={sources}
                    selectedSource={selectedSource}
                    onSelectSource={selectSource}
                    onOpenEvidence={openEvidence}
                  />
                ) : null}
              </div>
            ) : null}
            {visitedModes.has('Evidence') ? (
              <div hidden={mode !== 'Evidence'}>
                <EvidenceView
                  evidence={evidence ?? undefined}
                  review={review ?? undefined}
                  projection={projection ?? undefined}
                  r27Evidence={r27Evidence ?? undefined}
                  sources={sources}
                  filter={filter}
                  selectedSource={selectedSource}
                  selectedSourceKey={effectiveSelectedSourceKey}
                  onFilterChange={handleFilterChange}
                  onSelectSource={selectSource}
                  registerRow={(key, element) => {
                    if (element) sourceRows.current.set(key, element);
                    else sourceRows.current.delete(key);
                  }}
                  onLoadMoreR27={loadMoreR27Events}
                  loadingMoreR27={loadingMoreR27}
                  r27PageError={r27PageError}
                  hasHiringContext={Boolean(hiringReviewContext)}
                  hiringDraft={hiringDecisionDraft}
                  onHiringDraftChange={updateHiringDecisionDraft}
                  onBackToTimeline={() => {
                    setMode('Summary');
                    modeRefs.current[modes.indexOf('Summary')]?.focus();
                  }}
                />
              </div>
            ) : null}
          </section>

          <aside
            className={`evaluator-review-sidebar evaluator-workflow-slot${mode === 'Review' ? ' is-dedicated' : ' is-quick-note'}`}
            aria-label={
              readOnly && !r27Evidence
                ? 'Read-only review boundary'
                : mode === 'Review'
                  ? 'Review workflow'
                  : 'Quick note'
            }
            id="review-workflow"
            hidden={mode !== 'Review' && !quickNoteOpen}
          >
            {mode === 'Review' && !readOnly ? (
              <ReviewContext
                source={selectedSource}
                evidence={evidence!}
                onOpenSource={openSelectedSource}
              />
            ) : null}
            {mode === 'Review' && !readOnly ? (
              <p className="evaluator-evidence-notice workbench-review-boundary">
                The shared evaluator credential is not a named private reviewer
                identity.
              </p>
            ) : null}
            {readOnly ? (
              r27Evidence ? (
                visitedModes.has('Review') ? (
                  <div className="r27-review-stack" hidden={mode !== 'Review'}>
                    <div className="r27-human-review">
                      {hiringReviewContext ? (
                        <HiringDecisionPanel
                          initialContext={hiringReviewContext}
                          aiReviewReport={aiReviewReport}
                          initialPeerReviewId={initialPeerReviewId}
                          draft={hiringDecisionDraft}
                          onDraftChange={setHiringDecisionDraft}
                          onOpenEvidence={openEvidence}
                          onContextChange={setHiringReviewContext}
                          advisory={advisoryPanel}
                          onBackToEvidence={() => {
                            setMode('Evidence');
                            modeRefs.current[
                              modes.indexOf('Evidence')
                            ]?.focus();
                          }}
                        />
                      ) : null}
                      {r210IsEnabled() ? (
                        hiringReviewContext ? (
                          <details className="evaluator-source-details">
                            <summary>Formal audit packet (optional)</summary>
                            <R210ReviewPacketPanel
                              organizationId={r27Evidence.organizationId}
                              sessionId={r27Evidence.sessionId}
                              reviewer={r27Evidence.reviewer}
                              r27Evidence={r27Evidence}
                              sources={sources}
                              onOpenEvidence={openEvidence}
                            />
                          </details>
                        ) : (
                          <R210ReviewPacketPanel
                            organizationId={r27Evidence.organizationId}
                            sessionId={r27Evidence.sessionId}
                            reviewer={r27Evidence.reviewer}
                            r27Evidence={r27Evidence}
                            sources={sources}
                            onOpenEvidence={openEvidence}
                          />
                        )
                      ) : null}
                    </div>
                    {hiringReviewContext ? null : advisoryPanel}
                  </div>
                ) : null
              ) : mode === 'Review' ? (
                <section
                  className="evaluator-review-card"
                  aria-label="Read-only review boundary"
                >
                  <p className="section-kicker">Reviewer boundary</p>
                  <h2>Evidence inspection only</h2>
                  <p>
                    This lane does not submit review notes, scores, or
                    reconstructed claims.
                  </p>
                </section>
              ) : null
            ) : null}
            {!readOnly ? (
              <ReviewWorkflowPanel
                sessionId={sessionId}
                mode={mode === 'Review' ? 'full' : 'quick-note'}
              />
            ) : null}
          </aside>
        </div>

        <span className="visually-hidden" aria-live="polite">
          Showing {tabDisplayLabel(mode)} workspace.
        </span>
      </div>

      {mobileInspectorOpen ? (
        <div
          className="evaluator-mobile-inspector"
          role="dialog"
          aria-modal="true"
          aria-label="Focused source inspection"
          ref={inspectorDialog}
        >
          <header className="evaluator-mobile-inspector-toolbar">
            <button
              type="button"
              id="mobile-inspector-back"
              onClick={() => setMobileInspectorOpen(false)}
            >
              {hiringReviewContext ? '← Evidence' : '← Back to evidence'}
            </button>
            <div className="evaluator-mobile-inspector-navigation">
              <button
                type="button"
                id="mobile-inspector-previous"
                aria-label="Previous source in current filter"
                disabled={!canPrevious}
                onClick={() => navigateFilteredSource(-1)}
              >
                {hiringReviewContext ? (
                  <IconChevronLeft size={17} aria-hidden="true" />
                ) : (
                  'Previous'
                )}
              </button>
              {hiringReviewContext ? null : <span>{filter}</span>}
              <button
                type="button"
                id="mobile-inspector-next"
                aria-label="Next source in current filter"
                disabled={!canNext}
                onClick={() => navigateFilteredSource(1)}
              >
                {hiringReviewContext ? (
                  <IconChevronRight size={17} aria-hidden="true" />
                ) : (
                  'Next'
                )}
              </button>
            </div>
          </header>
          <div className="evaluator-mobile-inspector-content">
            {r27Evidence ? (
              <EvidenceSourceInspector
                key={focusedSource?.key ?? 'mobile-empty'}
                source={focusedSource}
                r27Evidence={r27Evidence}
                headingRef={inspectorHeading}
              />
            ) : evidence && review && projection ? (
              <EvidenceSourceInspector
                key={
                  focusedSource?.evidenceRef ??
                  focusedSource?.key ??
                  'mobile-empty'
                }
                source={focusedSource}
                evidence={evidence}
                review={review}
                projection={projection}
                headingRef={inspectorHeading}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};
