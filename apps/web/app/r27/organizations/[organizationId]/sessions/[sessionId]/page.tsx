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
          className="software-product evaluator-review-shell"
          data-testid="unsubmitted-evidence-unavailable"
          style={{
            maxWidth: '880px',
            margin: '32px auto',
            padding: '24px',
            borderRadius: '12px',
            border: '1px solid #d1d5db',
            backgroundColor: '#ffffff',
          }}
        >
          <h1>Submitted Evidence Unavailable (Session Not Submitted)</h1>
          <p role="status">
            Unsubmitted candidate evidence is unavailable in the R2.15
            authenticated staging slice. Candidate workspace execution and live
            AI-provider operations are disabled; chronological evidence
            reconstruction opens only after a session is in{' '}
            <code>SUBMITTED</code> status.
          </p>
          <section aria-labelledby="unsubmitted-metadata-title">
            <h2 id="unsubmitted-metadata-title">
              Permitted Assessment Metadata
            </h2>
            <dl>
              <dt>
                <strong>Assessment Title:</strong>
              </dt>
              <dd>{s.scenarioTitle}</dd>
              <dt>
                <strong>Session ID:</strong>
              </dt>
              <dd>
                <code>{s.sessionId}</code>
              </dd>
              <dt>
                <strong>Scenario:</strong>
              </dt>
              <dd>
                <code>{s.scenarioId}</code> (v{s.scenarioVersion})
              </dd>
              <dt>
                <strong>Lifecycle Status:</strong>
              </dt>
              <dd>
                <code>{s.status}</code>
              </dd>
              <dt>
                <strong>Time Budget:</strong>
              </dt>
              <dd>
                {s.durationSeconds
                  ? `${Math.round(s.durationSeconds / 60)} min`
                  : 'Untimed'}
              </dd>
            </dl>
          </section>
          <p>
            <Link
              href={`/r23/organizations/${encodeURIComponent(organizationId.toLowerCase())}/sessions/${encodeURIComponent(sessionId)}`}
            >
              ← Back to authorized session summary
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
