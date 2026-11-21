import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type { HandoffDossierItem } from '../../../../../src/hiring/types';
import { isHiringPlatformEnabled } from '../../../../../src/runtime/profile';
import { loadHiringOrganizationWorkspaceFromCookie } from '../../../../../src/staging/browser';
import { OrganizationWorkspaceShell } from '../../../_components/workspace-shell';
import { HandoffsHubClient } from './handoffs-client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export default async function OrganizationHandoffsPage({
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

  const res = (await workspace.dispatch('hiring.handoffs.list', {
    organizationId: workspace.organizationId,
  })) as { handoffs?: HandoffDossierItem[] };

  return (
    <OrganizationWorkspaceShell
      organizationId={workspace.organizationId}
      organizationName={workspace.organizationName}
      email={workspace.email}
      role={workspace.role}
      csrf={workspace.csrfToken}
      active="handoffs"
      plan={workspace.plan}
    >
      <div className="hiring-page-shell">
        <header className="hiring-page-header">
          <div>
            <span className="hiring-eyebrow">{workspace.organizationName}</span>
            <h1>Managerial Handoffs</h1>
            <p>
              Structured transition packets for accepted candidates moving to
              managerial or follow-up technical interviews.
            </p>
          </div>
          <div className="hiring-header-actions">
            <Link
              className="hiring-btn"
              href={`/r23/organizations/${encodeURIComponent(workspace.organizationId)}/candidates`}
            >
              View All Candidates
            </Link>
          </div>
        </header>

        <HandoffsHubClient
          organizationId={workspace.organizationId}
          initialHandoffs={res?.handoffs ?? []}
        />
      </div>
    </OrganizationWorkspaceShell>
  );
}
