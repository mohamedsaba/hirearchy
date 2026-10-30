import { cookies } from 'next/headers';
import path from 'node:path';

import {
  evaluatorCookieName,
  isEvaluatorCookieValid,
} from '../../../../src/access/evaluator-access';
import { disabledAiCapabilitySnapshot } from '../../../../src/ai/ai-interaction';
import { isSupportedAssessmentSelection } from '../../../../src/assessments/assessment-options';
import { parseAssessmentSelection } from '../../../../src/assessments/assessment-selection';
import {
  createGeneratedTaskRubric,
  createScenario002TaskRubric,
  GeneratedRubricUnavailableError,
} from '../../../../src/assessments/task-rubric';
import { getApplicationDatabasePath } from '../../../../src/database/database-path';
import { errorResponse } from '../../../../src/http/error-response';
import { getReviewerWorkflowStore } from '../../../../src/review-workflow/reviewer-workflow-store';
import { getSessionService } from '../../../../src/sessions/session-service';
import { CandidateTokenStorageError } from '../../../../src/sessions/candidate-token-storage.mjs';
import {
  ApplicationStartupNotReadyError,
  isAssessmentIssuanceReady,
} from '../../../../src/startup-status';
import {
  assessmentIssuanceIntentMatches,
  hashAssessmentIssuanceIntent,
  hashPersistedAssessmentIdentity,
  type AssessmentIssuanceIntent,
} from '../../../../src/sessions/assessment-issuance-idempotency';
import { getIssuableScenario } from '../../../../src/scenarios/issuable-scenarios';
import {
  loadValidatedGeneratedAssessment,
  toGeneratedScenarioSnapshot,
} from '../../../../src/scenarios/generated-assessment';

export const dynamic = 'force-dynamic';

const bodyRequestKeyPattern = /^(?:idempotency|request|issuance)[_-]?key$/i;

const responseForIssuance = (
  session: ReturnType<
    ReturnType<typeof getSessionService>['createSession']
  >['session'],
  candidateToken: string,
  status: 200 | 201,
) =>
  Response.json(
    {
      sessionId: session.id,
      candidatePath: `/candidate/${candidateToken}`,
      scenario: {
        id: session.scenario.id,
        version: session.scenario.version,
        title: session.scenario.title,
        durationSeconds: session.durationSeconds,
      },
      terminalEnabled: session.terminalEnabled ?? true,
      taskRubric: session.taskRubricSnapshot,
    },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );

const storageUnavailable = (message: string) =>
  Response.json(
    { error: { code: 'CANDIDATE_TOKEN_STORAGE_UNAVAILABLE', message } },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );

const isStorageUnavailableError = (error: unknown) =>
  error instanceof CandidateTokenStorageError ||
  error instanceof ApplicationStartupNotReadyError;

const conflictForIssuance = () =>
  Response.json(
    {
      error: {
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message:
          'This request key is already bound to a different assessment intent. Start a new assessment with a new request key.',
      },
    },
    { status: 409, headers: { 'Cache-Control': 'no-store' } },
  );

const recoverIssuance = (
  sessionService: ReturnType<typeof getSessionService>,
  issuance: NonNullable<
    ReturnType<typeof sessionService.findAssessmentIssuanceByKey>
  >,
  intent: AssessmentIssuanceIntent,
) => {
  if (!assessmentIssuanceIntentMatches(issuance.requestHash, intent)) {
    return conflictForIssuance();
  }
  let persistedHash: string;
  try {
    persistedHash = hashPersistedAssessmentIdentity(issuance.session);
  } catch {
    return storageUnavailable(
      'The stored assessment identity could not be read safely. Contact an administrator before retrying.',
    );
  }
  if (persistedHash !== issuance.payloadHash) {
    return storageUnavailable(
      'The stored assessment identity could not be verified. Contact an administrator before retrying.',
    );
  }
  let candidateToken: string | null;
  try {
    candidateToken = sessionService.recoverCandidateTokenForAssessment(
      issuance.session.id,
    );
  } catch (error) {
    if (isStorageUnavailableError(error)) {
      return storageUnavailable(
        'Encrypted candidate-link recovery is unavailable. Confirm the encryption key and migration status.',
      );
    }
    return errorResponse(error);
  }
  if (!candidateToken) {
    return storageUnavailable(
      'The candidate link is unavailable until encrypted token storage is migrated and verified.',
    );
  }
  return responseForIssuance(issuance.session, candidateToken, 200);
};

