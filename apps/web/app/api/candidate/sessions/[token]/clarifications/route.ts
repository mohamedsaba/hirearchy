import { errorResponse } from '../../../../../../src/http/error-response';
import { getReviewerWorkflowStore } from '../../../../../../src/review-workflow/reviewer-workflow-store';
import { SessionError } from '../../../../../../src/sessions/session';
import { getSessionService } from '../../../../../../src/sessions/session-service';

type Context = Readonly<{ params: Promise<{ token: string }> }>;
const submittedSession = (token: string) => {
  const session = getSessionService().getCandidateSession(token);
  if (session.status !== 'SUBMITTED') {
    throw new SessionError(
      'SESSION_NOT_ACTIVE',
      'Clarifications are available after submission.',
    );
  }
  return session;
};

export const GET = async (_request: Request, context: Context) => {
  try {
    const { token } = await context.params;
    const session = submittedSession(token);
    const workflow = getReviewerWorkflowStore().get(session.id);
    return Response.json(
      { clarifications: workflow.clarifications },
      {
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
};

export const POST = async (request: Request, context: Context) => {
  try {
    const { token } = await context.params;
    const session = submittedSession(token);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        {
          error: {
            code: 'INVALID_CLARIFICATION_REPLY',
            message: 'Write a reply of up to 1,600 characters.',
          },
        },
        { status: 400 },
      );
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json(
        {
          error: {
            code: 'INVALID_CLARIFICATION_REPLY',
            message: 'Write a reply of up to 1,600 characters.',
          },
        },
        { status: 400 },
      );
    }
    const value = body as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id : '';
    const reply = typeof value.reply === 'string' ? value.reply.trim() : '';
    if (!id || !reply || reply.length > 1600) {
      return Response.json(
        {
          error: {
            code: 'INVALID_CLARIFICATION_REPLY',
            message: 'Write a reply of up to 1,600 characters.',
          },
        },
        { status: 400 },
      );
    }
    const clarification = getReviewerWorkflowStore().replyToClarification(
      session.id,
      id,
      reply,
    );
    if (!clarification) {
      return Response.json(
        {
          error: {
            code: 'CLARIFICATION_NOT_FOUND',
            message: 'This request is unavailable for this candidate session.',
          },
        },
        { status: 404 },
      );
    }
    if (clarification === 'conflict') {
      return Response.json(
        {
          error: {
            code: 'CLARIFICATION_NOT_OPEN',
            message: 'This request is no longer open.',
          },
        },
        { status: 409 },
      );
    }
    return Response.json({ clarification });
  } catch (error) {
    return errorResponse(error);
  }
};
