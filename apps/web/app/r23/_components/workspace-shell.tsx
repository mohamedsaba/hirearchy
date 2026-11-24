import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  IconBriefcase,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconListDetails,
  IconSettings,
  IconSparkles,
  IconUsers,
} from '@tabler/icons-react';
import {
  formatPlanBadge,
  type OrganizationPlanSummary,
} from '../../../src/plans/entitlements';
import { isHiringPlatformEnabled } from '../../../src/runtime/profile';
import type { SoftwareWorkspaceActiveSection } from '../../../src/ui/software-document';
import { SoundToggle } from '../../_components/sound-toggle';
import { ThemeToggle } from '../../_components/theme-toggle';
import { BrandMark } from '../../_components/brand-mark';

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
          <BrandMark />
          <span>Hirearchy</span>
          <span className="software-document-product">Software</span>
        </Link>
        <div className="software-header-controls">
          <SoundToggle variant="header" />
          <ThemeToggle variant="header" />
        </div>
      </header>
      <div className="software-document-layout">
        <aside className="software-workspace-sidebar">
          <label
            className="software-workspace-rail-control"
            title="Expand workspace navigation"
          >
            <input type="checkbox" aria-label="Expand workspace navigation" />
            <IconLayoutSidebarLeftExpand size={20} aria-hidden="true" />
            <IconLayoutSidebarLeftCollapse size={20} aria-hidden="true" />
          </label>
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
              title="Candidates"
              aria-current={active === 'candidates' ? 'page' : undefined}
            >
              <IconUsers size={16} stroke={1.9} aria-hidden="true" />
              <span>Candidates</span>
            </Link>
            <Link
              href={`${orgBase}/builder`}
              title="Assessment Builder"
              aria-current={active === 'builder' ? 'page' : undefined}
            >
              <IconSparkles size={16} stroke={1.9} aria-hidden="true" />
              <span>Assessment Builder</span>
            </Link>
            <Link
              href={`${orgBase}/handoffs`}
              title="Handoffs"
              aria-current={active === 'handoffs' ? 'page' : undefined}
            >
              <IconBriefcase size={16} stroke={1.9} aria-hidden="true" />
              <span>Handoffs</span>
            </Link>
            <a
              href={orgBase}
              title="Sessions"
              aria-current={active === 'assessments' ? 'page' : undefined}
            >
              <IconListDetails size={16} stroke={1.9} aria-hidden="true" />
              <span>Sessions</span>
            </a>
            <a
              data-testid="org-settings-link"
              href={`${orgBase}/settings`}
              title="Team &amp; Plan"
              aria-current={active === 'settings' ? 'page' : undefined}
            >
              <IconSettings size={16} stroke={1.9} aria-hidden="true" />
              <span>Team &amp; Plan</span>
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
