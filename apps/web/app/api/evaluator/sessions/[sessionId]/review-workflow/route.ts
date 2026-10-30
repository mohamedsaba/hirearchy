import { cookies } from 'next/headers';

import { evaluatorCookieName } from '../../../../../../src/access/evaluator-access';
import { getAuthorizedEvidence } from '../../../../../../src/access/evaluator-evidence';
import { errorResponse } from '../../../../../../src/http/error-response';
import {
  getReviewerWorkflowStore,
  type ReviewNextStep,
} from '../../../../../../src/review-workflow/reviewer-workflow-store';

type Context = Readonly<{ params: Promise<{ sessionId: string }> }>;
const jsonObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const boundedText = (value: unknown, maximum: number) =>
  typeof value === 'string' && value.length <= maximum ? value.trim() : null;
const nextSteps: readonly ReviewNextStep['action'][] = [
  'continue_review',
  'technical_review',
  'candidate_conversation',
  'closeout',
];

export const GET = async (_request: Request, context: Context) => {
  try {
    const [{ sessionId }, cookieStore] = await Promise.all([
      context.params,
      cookies(),
    ]);
    getAuthorizedEvidence(
      sessionId,
      cookieStore.get(evaluatorCookieName)?.value,
    );
    return Response.json(getReviewerWorkflowStore().get(sessionId), {
      headers: { 'Cache-Control': 'private, no-store' },
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
    getAuthorizedEvidence(
      sessionId,
      cookieStore.get(evaluatorCookieName)?.value,
    );
    let body: Record<string, unknown> | null;
    try {
      body = jsonObject(await request.json());
    } catch {
      body = null;
    }
    if (!body)
      return Response.json(
        {
          error: {
            code: 'INVALID_REVIEW_ACTION',
            message: 'Choose a review action.',
          },
        },
        { status: 400 },
      );

    const store = getReviewerWorkflowStore();
    if (body.action === 'save_note') {
      const note = boundedText(body.body, 4000);
      const expectedVersion = body.expectedVersion;
      if (
        note === null ||
        typeof expectedVersion !== 'number' ||
        !Number.isInteger(expectedVersion) ||
        expectedVersion < 0
      )
        return Response.json(
          {
            error: {
              code: 'INVALID_NOTE',
              message: 'Notes must be 4,000 characters or fewer.',
            },
          },
          { status: 400 },
        );
      const savedNote = store.saveNote(sessionId, note, expectedVersion);
      if (!savedNote)
        return Response.json(
          {
            error: {
              code: 'NOTE_CHANGED',
              message:
                'This note changed in another review tab. Your draft is still here; reload the saved version before replacing it.',
            },
          },
          { status: 409 },
        );
      return Response.json({ note: savedNote });
    }

    if (body.action === 'request_clarification') {
      const prompt = boundedText(body.prompt, 1600);
      const requestKey =
        typeof body.requestKey === 'string' &&
        /^[0-9a-f-]{36}$/i.test(body.requestKey)
          ? body.requestKey
          : null;
      if (!prompt || prompt.length > 1600 || !requestKey)
        return Response.json(
          {
            error: {
              code: 'INVALID_CLARIFICATION',
              message: 'Add a question of up to 1,600 characters.',
            },
          },
          { status: 400 },
        );
      const clarification = store.requestClarification(
        sessionId,
        prompt,
        requestKey,
      );
      if (!clarification)
        return Response.json(
          {
            error: {
              code: 'REQUEST_KEY_CONFLICT',
              message:
                'This request key was already used for a different question. Keep your draft and try again with a new request.',
            },
          },
          { status: 409 },
        );
      return Response.json({ clarification }, { status: 201 });
    }

    if (body.action === 'close_clarification') {
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id || !store.closeClarification(sessionId, id))
        return Response.json(
          {
            error: {
              code: 'CLARIFICATION_NOT_CLOSABLE',
              message:
                'A clarification can be closed after the candidate replies. A pending request remains visible until then.',
            },
          },
          { status: 409 },
        );
      return Response.json({ workflow: store.get(sessionId) });
    }

    if (body.action === 'save_next_step') {
      const action = body.step;
      const note = boundedText(body.note, 2000);
      const expectedVersion = body.expectedVersion;
      if (
        typeof action !== 'string' ||
        !nextSteps.includes(action as ReviewNextStep['action']) ||
        note === null ||
        typeof expectedVersion !== 'number' ||
        !Number.isInteger(expectedVersion) ||
        expectedVersion < 0
      ) {
        return Response.json(
          {
            error: {
              code: 'INVALID_NEXT_STEP',
              message:
                'Choose a next step, keep its note within 2,000 characters, and include the saved version.',
            },
          },
          { status: 400 },
        );
      }
      const nextStep = store.saveNextStep(
        sessionId,
        action as ReviewNextStep['action'],
        note,
        expectedVersion,
      );
      if (!nextStep)
        return Response.json(
          {
            error: {
              code: 'NEXT_STEP_CHANGED',
              message:
                'The saved next step changed in another review tab. Your draft is still here; review the saved version before replacing it.',
            },
          },
          { status: 409 },
        );
      return Response.json({
        nextStep,
      });
    }

    return Response.json(
      {
        error: {
          code: 'INVALID_REVIEW_ACTION',
          message: 'Choose a review action.',
        },
      },
      { status: 400 },
    );
  } catch (error) {
    return errorResponse(error);
  }
};
