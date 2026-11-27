import '../../../../evaluator/sessions/[sessionId]/task-review.css';

import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import {
  buildSampleHiringReviewContext,
  DEMO_R27_EVIDENCE,
  DEMO_SESSION_ID,
} from '../../../../../src/demo/sample-session';
import { isHiringPlatformEnabled } from '../../../../../src/runtime/profile';
import { loadHiringOrganizationWorkspaceFromCookie } from '../../../../../src/staging/browser';
import { EvaluatorExperience } from '../../../../evaluator/sessions/[sessionId]/evaluator-experience';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export default async function OrganizationSampleReviewPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  if (!isHiringPlatformEnabled()) {
    notFound();
  }
  const { organizationId } = await params;
  const incomingHeaders = await headers();
  const workspace = await loadHiringOrganizationWorkspaceFromCookie(
    incomingHeaders.get('cookie') ?? '',
    organizationId,
  );
  if (!workspace) {
    redirect(
      `/r23/login?next=${encodeURIComponent(`/r23/organizations/${organizationId.toLowerCase()}/sample-review`)}`,
    );
  }

  const sampleContext = buildSampleHiringReviewContext({
    organizationId: workspace.organizationId,
    organizationName: workspace.organizationName,
    currentPrincipalId: workspace.orgContext.principalId,
  });

  return (
    <main
      className="software-product evaluator-review-shell"
      style={{ width: '100%', maxWidth: 'none', margin: 0, padding: 0 }}
    >
      <h1 className="visually-hidden">
        Sample Evaluated Candidate Review — {workspace.organizationName}
      </h1>
      <EvaluatorExperience
        sessionId={DEMO_SESSION_ID}
        readOnly
        isSample
        r27Evidence={DEMO_R27_EVIDENCE}
        hiringReviewContext={sampleContext}
      />
    </main>
  );
}
