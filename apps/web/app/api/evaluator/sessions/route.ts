import { cookies } from 'next/headers';

import { evaluatorCookieName } from '../../../../src/access/evaluator-access';
import { getAuthorizedReviewQueue } from '../../../../src/access/evaluator-evidence';
import { errorResponse } from '../../../../src/http/error-response';
import { getReviewerWorkflowStore } from '../../../../src/review-workflow/reviewer-workflow-store';

const reviewProcessStatus = (
  workflow: ReturnType<ReturnType<typeof getReviewerWorkflowStore>['get']>,
) => {
  if (workflow.clarifications.some((item) => !item.reply && !item.closedAt))
    return 'waiting_for_response';
  if (workflow.nextStep) return 'next_step_recorded';
  if (workflow.note || workflow.clarifications.length) return 'in_progress';
  return 'not_started';
};

export const GET = async () => {
  try {
    const cookieStore = await cookies();
    const queue = getAuthorizedReviewQueue(
      cookieStore.get(evaluatorCookieName)?.value,
    );
    const workflowStore = getReviewerWorkflowStore();
    return Response.json(
      {
        ...queue,
        sessions: queue.sessions.map((session) => ({
          ...session,
          reviewProcessStatus: reviewProcessStatus(
            workflowStore.get(session.sessionId),
          ),
        })),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
};
