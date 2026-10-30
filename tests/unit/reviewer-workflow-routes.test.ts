import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getCandidateSession,
  getSubmittedEvidence,
  workflowStore,
  cookieValue,
} = vi.hoisted(() => ({
  getCandidateSession: vi.fn(),
  getSubmittedEvidence: vi.fn(),
  workflowStore: {
    get: vi.fn(),
    replyToClarification: vi.fn(),
    closeClarification: vi.fn(),
    saveNote: vi.fn(),
    saveNextStep: vi.fn(),
  },
  cookieValue: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieValue();
      return name === 'hirearchy_evaluator' && value ? { value } : undefined;
    },
  }),
}));
vi.mock('../../apps/web/src/sessions/session-service', () => ({
  getSessionService: () => ({ getCandidateSession, getSubmittedEvidence }),
}));
vi.mock('../../apps/web/src/review-workflow/reviewer-workflow-store', () => ({
  getReviewerWorkflowStore: () => workflowStore,
}));

import {
  GET as candidateClarificationsGet,
  POST as candidateClarificationsPost,
} from '../../apps/web/app/api/candidate/sessions/[token]/clarifications/route';
import {
  GET as evaluatorWorkflowGet,
  POST as evaluatorWorkflowPost,
} from '../../apps/web/app/api/evaluator/sessions/[sessionId]/review-workflow/route';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';

const context = (token: string) => ({ params: Promise.resolve({ token }) });
const evaluatorContext = (sessionId: string) => ({
  params: Promise.resolve({ sessionId }),
});
const originalEvaluatorKey = process.env.HIREARCHY_EVALUATOR_KEY;
const authorizeEvaluator = () => {
  process.env.HIREARCHY_EVALUATOR_KEY = 'test-review-key';
  cookieValue.mockReturnValue(createSignedEvaluatorToken('test-review-key'));
  getSubmittedEvidence.mockReturnValue({ sessionId: 'session-1' });
};

describe('review workflow route boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieValue.mockReset();
    getSubmittedEvidence.mockReset();
    workflowStore.saveNextStep.mockReset();
    getCandidateSession.mockReturnValue({
      id: 'session-candidate-token',
      status: 'SUBMITTED',
    });
    workflowStore.get.mockReturnValue({
      note: { body: 'reviewer-only text' },
      clarifications: [
        {
          id: 'clarification-1',
          prompt: 'Question',
          reply: 'Candidate words',
          closedAt: null,
        },
      ],
      nextStep: { action: 'closeout', note: 'reviewer-only next step' },
    });
  });

  afterEach(() => {
    if (originalEvaluatorKey === undefined)
      delete process.env.HIREARCHY_EVALUATOR_KEY;
    else process.env.HIREARCHY_EVALUATOR_KEY = originalEvaluatorKey;
  });

  it('requires evaluator authorization before reading reviewer workflow', async () => {
    const response = await evaluatorWorkflowGet(
      new Request(
        'http://localhost/api/evaluator/sessions/session-1/review-workflow',
      ),
      { params: Promise.resolve({ sessionId: 'session-1' }) },
    );

    expect(response.status).toBe(401);
    expect(workflowStore.get).not.toHaveBeenCalled();
  });

  it('requires the expected version and returns a conflict for a stale next-step save', async () => {
    authorizeEvaluator();
    workflowStore.saveNextStep.mockReturnValue(null);
    const response = await evaluatorWorkflowPost(
      new Request(
        'http://localhost/api/evaluator/sessions/session-1/review-workflow',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'save_next_step',
            step: 'closeout',
            note: 'Stale draft',
            expectedVersion: 1,
          }),
        },
      ),
      evaluatorContext('session-1'),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'NEXT_STEP_CHANGED' },
    });
    expect(workflowStore.saveNextStep).toHaveBeenCalledWith(
      'session-1',
      'closeout',
      'Stale draft',
      1,
    );
  });

  it('rejects a next-step save without a valid expected version', async () => {
    authorizeEvaluator();
    const response = await evaluatorWorkflowPost(
      new Request(
        'http://localhost/api/evaluator/sessions/session-1/review-workflow',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'save_next_step',
            step: 'closeout',
            note: 'Draft',
          }),
        },
      ),
      evaluatorContext('session-1'),
    );

    expect(response.status).toBe(400);
    expect(workflowStore.saveNextStep).not.toHaveBeenCalled();
  });

  it('projects only clarification communication through the matching submitted candidate token', async () => {
    const response = await candidateClarificationsGet(
      new Request(
        'http://localhost/api/candidate/sessions/token/clarifications',
      ),
      context('candidate-token'),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(workflowStore.get).toHaveBeenCalledWith('session-candidate-token');
    expect(body).toEqual({
      clarifications: [
        {
          id: 'clarification-1',
          prompt: 'Question',
          reply: 'Candidate words',
          closedAt: null,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('reviewer-only');
  });

  it('does not expose or accept clarification operations before candidate submission', async () => {
    getCandidateSession.mockReturnValue({
      id: 'session-candidate-token',
      status: 'ACTIVE',
    });
    const response = await candidateClarificationsPost(
      new Request(
        'http://localhost/api/candidate/sessions/token/clarifications',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'clarification-1', reply: 'No' }),
        },
      ),
      context('candidate-token'),
    );

    expect(response.status).toBe(409);
    expect(workflowStore.replyToClarification).not.toHaveBeenCalled();
  });

  it('rejects malformed and cross-session replies without touching other records', async () => {
    const malformed = await candidateClarificationsPost(
      new Request(
        'http://localhost/api/candidate/sessions/token/clarifications',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'clarification-1',
            reply: ' '.repeat(1601),
          }),
        },
      ),
      context('candidate-token'),
    );
    expect(malformed.status).toBe(400);
    expect(workflowStore.replyToClarification).not.toHaveBeenCalled();

    workflowStore.replyToClarification.mockReturnValue(null);
    const crossSession = await candidateClarificationsPost(
      new Request(
        'http://localhost/api/candidate/sessions/token/clarifications',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'clarification-from-another-session',
            reply: 'Reply',
          }),
        },
      ),
      context('candidate-token'),
    );
    expect(crossSession.status).toBe(404);
    expect(workflowStore.replyToClarification).toHaveBeenCalledWith(
      'session-candidate-token',
      'clarification-from-another-session',
      'Reply',
    );
  });

  it('distinguishes a conflicting reply from an unavailable clarification without leaking it', async () => {
    workflowStore.replyToClarification.mockReturnValue('conflict');
    const response = await candidateClarificationsPost(
      new Request(
        'http://localhost/api/candidate/sessions/token/clarifications',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'clarification-1',
            reply: 'Changed reply',
          }),
        },
      ),
      context('candidate-token'),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'CLARIFICATION_NOT_OPEN' },
    });
  });
});
