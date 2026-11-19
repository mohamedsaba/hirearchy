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
import { loadHiringOrganizationWorkspaceFromCookie } from '../../../../../src/staging/browser';
import { OrganizationWorkspaceShell } from '../../../_components/workspace-shell';
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
  searchParams?: Promise<{ issuedSession?: string | string[] }>;
}) {
  const { organizationId } = await params;
  const query = await searchParams;
  const initialIssuedSessionId =
    typeof query?.issuedSession === 'string' ? query.issuedSession : null;
  const incomingHeaders = await headers();
  const cookie = incomingHeaders.get('cookie') ?? '';

  if (isHiringPlatformEnabled()) {
    const workspace = await loadHiringOrganizationWorkspaceFromCookie(
      cookie,
      organizationId,
    );
    if (!workspace) {
      redirect('/r23/login');
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
            <div>
              <span className="hiring-eyebrow">
                {workspace.organizationName}
              </span>
              <h1>Assessment Builder</h1>
              <p>
                Choose a curated platform template, generate a role-specific
                engineering problem with Kimi K3.1 Pro, or reuse a problem from
                your saved library.
              </p>
            </div>
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