export const POST = async (request: Request) => {
  const cookieStore = await cookies();
  if (!isEvaluatorCookieValid(cookieStore.get(evaluatorCookieName)?.value)) {
    return Response.json(
      {
        error: {
          code: 'EVALUATOR_ACCESS_REQUIRED',
          message: 'Evaluator access is required to create an assessment.',
        },
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (!isAssessmentIssuanceReady()) {
    return storageUnavailable(
      'Assessment issuance is unavailable until startup checks are ready. Contact an administrator before retrying.',
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      {
        error: {
          code: 'INVALID_ASSESSMENT_SELECTION',
          message: 'Choose assessment options before creating a link.',
        },
      },
      { status: 400 },
    );
  }

  const rawBody =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  if (Object.keys(rawBody).some((key) => bodyRequestKeyPattern.test(key))) {
    return Response.json(
      {
        error: {
          code: 'INVALID_IDEMPOTENCY_KEY',
          message:
            'Provide the request key in the Idempotency-Key header only.',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (
    idempotencyKey !== null &&
    (!/^[\x21-\x7e]{1,200}$/.test(idempotencyKey) ||
      idempotencyKey.trim() !== idempotencyKey)
  ) {
    return Response.json(
      {
        error: {
          code: 'INVALID_IDEMPOTENCY_KEY',
          message:
            'The Idempotency-Key header must contain 1 to 200 visible ASCII characters.',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const {
    generatedAssessmentId,
    rubricWeights,
    useCuratedBlueprint,
    ...selectionBody
  } = rawBody;
  let requestedRubricWeights: Record<string, number> | undefined;
  if (rubricWeights !== undefined) {
    if (
      !rubricWeights ||
      typeof rubricWeights !== 'object' ||
      Array.isArray(rubricWeights)
    ) {
      return invalidRubricWeights();
    }
    const entries = Object.entries(rubricWeights);
    if (
      entries.length === 0 ||
      entries.some(
        ([id, weight]) =>
          !id.trim() ||
          typeof weight !== 'number' ||
          !Number.isInteger(weight) ||
          weight < 1 ||
          weight > 100,
      ) ||
      entries.reduce((sum, [, weight]) => sum + Number(weight), 0) !== 100
    ) {
      return invalidRubricWeights();
    }
    requestedRubricWeights = Object.fromEntries(entries) as Record<
      string,
      number
    >;
  }
  const selection = parseAssessmentSelection(selectionBody);
  if (!selection) {
    return Response.json(
      {
        error: {
          code: 'INVALID_ASSESSMENT_SELECTION',
          message: 'The selected options are incomplete or unavailable.',
        },
      },
      { status: 400 },
    );
  }
  const intent: AssessmentIssuanceIntent = {
    selection,
    mode: useCuratedBlueprint === true ? 'curated' : 'generated',
    ...(typeof generatedAssessmentId === 'string'
      ? { generatedAssessmentId }
      : {}),
    rubricWeights: requestedRubricWeights ?? null,
  };
  let sessionService: ReturnType<typeof getSessionService>;
  try {
    sessionService = getSessionService();
  } catch (error) {
    if (isStorageUnavailableError(error)) {
      return storageUnavailable(
        'Assessment storage is unavailable. Contact an administrator before retrying.',
      );
    }
    return errorResponse(error);
  }
  const requestHash = hashAssessmentIssuanceIntent(intent);
  if (idempotencyKey !== null) {
    let existing: ReturnType<typeof sessionService.findAssessmentIssuanceByKey>;
    try {
      existing = sessionService.findAssessmentIssuanceByKey(idempotencyKey);
    } catch (error) {
      if (isStorageUnavailableError(error)) {
        return storageUnavailable(
          'Assessment storage is unavailable. Contact an administrator before retrying.',
        );
      }
      return errorResponse(error);
    }
    if (existing) return recoverIssuance(sessionService, existing, intent);
  }
  if (!isSupportedAssessmentSelection(selection)) {
    return Response.json(
      {
        error: {
          code: 'ASSESSMENT_NOT_READY',
          message:
            'This combination is still being prepared. Choose the available blueprint to create a candidate session.',
        },
      },
      { status: 409 },
    );
  }
  const configuredScenario = getIssuableScenario(
    'scenario-002-booking-notification-retry',
  );
  if (!configuredScenario) {
    return Response.json(
      {
        error: {
          code: 'SCENARIO_UNAVAILABLE',
          message: 'The selected task is unavailable.',
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let scenarioSnapshot;
  let taskRubricSnapshot;

  if (useCuratedBlueprint === true) {
    if (selection.terminalEnabled === false) {
      return Response.json(
        {
          error: {
            code: 'ASSESSMENT_CAPABILITY_UNSUPPORTED',
            message:
              'Terminal must be enabled for this blueprint because candidates are required to run pytest and record the required verification.',
          },
        },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (requestedRubricWeights) {
      const defaultRubric = createScenario002TaskRubric();
      if (
        defaultRubric.criteria.length !==
          Object.keys(requestedRubricWeights).length ||
        defaultRubric.criteria.some(
          (criterion) => !Object.hasOwn(requestedRubricWeights!, criterion.id),
        )
      ) {
        return invalidRubricWeights();
      }
      taskRubricSnapshot = {
        version: defaultRubric.version,
        criteria: defaultRubric.criteria.map((criterion) => ({
          ...criterion,
          weight: requestedRubricWeights![criterion.id],
        })),
      };
    } else {
      taskRubricSnapshot = createScenario002TaskRubric();
    }
    scenarioSnapshot = configuredScenario.scenario;
  } else {
    if (requestedRubricWeights && typeof generatedAssessmentId !== 'string') {
      return invalidRubricWeights();
    }
    if (typeof generatedAssessmentId !== 'string') {
      return Response.json(
        {
          error: {
            code: 'ASSESSMENT_NOT_PREPARED',
            message:
              'Prepare and validate a task before creating a candidate link.',
          },
        },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const generated = await loadValidatedGeneratedAssessment(
      path.dirname(getApplicationDatabasePath()),
      generatedAssessmentId,
    );
    if (!generated) {
      return Response.json(
        {
          error: {
            code: 'GENERATED_ASSESSMENT_UNAVAILABLE',
            message:
              'The validated task draft is unavailable. Prepare it again before creating a link.',
          },
        },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (
      requestedRubricWeights &&
      (generated.assessment.rubric.length !==
        Object.keys(requestedRubricWeights).length ||
        generated.assessment.rubric.some(
          (criterion) =>
            !('id' in criterion) ||
            !Object.hasOwn(requestedRubricWeights!, criterion.id),
        ))
    ) {
      return invalidRubricWeights();
    }
    scenarioSnapshot = toGeneratedScenarioSnapshot(generated);
    try {
      taskRubricSnapshot = createGeneratedTaskRubric({
        artifactId: generated.id,
        title: generated.assessment.title,
        brief: generated.assessment.brief,
        acceptanceCriteria: generated.assessment.acceptanceCriteria,
        rubric: generated.assessment.rubric,
        integratedAi: selection.integratedAi,
        criterionWeights: requestedRubricWeights,
      });
    } catch (error) {
      if (!(error instanceof GeneratedRubricUnavailableError)) throw error;
      return Response.json(
        {
          error: {
            code: 'GENERATED_RUBRIC_UNAVAILABLE',
            message:
              'The task rubric is unavailable. Regenerate the assessment before creating a link.',
          },
        },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  const sessionOptions = {
    scenario: {
      ...scenarioSnapshot,
      durationSeconds: selection.durationMinutes * 60,
    },
    terminalEnabled: selection.terminalEnabled ?? true,
    taskRubricSnapshot,
    aiCapability: selection.integratedAi
      ? configuredScenario.aiCapability
      : disabledAiCapabilitySnapshot,
  };
  try {
    if (idempotencyKey === null) {
      const issuance = sessionService.createSession(sessionOptions);
      return responseForIssuance(
        issuance.session,
        issuance.candidateToken,
        201,
      );
    }
    const written = sessionService.createAssessmentSession(sessionOptions, {
      key: idempotencyKey,
      requestHash,
    });
    if (!written.created) {
      return recoverIssuance(sessionService, written.issuance, intent);
    }
    if (!written.candidateToken) {
      return storageUnavailable(
        'The candidate link could not be returned after issuance. Retry with the same request key.',
      );
    }
    return responseForIssuance(
      written.issuance.session,
      written.candidateToken,
      201,
    );
  } catch (error) {
    if (isStorageUnavailableError(error)) {
      return storageUnavailable(
        'Candidate-link storage is unavailable. Confirm the encryption key and migration status before retrying.',
      );
    }
    return errorResponse(error);
  }
};

export const GET = async () => {
  const cookieStore = await cookies();
  if (!isEvaluatorCookieValid(cookieStore.get(evaluatorCookieName)?.value)) {
    return Response.json(
      {
        error: {
          code: 'EVALUATOR_ACCESS_REQUIRED',
          message: 'Evaluator access is required to view assessments.',
        },
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let sessionService: ReturnType<typeof getSessionService>;
  let rawEntries: ReturnType<
    typeof sessionService.listAssessmentLifecycleEntries
  >;
  try {
    sessionService = getSessionService();
    rawEntries = sessionService.listAssessmentLifecycleEntries();
  } catch (error) {
    if (isStorageUnavailableError(error)) {
      return storageUnavailable(
        'Encrypted candidate-link recovery is unavailable. Confirm the encryption key and migration status.',
      );
    }
    return errorResponse(error);
  }
  let workflowStore: ReturnType<typeof getReviewerWorkflowStore>;
  try {
    workflowStore = getReviewerWorkflowStore();
  } catch (error) {
    if (isStorageUnavailableError(error)) {
      return storageUnavailable(
        'Assessment storage is unavailable. Contact an administrator before retrying.',
      );
    }
    return errorResponse(error);
  }

  const assessments = rawEntries.map((entry) => {
    const candidatePath = entry.candidateToken
      ? `/candidate/${entry.candidateToken}`
      : null;
    const workflow =
      entry.status === 'SUBMITTED' ? workflowStore.get(entry.sessionId) : null;
    const reviewStatus = workflow
      ? workflow.clarifications.some((item) => !item.reply && !item.closedAt)
        ? 'waiting_for_response'
        : workflow.nextStep
          ? 'next_step_recorded'
          : workflow.note || workflow.clarifications.length
            ? 'in_progress'
            : 'not_started'
      : null;

    return {
      sessionId: entry.sessionId,
      candidateToken: entry.candidateToken,
      candidatePath,
      scenarioTitle: entry.scenarioTitle,
      status: entry.status,
      createdAt: entry.createdAt,
      activatedAt: entry.activatedAt,
      submittedAt: entry.submittedAt,
      durationSeconds: entry.durationSeconds,
      closureReason: entry.closureReason,
      reviewProcessStatus: reviewStatus,
    };
  });

  return Response.json(
    { assessments },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
};

const invalidRubricWeights = () =>
  Response.json(
    {
      error: {
        code: 'INVALID_RUBRIC_WEIGHTS',
        message:
          'Provide a positive whole-number weight for every task criterion, with no extra criteria, totaling 100.',
      },
    },
    { status: 400, headers: { 'Cache-Control': 'no-store' } },
  );
