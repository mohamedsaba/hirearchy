import '../../../../../evaluator/sessions/[sessionId]/task-review.css';

import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { EvaluatorExperience } from '../../../../../evaluator/sessions/[sessionId]/evaluator-experience';
import type { SessionHiringReviewContext } from '../../../../../../src/hiring/types';
import { R23AuthenticationDenied } from '../../../../../../src/r23-auth/identity';
import { r27EvidenceApiGet } from '../../../../../../src/r23-auth/server';
import { r27IsEnabled } from '../../../../../../src/r27-evidence/config';
import {
  isAuthenticatedStaging,
  isHiringPlatformEnabled,
} from '../../../../../../src/runtime/profile';
import {
  loadHiringOrganizationWorkspaceFromCookie,
  stagingLoadR27EvidencePage,
} from '../../../../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseInitialTab(
  rawTab: string | undefined,
  hasPeerReview: boolean,
): 'Summary' | 'Evidence' | 'Review' | undefined {
  const normalized = rawTab?.trim().toLowerCase();
  if (normalized === 'review') return 'Review';
  if (normalized === 'evidence') return 'Evidence';
  if (normalized === 'summary') return 'Summary';
  return hasPeerReview ? 'Review' : undefined;
}

export default async function R27EvidencePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; sessionId: string }>;
  searchParams: Promise<{ tab?: string; peerReview?: string }>;
}) {
  if (!r27IsEnabled() && !isAuthenticatedStaging()) notFound();
  const [{ organizationId, sessionId }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const initialPeerReviewId =
    typeof query.peerReview === 'string' &&
    UUID_PATTERN.test(query.peerReview.trim())
      ? query.peerReview.trim().toLowerCase()
      : null;
  const initialTab = parseInitialTab(
    typeof query.tab === 'string' ? query.tab : undefined,
    Boolean(initialPeerReviewId),
  );
  const incomingHeaders = await headers();
  const request = new Request('https://r27-page.invalid/', {
    headers: {
      Accept: 'application/json',
      Cookie: incomingHeaders.get('cookie') ?? '',
    },
  });

  if (isAuthenticatedStaging()) {
    let pageState;
    let shouldRedirectToLogin = false;
    try {
      pageState = await stagingLoadR27EvidencePage(
        request,
        organizationId,
        sessionId,
      );
    } catch (error) {
      if (
        isHiringPlatformEnabled() &&
        error instanceof R23AuthenticationDenied &&
        UUID_PATTERN.test(organizationId) &&
        /^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
      ) {
        shouldRedirectToLogin = true;
      } else {
        notFound();
      }
    }
    if (shouldRedirectToLogin) {
      const nextParams = new URLSearchParams();
      if (initialTab) nextParams.set('tab', initialTab.toLowerCase());
      if (initialPeerReviewId)
        nextParams.set('peerReview', initialPeerReviewId);
      const nextQuery = nextParams.toString();
      const targetPath = `/r27/organizations/${encodeURIComponent(
        organizationId.toLowerCase(),
      )}/sessions/${encodeURIComponent(sessionId)}${
        nextQuery ? `?${nextQuery}` : ''
      }`;
      redirect(`/r23/login?next=${encodeURIComponent(targetPath)}`);
    }
    if (!pageState || pageState.kind === 'unavailable') notFound();
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

    const hiringReviewContext: SessionHiringReviewContext | null =
      isHiringPlatformEnabled()
        ? await loadHiringOrganizationWorkspaceFromCookie(
            incomingHeaders.get('cookie') ?? '',
            organizationId,
          )
            .then((ws) =>
              ws
                ? (ws.dispatch('hiring.review.context', {
                    organizationId: ws.organizationId,
                    sessionId,
                  }) as Promise<SessionHiringReviewContext>)
                : null,
            )
            .catch(() => null)
        : null;

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
          hiringReviewContext={hiringReviewContext}
          initialTab={initialTab}
          initialPeerReviewId={initialPeerReviewId}
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
