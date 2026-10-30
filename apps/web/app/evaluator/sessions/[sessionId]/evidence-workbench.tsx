'use client';

import { useEffect, useId, useState, type RefObject } from 'react';
import type { EvaluatorAiConversation } from '../../../../src/evaluator/evaluator-ai-conversations';
import type {
  EvaluatorReviewEvidence,
  EvaluatorReviewPresentation,
} from '../../../../src/evaluator/evaluator-review-presentation';
import { formatElapsed as formatElapsedValue } from '../../../../src/evaluator/evaluator-review-presentation';
import type { ProjectedBriefing } from '../../../../src/evaluator/project-evaluator-briefing';
import type { ReconstructionItem } from '../../../../src/evidence/chronological-reconstruction';
import type { CommandFinishedPayload } from '../../../../src/events/session-event';
import type { EvidenceCatalogEntry } from '../../../../src/reconstruction/evidence-reference-catalog';
import type { VerificationRun } from '../../../../src/evaluator/evaluator-briefing';
import type { R27Evidence } from '../../../../../../database/postgres/r27/contract.mjs';
import type { R28CandidateRevision } from '../../../../../../database/postgres/r28/contract.mjs';
import {
  buildR27Presentation,
  buildR27PresentationSources,
  formatExecutionProvenance,
  isRealRestrictedExecution,
  type R27Presentation,
  type R27PresentationSource,
} from '../../../../src/r27-evidence/presentation';
import {
  buildR28RevisionPresentation,
  type R28ComparisonMode,
} from '../../../../src/r28-revisions/presentation';
import {
  formatAnchorLabel,
  formatDigestBadge,
  formatObservationDisplayDate,
  validateObservationBody,
  OBJECTIVE_EVIDENCE_LABEL,
  HUMAN_INTERPRETATION_LABEL,
  CONCURRENCY_CONFLICT_MESSAGE,
  EVIDENCE_INTERPRETATION_NOTICE,
  type R29EvaluatorObservation,
  type R29EvidenceSourceType,
} from '../../../../src/r29-observations/presentation';
import { r29IsEnabled } from '../../../../src/r29-observations/config';
import { r210IsEnabled } from '../../../../src/r210-review-packets/config';
import {
  formatDigestBadge as formatR210DigestBadge,
  formatReviewPacketTimestamp,
  formatReferenceLabel,
  validatePacketReadinessForFinalization,
  OBJECTIVE_EVIDENCE_LABEL as R210_OBJECTIVE_LABEL,
  HUMAN_INTERPRETATION_LABEL as R210_HUMAN_LABEL,
  REVIEW_PACKET_FINALIZED_NOTICE,
  CONCURRENCY_CONFLICT_MESSAGE as R210_CONFLICT_MESSAGE,
  EVIDENCE_INTEGRITY_NOTICE as R210_INTEGRITY_NOTICE,
  type R210ReviewPacket,
  type R210ReferencedEvidence,
} from '../../../../src/r210-review-packets/presentation';
import { EvidenceItemCard } from './evidence-item-card';
import { SubmittedWork } from './submitted-work';
import { TechnicalRecord } from './technical-record';

export const evidenceFilters = [
  'Chronology',
  'Code changes',
  'Tests',
  'Terminal',
  'AI conversations',
  'Execution runs',
] as const;

export type EvidenceFilter = (typeof evidenceFilters)[number];

export type EvidenceSource = Readonly<{
  key: string;
  rowKey?: string;
  evidenceRef: string | null;
  evidenceRefs: readonly string[];
  entry: EvidenceCatalogEntry | null;
  item: ReconstructionItem | null;
  kind: 'record' | 'conversation' | 'test' | 'execution';
  title: string;
  summary: string;
  timestamp: string | null;
  chronologyOrder: number;
  verificationRun: VerificationRun | null;
  conversation: EvaluatorAiConversation | null;
  execution?: NonNullable<R27Evidence['executions']>[number] | null;
  r27?: R27PresentationSource;
}>;

export const verificationLabel = (run: VerificationRun) => {
  if (run.timedOut) return 'Timed out';
  if (run.counts?.failed)
    return `${run.counts.failed} failing check${run.counts.failed === 1 ? '' : 's'}`;
  if (run.exitCode !== null && run.exitCode !== 0)
    return `Exited with status ${run.exitCode}`;
  if (run.counts && run.counts.failed === 0 && run.exitCode === 0)
    return `${run.counts.passed} passed`;
  if (run.exitCode === 0)
    return 'Exited successfully; check details unavailable';
  if (run.counts?.failed === 0)
    return `${run.counts.passed} passed; exit status unavailable`;
  return 'Outcome unavailable';
};

const timestampForItem = (item: ReconstructionItem | null) =>
  item?.kind === 'COMMAND_EXECUTION'
    ? item.finishedAt
    : item && 'timestamp' in item
      ? item.timestamp
      : null;

const itemTitle = (entry: EvidenceCatalogEntry) => {
  const { item } = entry;
  if (entry.kind === 'final_diff') return 'Submitted changes';
  if (!item) return 'Recorded source unavailable';
  if (item.kind === 'SESSION_ACTIVATED') return 'Session started';
  if (item.kind === 'SESSION_SUBMITTED') return 'Session submitted';
  if (item.kind === 'COMMAND_EXECUTION') return `$ ${item.command}`;
  if (item.kind === 'WORKSPACE_CHANGE')
    return item.files[0]?.path
      ? `Workspace change · ${item.files[0].path}`
      : 'Workspace change';
  if (item.kind === 'WORKSPACE_GAP') return 'Activity capture incomplete';
  if (item.kind === 'AI_REQUEST_STARTED') return 'AI request recorded';
  if (item.kind === 'AI_RESPONSE_COMPLETED') return 'AI response recorded';
  if (item.kind === 'AI_REQUEST_CANCELLED') return 'AI request cancelled';
  if (item.kind === 'AI_REQUEST_FAILED') return 'AI request failed';
  return 'Recorded activity';
};

const itemSummary = (entry: EvidenceCatalogEntry) => {
  const { item } = entry;
  if (entry.kind === 'final_diff') return 'Server-derived submitted state';
  if (!item) return 'Source details unavailable';
  if (item.kind === 'COMMAND_EXECUTION')
    return `Exit status ${item.exitCode ?? 'not recorded'}${item.timedOut ? ' · timed out' : ''}`;
  if (item.kind === 'WORKSPACE_CHANGE')
    return `${item.files.length} recorded file change${item.files.length === 1 ? '' : 's'}`;
  if (item.kind === 'WORKSPACE_GAP')
    return 'The intermediate workspace state was not fully captured';
  if (item.kind === 'SESSION_SUBMITTED')
    return 'The submitted workspace state was frozen for review';
  if (item.kind === 'SESSION_ACTIVATED')
    return 'The candidate workspace became available';
  return 'Recorded session activity';
};

export const buildEvidenceSources = (
  review: EvaluatorReviewPresentation,
  projection: ProjectedBriefing,
  conversations: readonly EvaluatorAiConversation[],
): readonly EvidenceSource[] => {
  const entryByRef = new Map(
    review.evidenceEntries.map((entry) => [entry.evidenceRef, entry]),
  );
  const runByRef = new Map<string, VerificationRun>();
  for (const run of projection.briefing.recordedVerification.runs)
    for (const ref of run.evidenceRefs) runByRef.set(ref, run);

  const conversationByRef = new Map<string, EvaluatorAiConversation>();
  for (const conversation of conversations)
    for (const ref of conversation.evidenceRefs)
      conversationByRef.set(ref, conversation);

  const groupedConversationRefs = new Set(conversationByRef.keys());
  const records: EvidenceSource[] = review.evidenceEntries
    .filter(
      (entry) =>
        !entry.kind.startsWith('ai_') ||
        !groupedConversationRefs.has(entry.evidenceRef),
    )
    .map((entry) => ({
      key: entry.evidenceRef,
      evidenceRef: entry.evidenceRef,
      evidenceRefs: [entry.evidenceRef],
      entry,
      item: entry.item,
      kind: 'record',
      title: itemTitle(entry),
      summary: itemSummary(entry),
      timestamp:
        entry.kind === 'final_diff'
          ? review.session.submittedAt
          : timestampForItem(entry.item),
      chronologyOrder: entry.chronologyOrder ?? Number.MAX_SAFE_INTEGER,
      verificationRun: runByRef.get(entry.evidenceRef) ?? null,
      conversation: null,
    }));

  for (const conversation of conversations) {
    const refs = conversation.evidenceRefs;
    const entry = refs.map((ref) => entryByRef.get(ref)).find(Boolean) ?? null;
    const order = refs
      .map((ref) => entryByRef.get(ref)?.chronologyOrder)
      .filter((value): value is number => value !== null && value !== undefined)
      .sort((a, b) => a - b)[0];
    records.push({
      key: refs[0] ?? `ai:${conversation.interactionId}`,
      evidenceRef: refs[0] ?? null,
      evidenceRefs: refs,
      entry,
      item: entry?.item ?? null,
      kind: 'conversation',
      title: 'AI conversation',
      summary: `Recorded interaction · ${conversation.outcome}`,
      timestamp: conversation.startedAt ?? conversation.respondedAt,
      chronologyOrder: order ?? Number.MAX_SAFE_INTEGER,
      verificationRun: null,
      conversation,
    });
  }

  const existingKeys = new Set(records.map((source) => source.key));
  for (const [
    index,
    run,
  ] of projection.briefing.recordedVerification.runs.entries()) {
    const ref = run.evidenceRefs.find((candidate) => {
      const entry = entryByRef.get(candidate);
      return entry?.kind === 'command_execution';
    });
    if (ref && existingKeys.has(ref)) continue;
    records.push({
      key: ref ?? `test:${run.id}`,
      evidenceRef: ref ?? null,
      evidenceRefs: run.evidenceRefs,
      entry: ref ? (entryByRef.get(ref) ?? null) : null,
      item: ref ? (entryByRef.get(ref)?.item ?? null) : null,
      kind: 'test',
      title: `Recorded test run ${index + 1}`,
      summary: verificationLabel(run),
      timestamp: null,
      chronologyOrder: run.chronologyOrder,
      verificationRun: run,
      conversation: null,
    });
  }

  return records.sort(
    (a, b) =>
      a.chronologyOrder - b.chronologyOrder ||
      (a.timestamp ?? '').localeCompare(b.timestamp ?? ''),
  );
};

export const buildR27EvidenceSources = (
  evidence: R27Evidence,
  presentation: R27Presentation = buildR27Presentation(evidence),
) => {
  return buildR27PresentationSources(evidence, presentation).map(
    (source, index): EvidenceSource => {
      if (source.kind === 'event') {
        const event = source.event;
        const reference = `r27:${evidence.organizationId}:session:${evidence.sessionId}:event:${event.sequence}`;
        const payload = event.payload as Record<string, unknown> | undefined;
        const title =
          event.type === 'SESSION_ACTIVATED'
            ? 'Session activated'
            : event.type === 'WORKSPACE_CHANGED'
              ? 'Workspace save recorded'
              : event.type === 'AI_REQUEST_STARTED'
                ? 'AI request recorded'
                : event.type === 'AI_RESPONSE_COMPLETED'
                  ? 'AI response recorded'
                  : event.type === 'AI_REQUEST_FAILED'
                    ? 'AI request failed'
                    : event.type === 'EXECUTION_REQUESTED'
                      ? 'Execution requested'
                      : event.type === 'EXECUTION_COMPLETED'
                        ? 'Execution completed'
                        : event.type === 'EXECUTION_FAILED'
                          ? 'Execution failed'
                          : 'Session submitted';
        const summary =
          event.type === 'WORKSPACE_CHANGED'
            ? 'Save sequence and digest metadata are available; intermediate file content is unavailable.'
            : event.type === 'SESSION_ACTIVATED'
              ? 'Candidate workspace activation event'
              : event.type === 'AI_REQUEST_STARTED'
                ? `Candidate submitted prompt (${typeof payload?.promptChars === 'number' ? payload.promptChars : 0} chars)`
                : event.type === 'AI_RESPONSE_COMPLETED'
                  ? `Assistant response generated (${typeof payload?.durationMs === 'number' ? payload.durationMs : 0}ms)`
                  : event.type === 'AI_REQUEST_FAILED'
                    ? typeof payload?.errorMessage === 'string'
                      ? payload.errorMessage
                      : typeof payload?.failureReason === 'string'
                        ? payload.failureReason
                        : 'AI request failed'
                    : event.type === 'EXECUTION_REQUESTED'
                      ? `Candidate requested run checks for recipe ${typeof payload?.recipeId === 'string' ? payload.recipeId : ''}`
                      : event.type === 'EXECUTION_COMPLETED'
                        ? `Execution run completed (exit ${payload?.exitCode ?? 0})`
                        : event.type === 'EXECUTION_FAILED'
                          ? typeof payload?.errorMessage === 'string'
                            ? payload.errorMessage
                            : 'Execution run failed'
                          : 'Recorded session closure event';
        return {
          key: reference,
          evidenceRef: reference,
          evidenceRefs: [reference],
          entry: null,
          item: null,
          kind: 'record',
          title,
          summary,
          timestamp: event.timestamp,
          chronologyOrder: index,
          verificationRun: null,
          conversation: null,
          r27: source,
        };
      }

      if (source.kind === 'conversation') {
        const interaction = source.interaction;
        const reference = `r27:${evidence.organizationId}:session:${evidence.sessionId}:ai:${interaction.interactionId || interaction.requestId}`;
        const outcome =
          interaction.status === 'COMPLETED'
            ? 'completed'
            : interaction.status === 'FAILED'
              ? 'failed'
              : 'incomplete';
        return {
          key: reference,
          rowKey: reference,
          evidenceRef: reference,
          evidenceRefs: [
            reference,
            `r27:${evidence.organizationId}:session:${evidence.sessionId}:event:${interaction.sequenceStart}`,
            ...(interaction.sequenceCompleted
              ? [
                  `r27:${evidence.organizationId}:session:${evidence.sessionId}:event:${interaction.sequenceCompleted}`,
                ]
              : []),
          ],
          entry: null,
          item: null,
          kind: 'conversation',
          title: 'AI conversation',
          summary: `Recorded interaction · ${outcome} · ${interaction.providerId || 'synthetic-test-provider'}`,
          timestamp: interaction.createdAt,
          chronologyOrder: Number(interaction.sequenceStart) || index,
          verificationRun: null,
          conversation: {
            interactionId: interaction.interactionId || interaction.requestId,
            startedAt: interaction.createdAt,
            respondedAt: interaction.completedAt,
            elapsedLabel: null,
            responseElapsedLabel: null,
            prompt: interaction.candidatePrompt,
            promptTruncated: false,
            response: interaction.assistantResponse,
            responseTruncated: false,
            outcome,
            evidenceRefs: [reference],
          },
          r27: source,
        };
      }

      if (source.kind === 'execution') {
        const execution = source.execution;
        const reference = `r27:${evidence.organizationId}:session:${evidence.sessionId}:execution:${execution.operationId || execution.requestId}`;
        const outcome =
          execution.status === 'COMPLETED'
            ? execution.exitCode === 0
              ? 'Passed (Exit 0)'
              : `Failed (Exit ${execution.exitCode})`
            : execution.status === 'TIMED_OUT'
              ? 'Timed out'
              : execution.status === 'UNKNOWN'
                ? 'Unknown execution status'
                : 'Execution failed';
        const isReal = isRealRestrictedExecution(execution);
        const provenanceLabel = isReal
          ? 'Restricted Docker Executor (Development)'
          : '[Synthetic Test Result] · Synthetic execution (simulation)';
        return {
          key: reference,
          rowKey: reference,
          evidenceRef: reference,
          evidenceRefs: [
            reference,
            `r27:${evidence.organizationId}:session:${evidence.sessionId}:event:${execution.sequenceStart}`,
            ...(execution.sequenceCompleted
              ? [
                  `r27:${evidence.organizationId}:session:${evidence.sessionId}:event:${execution.sequenceCompleted}`,
                ]
              : []),
          ],
          entry: null,
          item: null,
          kind: 'execution',
          title: `Execution run · ${execution.recipeId || 'pytest'}`,
          summary: `Recorded execution receipt · ${outcome} · ${provenanceLabel}`,
          timestamp: execution.createdAt,
          chronologyOrder: Number(execution.sequenceStart) || index,
          verificationRun: null,
          conversation: null,
          execution,
          r27: source,
        };
      }

      const file = source.file;
      const reference = `r27:${evidence.organizationId}:session:${evidence.sessionId}:file:${encodeURIComponent(file.path)}`;
      return {
        key: reference,
        evidenceRef: reference,
        evidenceRefs: [reference],
        entry: null,
        item: null,
        kind: 'record',
        title: `Submitted file · ${file.path}`,
        summary:
          file.diff === null
            ? 'The starter content is unavailable; a derived comparison is not shown.'
            : file.starterContent === file.submittedContent
              ? 'No net content change from starter to submitted state.'
              : 'Derived from the authorized starter and submitted contents.',
        timestamp: evidence.submittedAt,
        chronologyOrder: index,
        verificationRun: null,
        conversation: null,
        execution: null,
        r27: source,
      };
    },
  );
};

