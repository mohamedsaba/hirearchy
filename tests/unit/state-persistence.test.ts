// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readPersistedJson,
  removePersistedKey,
  writePersistedJson,
} from '../../apps/web/src/ui/browser-state';
import {
  hiringDecisionDraftKey,
  initialHiringDecisionDraft,
  restoreHiringDecisionDraft,
} from '../../apps/web/app/evaluator/sessions/[sessionId]/hiring-decision-panel';
import {
  clearBuilderGenerationJobsForTest,
  consumeBuilderGenerationJob,
  getLatestBuilderGenerationJob,
  startBuilderGenerationJob,
} from '../../apps/web/src/hiring/builder-generation-jobs';
import type { SessionHiringReviewContext } from '../../apps/web/src/hiring/types';

function makeContext(
  overrides: Partial<SessionHiringReviewContext> = {},
): SessionHiringReviewContext {
  return {
    organizationId: '11111111-1111-1111-1111-111111111111',
    organizationName: 'Acme Craft',
    sessionId: 'sess_cross_tab_draft',
    scenarioTitle: 'Reservation Moves',
    candidateEmail: 'nadia@candidate.test',
    candidateName: 'Nadia Hassan',
    candidateCode: 'CAND-1024',
    targetRole: 'Senior Backend Engineer',
    experienceLevel: 'senior',
    skills: ['Python', 'PostgreSQL'],
    currentPrincipalId: 'principal-lead',
    currentRole: 'reviewer',
    canPublishDecision: true,
    plan: {
      planTier: 'ultra',
      planStatus: 'active',
      candidateCreditsPurchased: 0,
      candidateCreditsUsed: 0,
      candidateCreditsRemaining: null,
      creditedEmails: [],
    },
    teamMembers: [
      {
        principalId: 'principal-recruiter',
        displayName: 'Sarah Chen',
        email: 'sarah@acme.test',
        role: 'recruiter',
        isOwner: true,
      },
    ],
    decision: null,
    secondOpinions: [],
    ...overrides,
  };
}

