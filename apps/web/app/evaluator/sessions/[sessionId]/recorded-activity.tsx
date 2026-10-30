'use client';

import { useState } from 'react';
import { IconListDetails } from '@tabler/icons-react';
import type {
  BriefingAiSummary,
  ObservedStatement,
  RecordedVerification,
} from '../../../../src/evaluator/evaluator-briefing';
import type { EvidenceCatalogEntry } from '../../../../src/reconstruction/evidence-reference-catalog';
import type { ReconstructionItem } from '../../../../src/evidence/chronological-reconstruction';
import { formatElapsed } from '../../../../src/evaluator/evaluator-review-presentation';
import { CompactAiSummary } from './compact-ai-summary';
import { EvidenceItemCard } from './evidence-item-card';

type RecordedActivityProps = Readonly<{
  activities: readonly ObservedStatement[];
  verification?: RecordedVerification;
  evidenceEntries: readonly EvidenceCatalogEntry[];
  showDetailedTechnical?: boolean;
  showStructuredEvidence?: boolean;
  showDirectEvidenceLinks?: boolean;
  showVerificationChronology?: boolean;
  aiSummary?: BriefingAiSummary;
  showConfiguredModel?: boolean;
  showTokenTelemetry?: boolean;
  activatedAt?: string | null;
  selectedEvidenceRef?: string | null;
  focusEvidenceRef?: string | null;
  onSelectEvidence?: (evidenceRef: string) => void;
}>;

type PresentationUnit =
  | { kind: 'single'; activity: ObservedStatement }
  | {
      kind: 'burst';
      id: string;
      activities: readonly ObservedStatement[];
      interactionCount: number;
      startElapsed: string | null;
      endElapsed: string | null;
    };

const getEntryTimestamp = (
  entry: EvidenceCatalogEntry | undefined,
): string | null => {
  if (!entry?.item) return null;
  if (entry.item.kind === 'COMMAND_EXECUTION') return entry.item.finishedAt;
  return entry.item.timestamp;
};

const getAiMetadata = (item: ReconstructionItem | null | undefined) => {
  if (!item) return null;
  if (item.kind === 'AI_REQUEST_STARTED') {
    return {
      model: item.configuredModelId,
      statusTag: 'request',
      durationLabel: null,
    };
  }
  if (item.kind === 'AI_RESPONSE_COMPLETED') {
    return {
      model: item.reportedModelId,
      statusTag: 'completed',
      durationLabel: `${(item.durationMs / 1000).toFixed(1)}s`,
    };
  }
  if (item.kind === 'AI_REQUEST_CANCELLED') {
    return {
      model: null,
      statusTag: 'cancelled',
      durationLabel: `${(item.durationMs / 1000).toFixed(1)}s`,
    };
  }
  if (item.kind === 'AI_REQUEST_FAILED') {
    const isTimeout =
      item.failureReason === 'timeout' ||
      item.failureReason === 'server_timeout';
    return {
      model: null,
      statusTag: isTimeout ? 'timeout' : 'failed',
      durationLabel: `${(item.durationMs / 1000).toFixed(1)}s`,
    };
  }
  return null;
};