export const sourcesForFilter = (
  sources: readonly EvidenceSource[],
  filter: EvidenceFilter,
  verificationRuns: readonly VerificationRun[],
) => {
  if (sources.some((source) => source.r27)) {
    if (filter === 'Chronology')
      return sources.filter((source) => source.r27?.kind === 'event');
    if (filter === 'Code changes')
      return sources.filter((source) => source.r27?.kind === 'file');
    if (filter === 'AI conversations')
      return sources.filter(
        (source) =>
          source.r27?.kind === 'conversation' || source.kind === 'conversation',
      );
    if (filter === 'Execution runs' || filter === 'Tests')
      return sources.filter(
        (source) =>
          source.r27?.kind === 'execution' || Boolean(source.execution),
      );
    return [];
  }
  if (filter === 'Chronology') return sources;
  if (filter === 'Code changes')
    return sources.filter(
      (source) =>
        source.entry?.kind === 'workspace_change' ||
        source.entry?.kind === 'evidence_gap' ||
        source.entry?.kind === 'final_diff',
    );
  if (filter === 'Execution runs') {
    return sources.filter(
      (source) => source.kind === 'execution' || Boolean(source.execution),
    );
  }
  if (filter === 'Tests') {
    return verificationRuns.map((run, index) => {
      const source = sources.find((candidate) =>
        run.evidenceRefs.includes(candidate.evidenceRef ?? ''),
      );
      return source
        ? {
            ...source,
            rowKey: `test:${run.id}`,
            verificationRun: run,
            title: `Recorded test run ${index + 1}`,
            summary: verificationLabel(run),
          }
        : {
            key: `test:${run.id}`,
            rowKey: `test:${run.id}`,
            evidenceRef: null,
            evidenceRefs: run.evidenceRefs,
            entry: null,
            item: null,
            kind: 'test' as const,
            title: `Recorded test run ${index + 1}`,
            summary: verificationLabel(run),
            timestamp: null,
            chronologyOrder: run.chronologyOrder,
            verificationRun: run,
            conversation: null,
            execution: null,
          };
    });
  }
  if (filter === 'Terminal')
    return sources.filter(
      (source) => source.entry?.kind === 'command_execution',
    );
  return sources.filter((source) => source.kind === 'conversation');
};

export const preferredEvidenceSource = (sources: readonly EvidenceSource[]) =>
  sources.find((source) => source.r27?.kind === 'file') ??
  sources.find((source) => source.r27?.kind === 'execution') ??
  sources.find((source) => source.verificationRun) ??
  sources.find(
    (source) => source.item && source.entry?.kind !== 'activation',
  ) ??
  sources[0] ??
  null;

export const formatEvidenceTime = (
  source: EvidenceSource,
  activatedAt: string | null,
) => {
  const timestamp = source.timestamp;
  if (!timestamp) return 'Time unavailable';
  return (
    formatElapsedValue(activatedAt, timestamp) ??
    new Date(timestamp).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  );
};

const captureStatus = (source: EvidenceSource) => {
  if (source.r27?.kind === 'event') return 'Recorded event metadata';
  if (source.r27?.kind === 'file')
    return source.r27.file.diff === null
      ? 'Starter state unavailable'
      : 'Submitted state available';
  if (source.kind === 'test' && !source.entry) return 'Source unavailable';
  if (source.entry?.kind === 'final_diff') return 'Submitted state available';
  if (source.conversation) {
    if (
      source.conversation.promptTruncated ||
      source.conversation.responseTruncated
    )
      return 'Truncated';
    if (
      source.conversation.prompt === null &&
      source.conversation.response === null
    )
      return 'Message text unavailable';
    if (
      source.conversation.prompt === null ||
      source.conversation.response === null
    )
      return 'One message unavailable';
    return 'Prompt and response captured';
  }
  if (source.item?.kind === 'WORKSPACE_GAP') return 'Capture incomplete';
  if (source.item?.kind === 'COMMAND_EXECUTION') {
    const output = source.item.rawFinishedEvent
      .payload as CommandFinishedPayload;
    return output.stdoutTruncated || output.stderrTruncated
      ? 'Truncated'
      : 'Capture complete';
  }
  if (source.item?.kind === 'WORKSPACE_CHANGE')
    return source.item.files.some((file) => file.patchTruncated)
      ? 'Truncated'
      : 'Capture complete';
  if (source.item) return 'Recorded source';
  return 'Source unavailable';
};

const commandOutcome = (item: ReconstructionItem | null) =>
  item?.kind === 'COMMAND_EXECUTION'
    ? item.timedOut
      ? 'Timed out'
      : `Exit status ${item.exitCode ?? 'not recorded'}`
    : null;

