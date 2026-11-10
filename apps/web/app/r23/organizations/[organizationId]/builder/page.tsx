import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  loadAuthenticatedOrganizationSessionList,
  r211AssessmentDraftApiGet,
  r25OrganizationReviewersApiGet,
} from '../../../../../src/r23-auth/server';
import {
  dispatchVerifiedStagingOperation,
  loadStagingConfiguration,
} from '../../../../../src/staging/server';
import type { OrganizationMemberItem } from '../../../../../src/staging/onboarding';
import { isFounderUatEnabled } from '../../../../../src/runtime/founder-uat';
import { isAuthenticatedStaging } from '../../../../../src/runtime/profile';
import { AssessmentBuilderClient } from './assessment-builder-client';
import type { R211AssessmentDraft } from '../../../../../src/r211-builder/contract';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
export const metadata: Metadata = { title: 'Assessment Builder' };

export default async function AssessmentBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams?: Promise<{ issuedSession?: string | string[] }>;
}) {
  const { organizationId } = await params;
  const query = await searchParams;
  const initialIssuedSessionId =
    typeof query?.issuedSession === 'string' ? query.issuedSession : null;
  const incomingHeaders = await headers();
  const cookie = incomingHeaders.get('cookie') ?? '';

  const request = new Request('https://hirearchy-builder.invalid/', {
    headers: {
      Accept: 'application/json',
      Cookie: cookie,
    },
  });

  let context;
  try {
    context = await loadAuthenticatedOrganizationSessionList(
      request,
      organizationId,
    );
  } catch {
    redirect('/r23/login');
  }

  // Role boundary: Only active recruiters can author and issue assessments
  if (context.membership.role !== 'recruiter') {
    notFound();
  }

  const contextWithStaging = context as typeof context & {
    reviewers?: Array<{ principalId: string; role: string; joinedAt: string }>;
    draft?: R211AssessmentDraft | null;
  };

  let reviewers = contextWithStaging.reviewers ?? [];
  if (reviewers.length === 0) {
    try {
      const reviewersRes = await r25OrganizationReviewersApiGet(
        request,
        organizationId,
      );
      if (reviewersRes.ok) {
        const data = await reviewersRes.json();
        reviewers = data?.reviewers ?? [];
      }
    } catch {
      reviewers = [];
    }
  }

  if (isFounderUatEnabled() && context.membership.role === 'recruiter') {
    const membersResult = (await dispatchVerifiedStagingOperation(
      loadStagingConfiguration(),
      context.identity,
      'organization.members.list',
      { organizationId },
    )) as { members?: OrganizationMemberItem[] } | null;
    if (!Array.isArray(membersResult?.members)) {
      throw new Error('Organization member information is unavailable.');
    }

    const memberByPrincipalId = new Map(
      membersResult.members
        .filter(
          (member) => member.status === 'active' && member.role === 'reviewer',
        )
        .map((member) => [member.principalId.toLowerCase(), member]),
    );
    reviewers = reviewers.map((reviewer) => {
      const member = memberByPrincipalId.get(
        reviewer.principalId.toLowerCase(),
      );
      return {
        ...reviewer,
        displayName: member?.displayName ?? null,
        email: member?.email ?? null,
      };
    });
  }

  let initialDraft: R211AssessmentDraft | null =
    contextWithStaging.draft ?? null;
  if (!initialDraft) {
    try {
      if (typeof r211AssessmentDraftApiGet === 'function') {
        const draftRes = await r211AssessmentDraftApiGet(
          request,
          organizationId,
        );
        if (draftRes.ok) {
          const data = await draftRes.json();
          initialDraft = data?.draft ?? null;
        }
      }
    } catch {
      initialDraft = null;
    }
  }

  return (
    <AssessmentBuilderClient
      key={JSON.stringify([
        organizationId,
        initialDraft?.definitionId ?? null,
        initialIssuedSessionId,
      ])}
      organizationId={organizationId}
      csrfToken={context.csrfToken}
      initialDraft={initialDraft}
      reviewers={reviewers}
      isAuthenticatedStaging={isAuthenticatedStaging()}
      initialIssuedSessionId={initialIssuedSessionId}
    />
  );
}
