import '../../../../../evaluator/sessions/[sessionId]/task-review.css';

import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EvaluatorExperience } from '../../../../../evaluator/sessions/[sessionId]/evaluator-experience';
import { r27EvidenceApiGet } from '../../../../../../src/r23-auth/server';
import { r27IsEnabled } from '../../../../../../src/r27-evidence/config';
import { isAuthenticatedStaging } from '../../../../../../src/runtime/profile';
import { stagingLoadR27EvidencePage } from '../../../../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export default async function R27EvidencePage({
  params,
}: {
  params: Promise<{ organizationId: string; sessionId: string }>;
}) {
  if (!r27IsEnabled() && !isAuthenticatedStaging()) notFound();
  const { organizationId, sessionId } = await params;
  const incomingHeaders = await headers();
  const request = new Request('https://r27-page.invalid/', {
    headers: {
      Accept: 'application/json',
      Cookie: incomingHeaders.get('cookie') ?? '',
    },
  });

  if (isAuthenticatedStaging()) {
    let pageState;
    try {
      pageState = await stagingLoadR27EvidencePage(
        request,
        organizationId,
        sessionId,
      );
    } catch {
      notFound();
    }
    if (pageState.kind === 'unavailable') notFound();
    if (pageState.kind === 'unsubmitted') {
      const s = pageState.session;
      return (
        <main
          className="software-product evaluator-pending-review"
          data-testid="unsubmitted-evidence-unavailable"
        >
          <p className="software-eyebrow">Assigned assessment</p>
          <h1>{s.scenarioTitle}</h1>
          <p role="status">
            {s.status === 'CREATED'
              ? 'Waiting for the candidate to start.'
              : 'Waiting for the candidate to submit.'}{' '}
            The review opens when the session is submitted.
          </p>
          <details className="evaluator-source-details">
            <summary>Assessment details</summary>
            <dl className="evaluator-source-metadata">
              <div>
                <dt>Session</dt>
                <dd>
                  <code>{s.sessionId}</code>
                </dd>
              </div>
              <div>
                <dt>Scenario version</dt>
                <dd>
                  {s.scenarioId} · v{s.scenarioVersion}
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{s.status}</dd>
              </div>
              <div>
                <dt>Time limit</dt>
                <dd>
                  {s.durationSeconds
                    ? `${Math.round(s.durationSeconds / 60)} min`
                    : 'Untimed'}
                </dd>
              </div>
            </dl>
          </details>
          <p>
            <Link
              href={`/r23/organizations/${encodeURIComponent(
                organizationId.toLowerCase(),
              )}/sessions/${encodeURIComponent(sessionId)}`}
            >
              ← Back to session
            </Link>
          </p>
        </main>
      );
    }

    return (
      <main
        className="software-product evaluator-review-shell"
        style={{ width: '100%', maxWidth: 'none', margin: 0, padding: 0 }}
      >
        <h1 className="visually-hidden">Evaluator review</h1>
        <EvaluatorExperience
          sessionId={sessionId}
          readOnly
          r27Evidence={pageState.evidence}
        />
      </main>
    );
  }

  const response = await r27EvidenceApiGet(request, organizationId, sessionId);
  if ([401, 403, 404].includes(response.status)) notFound();
  if (!response.ok)
    throw new Error('Submitted evidence is temporarily unavailable.');
  const evidence = await response.json();

  return (
    <main
      className="software-product evaluator-review-shell"
      style={{ width: '100%', maxWidth: 'none', margin: 0, padding: 0 }}
    >
      <h1 className="visually-hidden">Evaluator review</h1>
      <EvaluatorExperience
        sessionId={sessionId}
        readOnly
        r27Evidence={evidence}
      />
    </main>
  );
}
