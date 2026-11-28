import { cookies } from 'next/headers';
import Link from 'next/link';
import { IconPlus } from '@tabler/icons-react';

import type { R211ReusableProblem } from '../../../../../src/r211-builder/contract';
import { isHiringPlatformEnabled } from '../../../../../src/runtime/profile';
import { loadHiringOrganizationWorkspaceFromCookie } from '../../../../../src/staging/browser';
import { ThemeToggle } from '../../../../_components/theme-toggle';
import { OrgBenchmarksStrip } from '../../../_components/org-benchmarks-strip';
import { OrganizationWorkspaceShell } from '../../../_components/workspace-shell';
import { DeferredProblemRead } from './deferred-problem-read';
import { loadProblems } from './load-problems';
import { ProblemsTable } from './problems-table';
import './problems.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Problems' };

export default async function ProblemsPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const workspaceBase = `/r23/organizations/${encodeURIComponent(organizationId)}`;
  const { response, csrfToken } = await loadProblems(organizationId);
  const data: { problems: R211ReusableProblem[] } | null = response
    ? await response.json()
    : null;

  const jar = await cookies();
  const workspace = isHiringPlatformEnabled()
    ? await loadHiringOrganizationWorkspaceFromCookie(
        jar.toString(),
        organizationId,
      ).catch(() => null)
    : null;

  const pageBody = (
    <div className="problems-page hiring-page-shell ct-enter-crossfade">
      <header className="hiring-page-header">
        <div>
          <span className="hiring-eyebrow">Reusable library</span>
          <h1>Problems</h1>
          <p>
            Manage saved coding tasks, inspect health signals, and issue
            assessments directly from your library.
          </p>
        </div>
        <Link
          className="hiring-btn hiring-btn-primary"
          href={workspaceBase + '/builder?mode=new'}
        >
          <IconPlus size={17} aria-hidden="true" />
          Create a problem
        </Link>
      </header>
      <OrgBenchmarksStrip organizationId={organizationId} showProblemHealth />
      {data ? (
        <ProblemsTable
          workspace={workspaceBase}
          organizationId={organizationId}
          problems={data.problems}
        />
      ) : (
        <DeferredProblemRead
          key={organizationId}
          organizationId={organizationId}
          csrfToken={csrfToken}
        />
      )}
    </div>
  );

  if (workspace) {
    return (
      <OrganizationWorkspaceShell
        organizationId={workspace.organizationId}
        organizationName={workspace.organizationName}
        email={workspace.email}
        role={workspace.role}
        csrf={workspace.csrfToken}
        active="assessments"
        plan={workspace.plan}
      >
        {pageBody}
      </OrganizationWorkspaceShell>
    );
  }

  return (
    <div className="software-product software-document-body software-document-workspace software-document-compact-nav">
      <header className="software-document-header">
        <Link
          className="software-document-wordmark"
          href={workspaceBase}
          aria-label="Hirearchy Software workspace"
        >
          <span>Hirearchy</span>
          <span className="software-document-product">Software</span>
        </Link>
        <div className="software-header-controls">
          <Link className="hiring-btn hiring-btn-sm" href={workspaceBase}>
            Organization workspace
          </Link>
          <ThemeToggle variant="header" />
        </div>
      </header>
      <div className="software-document-layout">
        <main
          className="software-document-shell"
          id="main-content"
          tabIndex={-1}
        >
          <div className="software-document-panel">{pageBody}</div>
        </main>
      </div>
    </div>
  );
}
