'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  IconCode,
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
import type {
  EvaluatorReviewEvidence,
  EvaluatorReviewPresentation,
} from '../../../../src/evaluator/evaluator-review-presentation';
import type { EvaluatorAiConversation } from '../../../../src/evaluator/evaluator-ai-conversations';
import type { R27Evidence } from '../../../../../../database/postgres/r27/contract.mjs';
import {
  buildR27Presentation,
  type R27Presentation,
} from '../../../../src/r27-evidence/presentation';
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

const modes = ['Summary', 'Evidence', 'Review'] as const;
type WorkbenchMode = (typeof modes)[number];
const emptyAiConversations: readonly EvaluatorAiConversation[] = [];

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
      type="button"
      data-source-ref={source.evidenceRef ?? source.key}
      aria-pressed={selected}
      onClick={() => onSelect(source)}
    >
      <span className="evaluator-source-row-mark" aria-hidden="true" />
      <span className="evaluator-source-row-copy">
        <strong>{source.title}</strong>
        <span>{source.summary}</span>
        <small>
          {sourceLabel(source)} · {sourceTime(source, activatedAt)}
        </small>
      </span>
      {selected ? (
        <span className="evaluator-source-row-current">Current</span>
      ) : null}
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
  onOpenEvidence,
  onLoadMore,
  loadingMore,
  pageError,
}: Readonly<{
  evidence: R27Evidence;
  presentation: R27Presentation;
  sources: readonly EvidenceSource[];
  onOpenEvidence: (filter?: EvidenceFilter, source?: EvidenceSource) => void;
  onLoadMore: () => void;
  loadingMore: boolean;
  pageError: string | null;
}>) => {
  const fileSources = sources.filter((source) => source.r27?.kind === 'file');
  const eventSources = sources.filter((source) => source.r27?.kind === 'event');
  const conversationSources = sources.filter(
    (source) =>
      source.r27?.kind === 'conversation' || source.kind === 'conversation',
  );
  const executionSources = sources.filter(
    (source) => source.r27?.kind === 'execution' || Boolean(source.execution),
  );
  const elapsedMs =
    Date.parse(evidence.submittedAt) - Date.parse(evidence.activatedAt);
  const duration =
    Number.isFinite(elapsedMs) && elapsedMs >= 0
      ? `${Math.floor(elapsedMs / 60_000)} minutes`
      : 'Unavailable';

  return (
    <div className="workbench-summary-grid">
      <div className="workbench-summary-content">
        <section
          className="evaluator-review-card"
          aria-labelledby="r27-summary-title"
        >
          <div>
            <p className="section-kicker">Assigned reviewer · Read only</p>
            <h2 id="r27-summary-title">Submitted evidence</h2>
            <p>
              This view contains the frozen submission and authorized session
              records. It does not provide a score or decision.
            </p>
            <dl className="evaluator-source-metadata">
              <div>
                <dt>Session</dt>
                <dd>
                  <code>{evidence.sessionId}</code>
                </dd>
              </div>
              <div>
                <dt>Scenario</dt>
                <dd>
                  {evidence.scenario.title} · v{evidence.scenario.version}
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
                <dt>Elapsed time</dt>
                <dd>{duration}</dd>
              </div>
              <div>
                <dt>Closure</dt>
                <dd>
                  {evidence.closureReason === 'candidate_submission'
                    ? 'Candidate submission'
                    : 'Timeout'}
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
          </div>
        </section>

        <section
          className="evaluator-review-card"
          aria-labelledby="r27-snapshot-title"
        >
          <header className="evaluator-review-section-heading">
            <span className="evaluator-review-title-icon" aria-hidden="true">
              <IconFile size={21} stroke={1.8} />
            </span>
            <div>
              <p className="section-kicker">Versioned scenario snapshot</p>
              <h2 id="r27-snapshot-title">Task context</h2>
            </div>
          </header>
          <p style={{ overflowWrap: 'anywhere' }}>Scenario snapshot digest:</p>
          <code
            style={{
              display: 'block',
              maxWidth: '100%',
              overflowX: 'auto',
              whiteSpace: 'nowrap',
            }}
          >
            {evidence.scenario.snapshotDigest}
          </code>
          <p>
            {presentation.scenarioContext.brief ??
              'Scenario brief unavailable in this snapshot.'}
          </p>
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
          <details
            className="evaluator-source-details"
            style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}
          >
            <summary>Open immutable scenario snapshot</summary>
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
        </section>

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
              {fileSources.map((source) => (
                <li key={source.key}>
                  <code>
                    {source.r27?.kind === 'file'
                      ? source.r27.file.path
                      : source.key}
                  </code>{' '}
                  <button
                    type="button"
                    className="evaluator-text-link"
                    onClick={() => onOpenEvidence('Code changes', source)}
                  >
                    Open contents and derived diff →
                  </button>
                </li>
              ))}
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
                Save history includes version and digest metadata. Intermediate
                file contents are unavailable.
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

        <section
          className="evaluator-review-card"
          aria-labelledby="r27-timeline-title"
        >
          <header className="evaluator-review-section-heading">
            <span className="evaluator-review-title-icon" aria-hidden="true">
              <IconListDetails size={21} stroke={1.8} />
            </span>
            <div>
              <p className="section-kicker">Candidate event sequence</p>
              <h2 id="r27-timeline-title">Recorded timeline</h2>
            </div>
            <span>{eventSources.length} events available</span>
          </header>
          {eventSources.length ? (
            <ol className="workbench-progression-list">
              {eventSources.map((source) => {
                const event =
                  source.r27?.kind === 'event' ? source.r27.event : null;
                if (!event) return null;
                return (
                  <li key={source.key}>
                    <time dateTime={event.timestamp}>{event.timestamp}</time>
                    <div>
                      <p>
                        <code>{event.sequence}</code> · {source.title}
                      </p>
                      <small>
                        Provenance: <code>{event.provenance}</code>
                      </small>
                      <button
                        type="button"
                        className="evaluator-text-link"
                        onClick={() => onOpenEvidence('Chronology', source)}
                      >
                        Inspect event metadata →
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="evaluator-muted-copy">
              No candidate event is present on this evidence page.
            </p>
          )}
          {pageError ? <p role="alert">{pageError}</p> : null}
          {evidence.pagination.nextAfterSequence !== null ? (
            <button type="button" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading events…' : 'Load more recorded events'}
            </button>
          ) : null}
        </section>

        {conversationSources.length ? (
          <section
            className="evaluator-review-card"
            aria-labelledby="r27-ai-conversations-title"
          >
            <header className="evaluator-review-section-heading">
              <span className="evaluator-review-title-icon" aria-hidden="true">
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
                      onClick={() => onOpenEvidence('AI conversations', source)}
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
              <span className="evaluator-review-title-icon" aria-hidden="true">
                <IconTerminal2 size={21} stroke={1.8} />
              </span>
              <div>
                <p className="section-kicker">Automated Verification</p>
                <h2 id="r213-execution-runs-title">Recorded execution runs</h2>
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
          <dl className="evaluator-source-metadata">
            <div>
              <dt>Workspace digest</dt>
              <dd>
                <code
                  style={{
                    display: 'block',
                    maxWidth: '100%',
                    overflowX: 'auto',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {evidence.submission.workspaceDigest}
                </code>
              </dd>
            </div>
            <div>
              <dt>Manifest digest</dt>
              <dd>
                <code
                  style={{
                    display: 'block',
                    maxWidth: '100%',
                    overflowX: 'auto',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {evidence.submission.manifestDigest}
                </code>
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <aside
        className="workbench-summary-sidebar"
        aria-label="Evidence availability"
      >
        <section className="evaluator-review-card">
          <p className="section-kicker">Source availability</p>
          <h2>Evidence limits</h2>
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
        </section>
      </aside>
    </div>
  );
};

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
}>) => {
  const visibleSources = sourcesForFilter(
    sources,
    filter,
    projection?.briefing.recordedVerification.runs ?? [],
  );
  const activatedAt = evidence?.activatedAt ?? r27Evidence?.activatedAt ?? null;
  const selectedIsVisible = visibleSources.some(
    (source) => source.key === selectedSourceKey,
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
      <div
        className="evaluator-evidence-filter-bar"
        role="tablist"
        aria-label="Evidence filters"
      >
        {evidenceFilters.map((item, index) => (
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
                event.key === 'ArrowRight'
                  ? (index + 1) % evidenceFilters.length
                  : event.key === 'ArrowLeft'
                    ? (index + evidenceFilters.length - 1) %
                      evidenceFilters.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? evidenceFilters.length - 1
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              onFilterChange(evidenceFilters[next]);
              document.getElementById(filterId(evidenceFilters[next]))?.focus();
            }}
          >
            {iconForFilter(item)}
            <span>{item}</span>
          </button>
        ))}
      </div>

      <div
        className="evaluator-evidence-browser"
        id="evidence-filter-panel"
        role="tabpanel"
        aria-labelledby={filterId(filter)}
        tabIndex={0}
      >
        <section
          className="evaluator-evidence-list-panel"
          aria-label={`${filter} source list`}
        >
          <header>
            <div>
              <p className="section-kicker">Chronological records</p>
              <h2>{filter}</h2>
            </div>
            <span>
              {visibleSources.length} source
              {visibleSources.length === 1 ? '' : 's'}
            </span>
          </header>
          {!selectedIsVisible && selectedSource ? (
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
                  ? 'No AI conversations were recorded for this session.'
                  : 'AI interaction evidence is unavailable in this read-only source.'
                : r27Evidence && filter === 'Execution runs'
                  ? r27Evidence.availability.terminal === 'available'
                    ? 'No execution runs were recorded for this session.'
                    : 'Execution evidence is unavailable in this read-only source.'
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
        </section>

        {r27Evidence ? (
          <EvidenceSourceInspector
            key={selectedSource?.key ?? 'evidence-empty'}
            source={selectedSource}
            r27Evidence={r27Evidence}
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
      {r27Evidence?.pagination.nextAfterSequence !== null && r27Evidence ? (
        <button type="button" onClick={onLoadMoreR27} disabled={loadingMoreR27}>
          {loadingMoreR27 ? 'Loading events…' : 'Load more recorded events'}
        </button>
      ) : null}
      {r27Evidence && r27PageError ? <p role="alert">{r27PageError}</p> : null}
      {review?.notices.map((notice) => (
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
}>;

export const EvaluatorReviewWorkspace = (
  props: LegacyEvaluatorReviewWorkspaceProps | R27EvaluatorReviewWorkspaceProps,
) => {
  const { sessionId } = props;
  const initialR27Evidence = 'r27Evidence' in props ? props.r27Evidence : null;
  const [r27Evidence, setR27Evidence] = useState<R27Evidence | null>(
    initialR27Evidence,
  );
  const [loadingMoreR27, setLoadingMoreR27] = useState(false);
  const [r27PageError, setR27PageError] = useState<string | null>(null);
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
  const [mode, setMode] = useState<WorkbenchMode>('Summary');
  const [filter, setFilter] = useState<EvidenceFilter>('Chronology');
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(
    () => preferredEvidenceSource(sources)?.key ?? null,
  );
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

  const openEvidence = (
    nextFilter?: EvidenceFilter,
    source?: EvidenceSource,
  ) => {
    if (nextFilter) setFilter(nextFilter);
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

  return (
    <div
      className="evaluator-review-layout evaluator-workbench"
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
          scenarioTitle={
            r27Evidence?.scenario.title ?? evidence!.scenario.title
          }
          sessionDuration={projection?.briefing.sessionDuration}
          submittedAt={review?.session.submittedAt ?? r27Evidence!.submittedAt}
          closureReason={
            review?.session.closureReason ?? r27Evidence!.closureReason
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
                {item}
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
            {mode === 'Summary' ? (
              r27Evidence ? (
                <R27SummaryView
                  evidence={r27Evidence}
                  presentation={r27Presentation!}
                  sources={sources}
                  onOpenEvidence={openEvidence}
                  onLoadMore={loadMoreR27Events}
                  loadingMore={loadingMoreR27}
                  pageError={r27PageError}
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
              ) : null
            ) : mode === 'Evidence' ? (
              <EvidenceView
                evidence={evidence ?? undefined}
                review={review ?? undefined}
                projection={projection ?? undefined}
                r27Evidence={r27Evidence ?? undefined}
                sources={sources}
                filter={filter}
                selectedSource={selectedSource}
                selectedSourceKey={effectiveSelectedSourceKey}
                onFilterChange={setFilter}
                onSelectSource={selectSource}
                registerRow={(key, element) => {
                  if (element) sourceRows.current.set(key, element);
                  else sourceRows.current.delete(key);
                }}
                onLoadMoreR27={loadMoreR27Events}
                loadingMoreR27={loadingMoreR27}
                r27PageError={r27PageError}
              />
            ) : null}
          </section>

          <aside
            className={`evaluator-review-sidebar evaluator-workflow-slot${mode === 'Review' ? ' is-dedicated' : ' is-quick-note'}`}
            aria-label={
              readOnly
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
            {mode === 'Review' && readOnly ? (
              r27Evidence && r210IsEnabled() ? (
                <R210ReviewPacketPanel
                  organizationId={r27Evidence.organizationId}
                  sessionId={r27Evidence.sessionId}
                  reviewer={r27Evidence.reviewer}
                  r27Evidence={r27Evidence}
                  sources={sources}
                  onOpenEvidence={openEvidence}
                />
              ) : (
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
              )
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
          Showing {mode} workspace.
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
              ← Back to evidence
            </button>
            <div className="evaluator-mobile-inspector-navigation">
              <button
                type="button"
                id="mobile-inspector-previous"
                aria-label="Previous source in current filter"
                disabled={!canPrevious}
                onClick={() => navigateFilteredSource(-1)}
              >
                Previous
              </button>
              <span>{filter}</span>
              <button
                type="button"
                id="mobile-inspector-next"
                aria-label="Next source in current filter"
                disabled={!canNext}
                onClick={() => navigateFilteredSource(1)}
              >
                Next
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