describe('browser state persistence helpers & cross-tab draft recovery', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it('gives sessionStorage precedence over localStorage and restores cross-tab from localStorage', () => {
    const key = 'hirearchy:test:prefs:v1';

    expect(
      writePersistedJson(key, { tab: 'Evidence', filter: 'Tests' }, 'durable'),
    ).toBe(true);
    expect(readPersistedJson<{ tab: string }>(key, 'durable')?.tab).toBe(
      'Evidence',
    );

    // Simulate opening a brand-new browser tab (empty sessionStorage, shared localStorage)
    window.sessionStorage.clear();
    expect(readPersistedJson<{ tab: string }>(key, 'session')).toBeNull();
    expect(readPersistedJson<{ tab: string }>(key, 'durable')).toEqual({
      tab: 'Evidence',
      filter: 'Tests',
    });

    // In-tab override in sessionStorage wins over stale localStorage
    window.sessionStorage.setItem(
      key,
      JSON.stringify({ tab: 'Review', filter: 'Chronology' }),
    );
    expect(readPersistedJson<{ tab: string }>(key, 'durable')?.tab).toBe(
      'Review',
    );

    removePersistedKey(key);
    expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('restores evaluator decision draft across tabs from localStorage when sessionStorage is empty', () => {
    const context = makeContext({
      sessionId: 'sess_cross_tab_draft',
    });
    const defaults = initialHiringDecisionDraft(context);
    const key = hiringDecisionDraftKey(context.sessionId);

    window.localStorage.setItem(
      key,
      JSON.stringify({
        decision: 'rejected',
        internalNotes: 'Follow up on concurrency boundary',
      }),
    );

    const restored = restoreHiringDecisionDraft(context.sessionId, defaults);
    expect(restored.decision).toBe('rejected');
    expect(restored.internalNotes).toBe('Follow up on concurrency boundary');
  });
});

describe('builder async generation job store', () => {
  beforeEach(() => {
    clearBuilderGenerationJobsForTest();
  });

  afterEach(() => {
    clearBuilderGenerationJobsForTest();
  });

  it('tracks running jobs, survives navigation until completion, isolates owners, and clears on consume', async () => {
    let resolveRunner!: (value: {
      draft: {
        title: string;
        targetRole: string;
        experienceLevel: 'senior';
        yearsExperience: number;
        skills: string[];
        problemStructure: 'multi_file';
        durationMinutes: 60;
        integratedAi: boolean;
        brief: string;
        files: { path: string; content: string; editable: boolean }[];
        starterCommand: string;
        verificationCommand: string;
        evaluatorRubric: string;
      };
      modelId: string;
    }) => void;

    const baseRequest = {
      organizationId: '11111111-1111-1111-1111-111111111111',
      principalId: 'principal-author',
      draftId: 'draft-123',
      targetRole: 'Backend Engineer',
      experienceLevel: 'senior' as const,
      yearsExperience: 6,
      skills: ['TypeScript', 'PostgreSQL'],
      problemStructure: 'multi_file' as const,
      workKind: 'Bug fix',
      domain: 'API',
      durationMinutes: 60 as const,
      integratedAi: true,
    };

    const job1 = startBuilderGenerationJob(
      baseRequest,
      () =>
        new Promise((resolve) => {
          resolveRunner = resolve;
        }),
    );

    expect(job1.status).toBe('running');

    // Duplicate trigger while in-flight for the same (org, principal) reuses the active job.
    const job2 = startBuilderGenerationJob(baseRequest, async () => {
      throw new Error('should not invoke second runner');
    });
    expect(job2.jobId).toBe(job1.jobId);

    // Other principals or organizations do not see this job.
    expect(
      getLatestBuilderGenerationJob(
        baseRequest.organizationId,
        'principal-other',
      ),
    ).toBeNull();
    expect(
      getLatestBuilderGenerationJob(
        '22222222-2222-2222-2222-222222222222',
        baseRequest.principalId,
      ),
    ).toBeNull();

    // Cannot consume while still running.
    expect(
      consumeBuilderGenerationJob(
        baseRequest.organizationId,
        baseRequest.principalId,
        job1.jobId,
      ),
    ).toBe(false);

    resolveRunner({
      modelId: 'gemini-test',
      draft: {
        title: 'Async Retry Queue',
        targetRole: 'Backend Engineer',
        experienceLevel: 'senior',
        yearsExperience: 6,
        skills: ['TypeScript', 'PostgreSQL'],
        problemStructure: 'multi_file',
        durationMinutes: 60,
        integratedAi: true,
        brief: 'Fix retry ordering.',
        files: [{ path: 'src/queue.ts', content: '// code', editable: true }],
        starterCommand: 'npm test',
        verificationCommand: 'npm test',
        evaluatorRubric: 'Checks idempotency.',
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    const completed = getLatestBuilderGenerationJob(
      baseRequest.organizationId,
      baseRequest.principalId,
    );
    expect(completed?.status).toBe('completed');
    expect(completed?.draft?.title).toBe('Async Retry Queue');
    expect(completed?.modelId).toBe('gemini-test');

    expect(
      consumeBuilderGenerationJob(
        baseRequest.organizationId,
        baseRequest.principalId,
        job1.jobId,
      ),
    ).toBe(true);
    expect(
      getLatestBuilderGenerationJob(
        baseRequest.organizationId,
        baseRequest.principalId,
      ),
    ).toBeNull();
  });

  it('records failed status when the generation runner throws', async () => {
    const req = {
      organizationId: '11111111-1111-1111-1111-111111111111',
      principalId: 'principal-author',
      targetRole: 'Backend Engineer',
      experienceLevel: 'mid' as const,
      yearsExperience: 3,
      skills: ['Python'],
      problemStructure: 'single_file' as const,
      workKind: 'Feature implementation',
      domain: 'API',
      durationMinutes: 45 as const,
      integratedAi: false,
    };

    const job = startBuilderGenerationJob(req, async () => {
      throw new Error('Model rate limit exceeded');
    });

    await Promise.resolve();
    await Promise.resolve();

    const failed = getLatestBuilderGenerationJob(
      req.organizationId,
      req.principalId,
      job.jobId,
    );
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('Model rate limit exceeded');
  });
});
