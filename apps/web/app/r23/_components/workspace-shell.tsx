import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  formatPlanBadge,
  type OrganizationPlanSummary,
} from '../../../src/plans/entitlements';
import type { SoftwareWorkspaceActiveSection } from '../../../src/ui/software-document';

function resolveRoleLabel(role: string): string {
  switch (role) {
    case 'cto':
      return 'CTO / Owner';
    case 'recruiter':
      return 'Recruiting team';
    case 'reviewer':
      return 'Evaluator';
    default:
      return 'Evaluation team';
  }
}

export interface OrganizationWorkspaceShellProps {
  organizationId: string;
  organizationName: string;
  email: string;
  role: string;
  csrf: string;
  active: SoftwareWorkspaceActiveSection;
  plan?: OrganizationPlanSummary | null;
  children: ReactNode;
}

export function OrganizationWorkspaceShell({
  organizationId,
  organizationName,
  email,
  role,
  csrf,
  active,
  plan,
  children,
}: OrganizationWorkspaceShellProps) {
  const orgBase = `/r23/organizations/${encodeURIComponent(organizationId)}`;
  const planBadge = plan ? formatPlanBadge(plan) : undefined;

  return (
    <div className="software-product software-document-body software-document-workspace">
      <header className="software-document-header">
        <a
          className="software-document-wordmark"
          href={orgBase}
          aria-label="Hirearchy Software home"
        >
          <span>Hirearchy</span>
          <span className="software-document-product">Software</span>
        </a>
      </header>
      <div className="software-document-layout">
        <aside className="software-workspace-sidebar">
          <div
            className="software-workspace-identity"
            role="region"
            aria-label="Active organization"
          >
            <span className="software-eyebrow">Your workspace</span>
            <strong>{organizationName}</strong>
            <span>{resolveRoleLabel(role)}</span>
            {planBadge ? (
              <span className="hiring-sidebar-plan-badge">{planBadge}</span>
            ) : null}
          </div>
          <nav aria-label="Workspace navigation">
            <Link
              href={`${orgBase}/candidates`}
              aria-current={active === 'candidates' ? 'page' : undefined}
            >
              Candidates
            </Link>
            <Link
              href={`${orgBase}/builder`}
              aria-current={active === 'builder' ? 'page' : undefined}
            >
              Assessment Builder
            </Link>
            <Link
              href={`${orgBase}/handoffs`}
              aria-current={active === 'handoffs' ? 'page' : undefined}
            >
              Handoffs
            </Link>
            <a
              href={orgBase}
              aria-current={active === 'assessments' ? 'page' : undefined}
            >
              Sessions
            </a>
            <a
              data-testid="org-settings-link"
              href={`${orgBase}/settings`}
              aria-current={active === 'settings' ? 'page' : undefined}
            >
              Team &amp; Plan
            </a>
          </nav>
          <div className="software-workspace-sidebar-footer">
            <a href="/r23/organizations">Switch workspace</a>
            <span>{email}</span>
            <form action="/r23/auth/logout" method="post">
              <input type="hidden" name="csrf" value={csrf} />
              <button type="submit">Sign out</button>
            </form>
          </div>
        </aside>
        <main className="software-document-shell">
          <div className="software-document-panel">{children}</div>
        </main>
      </div>
    </div>
  );
}
