import { cookies } from 'next/headers';

import { evaluatorCookieName } from '../../../../../../src/access/evaluator-access';
import { getAuthorizedEvidence } from '../../../../../../src/access/evaluator-evidence';
import type { TaskRubricSnapshot } from '../../../../../../src/assessments/task-rubric';
import { errorResponse } from '../../../../../../src/http/error-response';
import { createTaskAssessmentScoringService } from '../../../../../../src/scoring/task-assessment-scoring-runtime';
import type { TaskScoringSource } from '../../../../../../src/scoring/task-assessment-scoring';

type Context = Readonly<{ params: Promise<{ sessionId: string }> }>;

const noStore = { 'Cache-Control': 'private, no-store' };

const loadAuthorizedSource = async (
  sessionId: string,
  credential: string | undefined,
): Promise<TaskScoringSource> => {
  const evidence = getAuthorizedEvidence(sessionId, credential);
  const rubricEvidence = evidence as typeof evidence & {
    taskRubricSnapshot?: TaskRubricSnapshot | null;
  };

  return {
    sessionId: evidence.sessionId,
    scenario: {
      id: evidence.scenario.id,
      version: evidence.scenario.version,
      title: evidence.scenario.title,
      brief: evidence.scenario.brief,
      acceptanceCriteria: evidence.scenario.acceptanceCriteria,
    },
    activatedAt: evidence.activatedAt,
    submittedAt: evidence.submittedAt,
    diff: evidence.diff,
    events: evidence.events,
    rubric: rubricEvidence.taskRubricSnapshot ?? null,
    aiCapabilitySnapshot: evidence.aiCapabilitySnapshot ?? null,
    // Placeholder: get() ignores it and request() replaces it with its own
    // guarded read, so this route must not pre-load the interaction log.
    aiInteractions: [],
  };
};

export const GET = async (_request: Request, context: Context) => {
  try {
    const [{ sessionId }, cookieStore] = await Promise.all([
      context.params,
      cookies(),
    ]);
    const source = await loadAuthorizedSource(
      sessionId,
      cookieStore.get(evaluatorCookieName)?.value,
    );
    return Response.json(createTaskAssessmentScoringService().get(source), {
      headers: noStore,
    });
  } catch (error) {
    return errorResponse(error);
  }
};

export const POST = async (request: Request, context: Context) => {
  try {
    const [{ sessionId }, cookieStore] = await Promise.all([
      context.params,
      cookies(),
    ]);
    const source = await loadAuthorizedSource(
      sessionId,
      cookieStore.get(evaluatorCookieName)?.value,
    );
    const body = await request.json().catch(() => null);
    const retryFailed =
      Boolean(body) &&
      typeof body === 'object' &&
      'retryFailed' in body &&
      (body as { retryFailed?: unknown }).retryFailed === true;
    const report = await createTaskAssessmentScoringService().request(source, {
      retryFailed,
    });
    return Response.json(report, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
};
