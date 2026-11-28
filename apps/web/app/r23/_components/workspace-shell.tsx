import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  IconArrowUpRight,
  IconArrowsExchange,
  IconBriefcase,
  IconFilePencil,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconListDetails,
  IconLogout,
  IconPlus,
  IconSettings,
  IconUserCircle,
  IconUsers,
} from '@tabler/icons-react';
import {
  formatPlanBadge,
  type OrganizationPlanSummary,
} from '../../../src/plans/entitlements';
import {
  getSidebarPlanCopy,
  resolveWorkspaceRoleLabel,
  type SoftwareWorkspaceActiveSection,
} from '../../../src/ui/software-document';
import { ThemeToggle } from '../../_components/theme-toggle';

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
  const homeHref = `${orgBase}/candidates`;
  const planBadge = plan ? formatPlanBadge(plan) : undefined;
  const planCopy = plan ? getSidebarPlanCopy(plan.planTier, planBadge) : null;
  const orgInitial = (organizationName.trim()[0] ?? 'W').toUpperCase();
  const userInitial = (email.trim()[0] ?? 'U').toUpperCase();

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
          <div
            className="software-header-context"
            aria-label="Workspace context"
          >
            <span className="software-header-context-org">
              {organizationName}
            </span>
            <span className="software-header-context-sep" aria-hidden="true">
              ·
            </span>
            <span className="software-header-context-role">
              {resolveWorkspaceRoleLabel(role, true)}
            </span>
          </div>
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
            <span className="software-org-avatar" aria-hidden="true">
              {orgInitial}
            </span>
            <div className="software-workspace-identity-copy">
              <strong>{organizationName}</strong>
              <span>{resolveWorkspaceRoleLabel(role, true)}</span>
            </div>
          </div>
          {role === 'cto' || role === 'recruiter' ? (
            <Link
              className="software-sidebar-quick-action"
              href={`${orgBase}/builder?mode=new`}
              title="New assessment"
            >
              <IconPlus size={15} stroke={2.1} aria-hidden="true" />
              <span className="software-workspace-nav-label">
                New assessment
              </span>
              <span
                className="software-workspace-rail-label"
                aria-hidden="true"
              >
                New
              </span>
            </Link>
          ) : null}
          <nav aria-label="Workspace navigation">
            <span className="software-nav-group-label" aria-hidden="true">
              Workspace
            </span>
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
            <span className="software-nav-group-label" aria-hidden="true">
              Settings
            </span>
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
            <a
              href="/r23/account"
              title="My account"
              aria-current={active === 'account' ? 'page' : undefined}
            >
              <IconUserCircle size={16} stroke={1.9} aria-hidden="true" />
              <span>My account</span>
            </a>
          </nav>
          {plan && planCopy ? (
            <div
              className="software-sidebar-plan-card"
              data-tier={plan.planTier}
            >
              <div className="software-sidebar-plan-head">
                <span
                  className="software-sidebar-plan-dot"
                  aria-hidden="true"
                />
                <span className="software-sidebar-plan-tier">
                  {planCopy.badge}
                </span>
              </div>
              <p className="software-sidebar-plan-copy">{planCopy.hook}</p>
              {plan.planTier === 'ultra' ? (
                <a
                  className="software-sidebar-plan-manage"
                  href={`${orgBase}/plan`}
                  title="Plan & add-ons"
                  aria-current={active === 'plan' ? 'page' : undefined}
                >
                  <span>{planCopy.cta}</span>
                  <IconArrowUpRight size={14} aria-hidden="true" />
                </a>
              ) : (
                <a
                  className="software-workspace-upgrade"
                  href={`${orgBase}/upgrade`}
                  title="Upgrade"
                  aria-current={active === 'plan' ? 'page' : undefined}
                >
                  <span>{planCopy.cta}</span>
                  <IconArrowUpRight size={14} aria-hidden="true" />
                </a>
              )}
            </div>
          ) : null}
          <div className="software-workspace-sidebar-footer">
            <div className="software-sidebar-user">
              <span className="software-user-avatar" aria-hidden="true">
                {userInitial}
              </span>
              <span className="software-sidebar-user-email" title={email}>
                {email}
              </span>
            </div>
            <div className="software-sidebar-footer-actions">
              <a
                href="/r23/organizations"
                className="software-sidebar-action"
                title="Switch workspace"
              >
                <IconArrowsExchange size={14} aria-hidden="true" />
                <span>Switch workspace</span>
              </a>
              <form action="/r23/auth/logout" method="post">
                <input type="hidden" name="csrf" value={csrf} />
                <button
                  type="submit"
                  className="software-sidebar-action software-sidebar-signout"
                >
                  <IconLogout size={14} aria-hidden="true" />
                  <span>Sign out</span>
                </button>
              </form>
            </div>
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