const ConversationMessage = ({
  author,
  timestamp,
  text,
  truncated,
}: Readonly<{
  author: string;
  timestamp: string | null;
  text: string | null;
  truncated: boolean;
}>) => (
  <article className="evaluator-ai-message">
    <header>
      <strong>{author}</strong>
      {timestamp ? (
        <time dateTime={timestamp}>
          {new Date(timestamp).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </time>
      ) : null}
    </header>
    {text === null ? (
      <p className="evaluator-ai-unavailable">Message text was not captured.</p>
    ) : text.length === 0 ? (
      <p className="evaluator-ai-unavailable">The recorded message is empty.</p>
    ) : (
      <pre tabIndex={0} aria-label={`Recorded ${author.toLowerCase()} message`}>
        {text}
      </pre>
    )}
    {truncated ? (
      <p className="evaluator-ai-limitation">
        Only the recorded excerpt is available; the message is incomplete.
      </p>
    ) : null}
  </article>
);

type LegacyInspectorProps = Readonly<{
  source: EvidenceSource | null;
  evidence: EvaluatorReviewEvidence;
  review: EvaluatorReviewPresentation;
  projection: ProjectedBriefing;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}>;

type R27InspectorProps = Readonly<{
  source: EvidenceSource | null;
  r27Evidence: R27Evidence;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}>;

const R29ObservationPanel = ({
  organizationId,
  sessionId,
  evidenceSourceType,
  eventSequence,
  filePath,
  fileVersion,
  evidenceDigest,
}: Readonly<{
  organizationId: string;
  sessionId: string;
  evidenceSourceType: R29EvidenceSourceType;
  eventSequence: string;
  filePath?: string | null;
  fileVersion?: string | null;
  evidenceDigest: string;
}>) => {
  const [observations, setObservations] = useState<
    readonly R29EvaluatorObservation[]
  >([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [newBody, setNewBody] = useState<string>('');
  const [creating, setCreating] = useState<boolean>(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<boolean>(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState<string>('');
  const [updating, setUpdating] = useState<boolean>(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);

  const getCsrfToken = (): string => {
    if (typeof document === 'undefined') return '';
    const match = document.cookie.match(/(?:^|;\s*)__Host-r23-csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  };

  useEffect(() => {
    let active = true;

    fetch(
      `/r27/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/observations`,
      { headers: { Accept: 'application/json' } },
    )
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 404 || response.status === 403) {
            return { observations: [] };
          }
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((data: { observations?: readonly R29EvaluatorObservation[] }) => {
        if (active) {
          setObservations(data.observations ?? []);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [organizationId, sessionId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const validation = validateObservationBody(newBody);
    if (!validation.valid || !validation.value) {
      setCreateError(validation.error ?? 'Observation body is invalid.');
      return;
    }

    try {
      setCreating(true);
      setCreateError(null);
      setCreateSuccess(false);
      const csrf = getCsrfToken();

      const response = await fetch(
        `/r27/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/observations`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
          },
          body: JSON.stringify({
            evidenceSourceType,
            eventSequence,
            filePath: filePath ?? null,
            fileVersion: fileVersion ?? null,
            evidenceDigest,
            body: validation.value,
            csrf,
          }),
        },
      );

      if (!response.ok) {
        const errJson = await response.json().catch(() => null);
        throw new Error(
          errJson?.error?.message ?? `Failed to save (HTTP ${response.status})`,
        );
      }

      const result = await response.json();
      if (result.observation) {
        setObservations((prev) => [result.observation, ...prev]);
        setNewBody('');
        setCreateSuccess(true);
      }
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleStartEdit = (obs: R29EvaluatorObservation) => {
    setEditingId(obs.id);
    setEditBody(obs.body);
    setUpdateError(null);
    setConflictError(null);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditBody('');
    setUpdateError(null);
    setConflictError(null);
  };

  const handleSaveEdit = async (obs: R29EvaluatorObservation) => {
    const validation = validateObservationBody(editBody);
    if (!validation.valid || !validation.value) {
      setUpdateError(validation.error ?? 'Observation body is invalid.');
      return;
    }

    try {
      setUpdating(true);
      setUpdateError(null);
      setConflictError(null);
      const csrf = getCsrfToken();

      const response = await fetch(
        `/r27/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/observations/${encodeURIComponent(obs.id)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
          },
          body: JSON.stringify({
            expectedVersion: obs.version,
            body: validation.value,
            csrf,
          }),
        },
      );

      if (response.status === 409) {
        setConflictError(CONCURRENCY_CONFLICT_MESSAGE);
        return;
      }

      if (!response.ok) {
        const errJson = await response.json().catch(() => null);
        throw new Error(
          errJson?.error?.message ??
            `Failed to update (HTTP ${response.status})`,
        );
      }

      const result = await response.json();
      if (result.observation) {
        setObservations((prev) =>
          prev.map((item) => (item.id === obs.id ? result.observation : item)),
        );
        setEditingId(null);
        setEditBody('');
      }
    } catch (err: unknown) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(false);
    }
  };

  const anchoredObservations = observations.filter(
    (obs) => obs.eventSequence === eventSequence,
  );

  const anchorLabel = formatAnchorLabel({
    evidenceSourceType,
    eventSequence,
    filePath,
    fileVersion,
  });

  if (!r29IsEnabled()) return null;

  return (
    <section
      className="evaluator-observation-panel"
      aria-label="Anchored Observations"
      style={{
        marginTop: '24px',
        padding: '16px',
        border: '1px solid var(--software-border, #d1d5db)',
        borderRadius: '8px',
        background: 'var(--software-surface-elevated, #fafafa)',
        minWidth: 0,
        maxWidth: '100%',
        boxSizing: 'border-box',
      }}
    >
      <header
        style={{
          marginBottom: '12px',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: '8px',
        }}
      >
        <div>
          <h3
            style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 600 }}
          >
            Anchored Observations
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: '12px',
              color: 'var(--software-muted, #4b5563)',
              lineHeight: 1.4,
            }}
          >
            {EVIDENCE_INTERPRETATION_NOTICE}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              background: '#e0e7ff',
              color: '#3730a3',
              padding: '3px 8px',
              borderRadius: '4px',
            }}
          >
            {OBJECTIVE_EVIDENCE_LABEL}
          </span>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              background: '#fef3c7',
              color: '#92400e',
              padding: '3px 8px',
              borderRadius: '4px',
            }}
          >
            {HUMAN_INTERPRETATION_LABEL}
          </span>
        </div>
      </header>

      {/* Anchor details */}
      <div
        style={{
          background: 'var(--software-surface, #ffffff)',
          border: '1px solid var(--software-border, #e5e7eb)',
          borderRadius: '6px',
          padding: '10px 14px',
          marginBottom: '16px',
          fontSize: '13px',
          minWidth: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            fontWeight: 600,
            marginBottom: '4px',
            wordBreak: 'break-word',
          }}
        >
          {anchorLabel}
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            fontSize: '12px',
            color: '#4b5563',
            alignItems: 'center',
          }}
        >
          <span>
            Sequence: <code>{eventSequence}</code>
          </span>
          <span>·</span>
          <span>
            Digest: <code>{formatDigestBadge(evidenceDigest)}</code>
          </span>
        </div>
      </div>

      {/* Existing observations */}
      <div style={{ marginBottom: '16px' }}>
        <h4
          style={{
            margin: '0 0 8px 0',
            fontSize: '13px',
            fontWeight: 600,
            color: '#374151',
          }}
        >
          Evaluator Notes ({anchoredObservations.length})
        </h4>

        {loading ? (
          <p style={{ fontSize: '13px', color: '#6b7280' }}>
            Loading observations…
          </p>
        ) : error ? (
          <p role="alert" style={{ fontSize: '13px', color: '#dc2626' }}>
            Failed to load observations: {error}
          </p>
        ) : anchoredObservations.length === 0 ? (
          <p
            style={{ fontSize: '13px', color: '#6b7280', fontStyle: 'italic' }}
          >
            No evaluator observations recorded for this evidence item yet.
          </p>
        ) : (
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
          >
            {anchoredObservations.map((obs) => {
              const isEditing = editingId === obs.id;
              return (
                <article
                  key={obs.id}
                  data-testid="evaluator-observation"
                  style={{
                    background: 'var(--software-surface, #ffffff)',
                    border: '1px solid var(--software-border, #e5e7eb)',
                    borderRadius: '6px',
                    padding: '12px',
                    minWidth: 0,
                    maxWidth: '100%',
                    boxSizing: 'border-box',
                  }}
                >
                  <header
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: '8px',
                      fontSize: '12px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        gap: '8px',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 600,
                          background: '#dbeafe',
                          color: '#1e40af',
                          padding: '1px 6px',
                          borderRadius: '4px',
                        }}
                      >
                        v{obs.version}
                      </span>
                      <time
                        dateTime={obs.updatedAt}
                        style={{ color: '#6b7280' }}
                      >
                        Updated {formatObservationDisplayDate(obs.updatedAt)}
                      </time>
                    </div>
                    {!isEditing ? (
                      <button
                        type="button"
                        onClick={() => handleStartEdit(obs)}
                        style={{
                          fontSize: '12px',
                          padding: '3px 8px',
                          borderRadius: '4px',
                          border: '1px solid #d1d5db',
                          background: '#fff',
                          cursor: 'pointer',
                        }}
                      >
                        Edit observation
                      </button>
                    ) : null}
                  </header>

                  {isEditing ? (
                    <div>
                      {conflictError ? (
                        <div
                          role="alert"
                          style={{
                            background: '#fee2e2',
                            color: '#991b1b',
                            padding: '8px 12px',
                            borderRadius: '4px',
                            fontSize: '13px',
                            marginBottom: '8px',
                            lineHeight: 1.4,
                          }}
                        >
                          {conflictError}
                        </div>
                      ) : null}
                      {updateError ? (
                        <div
                          role="alert"
                          style={{
                            background: '#fee2e2',
                            color: '#991b1b',
                            padding: '8px 12px',
                            borderRadius: '4px',
                            fontSize: '13px',
                            marginBottom: '8px',
                          }}
                        >
                          {updateError}
                        </div>
                      ) : null}
                      <textarea
                        aria-label="Edit observation body"
                        rows={4}
                        maxLength={10000}
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                        style={{
                          width: '100%',
                          minWidth: 0,
                          maxWidth: '100%',
                          boxSizing: 'border-box',
                          padding: '8px',
                          fontSize: '14px',
                          fontFamily: 'inherit',
                          borderRadius: '4px',
                          border: '1px solid #9ca3af',
                        }}
                      />
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginTop: '6px',
                          gap: '8px',
                        }}
                      >
                        <span style={{ fontSize: '11px', color: '#6b7280' }}>
                          {editBody.length} / 10000 characters
                        </span>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button
                            type="button"
                            onClick={handleCancelEdit}
                            disabled={updating}
                            style={{
                              fontSize: '12px',
                              padding: '4px 10px',
                              borderRadius: '4px',
                              border: '1px solid #d1d5db',
                              background: '#fff',
                              cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSaveEdit(obs)}
                            disabled={updating || !editBody.trim()}
                            style={{
                              fontSize: '12px',
                              padding: '4px 12px',
                              borderRadius: '4px',
                              border: 'none',
                              background: '#2563eb',
                              color: '#fff',
                              fontWeight: 600,
                              cursor:
                                updating || !editBody.trim()
                                  ? 'not-allowed'
                                  : 'pointer',
                              opacity: updating || !editBody.trim() ? 0.6 : 1,
                            }}
                          >
                            {updating ? 'Saving…' : 'Save changes'}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        fontSize: '14px',
                        lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        color: 'var(--software-ink, #111827)',
                      }}
                    >
                      {obs.body}
                    </div>
                  )}

                  {/* Expandable audit history */}
                  {obs.history && obs.history.length > 0 ? (
                    <details
                      style={{
                        marginTop: '10px',
                        paddingTop: '8px',
                        borderTop: '1px solid #f3f4f6',
                        fontSize: '12px',
                      }}
                    >
                      <summary
                        style={{
                          cursor: 'pointer',
                          color: '#4b5563',
                          fontWeight: 500,
                        }}
                      >
                        Audit history ({obs.history.length} earlier revision
                        {obs.history.length === 1 ? '' : 's'})
                      </summary>
                      <div
                        style={{
                          marginTop: '8px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px',
                          paddingLeft: '12px',
                          borderLeft: '2px solid #e5e7eb',
                        }}
                      >
                        {obs.history.map((h) => (
                          <div
                            key={h.historyId}
                            style={{ fontSize: '11px', color: '#4b5563' }}
                          >
                            <div style={{ fontWeight: 600 }}>
                              v{h.version} (
                              {formatObservationDisplayDate(h.validFrom)} -{' '}
                              {formatObservationDisplayDate(h.validUntil)}):
                            </div>
                            <div
                              style={{
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                fontStyle: 'italic',
                                marginTop: '2px',
                              }}
                            >
                              {h.body}
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* Authoring form */}
      <form
        onSubmit={handleCreate}
        style={{
          borderTop: '1px solid var(--software-border, #e5e7eb)',
          paddingTop: '14px',
          minWidth: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
        }}
      >
        <h4
          style={{
            margin: '0 0 6px 0',
            fontSize: '13px',
            fontWeight: 600,
            color: '#374151',
          }}
        >
          Record Observation
        </h4>

        {createError ? (
          <div
            role="alert"
            style={{
              background: '#fee2e2',
              color: '#991b1b',
              padding: '8px 12px',
              borderRadius: '4px',
              fontSize: '13px',
              marginBottom: '8px',
            }}
          >
            {createError}
          </div>
        ) : null}

        {createSuccess ? (
          <div
            role="status"
            style={{
              background: '#dcfce7',
              color: '#15803d',
              padding: '8px 12px',
              borderRadius: '4px',
              fontSize: '13px',
              marginBottom: '8px',
            }}
          >
            Observation saved.
          </div>
        ) : null}

        <textarea
          aria-label="Observation note"
          placeholder="Record human evaluator note anchored to this evidence…"
          rows={3}
          maxLength={10000}
          value={newBody}
          onChange={(e) => {
            setNewBody(e.target.value);
            if (createSuccess) setCreateSuccess(false);
          }}
          style={{
            width: '100%',
            minWidth: 0,
            maxWidth: '100%',
            boxSizing: 'border-box',
            padding: '8px 10px',
            fontSize: '14px',
            fontFamily: 'inherit',
            borderRadius: '6px',
            border: '1px solid #d1d5db',
          }}
        />

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: '8px',
            gap: '8px',
          }}
        >
          <span style={{ fontSize: '11px', color: '#6b7280' }}>
            {newBody.length} / 10000 characters
          </span>
          <button
            type="submit"
            disabled={creating || !newBody.trim()}
            style={{
              fontSize: '13px',
              padding: '6px 14px',
              borderRadius: '6px',
              border: 'none',
              background: '#2563eb',
              color: '#ffffff',
              fontWeight: 600,
              cursor: creating || !newBody.trim() ? 'not-allowed' : 'pointer',
              opacity: creating || !newBody.trim() ? 0.6 : 1,
            }}
          >
            {creating ? 'Saving…' : 'Save observation'}
          </button>
        </div>
      </form>
    </section>
  );
};

const revisionCache = new Map<string, R28CandidateRevision>();

const R28WorkspaceRevisionView = ({
  event,
  r27Evidence,
  headingId,
  headingRef,
  source,
  sourceReference,
  copySourceReference,
  copyStatus,
}: Readonly<{
  event: R27Evidence['events'][number];
  r27Evidence: R27Evidence;
  headingId: string;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  source: EvidenceSource;
  sourceReference: string | null | undefined;
  copySourceReference: (reference: string) => Promise<void>;
  copyStatus: string | null;
}>) => {
  const cacheKey = `${r27Evidence.organizationId}:${r27Evidence.sessionId}:${event.sequence}`;
  const [revision, setRevision] = useState<R28CandidateRevision | null>(
    () => revisionCache.get(cacheKey) ?? null,
  );
  const [loading, setLoading] = useState<boolean>(!revisionCache.has(cacheKey));
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<R28ComparisonMode>('content');

  useEffect(() => {
    if (revisionCache.has(cacheKey)) {
      return;
    }

    let active = true;

    fetch(
      `/r27/api/organizations/${encodeURIComponent(r27Evidence.organizationId)}/sessions/${encodeURIComponent(r27Evidence.sessionId)}/evidence/revisions/${encodeURIComponent(event.sequence)}`,
      { headers: { Accept: 'application/json' } },
    )
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 404) {
            return {
              organizationId: r27Evidence.organizationId,
              sessionId: r27Evidence.sessionId,
              filePath: 'workspace',
              version: '1',
              requestId: '',
              eventSequence: event.sequence,
              acceptedAt: event.timestamp,
              contentEncoding: 'utf-8' as const,
              content: null,
              contentLength: 0,
              contentDigest: '',
              previousVersion: '0',
              previousDigest: '',
              previousContent: null,
              starterContent: null,
              submittedContent: null,
              isSubmitted: false,
              availability: 'unavailable' as const,
              provenance: event.provenance,
            };
          }
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((data: R28CandidateRevision) => {
        revisionCache.set(cacheKey, data);
        if (active) {
          setRevision(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [
    cacheKey,
    r27Evidence.organizationId,
    r27Evidence.sessionId,
    event.sequence,
    event.timestamp,
    event.provenance,
  ]);

  const presentation = revision ? buildR28RevisionPresentation(revision) : null;
  const isAvailable =
    revision?.availability === 'available' && presentation?.content !== null;

  return (
    <section
      className="evaluator-source-inspector"
      aria-labelledby={headingId}
      data-source-inspector="true"
      data-source-ref={source.key}
      style={{ minWidth: 0, maxWidth: '100%' }}
    >
      <header className="evaluator-source-inspector-heading">
        <div>
          <p className="section-kicker">Session chronology · Selected event</p>
          <h2 id={headingId} ref={headingRef} tabIndex={-1}>
            {source.title}
          </h2>
          <p className="evaluator-source-summary">{source.summary}</p>
        </div>
        <span className="evaluator-source-status">
          {presentation ? presentation.statusBadge : 'Recorded event metadata'}
        </span>
      </header>

      {loading ? (
        <div
          role="status"
          aria-live="polite"
          className="evaluator-revision-loading"
          style={{ padding: '8px 0' }}
        >
          <p>Loading candidate file revision...</p>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="evaluator-revision-error"
          style={{ padding: '8px 0', color: 'var(--software-error, #b00)' }}
        >
          <p>Failed to load file revision: {error}</p>
        </div>
      ) : null}

      <dl className="evaluator-source-metadata">
        <div>
          <dt>Sequence</dt>
          <dd>
            <code>{event.sequence}</code>
          </dd>
        </div>
        <div>
          <dt>Event type</dt>
          <dd>
            <code>{event.type}</code>
          </dd>
        </div>
        <div>
          <dt>Timestamp</dt>
          <dd>
            <time dateTime={revision?.acceptedAt ?? event.timestamp}>
              {revision?.acceptedAt ?? event.timestamp}
            </time>
          </dd>
        </div>
        <div>
          <dt>Provenance</dt>
          <dd>
            <code>{revision?.provenance ?? event.provenance}</code>
          </dd>
        </div>
        {isAvailable && revision ? (
          <>
            <div>
              <dt>File path</dt>
              <dd>
                <code>{revision.filePath}</code>
              </dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>
                <code>v{revision.version}</code>
              </dd>
            </div>
            <div>
              <dt>Content digest</dt>
              <dd>
                <code
                  style={{
                    display: 'block',
                    maxWidth: '100%',
                    overflowX: 'auto',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {revision.contentDigest}
                </code>
              </dd>
            </div>
            <div>
              <dt>Request ID</dt>
              <dd>
                <code
                  style={{
                    display: 'block',
                    maxWidth: '100%',
                    overflowX: 'auto',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {revision.requestId}
                </code>
              </dd>
            </div>
          </>
        ) : null}
      </dl>

      {!loading && !isAvailable ? (
        <p className="evaluator-evidence-notice">
          This save is retained as sequence and digest metadata. Intermediate
          file content is unavailable.
        </p>
      ) : null}

      {!loading && isAvailable && presentation && revision ? (
        <div
          className="evaluator-revision-container"
          style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}
        >
          <div
            className="evaluator-revision-mode-selector"
            role="group"
            aria-label="Comparison mode"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '8px',
              margin: '12px 0',
            }}
          >
            <button
              type="button"
              aria-pressed={mode === 'content'}
              onClick={() => setMode('content')}
              className={`evaluator-mode-button ${mode === 'content' ? 'is-active' : ''}`}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                fontWeight: mode === 'content' ? 600 : 400,
                borderRadius: '6px',
                border: '1px solid var(--software-border)',
                background:
                  mode === 'content'
                    ? 'var(--software-lilac, #ede7f6)'
                    : 'var(--software-surface, #fff)',
                color: 'var(--software-ink)',
                cursor: 'pointer',
              }}
            >
              View file content at this revision
            </button>
            {presentation.hasPrevious ? (
              <button
                type="button"
                aria-pressed={mode === 'previous'}
                onClick={() => setMode('previous')}
                className={`evaluator-mode-button ${mode === 'previous' ? 'is-active' : ''}`}
                style={{
                  padding: '6px 12px',
                  fontSize: '12px',
                  fontWeight: mode === 'previous' ? 600 : 400,
                  borderRadius: '6px',
                  border: '1px solid var(--software-border)',
                  background:
                    mode === 'previous'
                      ? 'var(--software-lilac, #ede7f6)'
                      : 'var(--software-surface, #fff)',
                  color: 'var(--software-ink)',
                  cursor: 'pointer',
                }}
              >
                Diff with previous revision
              </button>
            ) : null}
            {presentation.hasStarter ? (
              <button
                type="button"
                aria-pressed={mode === 'starter'}
                onClick={() => setMode('starter')}
                className={`evaluator-mode-button ${mode === 'starter' ? 'is-active' : ''}`}
                style={{
                  padding: '6px 12px',
                  fontSize: '12px',
                  fontWeight: mode === 'starter' ? 600 : 400,
                  borderRadius: '6px',
                  border: '1px solid var(--software-border)',
                  background:
                    mode === 'starter'
                      ? 'var(--software-lilac, #ede7f6)'
                      : 'var(--software-surface, #fff)',
                  color: 'var(--software-ink)',
                  cursor: 'pointer',
                }}
              >
                Diff with starter baseline
              </button>
            ) : null}
            {presentation.hasSubmitted ? (
              <button
                type="button"
                aria-pressed={mode === 'submitted'}
                onClick={() => setMode('submitted')}
                className={`evaluator-mode-button ${mode === 'submitted' ? 'is-active' : ''}`}
                style={{
                  padding: '6px 12px',
                  fontSize: '12px',
                  fontWeight: mode === 'submitted' ? 600 : 400,
                  borderRadius: '6px',
                  border: '1px solid var(--software-border)',
                  background:
                    mode === 'submitted'
                      ? 'var(--software-lilac, #ede7f6)'
                      : 'var(--software-surface, #fff)',
                  color: 'var(--software-ink)',
                  cursor: 'pointer',
                }}
              >
                Diff with submitted code
              </button>
            ) : null}
          </div>

          <div
            className="evaluator-source-inspector-output"
            style={{ minWidth: 0, maxWidth: '100%' }}
          >
            {mode === 'content' ? (
              <>
                <h3>File content at this revision</h3>
                <pre
                  tabIndex={0}
                  aria-label={`File content for ${revision.filePath} at version ${revision.version}`}
                  style={{
                    minWidth: 0,
                    width: '100%',
                    maxWidth: '100%',
                    overflowX: 'auto',
                    whiteSpace: 'pre',
                  }}
                >
                  <code>{presentation.content ?? ''}</code>
                </pre>
              </>
            ) : mode === 'previous' ? (
              <>
                <h3>Diff with previous revision</h3>
                <pre
                  tabIndex={0}
                  aria-label={`Diff with previous revision for ${revision.filePath}`}
                  style={{
                    minWidth: 0,
                    width: '100%',
                    maxWidth: '100%',
                    overflowX: 'auto',
                    whiteSpace: 'pre',
                  }}
                >
                  <code>
                    {presentation.diffWithPrevious || 'No net content change.'}
                  </code>
                </pre>
              </>
            ) : mode === 'starter' ? (
              <>
                <h3>Diff with starter baseline</h3>
                <pre
                  tabIndex={0}
                  aria-label={`Diff with starter baseline for ${revision.filePath}`}
                  style={{
                    minWidth: 0,
                    width: '100%',
                    maxWidth: '100%',
                    overflowX: 'auto',
                    whiteSpace: 'pre',
                  }}
                >
                  <code>
                    {presentation.diffWithStarter || 'No net content change.'}
                  </code>
                </pre>
              </>
            ) : (
              <>
                <h3>Diff with submitted code</h3>
                <pre
                  tabIndex={0}
                  aria-label={`Diff with submitted code for ${revision.filePath}`}
                  style={{
                    minWidth: 0,
                    width: '100%',
                    maxWidth: '100%',
                    overflowX: 'auto',
                    whiteSpace: 'pre',
                  }}
                >
                  <code>
                    {presentation.diffWithSubmitted || 'No net content change.'}
                  </code>
                </pre>
              </>
            )}
          </div>
        </div>
      ) : null}

      <details
        className="evaluator-source-details"
        style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}
      >
        <summary>Recorded event payload</summary>
        <pre
          tabIndex={0}
          style={{
            minWidth: 0,
            width: '100%',
            maxWidth: '100%',
            overflowX: 'auto',
            whiteSpace: 'pre',
          }}
        >
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </details>

      {sourceReference ? (
        <details
          className="evaluator-source-details"
          style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}
        >
          <summary>Stable source reference</summary>
          <p>
            <code
              style={{
                display: 'block',
                maxWidth: '100%',
                overflowX: 'auto',
                whiteSpace: 'nowrap',
              }}
            >
              {sourceReference}
            </code>
          </p>
          <button
            type="button"
            onClick={() => void copySourceReference(sourceReference)}
          >
            Copy source reference
          </button>
          {copyStatus ? <span role="status">{copyStatus}</span> : null}
        </details>
      ) : null}

      <R29ObservationPanel
        organizationId={r27Evidence.organizationId}
        sessionId={r27Evidence.sessionId}
        evidenceSourceType="file_revision"
        eventSequence={event.sequence}
        filePath={
          revision?.filePath ??
          (event.payload?.path as string | undefined) ??
          null
        }
        fileVersion={
          revision?.version
            ? String(revision.version)
            : event.payload?.version
              ? String(event.payload.version)
              : null
        }
        evidenceDigest={
          revision?.contentDigest ??
          (event.payload?.digest as string | undefined) ??
          (event.payload?.contentDigest as string | undefined) ??
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        }
      />
    </section>
  );
};

const R27EvidenceSourceInspector = ({
  source,
  r27Evidence,
  headingId,
  headingRef,
}: Readonly<{
  source: EvidenceSource | null;
  r27Evidence: R27Evidence;
  headingId: string;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}>) => {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const copySourceReference = async (reference: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        setCopyStatus(
          'Clipboard access is unavailable. Select the reference to copy it.',
        );
        return;
      }
      await navigator.clipboard.writeText(reference);
      setCopyStatus('Stable source reference copied.');
    } catch {
      setCopyStatus(
        'Clipboard access is unavailable. Select the reference to copy it.',
      );
    }
  };
  const sourceReference = source?.evidenceRef;
  if (!source?.r27)
    return (
      <section
        className="evaluator-source-inspector"
        aria-label="Source inspection"
      >
        <h2>No source selected</h2>
        <p>No authorized R2.7 source is selected.</p>
      </section>
    );

  if (source.r27.kind === 'conversation' || source.conversation) {
    const interaction =
      source.r27.kind === 'conversation' ? source.r27.interaction : null;
    const providerName = interaction?.providerId ?? 'synthetic-test-provider';
    const authorAssistant = `Synthetic Assistant (${providerName})`;
    const eventSequence = interaction?.sequenceStart ?? null;

    return (
      <section
        className="evaluator-source-inspector"
        aria-labelledby={headingId}
        data-source-inspector="true"
        data-source-ref={source.key}
        style={{ minWidth: 0, maxWidth: '100%' }}
      >
        <header className="evaluator-source-inspector-heading">
          <div>
            <p className="section-kicker">
              Session AI conversation · Selected interaction
            </p>
            <h2 id={headingId} ref={headingRef} tabIndex={-1}>
              {source.title}
            </h2>
            <p className="evaluator-source-summary">{source.summary}</p>
          </div>
          <span className="evaluator-source-status">
            {source.conversation?.outcome === 'completed'
              ? 'Completed'
              : source.conversation?.outcome === 'failed'
                ? 'Failed'
                : 'Recorded interaction'}
          </span>
        </header>

        <dl className="evaluator-source-metadata">
          <div>
            <dt>Provider</dt>
            <dd>
              <code>{providerName}</code>
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>
              <code>{interaction?.modelId ?? 'synthetic-model-r212'}</code>
            </dd>
          </div>
          <div>
            <dt>Started at</dt>
            <dd>
              <time dateTime={source.conversation?.startedAt ?? undefined}>
                {source.conversation?.startedAt ?? 'Unavailable'}
              </time>
            </dd>
          </div>
          {source.conversation?.respondedAt ? (
            <div>
              <dt>Completed at</dt>
              <dd>
                <time dateTime={source.conversation.respondedAt}>
                  {source.conversation.respondedAt}
                </time>
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="evaluator-source-inspector-output">
          <div className="evaluator-ai-message-list">
            <ConversationMessage
              author="Candidate"
              timestamp={source.conversation?.startedAt ?? null}
              text={source.conversation?.prompt ?? null}
              truncated={Boolean(source.conversation?.promptTruncated)}
            />
            {source.conversation?.response !== null &&
            source.conversation?.response !== undefined ? (
              <ConversationMessage
                author={authorAssistant}
                timestamp={source.conversation?.respondedAt ?? null}
                text={source.conversation.response}
                truncated={Boolean(source.conversation?.responseTruncated)}
              />
            ) : source.conversation?.outcome === 'failed' ? (
              <p className="evaluator-muted-copy" role="alert">
                Interaction failed:{' '}
                {interaction?.errorMessage ||
                  interaction?.failureReason ||
                  'Failed to generate response.'}
              </p>
            ) : (
              <p className="evaluator-muted-copy">
                No assistant response was recorded for this interaction.
              </p>
            )}
          </div>
        </div>

        {sourceReference ? (
          <details
            className="evaluator-source-details"
            style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}
          >
            <summary>Stable source reference</summary>
            <p>
              <code
                style={{
                  display: 'block',
                  maxWidth: '100%',
                  overflowX: 'auto',
                  whiteSpace: 'nowrap',
                }}
              >
                {sourceReference}
              </code>
            </p>
            <button
              type="button"
              onClick={() => void copySourceReference(sourceReference)}
            >
              Copy source reference
            </button>
            {copyStatus ? <span role="status">{copyStatus}</span> : null}
          </details>
        ) : null}

        {eventSequence ? (
          <R29ObservationPanel
            organizationId={r27Evidence.organizationId}
            sessionId={r27Evidence.sessionId}
            evidenceSourceType="timeline_event"
            eventSequence={eventSequence}
            evidenceDigest={eventSequence}
          />
        ) : null}
      </section>
    );
  }

  if (source.r27?.kind === 'execution' || source.execution) {
    const execution =
      source.r27?.kind === 'execution'
        ? source.r27.execution
        : source.execution!;
    const isRealExecution = isRealRestrictedExecution(execution);
    const provenanceDisplay = formatExecutionProvenance(execution);
    const statusText =
      execution.status === 'COMPLETED'
        ? execution.exitCode === 0
          ? 'Passed (Exit 0)'
          : `Failed (Exit ${execution.exitCode})`
        : execution.status === 'TIMED_OUT'
          ? 'Timed out'
          : execution.status === 'UNKNOWN' || execution.isUnknown
            ? 'Unknown'
            : 'Failed';

    return (
      <section
        className="evaluator-source-inspector"
        aria-labelledby={headingId}
        data-source-inspector="true"
        data-source-ref={source.key}
        data-testid="execution-source-inspector"
        style={{ minWidth: 0, maxWidth: '100%' }}
      >
        <header className="evaluator-source-inspector-heading">
          <div>
            <p className="section-kicker">
              Session execution run · Candidate test execution
            </p>
            <h2 id={headingId} ref={headingRef} tabIndex={-1}>
              {source.title}
            </h2>
            <p className="evaluator-source-summary">{source.summary}</p>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: '0.25rem',
            }}
          >
            <span
              className="evaluator-source-status"
              data-testid="execution-status-badge"
            >
              {statusText}
            </span>
            <span
              className={
                isRealExecution
                  ? 'r214-real-executor-badge'
                  : 'r213-synthetic-badge'
              }
              data-testid={
                isRealExecution
                  ? 'real-execution-receipt-badge'
                  : 'synthetic-execution-receipt-badge'
              }
              style={
                isRealExecution
                  ? {
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: '#0984e3',
                      background: '#e8f4fd',
                      padding: '0.2rem 0.5rem',
                      borderRadius: '4px',
                      border: '1px solid #74b9ff',
                    }
                  : {
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: '#6c5ce7',
                      background: '#f0eeff',
                      padding: '0.2rem 0.5rem',
                      borderRadius: '4px',
                      border: '1px solid #dcd6ff',
                    }
              }
            >
              {isRealExecution
                ? 'Restricted Docker Executor (Development)'
                : '[Synthetic Execution Receipt · Test Lane] · Synthetic execution (simulation)'}
            </span>
            {execution.isUnknown || execution.status === 'UNKNOWN' ? (
              <span
                className="r213-unknown-badge"
                data-testid="unknown-execution-badge"
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  color: '#d63031',
                  background: '#ffeaa7',
                  padding: '0.2rem 0.5rem',
                  borderRadius: '4px',
                }}
              >
                [UNKNOWN EXECUTION STATE]
              </span>
            ) : null}
          </div>
        </header>

        {/* Evaluator Notice: Clear disclaimer that no automatic hiring decision or ranking is produced */}
        <div
          className="evaluator-evidence-disclaimer"
          data-testid="execution-evaluator-disclaimer"
          style={{
            margin: '0.75rem 0',
            padding: '0.6rem 0.85rem',
            background: '#f8f9fa',
            border: '1px solid #dfe6e9',
            borderRadius: '4px',
            fontSize: '0.8rem',
            color: '#636e72',
          }}
        >
          <strong>Evaluator Notice:</strong> Factual execution record only. No
          automatic hiring decision, score, or ranking is produced. The human
          evaluator owns all judgment.
        </div>

        <dl className="evaluator-source-metadata">
          <div>
            <dt>Execution Provenance</dt>
            <dd>
              <span data-testid="execution-factual-provenance">
                {provenanceDisplay}
              </span>
            </dd>
          </div>
          <div>
            <dt>Recipe ID</dt>
            <dd>
              <code>{execution.recipeId}</code>
            </dd>
          </div>
          <div>
            <dt>Recipe Version</dt>
            <dd>
              <code>{execution.recipeVersion}</code>
            </dd>
          </div>
          <div>
            <dt>Recipe Digest</dt>
            <dd>
              <code style={{ wordBreak: 'break-all' }}>
                {execution.recipeDigest}
              </code>
            </dd>
          </div>
          <div>
            <dt>Workspace Snapshot</dt>
            <dd>
              <code style={{ wordBreak: 'break-all' }}>
                {execution.workspaceDigest}
              </code>
            </dd>
          </div>
          <div>
            <dt>Workspace Version</dt>
            <dd>
              <code>{execution.workspaceVersion}</code>
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <code data-testid="execution-exit-status">
                {execution.status}
              </code>
            </dd>
          </div>
          <div>
            <dt>Exit Code</dt>
            <dd>
              <code data-testid="execution-exit-code">
                {execution.exitCode !== null
                  ? execution.exitCode
                  : 'null (None)'}
              </code>
            </dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>
              <span data-testid="execution-duration">
                {execution.durationMs !== null
                  ? `${execution.durationMs}ms`
                  : 'Unavailable'}
              </span>
            </dd>
          </div>
          <div>
            <dt>Sequence & Fence</dt>
            <dd>
              <span>
                Start: {execution.sequenceStart} · Fence: {execution.fence} ·
                Gen: {execution.generation}
              </span>
            </dd>
          </div>
          <div>
            <dt>Cleanup Status</dt>
            <dd>
              <code data-testid="execution-cleanup-status">
                {execution.cleanupStatus}
              </code>
            </dd>
          </div>
          <div>
            <dt>Provenance</dt>
            <dd>
              <code data-testid="execution-raw-provenance">
                {execution.provenance}
              </code>
            </dd>
          </div>
          {execution.failureReason ? (
            <div>
              <dt>Failure Reason</dt>
              <dd>
                <code data-testid="execution-failure-reason">
                  {execution.failureReason}
                </code>
              </dd>
            </div>
          ) : null}
          {execution.errorMessage ? (
            <div>
              <dt>Error Message</dt>
              <dd>
                <code data-testid="execution-error-message">
                  {execution.errorMessage}
                </code>
              </dd>
            </div>
          ) : null}
          {execution.stdoutDigest ? (
            <div>
              <dt>Stdout Digest</dt>
              <dd>
                <code
                  data-testid="execution-stdout-digest"
                  style={{ wordBreak: 'break-all' }}
                >
                  {execution.stdoutDigest}
                </code>
              </dd>
            </div>
          ) : null}
          {execution.stderrDigest ? (
            <div>
              <dt>Stderr Digest</dt>
              <dd>
                <code
                  data-testid="execution-stderr-digest"
                  style={{ wordBreak: 'break-all' }}
                >
                  {execution.stderrDigest}
                </code>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Executed at</dt>
            <dd>
              <time dateTime={execution.createdAt}>{execution.createdAt}</time>
            </dd>
          </div>
          {execution.completedAt ? (
            <div>
              <dt>Completed at</dt>
              <dd>
                <time dateTime={execution.completedAt}>
                  {execution.completedAt}
                </time>
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="evaluator-source-inspector-output">
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
              width: '100%',
            }}
          >
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.25rem',
                }}
              >
                <strong style={{ fontSize: '0.85rem' }}>
                  Captured Standard Output (stdout)
                </strong>
                {execution.truncatedStdout ? (
                  <span
                    style={{ fontSize: '0.75rem', color: '#e17055' }}
                    data-testid="stdout-truncated-notice"
                  >
                    [Output truncated at limit]
                  </span>
                ) : null}
              </div>
              <pre
                data-testid="evaluator-execution-stdout"
                style={{
                  background: '#181622',
                  color: '#a6e3a1',
                  padding: '0.75rem',
                  borderRadius: '6px',
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                  maxHeight: '260px',
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {execution.stdout || '(No standard output)'}
              </pre>
            </div>

            {execution.stderr || execution.truncatedStderr ? (
              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.25rem',
                  }}
                >
                  <strong style={{ fontSize: '0.85rem' }}>
                    Captured Standard Error (stderr)
                  </strong>
                  {execution.truncatedStderr ? (
                    <span
                      style={{ fontSize: '0.75rem', color: '#e17055' }}
                      data-testid="stderr-truncated-notice"
                    >
                      [Output truncated at limit]
                    </span>
                  ) : null}
                </div>
                <pre
                  data-testid="execution-inspector-stderr"
                  style={{
                    background: '#221618',
                    color: '#ff7675',
                    padding: '0.75rem',
                    borderRadius: '6px',
                    fontFamily: 'monospace',
                    fontSize: '0.85rem',
                    maxHeight: '200px',
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {execution.stderr || '(No standard error)'}
                </pre>
              </div>
            ) : null}
          </div>
        </div>

        {sourceReference ? (
          <details
            className="evaluator-source-details"
            style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}
          >
            <summary>Stable source reference</summary>
            <p>
              <code
                style={{
                  display: 'block',
                  maxWidth: '100%',
                  overflowX: 'auto',
                  whiteSpace: 'nowrap',
                }}
              >
                {sourceReference}
              </code>
            </p>
            <button
              type="button"
              onClick={() => void copySourceReference(sourceReference)}
            >
              Copy source reference
            </button>
            {copyStatus ? <span role="status">{copyStatus}</span> : null}
          </details>
        ) : null}

        {execution.sequenceStart ? (
          <R29ObservationPanel
            organizationId={r27Evidence.organizationId}
            sessionId={r27Evidence.sessionId}
            evidenceSourceType="timeline_event"
            eventSequence={String(execution.sequenceStart)}
            evidenceDigest={String(execution.sequenceStart)}
          />
        ) : null}
      </section>
    );
  }

  if (source.r27.kind === 'event') {
    const { event } = source.r27;
    if (event.type === 'WORKSPACE_CHANGED') {
      return (
        <R28WorkspaceRevisionView
          key={event.sequence}
          event={event}
          r27Evidence={r27Evidence}
          headingId={headingId}
          headingRef={headingRef}
          source={source}
          sourceReference={sourceReference}
          copySourceReference={copySourceReference}
          copyStatus={copyStatus}
        />
      );
    }
    return (
      <section
        className="evaluator-source-inspector"
        aria-labelledby={headingId}
        data-source-inspector="true"
        data-source-ref={source.key}
        style={{ minWidth: 0, maxWidth: '100%' }}
      >
        <header className="evaluator-source-inspector-heading">
          <div>
            <p className="section-kicker">
              Session chronology · Selected event
            </p>
            <h2 id={headingId} ref={headingRef} tabIndex={-1}>
              {source.title}
            </h2>
            <p className="evaluator-source-summary">{source.summary}</p>
          </div>
          <span className="evaluator-source-status">
            Recorded event metadata
          </span>
        </header>
        <dl className="evaluator-source-metadata">
          <div>
            <dt>Sequence</dt>
            <dd>
              <code>{event.sequence}</code>
            </dd>
          </div>
          <div>
            <dt>Event type</dt>
            <dd>
              <code>{event.type}</code>
            </dd>
          </div>
          <div>
            <dt>Timestamp</dt>
            <dd>
              <time dateTime={event.timestamp}>{event.timestamp}</time>
            </dd>
          </div>
          <div>
            <dt>Provenance</dt>
            <dd>
              <code>{event.provenance}</code>
            </dd>
          </div>
        </dl>
        <details
          className="evaluator-source-details"
          style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}
        >
          <summary>Recorded event payload</summary>
          <pre
            tabIndex={0}
            style={{
              minWidth: 0,
              width: '100%',
              maxWidth: '100%',
              overflowX: 'auto',
              whiteSpace: 'pre',
            }}
          >
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </details>
        {sourceReference ? (
          <details
            className="evaluator-source-details"
            style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}
          >
            <summary>Stable source reference</summary>
            <p>
              <code
                style={{
                  display: 'block',
                  maxWidth: '100%',
                  overflowX: 'auto',
                  whiteSpace: 'nowrap',
                }}
              >
                {sourceReference}
              </code>
            </p>
            <button
              type="button"
              onClick={() => void copySourceReference(sourceReference)}
            >
              Copy source reference
            </button>
            {copyStatus ? <span role="status">{copyStatus}</span> : null}
          </details>
        ) : null}

        <R29ObservationPanel
          organizationId={r27Evidence.organizationId}
          sessionId={r27Evidence.sessionId}
          evidenceSourceType="timeline_event"
          eventSequence={event.sequence}
          evidenceDigest={
            (event.payload?.digest as string | undefined) ??
            (event.payload?.workspaceDigest as string | undefined) ??
            (event.payload?.manifestDigest as string | undefined) ??
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
          }
        />
      </section>
    );
  }

  const { file } = source.r27;
  return (
    <section
      className="evaluator-source-inspector"
      aria-labelledby={headingId}
      data-source-inspector="true"
      data-source-ref={source.key}
      style={{ minWidth: 0, maxWidth: '100%' }}
    >
      <header className="evaluator-source-inspector-heading">
        <div>
          <p className="section-kicker">Submitted file · Selected source</p>
          <h2 id={headingId} ref={headingRef} tabIndex={-1}>
            {file.path}
          </h2>
          <p className="evaluator-source-summary">{source.summary}</p>
        </div>
        <span className="evaluator-source-status">{captureStatus(source)}</span>
      </header>
      <div
        className="evaluator-source-inspector-output"
        style={{ minWidth: 0, maxWidth: '100%' }}
      >
        <h3>Starter content</h3>
        {file.starterContent === null ? (
          <p className="evaluator-muted-copy">
            Starter content was not available in the authorized snapshot.
          </p>
        ) : (
          <pre
            tabIndex={0}
            aria-label={`Starter content for ${file.path}`}
            style={{
              minWidth: 0,
              width: '100%',
              maxWidth: '100%',
              overflowX: 'auto',
              whiteSpace: 'pre',
            }}
          >
            {file.starterContent}
          </pre>
        )}
        <h3>Submitted content</h3>
        {file.submittedContent === null ? (
          <p className="evaluator-muted-copy">
            This path is absent from the frozen submitted workspace.
          </p>
        ) : (
          <pre
            tabIndex={0}
            aria-label={`Submitted content for ${file.path}`}
            style={{
              minWidth: 0,
              width: '100%',
              maxWidth: '100%',
              overflowX: 'auto',
              whiteSpace: 'pre',
            }}
          >
            {file.submittedContent}
          </pre>
        )}
        <h3>Derived starter-to-submission diff</h3>
        {file.diff === null ? (
          <p className="evaluator-muted-copy">
            The starter baseline is unavailable, so a diff is not derived.
          </p>
        ) : (
          <pre
            tabIndex={0}
            aria-label={`Derived diff for ${file.path}`}
            style={{
              minWidth: 0,
              width: '100%',
              maxWidth: '100%',
              overflowX: 'auto',
              whiteSpace: 'pre',
            }}
          >
            {file.diff || 'No net content change.'}
          </pre>
        )}
      </div>
      <details
        className="evaluator-source-details"
        style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}
      >
        <summary>File version and digest metadata</summary>
        <dl className="evaluator-source-metadata">
          <div>
            <dt>Starter version</dt>
            <dd>
              <code
                style={{
                  display: 'block',
                  maxWidth: '100%',
                  overflowX: 'auto',
                  whiteSpace: 'nowrap',
                }}
              >
                {file.starterVersion ?? 'Unavailable'}
              </code>
            </dd>
          </div>
          <div>
            <dt>Starter digest</dt>
            <dd>
              <code
                style={{
                  display: 'block',
                  maxWidth: '100%',
                  overflowX: 'auto',
                  whiteSpace: 'nowrap',
                }}
              >
                {file.starterDigest ?? 'Unavailable'}
              </code>
            </dd>
          </div>
          <div>
            <dt>Submitted version</dt>
            <dd>
              <code
                style={{
                  display: 'block',
                  maxWidth: '100%',
                  overflowX: 'auto',
                  whiteSpace: 'nowrap',
                }}
              >
                {file.submittedVersion ?? 'Unavailable'}
              </code>
            </dd>
          </div>
          <div>
            <dt>Submitted digest</dt>
            <dd>
              <code
                style={{
                  display: 'block',
                  maxWidth: '100%',
                  overflowX: 'auto',
                  whiteSpace: 'nowrap',
                }}
              >
                {file.submittedDigest ?? 'Unavailable'}
              </code>
            </dd>
          </div>
        </dl>
      </details>
      <p
        className="evaluator-muted-copy"
        style={{
          minWidth: 0,
          maxWidth: '100%',
          overflowWrap: 'anywhere',
        }}
      >
        Session {r27Evidence.sessionId}; submission digest{' '}
        <code
          style={{
            display: 'inline-block',
            maxWidth: '100%',
            overflowX: 'auto',
            whiteSpace: 'nowrap',
            verticalAlign: 'bottom',
          }}
        >
          {r27Evidence.submission.workspaceDigest}
        </code>
        .
      </p>
      {sourceReference ? (
        <details
          className="evaluator-source-details"
          style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}
        >
          <summary>Stable source reference</summary>
          <p>
            <code
              style={{
                display: 'block',
                maxWidth: '100%',
                overflowX: 'auto',
                whiteSpace: 'nowrap',
              }}
            >
              {sourceReference}
            </code>
          </p>
          <button
            type="button"
            onClick={() => void copySourceReference(sourceReference)}
          >
            Copy source reference
          </button>
          {copyStatus ? <span role="status">{copyStatus}</span> : null}
        </details>
      ) : null}
    </section>
  );
};

export const EvidenceSourceInspector = (
  props: LegacyInspectorProps | R27InspectorProps,
) => {
  const headingId = `evaluator-source-inspector-title-${useId()}`;
  const [copyFeedback, setCopyFeedback] = useState<{
    reference: string;
    message: string;
  } | null>(null);
  if ('r27Evidence' in props)
    return (
      <R27EvidenceSourceInspector
        source={props.source}
        r27Evidence={props.r27Evidence}
        headingId={headingId}
        headingRef={props.headingRef}
      />
    );

  const { source, evidence, review, projection, headingRef } = props;
  if (!source)
    return (
      <section
        className="evaluator-source-inspector"
        aria-label="Source inspection"
      >
        <h2>No source selected</h2>
        <p>No recorded source is available to inspect.</p>
      </section>
    );

  const depth = projection.defaultDepth;
  const showTechnicalDetails = depth.technicalRecord;
  const timestamp = source.timestamp;
  const outcome = source.verificationRun
    ? verificationLabel(source.verificationRun)
    : commandOutcome(source.item);
  const sourceSummary = [
    source.verificationRun ? `Test result · ${outcome}` : null,
    source.verificationRun && commandOutcome(source.item)
      ? `Command outcome · ${commandOutcome(source.item)}`
      : null,
    !source.verificationRun && outcome ? `Command outcome · ${outcome}` : null,
    !source.verificationRun && !outcome ? source.summary : null,
  ]
    .filter((value): value is string => value !== null)
    .join(' · ');
  const copyReference = async () => {
    const reference = source.evidenceRef;
    if (!reference) return;
    if (!navigator.clipboard?.writeText) {
      setCopyFeedback({
        reference,
        message:
          'Clipboard access is unavailable. Select the reference above to copy it.',
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(reference);
      setCopyFeedback({ reference, message: 'Evidence reference copied.' });
    } catch {
      setCopyFeedback({
        reference,
        message:
          'Clipboard access is unavailable. Select the reference above to copy it.',
      });
    }
  };
  const sourceLabel = source.conversation
    ? 'AI conversation'
    : source.execution
      ? 'Execution run'
      : source.entry?.kind === 'command_execution'
        ? 'Terminal capture'
        : source.entry?.kind === 'workspace_change' ||
            source.entry?.kind === 'evidence_gap'
          ? 'Code change record'
          : source.entry?.kind === 'final_diff'
            ? 'Submitted state'
            : source.entry?.kind === 'activation'
              ? 'Session chronology'
              : source.entry?.kind === 'submission'
                ? 'Session chronology'
                : 'Recorded source';

  return (
    <section
      className="evaluator-source-inspector"
      aria-labelledby={headingId}
      data-source-inspector="true"
      data-source-ref={source.evidenceRef ?? source.key}
    >
      <header className="evaluator-source-inspector-heading">
        <div>
          <p className="section-kicker">{sourceLabel} · Selected source</p>
          <h2 id={headingId} ref={headingRef} tabIndex={-1}>
            {source.title}
          </h2>
          <p className="evaluator-source-summary">{sourceSummary}</p>
        </div>
        <span
          className="evaluator-source-status"
          aria-label={`Capture status: ${captureStatus(source)}`}
        >
          {captureStatus(source)}
        </span>
      </header>

      <div className="evaluator-source-inspector-output">
        {source.entry?.kind === 'final_diff' ? (
          <SubmittedWork
            submittedState={projection.briefing.submittedState}
            diff={review.submittedDiff}
            embedded
          />
        ) : source.conversation ? (
          <div className="evaluator-ai-message-list">
            <ConversationMessage
              author="Candidate"
              timestamp={source.conversation.startedAt}
              text={source.conversation.prompt}
              truncated={source.conversation.promptTruncated}
            />
            {source.conversation.response !== null ? (
              <ConversationMessage
                author="Weft"
                timestamp={source.conversation.respondedAt}
                text={source.conversation.response}
                truncated={source.conversation.responseTruncated}
              />
            ) : (
              <p className="evaluator-muted-copy">
                No assistant response was recorded for this interaction.
              </p>
            )}
          </div>
        ) : source.item ? (
          <EvidenceItemCard
            key={source.key}
            item={source.item}
            elapsedLabel={formatEvidenceTime(source, evidence.activatedAt)}
            showConfiguredModel={depth.aiConfiguredModel}
            showTokenTelemetry={depth.aiTokenTelemetry}
            showTechnicalDetails={showTechnicalDetails}
            sourceInspector
          />
        ) : (
          <p className="evaluator-muted-copy">
            {source.verificationRun
              ? 'A recognized test execution is recorded, but its linked command source is unavailable.'
              : 'The source record is unavailable in the authorized evidence provided for this session.'}
          </p>
        )}
      </div>

      <details className="evaluator-source-details">
        <summary>Source details</summary>
        <dl className="evaluator-source-metadata">
          <div>
            <dt>Recorded</dt>
            <dd>
              {timestamp ? (
                <time dateTime={timestamp}>
                  {formatEvidenceTime(source, evidence.activatedAt)}
                </time>
              ) : (
                'Time unavailable'
              )}
            </dd>
          </div>
          {source.item?.kind === 'COMMAND_EXECUTION' ? (
            <>
              <div>
                <dt>Duration</dt>
                <dd>{source.item.durationMs} ms</dd>
              </div>
              <div>
                <dt>Working directory</dt>
                <dd>
                  <code>{source.item.cwd}</code>
                </dd>
              </div>
            </>
          ) : null}
          {showTechnicalDetails && source.evidenceRef ? (
            <div>
              <dt>Evidence reference</dt>
              <dd>
                <code>{source.evidenceRef}</code>{' '}
                <button
                  type="button"
                  className="evaluator-text-link"
                  aria-label="Copy evidence reference"
                  onClick={() => void copyReference()}
                >
                  Copy reference
                </button>
                {copyFeedback?.reference === source.evidenceRef ? (
                  <span className="evaluator-source-copy-status" role="status">
                    {copyFeedback.message}
                  </span>
                ) : null}
              </dd>
            </div>
          ) : null}
          {showTechnicalDetails && source.entry ? (
            <div>
              <dt>Record kind</dt>
              <dd>{source.entry.kind}</dd>
            </div>
          ) : null}
        </dl>
      </details>

      {showTechnicalDetails ? (
        <details className="evaluator-technical-record-disclosure">
          <summary>Open complete technical record</summary>
          <TechnicalRecord review={review} activatedAt={evidence.activatedAt} />
        </details>
      ) : null}
    </section>
  );
};

export type R210ReviewPacketPanelProps = Readonly<{
  organizationId: string;
  sessionId: string;
  reviewer: Readonly<{ subjectId: string; principalId: string }>;
  r27Evidence: R27Evidence;
  sources?: readonly EvidenceSource[];
  onOpenEvidence?: (filter?: EvidenceFilter, source?: EvidenceSource) => void;
}>;

export const R210ReviewPacketPanel = ({
  organizationId,
  sessionId,
  reviewer,
  r27Evidence,
  sources = [],
  onOpenEvidence,
}: R210ReviewPacketPanelProps) => {
  const [packet, setPacket] = useState<R210ReviewPacket | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [availableObservations, setAvailableObservations] = useState<
    readonly R29EvaluatorObservation[]
  >([]);

  // Draft form state
  const [summary, setSummary] = useState<string>('');
  const [strengthsText, setStrengthsText] = useState<string>('');
  const [concernsText, setConcernsText] = useState<string>('');
  const [questionsText, setQuestionsText] = useState<string>('');
  const [selectedObservationIds, setSelectedObservationIds] = useState<
    Set<string>
  >(new Set());
  const [selectedEvidenceRefs, setSelectedEvidenceRefs] = useState<
    Map<string, R210ReferencedEvidence>
  >(new Map());

  // Saved baseline for dirty tracking
  const [savedBaseline, setSavedBaseline] = useState<{
    summary: string;
    strengthsText: string;
    concernsText: string;
    questionsText: string;
    obsIds: string;
    evidenceKeys: string;
  }>({
    summary: '',
    strengthsText: '',
    concernsText: '',
    questionsText: '',
    obsIds: '',
    evidenceKeys: '',
  });

  const [saving, setSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedMessage, setLastSavedMessage] = useState<string | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);

  // Finalization state
  const [finalizing, setFinalizing] = useState<boolean>(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [confirmModalOpen, setConfirmModalOpen] = useState<boolean>(false);

  const getCsrfToken = (): string => {
    if (typeof document === 'undefined') return '';
    const match = document.cookie.match(/(?:^|;\s*)__Host-r23-csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  };

  const evidenceKey = (ref: {
    evidenceSourceType: string;
    eventSequence: string;
    filePath?: string | null;
  }) =>
    ref.evidenceSourceType === 'file_revision'
      ? `file:${ref.filePath}:${ref.eventSequence}`
      : `event:${ref.eventSequence}`;

  useEffect(() => {
    let active = true;

    async function fetchData() {
      try {
        const [packetRes, obsRes] = await Promise.all([
          fetch(
            `/r27/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/review-packet`,
            { headers: { Accept: 'application/json' } },
          ),
          fetch(
            `/r27/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/observations`,
            { headers: { Accept: 'application/json' } },
          ),
        ]);

        if (!active) return;

        let currentPacket: R210ReviewPacket | null = null;
        if (packetRes.ok) {
          const data = await packetRes.json();
          currentPacket = data.reviewPacket ?? null;
          if (active) setPacket(currentPacket);
        } else if (packetRes.status !== 404 && packetRes.status !== 403) {
          throw new Error(
            `Failed to load review packet (HTTP ${packetRes.status})`,
          );
        }

        if (currentPacket && active) {
          const initialSummary = currentPacket.summary ?? '';
          const initialStrengths = (currentPacket.strengths ?? []).join('\n');
          const initialConcerns = (currentPacket.concerns ?? []).join('\n');
          const initialQuestions = (
            currentPacket.unresolvedQuestions ?? []
          ).join('\n');
          const obsSet = new Set(currentPacket.referencedObservationIds ?? []);
          const evMap = new Map<string, R210ReferencedEvidence>();
          for (const ev of currentPacket.referencedEvidence ?? []) {
            evMap.set(
              ev.evidenceSourceType === 'file_revision'
                ? `file:${ev.filePath}:${ev.eventSequence}`
                : `event:${ev.eventSequence}`,
              ev,
            );
          }

          setSummary(initialSummary);
          setStrengthsText(initialStrengths);
          setConcernsText(initialConcerns);
          setQuestionsText(initialQuestions);
          setSelectedObservationIds(obsSet);
          setSelectedEvidenceRefs(evMap);

          setSavedBaseline({
            summary: initialSummary,
            strengthsText: initialStrengths,
            concernsText: initialConcerns,
            questionsText: initialQuestions,
            obsIds: Array.from(obsSet).sort().join(','),
            evidenceKeys: Array.from(evMap.keys()).sort().join(','),
          });
        }

        if (obsRes.ok && active) {
          const obsData = await obsRes.json();
          setAvailableObservations(obsData.observations ?? []);
        }
      } catch (err: unknown) {
        if (active) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void fetchData();

    return () => {
      active = false;
    };
  }, [organizationId, sessionId]);

  const handleReloadLatest = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      setConflictError(null);

      const [packetRes, obsRes] = await Promise.all([
        fetch(
          `/r27/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/review-packet`,
          { headers: { Accept: 'application/json' } },
        ),
        fetch(
          `/r27/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/observations`,
          { headers: { Accept: 'application/json' } },
        ),
      ]);

      let currentPacket: R210ReviewPacket | null = null;
      if (packetRes.ok) {
        const data = await packetRes.json();
        currentPacket = data.reviewPacket ?? null;
        setPacket(currentPacket);
      } else if (packetRes.status !== 404 && packetRes.status !== 403) {
        throw new Error(
          `Failed to load review packet (HTTP ${packetRes.status})`,
        );
      }

      if (currentPacket) {
        const initialSummary = currentPacket.summary ?? '';
        const initialStrengths = (currentPacket.strengths ?? []).join('\n');
        const initialConcerns = (currentPacket.concerns ?? []).join('\n');
        const initialQuestions = (currentPacket.unresolvedQuestions ?? []).join(
          '\n',
        );
        const obsSet = new Set(currentPacket.referencedObservationIds ?? []);
        const evMap = new Map<string, R210ReferencedEvidence>();
        for (const ev of currentPacket.referencedEvidence ?? []) {
          evMap.set(evidenceKey(ev), ev);
        }

        setSummary(initialSummary);
        setStrengthsText(initialStrengths);
        setConcernsText(initialConcerns);
        setQuestionsText(initialQuestions);
        setSelectedObservationIds(obsSet);
        setSelectedEvidenceRefs(evMap);

        setSavedBaseline({
          summary: initialSummary,
          strengthsText: initialStrengths,
          concernsText: initialConcerns,
          questionsText: initialQuestions,
          obsIds: Array.from(obsSet).sort().join(','),
          evidenceKeys: Array.from(evMap.keys()).sort().join(','),
        });
      }

      if (obsRes.ok) {
        const obsData = await obsRes.json();
        setAvailableObservations(obsData.observations ?? []);
      }
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const parseLines = (text: string): string[] =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  // Dirty detection
  const currentObsIdsSorted = Array.from(selectedObservationIds)
    .sort()
    .join(',');
  const currentEvidenceKeysSorted = Array.from(selectedEvidenceRefs.keys())
    .sort()
    .join(',');
  const isDirty =
    Boolean(packet?.status === 'DRAFT' || !packet) &&
    (summary !== savedBaseline.summary ||
      strengthsText !== savedBaseline.strengthsText ||
      concernsText !== savedBaseline.concernsText ||
      questionsText !== savedBaseline.questionsText ||
      currentObsIdsSorted !== savedBaseline.obsIds ||
      currentEvidenceKeysSorted !== savedBaseline.evidenceKeys);

  const handleSaveDraft = async () => {
    try {
      setSaving(true);
      setSaveError(null);
      setConflictError(null);
      const csrf = getCsrfToken();

      const payload = {
        summary: summary.trim(),
        strengths: parseLines(strengthsText),
        concerns: parseLines(concernsText),
        unresolvedQuestions: parseLines(questionsText),
        referencedObservationIds: Array.from(selectedObservationIds),
        referencedEvidence: Array.from(selectedEvidenceRefs.values()),
        ...(packet ? { expectedVersion: packet.version } : {}),
        csrf,
      };

      const response = await fetch(
        `/r27/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/review-packet`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
          },
          body: JSON.stringify(payload),
        },
      );

      if (response.status === 409) {
        setConflictError(R210_CONFLICT_MESSAGE);
        return;
      }

      if (!response.ok) {
        const errJson = await response.json().catch(() => null);
        throw new Error(
          errJson?.error?.message ??
            `Failed to save review packet draft (HTTP ${response.status})`,
        );
      }

      const result = await response.json();
      const updatedPacket: R210ReviewPacket = result.reviewPacket;
      setPacket(updatedPacket);

      const savedSummary = updatedPacket.summary ?? '';
      const savedStrengths = (updatedPacket.strengths ?? []).join('\n');
      const savedConcerns = (updatedPacket.concerns ?? []).join('\n');
      const savedQuestions = (updatedPacket.unresolvedQuestions ?? []).join(
        '\n',
      );
      const savedObsSet = new Set(updatedPacket.referencedObservationIds ?? []);
      const savedEvMap = new Map<string, R210ReferencedEvidence>();
      for (const ev of updatedPacket.referencedEvidence ?? []) {
        savedEvMap.set(evidenceKey(ev), ev);
      }

      setSavedBaseline({
        summary: savedSummary,
        strengthsText: savedStrengths,
        concernsText: savedConcerns,
        questionsText: savedQuestions,
        obsIds: Array.from(savedObsSet).sort().join(','),
        evidenceKeys: Array.from(savedEvMap.keys()).sort().join(','),
      });

      setLastSavedMessage(`Draft saved at ${new Date().toLocaleTimeString()}`);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handlePromptFinalize = () => {
    setFinalizeError(null);
    const readiness = validatePacketReadinessForFinalization({
      summary: summary.trim(),
      referencedObservationIds: Array.from(selectedObservationIds),
      referencedEvidence: Array.from(selectedEvidenceRefs.values()),
    });
    if (!readiness.valid) {
      setFinalizeError(
        readiness.errors?.join(' ') ??
          'Review packet cannot be finalized without a summary and at least one citation.',
      );
      return;
    }
    setConfirmModalOpen(true);
  };

  const handleConfirmFinalize = async () => {
    if (!packet) {
      setFinalizeError('Please save a draft before finalizing.');
      setConfirmModalOpen(false);
      return;
    }

    try {
      setFinalizing(true);
      setFinalizeError(null);
      setConflictError(null);
      const csrf = getCsrfToken();

      const response = await fetch(
        `/r27/api/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(sessionId)}/review-packet/finalize`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
          },
          body: JSON.stringify({
            expectedVersion: packet.version,
            csrf,
          }),
        },
      );

      if (response.status === 409) {
        setConflictError(R210_CONFLICT_MESSAGE);
        setConfirmModalOpen(false);
        return;
      }

      if (!response.ok) {
        const errJson = await response.json().catch(() => null);
        throw new Error(
          errJson?.error?.message ??
            `Failed to finalize review packet (HTTP ${response.status})`,
        );
      }

      const result = await response.json();
      setPacket(result.reviewPacket);
      setConfirmModalOpen(false);
    } catch (err: unknown) {
      setFinalizeError(err instanceof Error ? err.message : String(err));
      setConfirmModalOpen(false);
    } finally {
      setFinalizing(false);
    }
  };

  const toggleObservationCitation = (obsId: string) => {
    setSelectedObservationIds((prev) => {
      const next = new Set(prev);
      if (next.has(obsId)) {
        next.delete(obsId);
      } else {
        next.add(obsId);
      }
      return next;
    });
  };

  const toggleEvidenceCitation = (item: R210ReferencedEvidence) => {
    const key = evidenceKey(item);
    setSelectedEvidenceRefs((prev) => {
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.set(key, item);
      }
      return next;
    });
  };

  const navigateToObservation = (obs: R29EvaluatorObservation) => {
    if (!onOpenEvidence) return;
    const filter: EvidenceFilter =
      obs.evidenceSourceType === 'file_revision'
        ? 'Code changes'
        : 'Chronology';
    const matched = sources.find((s) => {
      if (
        obs.evidenceSourceType === 'file_revision' &&
        s.r27?.kind === 'file'
      ) {
        return s.r27.file.path === obs.filePath;
      }
      if (
        obs.evidenceSourceType === 'timeline_event' &&
        s.r27?.kind === 'event'
      ) {
        return s.r27.event.sequence === obs.eventSequence;
      }
      return false;
    });
    onOpenEvidence(filter, matched);
  };

  const navigateToEvidence = (ref: R210ReferencedEvidence) => {
    if (!onOpenEvidence) return;
    const filter: EvidenceFilter =
      ref.evidenceSourceType === 'file_revision'
        ? 'Code changes'
        : 'Chronology';
    const matched = sources.find((s) => {
      if (
        ref.evidenceSourceType === 'file_revision' &&
        s.r27?.kind === 'file'
      ) {
        return s.r27.file.path === ref.filePath;
      }
      if (
        ref.evidenceSourceType === 'timeline_event' &&
        s.r27?.kind === 'event'
      ) {
        return s.r27.event.sequence === ref.eventSequence;
      }
      return false;
    });
    onOpenEvidence(filter, matched);
  };

  if (!r210IsEnabled()) return null;

  if (loading) {
    return (
      <section
        className="evaluator-review-card"
        aria-label="Review packet loading"
        style={{ padding: '24px', textAlign: 'center' }}
      >
        <p style={{ color: 'var(--software-muted, #6b7280)' }}>
          Loading human review packet...
        </p>
      </section>
    );
  }

  if (loadError) {
    return (
      <section
        className="evaluator-review-card"
        aria-label="Review packet error"
        style={{ padding: '24px' }}
      >
        <p role="alert" style={{ color: '#dc2626' }}>
          {loadError}
        </p>
        <button
          type="button"
          onClick={() => void handleReloadLatest()}
          className="button-secondary"
        >
          Retry
        </button>
      </section>
    );
  }

  const isFinalized = packet?.status === 'FINALIZED';

  return (
    <div
      className="evaluator-review-card evaluator-review-packet"
      data-testid="evaluator-review-packet"
      style={{
        padding: 'clamp(16px, 2.5vw, 28px)',
        border: '1px solid var(--software-border, #d1d5db)',
        borderRadius: '12px',
        backgroundColor: 'var(--software-surface, #ffffff)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        minWidth: 0,
        maxWidth: '100%',
        boxSizing: 'border-box',
        overflowWrap: 'anywhere',
      }}
    >
      {/* Top Header */}
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '12px',
          marginBottom: '20px',
          borderBottom: '1px solid var(--software-border, #e5e7eb)',
          paddingBottom: '16px',
        }}
      >
        <div>
          <p
            className="section-kicker"
            style={{
              margin: '0 0 4px 0',
              fontSize: '11px',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--software-muted, #6b7280)',
            }}
          >
            Reviewer · {reviewer.principalId}
          </p>
          <h2
            style={{
              margin: 0,
              fontSize: 'clamp(18px, 2vw, 22px)',
              fontWeight: 700,
              color: 'var(--software-ink, #111827)',
            }}
          >
            Structured Human Review Packet
          </h2>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          <span
            data-testid="review-packet-status"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '4px 10px',
              borderRadius: '9999px',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              backgroundColor: isFinalized ? '#dcfce7' : '#fef3c7',
              color: isFinalized ? '#166534' : '#92400e',
              border: isFinalized ? '1px solid #86efac' : '1px solid #fde68a',
            }}
          >
            {isFinalized ? 'FINALIZED' : 'DRAFT'}
          </span>

          {isDirty && !isFinalized ? (
            <span
              data-testid="review-packet-unsaved-badge"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '4px 10px',
                borderRadius: '9999px',
                fontSize: '11px',
                fontWeight: 600,
                backgroundColor: '#fee2e2',
                color: '#991b1b',
                border: '1px solid #fca5a5',
              }}
            >
              Unsaved changes
            </span>
          ) : null}

          {packet?.version ? (
            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--software-muted, #6b7280)',
              }}
            >
              v{packet.version}
            </span>
          ) : null}

          {isFinalized && packet?.finalDigest ? (
            <span
              data-testid="review-packet-final-digest"
              title={packet.finalDigest}
              style={{
                fontFamily: 'var(--software-mono, monospace)',
                fontSize: '11px',
                padding: '3px 8px',
                borderRadius: '6px',
                backgroundColor: '#f3f4f6',
                color: '#374151',
                border: '1px solid #d1d5db',
              }}
            >
              {formatR210DigestBadge(packet.finalDigest)}
            </span>
          ) : null}
        </div>
      </header>

      {/* Non-negotiable boundary banner */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px',
          alignItems: 'center',
          padding: '8px 12px',
          marginBottom: '16px',
          borderRadius: '6px',
          backgroundColor: 'var(--software-surface-elevated, #f9fafb)',
          border: '1px solid var(--software-border, #e5e7eb)',
          fontSize: '12px',
          color: 'var(--software-muted, #4b5563)',
        }}
      >
        <span
          style={{
            fontSize: '10px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            padding: '2px 6px',
            borderRadius: '4px',
            backgroundColor: '#e0e7ff',
            color: '#3730a3',
          }}
        >
          {R210_OBJECTIVE_LABEL}
        </span>
        <span
          style={{
            fontSize: '10px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            padding: '2px 6px',
            borderRadius: '4px',
            backgroundColor: '#fef3c7',
            color: '#92400e',
          }}
        >
          {R210_HUMAN_LABEL}
        </span>
        <span style={{ flex: 1, minWidth: '200px' }}>
          {R210_INTEGRITY_NOTICE}
        </span>
      </div>

      {/* Optimistic Concurrency Conflict Banner */}
      {conflictError ? (
        <div
          role="alert"
          data-testid="review-packet-conflict-banner"
          style={{
            padding: '12px 16px',
            marginBottom: '16px',
            borderRadius: '8px',
            backgroundColor: '#fef2f2',
            border: '1px solid #f87171',
            color: '#991b1b',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontWeight: 500, fontSize: '13px' }}>
            {conflictError}
          </div>
          <button
            type="button"
            onClick={() => void handleReloadLatest()}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              backgroundColor: '#dc2626',
              color: '#ffffff',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '12px',
            }}
          >
            Reload latest changes
          </button>
        </div>
      ) : null}

      {/* Finalized Notice */}
      {isFinalized ? (
        <div
          data-testid="review-packet-finalized-notice"
          role="status"
          style={{
            padding: '12px 16px',
            marginBottom: '20px',
            borderRadius: '8px',
            backgroundColor: '#f0fdf4',
            border: '1px solid #86efac',
            color: '#166534',
            fontSize: '13px',
            fontWeight: 500,
          }}
        >
          {REVIEW_PACKET_FINALIZED_NOTICE}
        </div>
      ) : null}

      {/* Mode 1: FINALIZED READ-ONLY PRESENTATION */}
      {isFinalized && packet ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Metadata */}
          <dl
            className="evaluator-source-metadata"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '12px',
              padding: '12px 16px',
              margin: 0,
              borderRadius: '8px',
              backgroundColor: 'var(--software-surface-elevated, #f9fafb)',
              border: '1px solid var(--software-border, #e5e7eb)',
              fontSize: '12px',
            }}
          >
            <div>
              <dt
                style={{
                  color: 'var(--software-muted, #6b7280)',
                  fontWeight: 600,
                }}
              >
                Reviewer Author
              </dt>
              <dd style={{ margin: '4px 0 0 0', fontWeight: 500 }}>
                <code>{packet.authorPrincipalId}</code>
              </dd>
            </div>
            <div>
              <dt
                style={{
                  color: 'var(--software-muted, #6b7280)',
                  fontWeight: 600,
                }}
              >
                Finalized At (UTC)
              </dt>
              <dd style={{ margin: '4px 0 0 0', fontWeight: 500 }}>
                <time dateTime={packet.finalizedAt ?? undefined}>
                  {packet.finalizedAt
                    ? formatReviewPacketTimestamp(packet.finalizedAt)
                    : 'Unavailable'}
                </time>
              </dd>
            </div>
            <div>
              <dt
                style={{
                  color: 'var(--software-muted, #6b7280)',
                  fontWeight: 600,
                }}
              >
                Content-Integrity Digest
              </dt>
              <dd
                style={{
                  margin: '4px 0 0 0',
                  fontFamily: 'var(--software-mono, monospace)',
                  wordBreak: 'break-all',
                }}
              >
                <code>{packet.finalDigest}</code>
              </dd>
            </div>
          </dl>

          {/* Summary */}
          <section data-testid="review-packet-summary">
            <h3
              style={{
                fontSize: '15px',
                fontWeight: 700,
                margin: '0 0 8px 0',
                color: 'var(--software-ink, #111827)',
              }}
            >
              Review Summary
            </h3>
            <div
              style={{
                whiteSpace: 'pre-wrap',
                lineHeight: 1.6,
                fontSize: '14px',
                padding: '14px 16px',
                borderRadius: '8px',
                backgroundColor: 'var(--software-surface-elevated, #f9fafb)',
                border: '1px solid var(--software-border, #e5e7eb)',
                color: 'var(--software-ink, #1f2937)',
              }}
            >
              {packet.summary}
            </div>
          </section>

          {/* Strengths */}
          {packet.strengths && packet.strengths.length > 0 ? (
            <section data-testid="review-packet-strengths">
              <h3
                style={{
                  fontSize: '15px',
                  fontWeight: 700,
                  margin: '0 0 8px 0',
                  color: '#15803d',
                }}
              >
                Key Strengths
              </h3>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: '20px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  fontSize: '14px',
                  lineHeight: 1.5,
                }}
              >
                {packet.strengths.map((str, i) => (
                  <li key={i}>{str}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Concerns */}
          {packet.concerns && packet.concerns.length > 0 ? (
            <section data-testid="review-packet-concerns">
              <h3
                style={{
                  fontSize: '15px',
                  fontWeight: 700,
                  margin: '0 0 8px 0',
                  color: '#b45309',
                }}
              >
                Concerns & Risks
              </h3>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: '20px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  fontSize: '14px',
                  lineHeight: 1.5,
                }}
              >
                {packet.concerns.map((con, i) => (
                  <li key={i}>{con}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Unresolved Questions */}
          {packet.unresolvedQuestions &&
          packet.unresolvedQuestions.length > 0 ? (
            <section data-testid="review-packet-questions">
              <h3
                style={{
                  fontSize: '15px',
                  fontWeight: 700,
                  margin: '0 0 8px 0',
                  color: 'var(--software-ink, #374151)',
                }}
              >
                Unresolved Questions
              </h3>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: '20px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  fontSize: '14px',
                  lineHeight: 1.5,
                }}
              >
                {packet.unresolvedQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Cited Grounded References */}
          <section data-testid="review-packet-citations">
            <h3
              style={{
                fontSize: '15px',
                fontWeight: 700,
                margin: '0 0 10px 0',
                color: 'var(--software-ink, #111827)',
              }}
            >
              Grounded Evidence & Observation Citations
            </h3>

            {/* Cited Observations */}
            {packet.referencedObservationIds &&
            packet.referencedObservationIds.length > 0 ? (
              <div
                data-testid="review-packet-cited-observations"
                style={{
                  marginBottom: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    color: 'var(--software-muted, #6b7280)',
                  }}
                >
                  Cited Observations ({packet.referencedObservationIds.length})
                </div>
                {packet.referencedObservationIds.map((obsId) => {
                  const obs = availableObservations.find((o) => o.id === obsId);
                  return (
                    <div
                      key={obsId}
                      style={{
                        padding: '10px 14px',
                        borderRadius: '6px',
                        backgroundColor: '#fffbeb',
                        border: '1px solid #fde68a',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '12px',
                        flexWrap: 'wrap',
                      }}
                    >
                      <div
                        style={{ flex: 1, minWidth: '220px', fontSize: '13px' }}
                      >
                        <strong>
                          Observation #{obs?.eventSequence ?? '?'}:
                        </strong>{' '}
                        <span>
                          {obs?.body ? `"${obs.body}"` : `UUID: ${obsId}`}
                        </span>
                      </div>
                      {obs && onOpenEvidence ? (
                        <button
                          type="button"
                          className="evaluator-text-link"
                          onClick={() => navigateToObservation(obs)}
                          style={{
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          Inspect observation in workbench →
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* Cited Evidence Items */}
            {packet.referencedEvidence &&
            packet.referencedEvidence.length > 0 ? (
              <div
                data-testid="review-packet-cited-evidence"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    color: 'var(--software-muted, #6b7280)',
                  }}
                >
                  Cited Candidate Evidence ({packet.referencedEvidence.length})
                </div>
                {packet.referencedEvidence.map((ev, i) => (
                  <div
                    key={i}
                    style={{
                      padding: '10px 14px',
                      borderRadius: '6px',
                      backgroundColor: '#eff6ff',
                      border: '1px solid #bfdbfe',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '12px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div
                      style={{ flex: 1, minWidth: '220px', fontSize: '13px' }}
                    >
                      <strong>{formatReferenceLabel(ev)}</strong>
                      <span
                        style={{
                          marginLeft: '8px',
                          fontFamily: 'monospace',
                          fontSize: '11px',
                          color: '#4b5563',
                        }}
                      >
                        {formatR210DigestBadge(ev.evidenceDigest)}
                      </span>
                    </div>
                    {onOpenEvidence ? (
                      <button
                        type="button"
                        className="evaluator-text-link"
                        onClick={() => navigateToEvidence(ev)}
                        style={{
                          fontSize: '12px',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        Inspect candidate evidence →
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </div>
      ) : (
        /* Mode 2: DRAFT REVIEW FORM */
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSaveDraft();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}
        >
          {/* Summary Input */}
          <div>
            <label
              htmlFor="review-packet-summary"
              style={{
                display: 'block',
                fontWeight: 700,
                fontSize: '14px',
                marginBottom: '6px',
                color: 'var(--software-ink, #111827)',
              }}
            >
              Review summary{' '}
              <span
                style={{
                  fontWeight: 400,
                  fontSize: '12px',
                  color: 'var(--software-muted, #6b7280)',
                }}
              >
                (Required for finalization, min 10 characters)
              </span>
            </label>
            <textarea
              id="review-packet-summary"
              aria-label="Review summary"
              rows={5}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Author objective evaluation narrative grounded in observed candidate behavior and execution..."
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid var(--software-border, #d1d5db)',
                fontSize: '14px',
                lineHeight: 1.5,
                boxSizing: 'border-box',
                fontFamily: 'inherit',
                resize: 'vertical',
              }}
            />
          </div>

          {/* Strengths Input */}
          <div>
            <label
              htmlFor="review-packet-strengths"
              style={{
                display: 'block',
                fontWeight: 700,
                fontSize: '14px',
                marginBottom: '6px',
                color: '#15803d',
              }}
            >
              Strengths{' '}
              <span
                style={{
                  fontWeight: 400,
                  fontSize: '12px',
                  color: 'var(--software-muted, #6b7280)',
                }}
              >
                (One point per line)
              </span>
            </label>
            <textarea
              id="review-packet-strengths"
              aria-label="Strengths"
              rows={3}
              value={strengthsText}
              onChange={(e) => setStrengthsText(e.target.value)}
              placeholder="Demonstrated defensive error handling&#10;Clean separation of concerns"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid var(--software-border, #d1d5db)',
                fontSize: '14px',
                lineHeight: 1.5,
                boxSizing: 'border-box',
                fontFamily: 'inherit',
                resize: 'vertical',
              }}
            />
          </div>

          {/* Concerns Input */}
          <div>
            <label
              htmlFor="review-packet-concerns"
              style={{
                display: 'block',
                fontWeight: 700,
                fontSize: '14px',
                marginBottom: '6px',
                color: '#b45309',
              }}
            >
              Concerns{' '}
              <span
                style={{
                  fontWeight: 400,
                  fontSize: '12px',
                  color: 'var(--software-muted, #6b7280)',
                }}
              >
                (One point per line)
              </span>
            </label>
            <textarea
              id="review-packet-concerns"
              aria-label="Concerns"
              rows={3}
              value={concernsText}
              onChange={(e) => setConcernsText(e.target.value)}
              placeholder="Potential edge case with missing booking ID&#10;Incomplete test coverage for retry timeout"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid var(--software-border, #d1d5db)',
                fontSize: '14px',
                lineHeight: 1.5,
                boxSizing: 'border-box',
                fontFamily: 'inherit',
                resize: 'vertical',
              }}
            />
          </div>

          {/* Unresolved Questions Input */}
          <div>
            <label
              htmlFor="review-packet-questions"
              style={{
                display: 'block',
                fontWeight: 700,
                fontSize: '14px',
                marginBottom: '6px',
                color: 'var(--software-ink, #374151)',
              }}
            >
              Unresolved questions{' '}
              <span
                style={{
                  fontWeight: 400,
                  fontSize: '12px',
                  color: 'var(--software-muted, #6b7280)',
                }}
              >
                (One question per line)
              </span>
            </label>
            <textarea
              id="review-packet-questions"
              aria-label="Unresolved questions"
              rows={2}
              value={questionsText}
              onChange={(e) => setQuestionsText(e.target.value)}
              placeholder="Why was the exponential backoff interval chosen as 5s?"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid var(--software-border, #d1d5db)',
                fontSize: '14px',
                lineHeight: 1.5,
                boxSizing: 'border-box',
                fontFamily: 'inherit',
                resize: 'vertical',
              }}
            />
          </div>

          {/* Grounded Citation Selector */}
          <fieldset
            style={{
              border: '1px solid var(--software-border, #e5e7eb)',
              borderRadius: '8px',
              padding: '16px',
              margin: 0,
              backgroundColor: 'var(--software-surface-elevated, #f9fafb)',
            }}
          >
            <legend
              style={{
                fontWeight: 700,
                fontSize: '14px',
                padding: '0 6px',
                color: 'var(--software-ink, #111827)',
              }}
            >
              Citations & Grounded Evidence{' '}
              <span
                style={{ fontWeight: 400, fontSize: '12px', color: '#6b7280' }}
              >
                (At least 1 citation required for finalization)
              </span>
            </legend>

            {/* Citations Count Indicator */}
            <div
              style={{
                marginBottom: '12px',
                fontSize: '12px',
                fontWeight: 600,
                color:
                  selectedObservationIds.size + selectedEvidenceRefs.size > 0
                    ? '#166534'
                    : '#dc2626',
              }}
            >
              Selected Citations: {selectedObservationIds.size} observations,{' '}
              {selectedEvidenceRefs.size} candidate evidence items
            </div>

            {/* Observations Picker */}
            <div style={{ marginBottom: '14px' }}>
              <div
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  color: 'var(--software-muted, #6b7280)',
                  marginBottom: '8px',
                }}
              >
                Available Observations from this Session
              </div>
              {availableObservations.length === 0 ? (
                <p
                  style={{
                    margin: 0,
                    fontSize: '13px',
                    color: 'var(--software-muted, #6b7280)',
                  }}
                >
                  No observations recorded yet. You can inspect evidence in the
                  Evidence tab and record observations.
                </p>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    maxHeight: '180px',
                    overflowY: 'auto',
                  }}
                >
                  {availableObservations.map((obs) => {
                    const checked = selectedObservationIds.has(obs.id);
                    return (
                      <label
                        key={obs.id}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '8px',
                          fontSize: '13px',
                          cursor: 'pointer',
                          padding: '6px 8px',
                          borderRadius: '6px',
                          backgroundColor: checked ? '#fef3c7' : 'transparent',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleObservationCitation(obs.id)}
                          style={{ marginTop: '2px' }}
                        />
                        <span>
                          <strong>Event #{obs.eventSequence}:</strong>{' '}
                          {obs.body.length > 80
                            ? `${obs.body.slice(0, 80)}…`
                            : obs.body}{' '}
                          <span style={{ color: '#6b7280', fontSize: '11px' }}>
                            (v{obs.version})
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Candidate Session Evidence Picker */}
            <div>
              <div
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  color: 'var(--software-muted, #6b7280)',
                  marginBottom: '8px',
                }}
              >
                Candidate Session Events & File Revisions
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  maxHeight: '180px',
                  overflowY: 'auto',
                }}
              >
                {/* File Revisions */}
                {(() => {
                  const seenRevs = new Set<string>();
                  const uniqueRevs = (r27Evidence.revisions ?? []).filter(
                    (rev) => {
                      const id = `${rev.path}:${rev.version}:${rev.digest}`;
                      if (seenRevs.has(id)) return false;
                      seenRevs.add(id);
                      return true;
                    },
                  );
                  return uniqueRevs.map((rev, idx) => {
                    const item: R210ReferencedEvidence = {
                      evidenceSourceType: 'file_revision',
                      eventSequence: rev.version || '1',
                      filePath: rev.path,
                      fileVersion: rev.version,
                      evidenceDigest: rev.digest,
                      label: `File: ${rev.path} (v${rev.version})`,
                    };
                    const key = evidenceKey(item);
                    const checked = selectedEvidenceRefs.has(key);
                    return (
                      <label
                        key={`rev-${rev.path}-${rev.version}-${rev.source ?? ''}-${idx}`}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '8px',
                          fontSize: '13px',
                          cursor: 'pointer',
                          padding: '6px 8px',
                          borderRadius: '6px',
                          backgroundColor: checked ? '#eff6ff' : 'transparent',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleEvidenceCitation(item)}
                          style={{ marginTop: '2px' }}
                        />
                        <span>
                          <strong>File:</strong> <code>{rev.path}</code> (v
                          {rev.version}) ·{' '}
                          <span style={{ color: '#6b7280', fontSize: '11px' }}>
                            {formatR210DigestBadge(rev.digest)}
                          </span>
                        </span>
                      </label>
                    );
                  });
                })()}

                {/* Candidate Events */}
                {(r27Evidence.events ?? []).map((ev, idx) => {
                  const item: R210ReferencedEvidence = {
                    evidenceSourceType: 'timeline_event',
                    eventSequence: ev.sequence,
                    filePath: null,
                    fileVersion: null,
                    evidenceDigest:
                      (ev.payload?.digest as string | undefined) ??
                      (ev.payload?.workspaceDigest as string | undefined) ??
                      (ev.payload?.manifestDigest as string | undefined) ??
                      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                    label: `Event Sequence #${ev.sequence} (${ev.type})`,
                  };
                  const key = evidenceKey(item);
                  const checked = selectedEvidenceRefs.has(key);
                  return (
                    <label
                      key={`ev-${ev.sequence}-${idx}`}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '8px',
                        fontSize: '13px',
                        cursor: 'pointer',
                        padding: '6px 8px',
                        borderRadius: '6px',
                        backgroundColor: checked ? '#eff6ff' : 'transparent',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleEvidenceCitation(item)}
                        style={{ marginTop: '2px' }}
                      />
                      <span>
                        <strong>Event Sequence #{ev.sequence}:</strong>{' '}
                        {ev.type}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          </fieldset>

          {/* Feedback messages */}
          {saveError ? (
            <div role="alert" style={{ color: '#dc2626', fontSize: '13px' }}>
              {saveError}
            </div>
          ) : null}

          {finalizeError ? (
            <div role="alert" style={{ color: '#dc2626', fontSize: '13px' }}>
              {finalizeError}
            </div>
          ) : null}

          {lastSavedMessage ? (
            <div
              role="status"
              style={{ color: '#166534', fontSize: '13px', fontWeight: 500 }}
            >
              {lastSavedMessage}
            </div>
          ) : null}

          {/* Action Buttons */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap',
              marginTop: '8px',
            }}
          >
            <button
              type="submit"
              disabled={saving}
              style={{
                padding: '8px 18px',
                borderRadius: '8px',
                backgroundColor: 'var(--software-plum, #6b21a8)',
                color: '#ffffff',
                border: 'none',
                fontWeight: 600,
                fontSize: '13px',
                cursor: saving ? 'wait' : 'pointer',
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? 'Saving draft...' : 'Save draft'}
            </button>

            <button
              type="button"
              onClick={handlePromptFinalize}
              disabled={saving || finalizing}
              style={{
                padding: '8px 18px',
                borderRadius: '8px',
                backgroundColor: '#15803d',
                color: '#ffffff',
                border: 'none',
                fontWeight: 600,
                fontSize: '13px',
                cursor: saving || finalizing ? 'not-allowed' : 'pointer',
              }}
            >
              Finalize review packet
            </button>
          </div>
        </form>
      )}

      {/* Confirmation Modal for Finalization */}
      {confirmModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm Review Packet Finalization"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '16px',
          }}
        >
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              padding: '24px',
              maxWidth: '480px',
              width: '100%',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)',
            }}
          >
            <h3
              style={{
                margin: '0 0 12px 0',
                fontSize: '18px',
                fontWeight: 700,
                color: '#111827',
              }}
            >
              Finalize Review Packet?
            </h3>
            <p
              style={{
                margin: '0 0 20px 0',
                fontSize: '14px',
                lineHeight: 1.5,
                color: '#4b5563',
              }}
            >
              This action is permanent and creates an immutable audit record.
              Once finalized, the review narrative and citations cannot be
              modified or deleted.
            </p>
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '12px',
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                onClick={() => setConfirmModalOpen(false)}
                disabled={finalizing}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: '1px solid #d1d5db',
                  backgroundColor: '#ffffff',
                  color: '#374151',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmFinalize()}
                disabled={finalizing}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: '#15803d',
                  color: '#ffffff',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: finalizing ? 'wait' : 'pointer',
                }}
              >
                {finalizing ? 'Finalizing...' : 'Confirm and finalize'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
