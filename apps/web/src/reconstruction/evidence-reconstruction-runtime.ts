import { getApplicationDatabasePath } from '../database/database-path';
import { isEvaluatorCookieValid } from '../access/evaluator-access';
import { EvaluatorAccessError } from '../access/evaluator-evidence';
import { getSessionService } from '../sessions/session-service';
import {
  DeterministicEvidenceReconstructionGenerator,
  deterministicReconstructionVersion,
} from './deterministic-evidence-reconstruction-generator';
import { EvidenceReconstructionService } from './evidence-reconstruction-service';
import { SqliteEvidenceReconstructionStore } from './sqlite-evidence-reconstruction-store';

const createStore = () =>
  new SqliteEvidenceReconstructionStore(getApplicationDatabasePath());

export const buildReconstructionView = (
  store: SqliteEvidenceReconstructionStore,
  sessionId: string,
) => {
  const record = store.getBySessionId(
    sessionId,
    deterministicReconstructionVersion,
  );
  const legacyArtifacts = store
    .getAllBySessionId(sessionId)
    .filter(
      (candidate) =>
        candidate.promptVersion !== deterministicReconstructionVersion,
    )
    .map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      promptVersion: candidate.promptVersion,
      generatorVersion: candidate.promptVersion,
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      createdAt: candidate.createdAt,
      completedAt: candidate.completedAt,
    }));
  if (!record) {
    return {
      status: 'NOT_STARTED' as const,
      record: null,
      legacyArtifacts,
    };
  }

  const { attemptToken, promptVersion, ...safeRecord } = record;
  void attemptToken;
  return {
    status: safeRecord.status,
    record: {
      ...safeRecord,
      promptVersion,
      generatorVersion: promptVersion,
    },
    legacyArtifacts,
  };
};

export const createConfiguredEvidenceReconstructionService = () => {
  const sessionService = getSessionService();
  return new EvidenceReconstructionService(
    createStore(),
    new DeterministicEvidenceReconstructionGenerator(),
    (sessionId) => sessionService.getSubmittedEvidence(sessionId),
    { providerTimeoutMs: 60_000 },
  );
};

export const getAuthorizedReconstruction = (
  sessionId: string,
  evaluatorCookie: string | undefined,
) => {
  if (!isEvaluatorCookieValid(evaluatorCookie)) {
    throw new EvaluatorAccessError();
  }

  getSessionService().getSubmittedEvidence(sessionId);
  return buildReconstructionView(createStore(), sessionId);
};

export const ensureAuthorizedReconstruction = async (
  sessionId: string,
  evaluatorCookie: string | undefined,
  retryFailed: boolean,
) => {
  if (!isEvaluatorCookieValid(evaluatorCookie)) {
    throw new EvaluatorAccessError();
  }
  getSessionService().getSubmittedEvidence(sessionId);
  const service = createConfiguredEvidenceReconstructionService();
  await service.ensure(sessionId, { retryFailed });
  return getAuthorizedReconstruction(sessionId, evaluatorCookie);
};

export const ensurePostSubmissionReconstruction = async (sessionId: string) => {
  const sessionService = getSessionService();
  sessionService.getSubmittedEvidence(sessionId);
  const service = new EvidenceReconstructionService(
    createStore(),
    new DeterministicEvidenceReconstructionGenerator(),
    (id) => sessionService.getSubmittedEvidence(id),
    { providerTimeoutMs: 60_000 },
  );
  await service.ensure(sessionId);
};
