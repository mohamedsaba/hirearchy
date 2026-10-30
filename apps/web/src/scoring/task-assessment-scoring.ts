import { randomUUID } from 'node:crypto';

import type { AiCapabilitySnapshot, AiInteraction } from '../ai/ai-interaction';
import type {
  TaskRubricCriterion,
  TaskRubricSnapshot,
} from '../assessments/task-rubric';
import type { SessionEvent } from '../events/session-event';
import { buildChronologicalReconstruction } from '../evidence/chronological-reconstruction';
import {
  buildEvidencePacket,
  type EvidencePacketV1,
} from '../reconstruction/evidence-packet';
import { buildEvidenceReferenceCatalog } from '../reconstruction/evidence-reference-catalog';
import { EvidenceReconstructionError } from '../reconstruction/evidence-reconstruction';
import type { SqliteTaskAssessmentScoreStore } from './task-assessment-score-store';

export type TaskAssessmentScoreStatus =
  | 'pending'
  | 'available'
  | 'incomplete'
  | 'unavailable'
  | 'failed'
  | 'rubric_unavailable';

export type TaskCriterionAssessment = Readonly<{
  criterionId: string;
  status: 'scored' | 'not_applicable' | 'insufficient_evidence';
  score: number | null;
  reason: string;
  evidenceRefs: readonly string[];
}>;

export type TaskAssessmentScoreReport = Readonly<{
  status: TaskAssessmentScoreStatus;
  rubric: TaskRubricSnapshot | null;
  totalScore: number | null;
  applicableWeight: number | null;
  scoredWeight: number | null;
  providerId: string | null;
  model: string | null;
  analyzedAt: string | null;
  criteria: readonly TaskCriterionAssessment[];
}>;

export type TaskScoringSource = Readonly<{
  sessionId: string;
  scenario: Readonly<{
    id: string;
    version: string;
    title: string;
    brief: string;
    acceptanceCriteria: readonly string[];
  }>;
  activatedAt: string | null;
  submittedAt: string;
  diff: string;
  events: readonly SessionEvent[];
  rubric: TaskRubricSnapshot | null;
  aiCapabilitySnapshot: AiCapabilitySnapshot | null;
  aiInteractions: readonly AiInteraction[];
}>;

export type TaskScoringPacket = Readonly<{
  schemaVersion: 1;
  rubricVersion: string;
  scenario: TaskScoringSource['scenario'];
  session: Readonly<{ activatedAt: string | null; submittedAt: string }>;
  applicableCriteria: readonly TaskRubricCriterion[];
  evidence: EvidencePacketV1;
}>;

