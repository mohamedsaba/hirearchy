import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  IconBriefcase,
  IconFilePencil,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconListDetails,
  IconSettings,
  IconArrowUpRight,
  IconUserCircle,
  IconUsers,
} from '@tabler/icons-react';
import {
  formatPlanBadge,
  type OrganizationPlanSummary,
} from '../../../src/plans/entitlements';
import { isHiringPlatformEnabled } from '../../../src/runtime/profile';
import type { SoftwareWorkspaceActiveSection } from '../../../src/ui/software-document';
import { ThemeToggle } from '../../_components/theme-toggle';

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
  const homeHref = isHiringPlatformEnabled()
    ? `${orgBase}/candidates`
    : orgBase;
  const planBadge = plan ? formatPlanBadge(plan) : undefined;

  return (
    <div className="software-product software-document-body software-document-workspace software-document-compact-nav">
      <a className="software-skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="software-document-header">
        <Link
          className="software-document-wordmark"
          href={homeHref}
          aria-label="Hirearchy Software home"
        >
          <span>Hirearchy</span>
          <span className="software-document-product">Software</span>
        </Link>
        <div className="software-header-controls">
          <ThemeToggle variant="header" />
        </div>
      </header>
      <div className="software-document-layout">
        <aside className="software-workspace-sidebar">
          <label
            className="software-workspace-rail-control"
            title="Toggle workspace navigation"
          >
            <input
              type="checkbox"
              aria-label="Show full workspace navigation"
            />
            <IconLayoutSidebarLeftExpand size={20} aria-hidden="true" />
            <IconLayoutSidebarLeftCollapse size={20} aria-hidden="true" />
            <span className="software-workspace-mobile-name">
              {organizationName}
            </span>
          </label>
          <div
            className="software-workspace-identity"
            role="region"
            aria-label="Active organization"
          >
            <strong>{organizationName}</strong>
            <span>{resolveRoleLabel(role)}</span>
            {planBadge ? (
              <span className="hiring-sidebar-plan-badge">{planBadge}</span>
            ) : null}
          </div>
          <nav aria-label="Workspace navigation">
            <Link
              href={`${orgBase}/candidates`}
              title="Candidates"
              aria-current={active === 'candidates' ? 'page' : undefined}
            >
              <IconUsers size={16} stroke={1.9} aria-hidden="true" />
              <span>Candidates</span>
            </Link>
            <a
              href={orgBase}
              title="Assessments"
              aria-current={active === 'assessments' ? 'page' : undefined}
            >
              <IconListDetails size={16} stroke={1.9} aria-hidden="true" />
              <span>Assessments</span>
            </a>
            <Link
              href={`${orgBase}/builder`}
              aria-label="Assessment Builder"
              title="Assessment Builder"
              aria-current={active === 'builder' ? 'page' : undefined}
            >
              <IconFilePencil size={16} stroke={1.9} aria-hidden="true" />
              <span className="software-workspace-nav-label">
                Assessment Builder
              </span>
              <span
                className="software-workspace-rail-label"
                aria-hidden="true"
              >
                Builder
              </span>
            </Link>
            <Link
              href={`${orgBase}/handoffs`}
              title="Handoffs"
              aria-current={active === 'handoffs' ? 'page' : undefined}
            >
              <IconBriefcase size={16} stroke={1.9} aria-hidden="true" />
              <span>Handoffs</span>
            </Link>
            {role === 'cto' ? (
              <a
                data-testid="org-settings-link"
                href={`${orgBase}/settings`}
                title="Organization"
                aria-current={active === 'settings' ? 'page' : undefined}
              >
                <IconSettings size={16} stroke={1.9} aria-hidden="true" />
                <span>Organization</span>
              </a>
            ) : null}
            {plan && plan.planTier !== 'ultra' ? (
              <a
                className="software-workspace-upgrade"
                href={`${orgBase}/upgrade`}
                title="Upgrade"
                aria-current={active === 'plan' ? 'page' : undefined}
              >
                <IconArrowUpRight size={16} stroke={1.9} aria-hidden="true" />
                <span>Upgrade</span>
              </a>
            ) : null}
            <a
              href="/r23/account"
              title="My account"
              aria-current={active === 'account' ? 'page' : undefined}
            >
              <IconUserCircle size={16} stroke={1.9} aria-hidden="true" />
              <span>My account</span>
            </a>
          </nav>
          <div className="software-workspace-sidebar-footer">
            <span title={email}>{email}</span>
            <a href="/r23/organizations">Switch workspace</a>
            <form action="/r23/auth/logout" method="post">
              <input type="hidden" name="csrf" value={csrf} />
              <button type="submit">Sign out</button>
            </form>
          </div>
        </aside>
        <main
          className="software-document-shell"
          id="main-content"
          tabIndex={-1}
        >
          <div className="software-document-panel">{children}</div>
        </main>
      </div>
    </div>
  );
}
