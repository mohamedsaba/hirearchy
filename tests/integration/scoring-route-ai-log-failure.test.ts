import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  createScoringService,
  getAiInteractionService,
  getAuthorizedEvidence,
  getCookie,
  requestScoring,
} = vi.hoisted(() => ({
  createScoringService: vi.fn(),
  getAiInteractionService: vi.fn(() => {
    throw new Error('AI interaction log is unavailable.');
  }),
  getAuthorizedEvidence: vi.fn(),
  getCookie: vi.fn(() => ({ value: 'authorized-evaluator' })),
  requestScoring: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: getCookie }),
}));
vi.mock('../../apps/web/src/ai/ai-interaction-service', () => ({
  getAiInteractionService,
}));
vi.mock('../../apps/web/src/access/evaluator-evidence', () => ({
  getAuthorizedEvidence,
}));
vi.mock('../../apps/web/src/scoring/task-assessment-scoring-runtime', () => ({
  createTaskAssessmentScoringService: createScoringService,
}));

import { POST } from '../../apps/web/app/api/evaluator/sessions/[sessionId]/assessment-score/route';

describe('assessment score route AI log failure', () => {
  afterEach(() => vi.resetAllMocks());

  it('hands AI log reads to scoring and returns its typed failed report', async () => {
    getCookie.mockReturnValue({ value: 'authorized-evaluator' });
    getAuthorizedEvidence.mockReturnValue({
      sessionId: 'submitted-session',
      scenario: {
        id: 'scenario',
        version: '1',
        title: 'Task',
        brief: 'Task brief',
        acceptanceCriteria: ['Complete the task'],
      },
      activatedAt: '2026-10-01T09:00:00.000Z',
      submittedAt: '2026-10-01T10:00:00.000Z',
      diff: '',
      events: [],
      taskRubricSnapshot: {
        version: 'rubric-v1',
        criteria: [],
      },
      aiCapabilitySnapshot: null,
    });
    const failedReport = {
      status: 'failed',
      rubric: { version: 'rubric-v1', criteria: [] },
      totalScore: null,
      applicableWeight: null,
      scoredWeight: null,
      providerId: null,
      model: null,
      analyzedAt: '2026-10-01T10:00:01.000Z',
      criteria: [],
    };
    requestScoring.mockResolvedValue(failedReport);
    createScoringService.mockReturnValue({ request: requestScoring });

    const response = await POST(
      new Request('http://localhost/score', { method: 'POST' }),
      { params: Promise.resolve({ sessionId: 'submitted-session' }) },
    );

    expect(getAuthorizedEvidence).toHaveBeenCalledWith(
      'submitted-session',
      'authorized-evaluator',
    );
    expect(getAiInteractionService).not.toHaveBeenCalled();
    expect(requestScoring).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(failedReport);
  });
});
