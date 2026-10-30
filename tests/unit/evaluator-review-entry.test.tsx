import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { cookies } from 'next/headers';

import { EvaluatorAccessForm } from '../../apps/web/app/evaluator/evaluator-access-form';
import EvaluatorAccessPage from '../../apps/web/app/evaluator/page';
import {
  EvaluatorReviewQueueContent,
  type QueueState,
} from '../../apps/web/app/evaluator/evaluator-review-queue';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';

vi.mock('next/headers', () => ({ cookies: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe('evaluator review entry', () => {
  it('renders authorized review entries as a semantic list of direct session links', () => {
    const state: QueueState = {
      kind: 'ready',
      sessions: [
        {
          sessionId: 'session-entry-1',
          scenarioTitle: 'Inventory cache incident',
          submittedAt: '2026-09-22T10:00:00.000Z',
          durationSeconds: 3600,
          closureReason: 'candidate_submission',
        },
      ],
    };

    const html = renderToStaticMarkup(
      <EvaluatorReviewQueueContent state={state} />,
    );

    expect(html).toContain('<ul');
    expect(html).toContain('Inventory cache incident');
    expect(html).toContain('href="/evaluator/sessions/session-entry-1"');
    expect(html).toContain(
      'aria-label="Review Inventory cache incident, session session-entry-1"',
    );
    expect(html).toContain('1h 0m assessment');
    expect(html).toContain('Submitted by candidate');
    expect(html).toContain('Filter by task or session reference');
  });

  it('distinguishes an empty queue from unavailable discovery', () => {
    expect(
      renderToStaticMarkup(
        <EvaluatorReviewQueueContent state={{ kind: 'ready', sessions: [] }} />,
      ),
    ).toContain('No submitted assessments are available for review.');
    expect(
      renderToStaticMarkup(
        <EvaluatorReviewQueueContent state={{ kind: 'service-error' }} />,
      ),
    ).toContain('Submitted assessments could not be loaded.');
  });

  it('keeps known-session access as a semantic form after authentication', () => {
    const html = renderToStaticMarkup(<EvaluatorAccessForm authenticated />);

    expect(html).toContain('Known session reference');
    expect(html).toContain('Open known session');
    expect(html).not.toContain('Evaluator credential');
  });

  it('shows the evaluator sign-in first and gates the assessment creation action', async () => {
    const originalCredential = process.env.HIREARCHY_EVALUATOR_KEY;
    process.env.HIREARCHY_EVALUATOR_KEY = 'local-review-key';
    vi.mocked(cookies).mockResolvedValue({
      get: () => ({ value: createSignedEvaluatorToken('local-review-key') }),
    } as never);

    const authorizedPage = renderToStaticMarkup(await EvaluatorAccessPage());
    expect(authorizedPage).toContain('href="/evaluator/assessments/new"');
    expect(authorizedPage).toContain('Create assessment');
    expect(authorizedPage).toContain('Submitted assessments');
    expect(authorizedPage).not.toContain('Evaluator perspective');

    vi.mocked(cookies).mockResolvedValue({ get: () => undefined } as never);
    const publicPage = renderToStaticMarkup(await EvaluatorAccessPage());
    expect(publicPage).toContain('Review submitted work.');
    expect(publicPage).toContain('Evaluator credential');
    expect(publicPage).not.toContain('Create assessment');

    if (originalCredential === undefined) {
      delete process.env.HIREARCHY_EVALUATOR_KEY;
    } else {
      process.env.HIREARCHY_EVALUATOR_KEY = originalCredential;
    }
  });
});
