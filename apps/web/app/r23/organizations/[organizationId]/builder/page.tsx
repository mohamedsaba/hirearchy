import type { Metadata } from 'next';
import { cookies } from 'next/headers';
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
import {
  StagingBrowserRefreshRequired,
  stagingLoadOrganizationSessionList,
} from '../../../../../src/staging/browser';
import { R23_CSRF_COOKIE } from '../../../../../src/r23-auth/config';
import { RefreshBuilderSession } from './refresh-builder-session';
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
  searchParams?: Promise<{
    mode?: string | string[];
    issuedSession?: string | string[];
    definitionId?: string | string[];
  }>;
}) {
  const { organizationId } = await params;
  const query = await searchParams;
  const initialIssuedSessionId =
    typeof query?.issuedSession === 'string' ? query.issuedSession : null;
  const requestedId = query?.definitionId;
  const fresh = query?.mode === 'new';
  if (query?.mode !== undefined && !fresh) notFound();
  if (fresh && (requestedId !== undefined || initialIssuedSessionId))
    notFound();
  if (
    requestedId !== undefined &&
    (typeof requestedId !== 'string' ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestedId))
  )
    notFound();
  const jar = await cookies();
  const staging = isAuthenticatedStaging();

  const url = new URL('https://hirearchy-builder.invalid/');
  if (requestedId) url.searchParams.set('definitionId', requestedId);
  const request = new Request(url, {
    headers: {
      Accept: 'application/json',
      Cookie: jar.toString(),
    },
  });

  let context;
  try {
    context = staging
      ? await stagingLoadOrganizationSessionList(
          request,
          organizationId,
          {
            assessmentId: requestedId,
          },
          'defer',
        )
      : await loadAuthenticatedOrganizationSessionList(request, organizationId);
  } catch (error) {
    if (error instanceof StagingBrowserRefreshRequired) {
      return (
        <RefreshBuilderSession csrfToken={jar.get(R23_CSRF_COOKIE)!.value} />
      );
    }
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
  if (!staging && reviewers.length === 0) {
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

  let initialDraft: R211AssessmentDraft | null = fresh
    ? null
    : (contextWithStaging.draft ?? null);
  if (!staging && requestedId) {
    const response = await r211AssessmentDraftApiGet(request, organizationId);
    if ([400, 403, 404].includes(response.status)) notFound();
    if (!response.ok)
      throw new Error('Could not load the requested assessment draft.');
    initialDraft = (await response.json()).draft;
  } else if (!fresh && !staging && !initialDraft) {
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

  if (requestedId && initialDraft?.definitionId !== requestedId.toLowerCase())
    notFound();

  return (
    <AssessmentBuilderClient
      key={JSON.stringify([
        organizationId,
        fresh,
        initialDraft?.definitionId ?? null,
        initialIssuedSessionId,
      ])}
      organizationId={organizationId}
      csrfToken={context.csrfToken}
      fresh={fresh}
      initialDraft={initialDraft}
      reviewers={reviewers}
      isAuthenticatedStaging={staging}
      initialIssuedSessionId={initialIssuedSessionId}
    />
  );
}