export interface TaskAssessmentScoringProvider {
  readonly providerId: string;
  readonly modelId: string;
  analyze(
    packet: TaskScoringPacket,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<unknown>;
}

type Applicability = 'applies' | 'not_applicable' | 'insufficient_evidence';
type ServiceOptions = Readonly<{
  now?: () => string;
  createAttemptToken?: () => string;
  providerTimeoutMs?: number;
}>;

const aiEventTypes = new Set([
  'AI_REQUEST_STARTED',
  'AI_RESPONSE_COMPLETED',
  'AI_REQUEST_CANCELLED',
  'AI_REQUEST_FAILED',
]);

const emptyReport = (
  status: TaskAssessmentScoreStatus,
  rubric: TaskRubricSnapshot | null,
): TaskAssessmentScoreReport => ({
  status,
  rubric,
  totalScore: null,
  applicableWeight: null,
  scoredWeight: null,
  providerId: null,
  model: null,
  analyzedAt: null,
  criteria: [],
});

const aiEventInteractionId = (event: SessionEvent): string | null => {
  if (
    !aiEventTypes.has(event.type) ||
    !('interactionId' in event.payload) ||
    typeof event.payload.interactionId !== 'string'
  )
    return null;
  return event.payload.interactionId;
};

const aiCaptureIsComplete = (source: TaskScoringSource) => {
  const interactions = source.aiInteractions;
  const aiEvents = source.events.filter((event) =>
    aiEventTypes.has(event.type),
  );
  const interactionsById = new Map(
    interactions.map((interaction) => [interaction.id, interaction]),
  );
  const starts = new Map<string, SessionEvent[]>();
  const terminals = new Map<string, SessionEvent[]>();

  for (const event of aiEvents) {
    const interactionId = aiEventInteractionId(event);
    if (!interactionId || !interactionsById.has(interactionId)) return false;
    const target = event.type === 'AI_REQUEST_STARTED' ? starts : terminals;
    target.set(interactionId, [...(target.get(interactionId) ?? []), event]);
  }
  for (const interaction of interactions) {
    const start = starts.get(interaction.id) ?? [];
    const terminal = terminals.get(interaction.id) ?? [];
    if (
      start.length !== 1 ||
      interaction.startedSequence !== start[0].sequence ||
      interaction.status === 'ADMITTED' ||
      interaction.status === 'DISPATCH_STARTED'
    ) {
      return false;
    }
    const expectedTerminal =
      interaction.status === 'COMPLETED'
        ? 'AI_RESPONSE_COMPLETED'
        : interaction.status === 'CANCELLED'
          ? 'AI_REQUEST_CANCELLED'
          : 'AI_REQUEST_FAILED';
    if (
      terminal.length !== 1 ||
      terminal[0].type !== expectedTerminal ||
      interaction.terminalSequence !== terminal[0].sequence
    ) {
      return false;
    }
  }
  return true;
};

const applicabilityFor = (
  criterion: TaskRubricCriterion,
  source: TaskScoringSource,
): Applicability => {
  if (criterion.applicability.kind === 'always') return 'applies';
  if (criterion.applicability.kind !== 'recorded_integrated_ai_interaction') {
    return 'insufficient_evidence';
  }
  const hasAiEvidence =
    source.aiInteractions.length > 0 ||
    source.events.some((event) => aiEventTypes.has(event.type));
  if (!source.aiCapabilitySnapshot) return 'insufficient_evidence';
  if (!source.aiCapabilitySnapshot.enabled) {
    return hasAiEvidence ? 'insufficient_evidence' : 'not_applicable';
  }
  if (!aiCaptureIsComplete(source)) return 'insufficient_evidence';
  if (source.aiInteractions.length === 0) {
    return source.aiCapabilitySnapshot.contractVersion === 'slice-6b-v1'
      ? 'not_applicable'
      : 'insufficient_evidence';
  }
  return 'applies';
};

const projectStoredReport = (
  stored: ReturnType<SqliteTaskAssessmentScoreStore['get']>,
  rubric: TaskRubricSnapshot,
): TaskAssessmentScoreReport | null => {
  if (!stored || stored.rubricVersion !== rubric.version) return null;
  return {
    status: stored.status,
    rubric,
    totalScore: stored.totalScore,
    applicableWeight: stored.applicableWeight,
    scoredWeight: stored.scoredWeight,
    providerId: stored.providerId,
    model: stored.model,
    analyzedAt: stored.analyzedAt,
    criteria: stored.criteria,
  };
};

const validateProviderResult = (
  value: unknown,
  expectedIds: readonly string[],
  authorizedRefs: ReadonlySet<string>,
): readonly TaskCriterionAssessment[] => {
  if (!value || typeof value !== 'object' || !('criteria' in value)) {
    throw new Error('Invalid analysis result.');
  }
  const candidates = (value as { criteria?: unknown }).criteria;
  if (!Array.isArray(candidates)) throw new Error('Invalid analysis criteria.');
  const results = new Map<string, TaskCriterionAssessment>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('Invalid analysis criterion.');
    }
    const result = candidate as Partial<TaskCriterionAssessment>;
    if (
      typeof result.criterionId !== 'string' ||
      results.has(result.criterionId) ||
      (result.status !== 'scored' &&
        result.status !== 'insufficient_evidence') ||
      typeof result.reason !== 'string' ||
      result.reason.trim().length === 0 ||
      result.reason.length > 4000 ||
      !Array.isArray(result.evidenceRefs) ||
      !result.evidenceRefs.every(
        (ref) => typeof ref === 'string' && authorizedRefs.has(ref),
      )
    ) {
      throw new Error('Invalid analysis criterion.');
    }
    if (
      result.status === 'scored' &&
      (typeof result.score !== 'number' ||
        !Number.isFinite(result.score) ||
        result.score < 0 ||
        result.score > 100 ||
        result.evidenceRefs.length === 0)
    ) {
      throw new Error('A score must be bounded and linked to evidence.');
    }
    if (result.status === 'insufficient_evidence' && result.score !== null) {
      throw new Error('Insufficient evidence cannot carry a score.');
    }
    results.set(result.criterionId, {
      criterionId: result.criterionId,
      status: result.status,
      score: result.status === 'scored' ? result.score! : null,
      reason: result.reason.trim(),
      evidenceRefs: [...result.evidenceRefs],
    });
  }
  if (
    results.size !== expectedIds.length ||
    expectedIds.some((id) => !results.has(id))
  ) {
    throw new Error('Analysis omitted or added a rubric criterion.');
  }
  return expectedIds.map((id) => results.get(id)!);
};

const roundScore = (value: number) => Math.round(value * 10) / 10;

export class TaskAssessmentScoringService {
  private readonly now: () => string;
  private readonly createAttemptToken: () => string;
  private readonly providerTimeoutMs: number;

