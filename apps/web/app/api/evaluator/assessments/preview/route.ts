import path from 'node:path';
import { cookies } from 'next/headers';
import { ZodError } from 'zod';

import {
  evaluatorCookieName,
  isEvaluatorCookieValid,
} from '../../../../../src/access/evaluator-access';
import { disabledAiCapabilitySnapshot } from '../../../../../src/ai/ai-interaction';
import { isSupportedAssessmentSelection } from '../../../../../src/assessments/assessment-options';
import { parseAssessmentSelection } from '../../../../../src/assessments/assessment-selection';
import {
  createGeneratedTaskRubric,
  createScenario002TaskRubric,
} from '../../../../../src/assessments/task-rubric';
import { getApplicationDatabasePath } from '../../../../../src/database/database-path';
import { loadValidatedGeneratedAssessment } from '../../../../../src/scenarios/generated-assessment';
import { getIssuableScenario } from '../../../../../src/scenarios/issuable-scenarios';

export const dynamic = 'force-dynamic';

export const POST = async (request: Request) => {
  const cookieStore = await cookies();
  if (!isEvaluatorCookieValid(cookieStore.get(evaluatorCookieName)?.value)) {
    return Response.json(
      {
        error: {
          code: 'EVALUATOR_ACCESS_REQUIRED',
          message: 'Evaluator access is required to preview an assessment.',
        },
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
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
          message: 'Choose assessment options before previewing the link.',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const rawBody =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const { generatedAssessmentId, ...selectionBody } = rawBody;
  const selection = parseAssessmentSelection(selectionBody);
  if (!selection) {
    return Response.json(
      {
        error: {
          code: 'INVALID_ASSESSMENT_SELECTION',
          message: 'The selected options are incomplete or unavailable.',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (!isSupportedAssessmentSelection(selection)) {
    return Response.json(
      {
        error: {
          code: 'ASSESSMENT_NOT_READY',
          message:
            'This combination is still being prepared. Choose the available blueprint to preview it.',
        },
      },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    );
  }
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

  let taskRubric = createScenario002TaskRubric();
  let scenarioSnapshot = {
    id: configuredScenario.scenario.id,
    version: configuredScenario.scenario.version,
    title: configuredScenario.scenario.title,
    durationSeconds: selection.durationMinutes * 60,
    brief: configuredScenario.scenario.brief,
    acceptanceCriteria: configuredScenario.scenario.acceptanceCriteria,
  };

  if (Object.hasOwn(rawBody, 'generatedAssessmentId')) {
    const unavailable = () =>
      Response.json(
        {
          error: {
            code: 'GENERATED_ASSESSMENT_UNAVAILABLE',
            message:
              'The validated task draft is unavailable. Prepare it again before previewing.',
          },
        },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    if (typeof generatedAssessmentId !== 'string') return unavailable();

    let generated;
    try {
      generated = await loadValidatedGeneratedAssessment(
        path.dirname(getApplicationDatabasePath()),
        generatedAssessmentId,
      );
    } catch (error) {
      if (error instanceof ZodError || error instanceof SyntaxError)
        return unavailable();
      throw error;
    }
    if (!generated) return unavailable();

    taskRubric = createGeneratedTaskRubric({
      artifactId: generated.id,
      title: generated.assessment.title,
      brief: generated.assessment.brief,
      acceptanceCriteria: generated.assessment.acceptanceCriteria,
      rubric: generated.assessment.rubric,
      integratedAi: selection.integratedAi,
    });
    scenarioSnapshot = {
      ...scenarioSnapshot,
      title: generated.assessment.title,
      brief: generated.assessment.brief,
      acceptanceCriteria: generated.assessment.acceptanceCriteria,
    };
  }

  return Response.json(
    {
      scenario: scenarioSnapshot,
      taskRubric,
      aiCapability: selection.integratedAi
        ? { enabled: configuredScenario.aiCapability.enabled }
        : { enabled: disabledAiCapabilitySnapshot.enabled },
      terminalEnabled: selection.terminalEnabled ?? true,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