const buildPresentationUnits = (
  activities: readonly ObservedStatement[],
  byReference: Map<string, EvidenceCatalogEntry>,
  activatedAt?: string | null,
): readonly PresentationUnit[] => {
  const units: PresentationUnit[] = [];
  let i = 0;

  while (i < activities.length) {
    let k = 0;
    while (i + 2 * k + 1 < activities.length) {
      const reqStmt = activities[i + 2 * k];
      const respStmt = activities[i + 2 * k + 1];
      if (
        reqStmt.kind !== 'recorded_ai_request' ||
        respStmt.kind !== 'recorded_ai_response'
      ) {
        break;
      }
      const reqEntry = (reqStmt.evidenceRefs ?? []).map((ref) =>
        byReference.get(ref),
      )[0];
      const respEntry = (respStmt.evidenceRefs ?? []).map((ref) =>
        byReference.get(ref),
      )[0];
      if (
        reqEntry?.item?.kind !== 'AI_REQUEST_STARTED' ||
        respEntry?.item?.kind !== 'AI_RESPONSE_COMPLETED' ||
        reqEntry.item.interactionId !== respEntry.item.interactionId
      ) {
        break;
      }
      k++;
    }

    if (k >= 3) {
      const burstActivities = activities.slice(i, i + 2 * k);
      const firstEntry = (burstActivities[0].evidenceRefs ?? []).map((ref) =>
        byReference.get(ref),
      )[0];
      const lastEntry = (
        burstActivities[burstActivities.length - 1].evidenceRefs ?? []
      ).map((ref) => byReference.get(ref))[0];
      const startElapsed = formatElapsed(
        activatedAt ?? null,
        getEntryTimestamp(firstEntry),
      );
      const endElapsed = formatElapsed(
        activatedAt ?? null,
        getEntryTimestamp(lastEntry),
      );

      units.push({
        kind: 'burst',
        id: `burst:${burstActivities[0].id}:${burstActivities[burstActivities.length - 1].id}`,
        activities: burstActivities,
        interactionCount: k,
        startElapsed,
        endElapsed,
      });
      i += 2 * k;
    } else {
      units.push({ kind: 'single', activity: activities[i] });
      i++;
    }
  }

  return units;
};