  constructor(
    private readonly store: SqliteTaskAssessmentScoreStore,
    private readonly provider: TaskAssessmentScoringProvider | null,
    private readonly loadAiInteractions: (
      sessionId: string,
    ) => readonly AiInteraction[],
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createAttemptToken = options.createAttemptToken ?? randomUUID;
    this.providerTimeoutMs = options.providerTimeoutMs ?? 60_000;
  }

  get(source: TaskScoringSource): TaskAssessmentScoreReport {
    if (!source.rubric) return emptyReport('rubric_unavailable', null);
    const saved = this.store.get(source.sessionId);
    if (saved && saved.rubricVersion !== source.rubric.version) {
      return emptyReport('failed', source.rubric);
    }
    const stored = projectStoredReport(saved, source.rubric);
    if (stored) return stored;
    return emptyReport(
      this.provider ? 'pending' : 'unavailable',
      source.rubric,
    );
  }

  async request(
    source: TaskScoringSource,
    options: Readonly<{ retryFailed?: boolean }> = {},
  ): Promise<TaskAssessmentScoreReport> {
    const rubric = source.rubric;
    if (!rubric) return emptyReport('rubric_unavailable', null);
    const saved = this.store.get(source.sessionId);
    if (saved && saved.rubricVersion !== rubric.version) {
      return emptyReport('failed', rubric);
    }
    const existing = projectStoredReport(saved, rubric);
    if (existing && !(options.retryFailed && existing.status === 'failed')) {
      return existing;
    }
    if (!this.provider) return emptyReport('unavailable', rubric);

    const attemptToken = this.createAttemptToken();
    const claim = this.store.begin({
      sessionId: source.sessionId,
      rubricVersion: rubric.version,
      attemptToken,
      now: this.now(),
      retryFailed: options.retryFailed,
    });
    if (!claim.claimed) {
      return (
        projectStoredReport(claim.report, rubric) ??
        emptyReport('failed', rubric)
      );
    }

    let applicability: Map<string, Applicability>;
    try {
      const aiInteractions = this.loadAiInteractions(source.sessionId);
      const resolvedSource = { ...source, aiInteractions };
      applicability = new Map(
        rubric.criteria.map((criterion) => [
          criterion.id,
          applicabilityFor(criterion, resolvedSource),
        ]),
      );
    } catch {
      // If the interaction log cannot be read, conditional criteria must remain
      // unassessable and the idempotent attempt must not stay pending forever.
      applicability = new Map(
        rubric.criteria.map((criterion) => [
          criterion.id,
          criterion.applicability.kind === 'always'
            ? 'applies'
            : 'insufficient_evidence',
        ]),
      );
      const analyzedAt = this.now();
      const report = this.failureReport(rubric, applicability, analyzedAt);
      this.store.complete({
        sessionId: source.sessionId,
        rubricVersion: rubric.version,
        attemptToken,
        report,
        now: analyzedAt,
      });
      return report;
    }
    const applicableCriteria = rubric.criteria.filter(
      (criterion) => applicability.get(criterion.id) === 'applies',
    );
    const analyzedAt = this.now();
    try {
      const reconstruction = buildChronologicalReconstruction(
        {
          activatedAt: source.activatedAt,
          submittedAt: source.submittedAt,
          submittedDiff: source.diff,
        },
        source.events,
      );
      const catalog = buildEvidenceReferenceCatalog(
        source.sessionId,
        reconstruction,
      );
      const evidence = buildEvidencePacket(
        {
          scenario: source.scenario,
          activatedAt: source.activatedAt,
          submittedAt: source.submittedAt,
          diff: source.diff,
        },
        catalog,
      );
      const authorizedRefs = new Set(
        catalog.entries.map((entry) => entry.evidenceRef),
      );
      const rawResult = await this.analyze({
        schemaVersion: 1,
        rubricVersion: rubric.version,
        scenario: source.scenario,
        session: {
          activatedAt: source.activatedAt,
          submittedAt: source.submittedAt,
        },
        applicableCriteria,
        evidence,
      });
      const providerResults = validateProviderResult(
        rawResult,
        applicableCriteria.map((criterion) => criterion.id),
        authorizedRefs,
      );
      const byId = new Map(
        providerResults.map((result) => [result.criterionId, result]),
      );
      const hasInspectableSubmittedCode = source.diff
        .split('\n')
        .some((line) => /^@@(?:\s|$)/.test(line));
      const results = rubric.criteria.map(
        (criterion): TaskCriterionAssessment => {
          const applies = applicability.get(criterion.id);
          if (applies === 'not_applicable') {
            return {
              criterionId: criterion.id,
              status: 'not_applicable',
              score: null,
              reason: criterion.applicability.rule,
              evidenceRefs: [],
            };
          }
          if (applies === 'insufficient_evidence') {
            return {
              criterionId: criterion.id,
              status: 'insufficient_evidence',
              score: null,
              reason:
                'The recorded integrated-AI capture is incomplete, so criterion applicability cannot be established.',
              evidenceRefs: [],
            };
          }
          if (
            criterion.id === 'implementation-quality' &&
            !hasInspectableSubmittedCode
          ) {
            return {
              criterionId: criterion.id,
              status: 'insufficient_evidence',
              score: null,
              reason:
                'The submitted record has no inspectable code changes for this criterion.',
              evidenceRefs: [],
            };
          }
          return byId.get(criterion.id)!;
        },
      );
      const applicableWeight = rubric.criteria.reduce(
        (sum, criterion) =>
          sum +
          (applicability.get(criterion.id) === 'not_applicable'
            ? 0
            : criterion.weight),
        0,
      );
      const scoredWeight = rubric.criteria.reduce((sum, criterion) => {
        const result = results.find(
          (candidate) => candidate.criterionId === criterion.id,
        );
        return sum + (result?.status === 'scored' ? criterion.weight : 0);
      }, 0);
      const complete =
        applicableWeight > 0 &&
        results.every((result) => result.status !== 'insufficient_evidence');
      const weightedScore = rubric.criteria.reduce((sum, criterion) => {
        const result = results.find(
          (candidate) => candidate.criterionId === criterion.id,
        );
        return (
          sum +
          (result?.status === 'scored' ? result.score! * criterion.weight : 0)
        );
      }, 0);
      const report: TaskAssessmentScoreReport = {
        status: complete ? 'available' : 'incomplete',
        rubric,
        totalScore: complete
          ? roundScore(weightedScore / applicableWeight)
          : null,
        applicableWeight,
        scoredWeight,
        providerId: this.provider.providerId,
        model: this.provider.modelId,
        analyzedAt,
        criteria: results,
      };
      this.store.complete({
        sessionId: source.sessionId,
        rubricVersion: rubric.version,
        attemptToken,
        report,
        now: analyzedAt,
      });
      return report;
    } catch (error) {
      const report =
        error instanceof EvidenceReconstructionError &&
        error.code === 'INPUT_TOO_LARGE'
          ? this.incompleteReport(rubric, applicability, analyzedAt)
          : this.failureReport(rubric, applicability, analyzedAt);
      this.store.complete({
        sessionId: source.sessionId,
        rubricVersion: rubric.version,
        attemptToken,
        report,
        now: analyzedAt,
      });
      return report;
    }
  }

