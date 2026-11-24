import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

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

  const initialCandidates = groupCandidateSessions(hydratedRows);

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
      <div className="hiring-page-shell">
        <header className="hiring-page-header">
          <div>
            <span className="hiring-eyebrow">{workspace.organizationName}</span>
            <h1>Candidates</h1>
            <p>
              Track candidates across every assessment stage and filter by role,
              skills, or status.
            </p>
          </div>
          <div className="hiring-header-actions">
            <Link
              className="hiring-btn hiring-btn-primary"
              href={`/r23/organizations/${encodeURIComponent(workspace.organizationId)}/builder`}
            >
              Build &amp; Issue Assessment
            </Link>
          </div>
        </header>

        <CandidatesPipelineClient
          organizationId={workspace.organizationId}
          initialCandidates={initialCandidates}
          plan={workspace.plan}
          currentRole={workspace.role}
          currentPrincipalId={workspace.orgContext.principalId}
        />
      </div>
    </OrganizationWorkspaceShell>
  );
}
