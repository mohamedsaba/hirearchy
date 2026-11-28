import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import type { HandoffDossierItem } from '../../../../../../src/hiring/types';
import { isHiringPlatformEnabled } from '../../../../../../src/runtime/profile';
import { loadHiringOrganizationWorkspaceFromCookie } from '../../../../../../src/staging/browser';
import { OrganizationWorkspaceShell } from '../../../../_components/workspace-shell';
import { HandoffDossierClient } from './handoff-dossier-client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export default async function HandoffDossierPage({
  params,
}: {
  params: Promise<{ organizationId: string; sessionId: string }>;
}) {
  if (!isHiringPlatformEnabled()) {
    notFound();
  }
  const { organizationId, sessionId } = await params;
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

  const dossier = (res?.handoffs ?? []).find(
    (item) => item.sessionId === sessionId,
  );
  if (!dossier) {
    notFound();
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
          <div>
            <span className="hiring-eyebrow">
              Managerial Handoff ·{' '}
              {dossier.decision.nextStageLabel ?? 'Next Interview'}
            </span>
            <h1>{dossier.candidateName}</h1>
            <p>
              {dossier.targetRole} · Assessed on{' '}
              <strong>{dossier.scenarioTitle}</strong>
            </p>
          </div>
          <div className="hiring-header-actions">
            <Link
              className="hiring-btn"
              href={`/r23/organizations/${encodeURIComponent(workspace.organizationId)}/handoffs`}
            >
              ← All Handoffs
            </Link>
            <a
              className="hiring-btn hiring-btn-primary"
              href={`/r27/organizations/${encodeURIComponent(workspace.organizationId)}/sessions/${encodeURIComponent(dossier.sessionId)}`}
            >
              View full submission &amp; timeline
            </a>
          </div>
        </header>

        <HandoffDossierClient
          organizationId={workspace.organizationId}
          initialDossier={dossier}
          plan={workspace.plan}
        />
      </div>
    </OrganizationWorkspaceShell>
  );
}
