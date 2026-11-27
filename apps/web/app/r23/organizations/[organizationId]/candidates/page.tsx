import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Suspense } from 'react';
import { IconPlus } from '@tabler/icons-react';

import {
  groupCandidateSessions,
  type RawHiringCandidateSessionRow,
} from '../../../../../src/hiring/candidates-view';
import { isHiringPlatformEnabled } from '../../../../../src/runtime/profile';
import {
  decryptCandidateLinkToken,
  loadHiringOrganizationWorkspaceFromCookie,
} from '../../../../../src/staging/browser';
import { OrganizationWorkspaceShell } from '../../../_components/workspace-shell';
import { WorkspaceContentLoading } from '../../../_components/workspace-loading';
import { CandidatesPipelineClient } from './candidates-client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export default async function OrganizationCandidatesPage({
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
      `/r23/login?next=${encodeURIComponent(`/r23/organizations/${organizationId.toLowerCase()}/candidates`)}`,
    );
  }

  return (
    <OrganizationWorkspaceShell
      organizationId={workspace.organizationId}
      organizationName={workspace.organizationName}
      email={workspace.email}
      role={workspace.role}
      csrf={workspace.csrfToken}
      active="candidates"
      plan={workspace.plan}
    >
      <div className="hiring-page-shell team-candidates-page">
        <header className="hiring-page-header">
          <h1>Candidates</h1>
          <Link
            className="hiring-btn hiring-btn-primary"
            href={`/r23/organizations/${encodeURIComponent(workspace.organizationId)}/builder?mode=new`}
          >
            <IconPlus size={17} aria-hidden="true" />
            New assessment
          </Link>
        </header>
        <Suspense fallback={<WorkspaceContentLoading section="candidates" />}>
          <CandidatePipeline workspace={workspace} />
        </Suspense>
      </div>
    </OrganizationWorkspaceShell>
  );
}

async function CandidatePipeline({
  workspace,
}: {
  workspace: NonNullable<
    Awaited<ReturnType<typeof loadHiringOrganizationWorkspaceFromCookie>>
  >;
}) {
  const raw = (await workspace.dispatch('hiring.candidates.list', {
    organizationId: workspace.organizationId,
  })) as { rows?: RawHiringCandidateSessionRow[] };

  const hydratedRows = (raw?.rows ?? []).map((row) => {
    if (
      row.lifecycleStatus !== 'CREATED' ||
      !row.invitationActive ||
      !row.candidateTokenCiphertext
    ) {
      return row;
    }
    try {
      const token = decryptCandidateLinkToken(
        row.candidateTokenCiphertext,
        row.sessionId,
      );
      return {
        ...row,
        candidateLink: `/r26/candidate/${encodeURIComponent(row.sessionId)}#${encodeURIComponent(token)}`,
      };
    } catch {
      return row;
    }
  });

  return (
    <CandidatesPipelineClient
      organizationId={workspace.organizationId}
      initialCandidates={groupCandidateSessions(hydratedRows)}
      plan={workspace.plan}
      currentRole={workspace.role}
      currentPrincipalId={workspace.orgContext.principalId}
    />
  );
}