export const RecordedActivity = ({
  activities = [],
  verification = { runs: [], scope: 'recognized_recorded_executions_only' },
  evidenceEntries = [],
  showDetailedTechnical = false,
  showStructuredEvidence = false,
  showDirectEvidenceLinks = false,
  showVerificationChronology = false,
  aiSummary,
  showConfiguredModel = false,
  showTokenTelemetry = false,
  activatedAt,
  selectedEvidenceRef,
  focusEvidenceRef,
  onSelectEvidence,
}: RecordedActivityProps) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedBurstIds, setExpandedBurstIds] = useState<Set<string>>(
    new Set(),
  );

  const byReference = new Map(
    evidenceEntries.map((entry) => [entry.evidenceRef, entry]),
  );
  const verificationByReference = new Map(
    verification.runs.flatMap((run) =>
      run.evidenceRefs.map((reference) => [reference, run] as const),
    ),
  );

  const toggleDisclosure = (id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  };

  const toggleBurst = (burstId: string) => {
    setExpandedBurstIds((prev) => {
      const next = new Set(prev);
      if (next.has(burstId)) next.delete(burstId);
      else next.add(burstId);
      return next;
    });
  };

  const units = buildPresentationUnits(activities, byReference, activatedAt);

  const renderActivityItem = (
    activity: ObservedStatement,
    index: number,
    totalCount: number,
  ) => {
    const isExpanded = expandedId === activity.id;
    const verificationRun = activity.evidenceRefs
      .map((reference) => verificationByReference.get(reference))
      .find((run) => run !== undefined);
    const matchingEntries = (activity.evidenceRefs ?? []).flatMap((ref) => {
      const entry = byReference.get(ref);
      return entry ? [entry] : [];
    });

    const firstEntry = matchingEntries[0];
    const isSelected = firstEntry?.evidenceRef === selectedEvidenceRef;
    const aiMetadata = getAiMetadata(firstEntry?.item);
    const elapsedLabel = formatElapsed(
      activatedAt ?? null,
      getEntryTimestamp(firstEntry),
    );
    const isAi =
      activity.kind === 'recorded_ai_request' ||
      activity.kind === 'recorded_ai_response' ||
      activity.kind === 'recorded_ai_cancellation' ||
      activity.kind === 'recorded_ai_failure';

    return (
      <li
        key={activity.id}
        className={`activity-item activity-item-${activity.kind}`}
        tabIndex={-1}
        data-evidence-refs={activity.evidenceRefs.join(' ')}
        data-evidence-focused={
          activity.evidenceRefs.includes(focusEvidenceRef ?? '') || undefined
        }
      >
        <div className="activity-marker-container" aria-hidden="true">
          <span className="activity-marker" />
          {index < totalCount - 1 ? <span className="activity-line" /> : null}
        </div>

        <div className="activity-content">
          <div className="activity-main-line">
            <div className="activity-headline">
              <p className="activity-text">{activity.text}</p>
              {aiMetadata ? (
                <span className="activity-ai-tags">
                  {showConfiguredModel && aiMetadata.model ? (
                    <span className="activity-model-tag">
                      {aiMetadata.model}
                    </span>
                  ) : null}
                  {aiMetadata.durationLabel ? (
                    <span className="activity-duration-tag">
                      {aiMetadata.durationLabel}
                    </span>
                  ) : null}
                  {aiMetadata.statusTag ? (
                    <span
                      className={`activity-status-tag status-${aiMetadata.statusTag}`}
                    >
                      {aiMetadata.statusTag}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {elapsedLabel ? (
                <span className="activity-elapsed-label">{elapsedLabel}</span>
              ) : null}
            </div>

            {showDirectEvidenceLinks && firstEntry && onSelectEvidence ? (
              <button
                type="button"
                className="evidence-toggle-button"
                data-evidence-control={firstEntry.evidenceRef}
                aria-pressed={isSelected}
                aria-label={`View source evidence ${firstEntry.evidenceRef}`}
                onClick={() => onSelectEvidence(firstEntry.evidenceRef)}
              >
                <span>View evidence</span>
                <span className="disclosure-chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            ) : showDirectEvidenceLinks && matchingEntries.length > 0 ? (
              <button
                type="button"
                className="evidence-toggle-button"
                aria-expanded={isExpanded}
                aria-controls={`evidence-drawer-${activity.id}`}
                onClick={() => toggleDisclosure(activity.id)}
              >
                <span>
                  {isExpanded
                    ? isAi
                      ? 'Hide details'
                      : 'Hide evidence'
                    : isAi
                      ? 'View details'
                      : 'View evidence'}
                </span>
                <span className="disclosure-chevron" aria-hidden="true">
                  {isExpanded ? '▾' : '›'}
                </span>
              </button>
            ) : null}
          </div>

          {verificationRun ? (
            <>
              <p className="activity-verification-result">
                {verificationRun.result?.text ??
                  (verificationRun.timedOut
                    ? 'The recorded test execution timed out.'
                    : `The recorded test execution exited with status ${verificationRun.exitCode ?? 'not recorded'}.`)}
              </p>
              {showVerificationChronology &&
              (verificationRun.laterWorkspaceEdits ||
                verificationRun.laterCaptureGaps) ? (
                <p className="activity-verification-context">
                  {verificationRun.laterWorkspaceEdits
                    ? 'Later workspace changes were recorded.'
                    : null}
                  {verificationRun.laterWorkspaceEdits &&
                  verificationRun.laterCaptureGaps
                    ? ' '
                    : null}
                  {verificationRun.laterCaptureGaps
                    ? 'Later workspace capture gaps were recorded.'
                    : null}
                </p>
              ) : null}
            </>
          ) : null}

          {showDetailedTechnical &&
          activity.paths &&
          activity.paths.length > 0 ? (
            <div className="activity-paths-badge">
              <span className="badge-label">File:</span>
              {activity.paths.map((p) => (
                <code key={p} className="code-inline">
                  {p}
                </code>
              ))}
            </div>
          ) : null}

          {showDirectEvidenceLinks &&
          !onSelectEvidence &&
          isExpanded &&
          matchingEntries.length > 0 ? (
            <div
              id={`evidence-drawer-${activity.id}`}
              className="activity-evidence-drawer"
            >
              <div className="evidence-entries-list">
                {matchingEntries.map((entry) => (
                  <div
                    key={entry.evidenceRef}
                    id={`evidence-${entry.evidenceRef}`}
                    className="evidence-entry-card"
                  >
                    <div className="entry-header">
                      <span className="entry-role">{entry.role}</span>
                      <span className="entry-kind">{entry.kind}</span>
                      <code className="entry-ref">{entry.evidenceRef}</code>
                    </div>
                    {entry.item && showStructuredEvidence ? (
                      <EvidenceItemCard
                        item={entry.item}
                        showConfiguredModel={showConfiguredModel}
                        showTokenTelemetry={showTokenTelemetry}
                        showTechnicalDetails={showDetailedTechnical}
                      />
                    ) : entry.item ? (
                      <p className="empty-evidence-copy">
                        Source evidence reference: {entry.evidenceRef}.
                      </p>
                    ) : (
                      <p className="empty-evidence-copy">
                        Recorded submission diff reference.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <section
      className="review-section activity-section"
      aria-labelledby="recorded-activity-title"
      id="reconstruction"
    >
      <header className="review-section-heading">
        <span className="evaluator-review-title-icon" aria-hidden="true">
          <IconListDetails size={22} stroke={1.8} />
        </span>
        <div>
          <p className="section-kicker">Chronological progression</p>
          <h2 id="recorded-activity-title">Session timeline</h2>
          <h3 id="summary-title" className="subheading-h3">
            What happened
          </h3>
          <p>
            Each factual statement is grounded in recorded session evidence.
            Expand evidence to inspect the exact technical record.
          </p>
        </div>
      </header>

      {aiSummary ? (
        <CompactAiSummary
          summary={aiSummary}
          showConfiguredModel={showConfiguredModel}
          showInterleaving={showDetailedTechnical}
        />
      ) : null}

      <ol
        className="activity-timeline"
        aria-label="Chronological activity statements"
      >
        {units.map((unit, unitIndex) => {
          if (unit.kind === 'single') {
            return renderActivityItem(
              unit.activity,
              unitIndex,
              activities.length,
            );
          }

          const isBurstExpanded = expandedBurstIds.has(unit.id);
          const elapsedRange =
            unit.startElapsed && unit.endElapsed
              ? `${unit.startElapsed}–${unit.endElapsed}`
              : (unit.startElapsed ?? null);

          return (
            <li
              key={unit.id}
              className="activity-item activity-burst-group"
              aria-label="Grouped AI interactions"
              data-evidence-refs={unit.activities
                .flatMap((activity) => activity.evidenceRefs)
                .join(' ')}
            >
              <div className="activity-marker-container" aria-hidden="true">
                <span className="activity-marker activity-marker-burst" />
                {unitIndex < units.length - 1 ? (
                  <span className="activity-line" />
                ) : null}
              </div>

              <div className="activity-content">
                <div className="activity-burst-header">
                  <div className="activity-burst-info">
                    <p className="activity-burst-title">
                      {unit.interactionCount} AI interactions recorded
                      {elapsedRange ? ` · ${elapsedRange}` : ''}
                    </p>
                    <span className="activity-status-tag status-completed">
                      {unit.interactionCount} completed
                    </span>
                  </div>

                  <button
                    type="button"
                    className="evidence-toggle-button burst-toggle-button"
                    aria-expanded={isBurstExpanded}
                    aria-controls={`burst-group-${unit.id}`}
                    onClick={() => toggleBurst(unit.id)}
                  >
                    <span>
                      {isBurstExpanded
                        ? 'Hide grouped interactions'
                        : `Expand ${unit.interactionCount} interactions`}
                    </span>
                    <span className="disclosure-chevron" aria-hidden="true">
                      {isBurstExpanded ? '▾' : '›'}
                    </span>
                  </button>
                </div>

                {isBurstExpanded ? (
                  <ol
                    id={`burst-group-${unit.id}`}
                    className="activity-burst-items"
                  >
                    {unit.activities.map((act, actIndex) =>
                      renderActivityItem(act, actIndex, unit.activities.length),
                    )}
                  </ol>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
};
