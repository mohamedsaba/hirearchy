import { cookies } from 'next/headers';

import { isEvaluatorRequestAuthorized } from '../../../src/access/evaluator-access';
import { getIssuableScenario } from '../../../src/scenarios/issuable-scenarios';
import { errorResponse } from '../../../src/http/error-response';
import { getSessionService } from '../../../src/sessions/session-service';
import { CandidateTokenStorageError } from '../../../src/sessions/candidate-token-storage.mjs';
import {
  ApplicationStartupNotReadyError,
  isAssessmentIssuanceReady,
} from '../../../src/startup-status';

const storageUnavailable = () =>
  Response.json(
    {
      error: {
        code: 'CANDIDATE_TOKEN_STORAGE_UNAVAILABLE',
        message:
          'Session issuance is unavailable until storage and startup checks are ready.',
      },
    },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );

export const POST = async (request: Request) => {
  let cookieStore: Awaited<ReturnType<typeof cookies>> | null = null;
  try {
    cookieStore = await cookies();
  } catch {
    cookieStore = null;
  }

  if (!isEvaluatorRequestAuthorized(request, cookieStore)) {
    return Response.json(
      {
        error: {
          code: 'EVALUATOR_ACCESS_REQUIRED',
          message: 'Evaluator access is required to create a session.',
        },
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (!isAssessmentIssuanceReady()) return storageUnavailable();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      {
        error: {
          code: 'INVALID_SESSION_REQUEST',
          message: 'The session request must contain valid JSON.',
        },
      },
      { status: 400 },
    );
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json(
      {
        error: {
          code: 'INVALID_SESSION_REQUEST',
          message: 'The session request must be an object.',
        },
      },
      { status: 400 },
    );
  }

  const { scenarioId } = body as { scenarioId?: unknown };
  if (scenarioId === undefined || scenarioId === null || scenarioId === '') {
    return Response.json(
      {
        error: {
          code: 'MISSING_SCENARIO_ID',
          message: 'A scenario ID is required to create a session.',
        },
      },
      { status: 400 },
    );
  }

  if (typeof scenarioId !== 'string' || !scenarioId.trim()) {
    return Response.json(
      {
        error: {
          code: 'INVALID_SCENARIO_ID',
          message: 'The scenario ID must be a non-empty string.',
        },
      },
      { status: 400 },
    );
  }

  const issuance = getIssuableScenario(scenarioId);
  if (!issuance) {
    return Response.json(
      {
        error: {
          code: 'UNSUPPORTED_SCENARIO',
          message: 'The requested scenario is not available.',
        },
      },
      { status: 404 },
    );
  }

  let created: ReturnType<
    ReturnType<typeof getSessionService>['createSession']
  >;
  try {
    created = getSessionService().createSession({
      scenario: issuance.scenario,
      aiCapability: issuance.aiCapability,
    });
  } catch (error) {
    if (
      error instanceof CandidateTokenStorageError ||
      error instanceof ApplicationStartupNotReadyError
    ) {
      return storageUnavailable();
    }
    return errorResponse(error);
  }
  const { candidateToken, session } = created;

  return Response.json(
    {
      sessionId: session.id,
      candidatePath: `/candidate/${candidateToken}`,
      scenarioId: session.scenario.id,
    },
    { status: 201 },
  );
};
