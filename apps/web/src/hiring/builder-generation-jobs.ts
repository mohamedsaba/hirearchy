import { randomUUID } from 'node:crypto';

import type { ExperienceLevelId, ProblemStructureId } from './catalogs';
import type { R211AssessmentDraftInput } from '../r211-builder/contract';

export type BuilderGenerationJobStatus = 'running' | 'completed' | 'failed';

export interface BuilderGenerationJobRequest {
  readonly organizationId: string;
  readonly principalId: string;
  readonly draftId?: string;
  readonly targetRole: string;
  readonly experienceLevel: ExperienceLevelId;
  readonly yearsExperience: number;
  readonly skills: readonly string[];
  readonly problemStructure: ProblemStructureId;
  readonly workKind: string;
  readonly domain: string;
  readonly durationMinutes: 30 | 45 | 60 | 90;
  readonly integratedAi: boolean;
  readonly guidance?: string;
}

export interface BuilderGenerationJobView {
  readonly jobId: string;
  readonly organizationId: string;
  readonly draftId?: string;
  readonly status: BuilderGenerationJobStatus;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly targetRole: string;
  readonly experienceLevel: ExperienceLevelId;
  readonly yearsExperience: number;
  readonly skills: readonly string[];
  readonly problemStructure: ProblemStructureId;
  readonly workKind: string;
  readonly domain: string;
  readonly durationMinutes: 30 | 45 | 60 | 90;
  readonly integratedAi: boolean;
  readonly guidance?: string;
  readonly draft?: R211AssessmentDraftInput;
  readonly modelId?: string;
  readonly error?: string;
}

interface InternalJobRecord {
  job: BuilderGenerationJobView;
  principalId: string;
}

const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 200;

const GLOBAL_STORE_KEY = '__hirearchy_builder_generation_jobs_v1__';

function getJobStore(): Map<string, InternalJobRecord> {
  const g = globalThis as Record<string, unknown>;
  if (!(g[GLOBAL_STORE_KEY] instanceof Map)) {
    g[GLOBAL_STORE_KEY] = new Map<string, InternalJobRecord>();
  }
  return g[GLOBAL_STORE_KEY] as Map<string, InternalJobRecord>;
}

function pruneJobs(store: Map<string, InternalJobRecord>, now = Date.now()) {
  for (const [id, entry] of store.entries()) {
    const refTime = entry.job.finishedAt ?? entry.job.startedAt;
    if (now - refTime > JOB_TTL_MS) {
      store.delete(id);
    }
  }
  while (store.size > MAX_JOBS) {
    const oldestKey = store.keys().next().value;
    if (!oldestKey) break;
    store.delete(oldestKey);
  }
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function ownerMatches(
  entry: InternalJobRecord,
  organizationId: string,
  principalId: string,
): boolean {
  return (
    entry.job.organizationId === normalizeId(organizationId) &&
    entry.principalId === normalizeId(principalId)
  );
}

/**
 * Starts an async AI assessment generation job detached from HTTP request cancellation,
 * returning an existing running job for the same `(organizationId, principalId)` if present.
 */
export function startBuilderGenerationJob(
  params: BuilderGenerationJobRequest,
  runner: () => Promise<{ draft: R211AssessmentDraftInput; modelId?: string }>,
): BuilderGenerationJobView {
  const store = getJobStore();
  const orgId = normalizeId(params.organizationId);
  const ownerId = normalizeId(params.principalId);
  const now = Date.now();
  pruneJobs(store, now);

  // Prevent duplicate in-flight generation for the same user in this org.
  for (const entry of store.values()) {
    if (ownerMatches(entry, orgId, ownerId) && entry.job.status === 'running') {
      return entry.job;
    }
  }

  const jobId = randomUUID();
  const initialJob: BuilderGenerationJobView = {
    jobId,
    organizationId: orgId,
    draftId: params.draftId,
    status: 'running',
    startedAt: now,
    targetRole: params.targetRole,
    experienceLevel: params.experienceLevel,
    yearsExperience: params.yearsExperience,
    skills: [...params.skills],
    problemStructure: params.problemStructure,
    workKind: params.workKind,
    domain: params.domain,
    durationMinutes: params.durationMinutes,
    integratedAi: params.integratedAi,
    ...(params.guidance ? { guidance: params.guidance } : {}),
  };

  store.set(jobId, {
    job: initialJob,
    principalId: ownerId,
  });

  void runner()
    .then((result) => {
      const current = store.get(jobId);
      if (!current) return;
      current.job = {
        ...current.job,
        status: 'completed',
        finishedAt: Date.now(),
        draft: result.draft,
        modelId: result.modelId,
      };
    })
    .catch((err: unknown) => {
      const current = store.get(jobId);
      if (!current) return;
      const rawMessage =
        err instanceof Error
          ? err.message
          : 'Unable to generate assessment with AI.';
      const friendlyMessage = /timeout|timed out/i.test(rawMessage)
        ? 'AI generation timed out. Try again or start from a template.'
        : rawMessage;
      current.job = {
        ...current.job,
        status: 'failed',
        finishedAt: Date.now(),
        error: friendlyMessage,
      };
    });

  return initialJob;
}

/**
 * Returns the latest active running or unconsumed finished job for `(organizationId, principalId)`.
 */
export function getLatestBuilderGenerationJob(
  organizationId: string,
  principalId: string,
  jobId?: string,
): BuilderGenerationJobView | null {
  const store = getJobStore();
  const orgId = normalizeId(organizationId);
  const ownerId = normalizeId(principalId);
  pruneJobs(store);

  if (jobId) {
    const direct = store.get(jobId);
    if (direct && ownerMatches(direct, orgId, ownerId)) {
      return direct.job;
    }
    return null;
  }

  let running: BuilderGenerationJobView | null = null;
  let latestFinished: BuilderGenerationJobView | null = null;

  for (const entry of store.values()) {
    if (!ownerMatches(entry, orgId, ownerId)) continue;
    if (entry.job.status === 'running') {
      if (!running || entry.job.startedAt > running.startedAt) {
        running = entry.job;
      }
    } else {
      if (!latestFinished || entry.job.startedAt > latestFinished.startedAt) {
        latestFinished = entry.job;
      }
    }
  }

  return running ?? latestFinished;
}

/**
 * Removes a finished (`completed` or `failed`) job once the client applies or acknowledges it.
 * Running jobs are never deleted early by this call.
 */
export function consumeBuilderGenerationJob(
  organizationId: string,
  principalId: string,
  jobId: string,
): boolean {
  const store = getJobStore();
  const orgId = normalizeId(organizationId);
  const ownerId = normalizeId(principalId);
  const entry = store.get(jobId);
  if (!entry || !ownerMatches(entry, orgId, ownerId)) {
    return false;
  }
  if (entry.job.status === 'running') {
    return false;
  }
  store.delete(jobId);
  return true;
}

/** Test-only cleanup helper. */
export function clearBuilderGenerationJobsForTest(): void {
  getJobStore().clear();
}
