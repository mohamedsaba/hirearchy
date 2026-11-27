import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Suspense } from 'react';

import type { HandoffDossierItem } from '../../../../../src/hiring/types';
import { isHiringPlatformEnabled } from '../../../../../src/runtime/profile';
import { loadHiringOrganizationWorkspaceFromCookie } from '../../../../../src/staging/browser';
import { OrganizationWorkspaceShell } from '../../../_components/workspace-shell';
import { WorkspaceContentLoading } from '../../../_components/workspace-loading';
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
    redirect(
      `/r23/login?next=${encodeURIComponent(`/r23/organizations/${organizationId.toLowerCase()}/handoffs`)}`,
    );
  }

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
          <h1>Interview handoffs</h1>
          <div className="hiring-header-actions">
            <Link
              className="hiring-btn"
              href={`/r23/organizations/${encodeURIComponent(workspace.organizationId)}/candidates`}
            >
              View candidates
            </Link>
          </div>
        </header>

        <Suspense fallback={<WorkspaceContentLoading section="handoffs" />}>
          <HandoffsContent workspace={workspace} />
        </Suspense>
      </div>
    </OrganizationWorkspaceShell>
  );
}

async function HandoffsContent({
  workspace,
}: {
  workspace: NonNullable<
    Awaited<ReturnType<typeof loadHiringOrganizationWorkspaceFromCookie>>
  >;
}) {
  const res = (await workspace.dispatch('hiring.handoffs.list', {
    organizationId: workspace.organizationId,
  })) as { handoffs?: HandoffDossierItem[] };

  return (
    <HandoffsHubClient
      organizationId={workspace.organizationId}
      initialHandoffs={res?.handoffs ?? []}
    />
  );
}
