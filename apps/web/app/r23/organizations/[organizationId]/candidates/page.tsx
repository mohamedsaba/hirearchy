import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import {
  groupCandidateSessions,
  type RawHiringCandidateSessionRow,
} from '../../../../../src/hiring/candidates-view';
import { isHiringPlatformEnabled } from '../../../../../src/runtime/profile';
import { loadHiringOrganizationWorkspaceFromCookie } from '../../../../../src/staging/browser';
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
    redirect('/r23/login');
  }

  const raw = (await workspace.dispatch('hiring.candidates.list', {
    organizationId: workspace.organizationId,
  })) as { rows?: RawHiringCandidateSessionRow[] };

  const initialCandidates = groupCandidateSessions(raw?.rows ?? []);

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
              Track every candidate across assessments, inspect profiles and
              status, and filter by role, skills, seniority, or location.
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
        />
      </div>
    </OrganizationWorkspaceShell>
  );
}
