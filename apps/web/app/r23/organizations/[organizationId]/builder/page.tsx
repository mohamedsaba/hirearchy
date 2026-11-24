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
import {
  isAuthenticatedStaging,
  isHiringPlatformEnabled,
} from '../../../../../src/runtime/profile';
import { serializePlatformTemplates } from '../../../../../src/hiring/templates';
import type {
  SavedLibraryProblem,
  TeamMemberOption,
  WorkspaceRoleKind,
} from '../../../../../src/hiring/types';
import {
  loadHiringOrganizationWorkspaceFromCookie,
  StagingBrowserRefreshRequired,
  stagingLoadOrganizationSessionList,
} from '../../../../../src/staging/browser';
import { R23_CSRF_COOKIE } from '../../../../../src/r23-auth/config';
import { OrganizationWorkspaceShell } from '../../../_components/workspace-shell';
import { RefreshBuilderSession } from './refresh-builder-session';
import { AssessmentBuilderClient } from './assessment-builder-client';
import { HiringAssessmentBuilderClient } from './hiring-assessment-builder-client';
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

  if (isHiringPlatformEnabled()) {
    const workspace = await loadHiringOrganizationWorkspaceFromCookie(
      jar.toString(),
      organizationId,
    );
    if (!workspace) {
      redirect(
        `/r23/login?next=${encodeURIComponent(`/r23/organizations/${organizationId.toLowerCase()}/builder`)}`,
      );
    }

    const [libraryRes, membersRes] = await Promise.all([
      workspace.dispatch('hiring.library.list', {
        organizationId: workspace.organizationId,
      }) as Promise<{ problems?: SavedLibraryProblem[] }>,
      workspace.dispatch('organization.members.list', {
        organizationId: workspace.organizationId,
      }) as Promise<{ members?: OrganizationMemberItem[] }>,
    ]);

    const teamMembers: TeamMemberOption[] = (membersRes?.members ?? [])
      .filter((m) => m.status === 'active')
      .map((m) => ({
        principalId: m.principalId,
        displayName: m.displayName ?? m.email ?? 'Team Member',
        email: m.email ?? '',
        role:
          m.role === 'cto' || m.role === 'recruiter'
            ? (m.role as WorkspaceRoleKind)
            : 'reviewer',
        isOwner: Boolean(m.isOwner),
      }));

    return (
      <OrganizationWorkspaceShell
        organizationId={workspace.organizationId}
        organizationName={workspace.organizationName}
        email={workspace.email}
        role={workspace.role}
        csrf={workspace.csrfToken}
        active="builder"
        plan={workspace.plan}
      >
        <div className="hiring-page-shell">
          <header className="hiring-page-header">
            <h1>Assessment Builder</h1>
          </header>

          <HiringAssessmentBuilderClient
            organizationId={workspace.organizationId}
            currentPrincipalId={workspace.orgContext.principalId}
            initialPlan={workspace.plan}
            initialLibrary={libraryRes?.problems ?? []}
            initialTemplates={serializePlatformTemplates()}
            teamMembers={teamMembers}
          />
        </div>
      </OrganizationWorkspaceShell>
    );
  }

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