  private async analyze(packet: TaskScoringPacket): Promise<unknown> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Task assessment analysis timed out.'));
      }, this.providerTimeoutMs);
    });
    try {
      return await Promise.race([
        this.provider!.analyze(packet, { signal: controller.signal }),
        timedOut,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private failureReport(
    rubric: TaskRubricSnapshot,
    applicability: ReadonlyMap<string, Applicability>,
    analyzedAt: string,
  ): TaskAssessmentScoreReport {
    return {
      status: 'failed',
      rubric,
      totalScore: null,
      applicableWeight: rubric.criteria.reduce(
        (sum, criterion) =>
          sum +
          (applicability.get(criterion.id) === 'not_applicable'
            ? 0
            : criterion.weight),
        0,
      ),
      scoredWeight: 0,
      providerId: this.provider?.providerId ?? null,
      model: this.provider?.modelId ?? null,
      analyzedAt,
      criteria: rubric.criteria.map((criterion) =>
        applicability.get(criterion.id) === 'not_applicable'
          ? {
              criterionId: criterion.id,
              status: 'not_applicable',
              score: null,
              reason: criterion.applicability.rule,
              evidenceRefs: [],
            }
          : {
              criterionId: criterion.id,
              status: 'insufficient_evidence',
              score: null,
              reason: 'Analysis could not validate this criterion result.',
              evidenceRefs: [],
            },
      ),
    };
  }

  private incompleteReport(
    rubric: TaskRubricSnapshot,
    applicability: ReadonlyMap<string, Applicability>,
    analyzedAt: string,
  ): TaskAssessmentScoreReport {
    const report = this.failureReport(rubric, applicability, analyzedAt);
    return {
      ...report,
      status: 'incomplete',
      criteria: report.criteria.map((criterion) =>
        criterion.status === 'not_applicable'
          ? criterion
          : {
              ...criterion,
              reason:
                'Finalized evidence exceeds the analysis limit and cannot support this criterion.',
            },
      ),
    };
  }
}
