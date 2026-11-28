import { isHiringPlatformEnabled } from '../runtime/profile';
import { getPlanDefinition, type PlanTier } from '../plans/entitlements';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export type SoftwareWorkspaceActiveSection =
  | 'assessments'
  | 'settings'
  | 'candidates'
  | 'builder'
  | 'handoffs'
  | 'plan'
  | 'account';

export type SoftwareDocumentTheme = 'light' | 'dark';

export type SoftwareWorkspace = Readonly<{
  organizationId: string;
  organizationName: string;
  email: string;
  role: string;
  csrf: string;
  active: SoftwareWorkspaceActiveSection;
  planBadge?: string;
  planTier?: PlanTier;
  theme?: SoftwareDocumentTheme;
  currentPath?: string;
}>;

export function resolveWorkspaceRoleLabel(
  role: string,
  hiringEnabled = true,
): string {
  if (!hiringEnabled) {
    return role === 'recruiter' ? 'Recruiting team' : 'Evaluation team';
  }
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

export function getSidebarPlanCopy(
  planTier: PlanTier,
  planBadge?: string,
): Readonly<{ badge: string; hook: string; cta: string }> {
  const badge = planBadge ?? getPlanDefinition(planTier).badgeLabel;
  switch (planTier) {
    case 'none':
      return {
        badge,
        hook: 'Activate a plan to issue assessments.',
        cta: 'Activate plan',
      };
    case 'per_candidate':
      return {
        badge,
        hook: 'Add slots or scale to unlimited seats.',
        cta: 'Upgrade plan',
      };
    case 'pro':
      return {
        badge,
        hook: 'Unlock AI review summaries & fit reports.',
        cta: 'Upgrade to Ultra',
      };
    case 'ultra':
      return {
        badge,
        hook: 'All AI & team features active.',
        cta: 'Manage plan',
      };
  }
}

// Outline paths from the same MIT-licensed Tabler icons used by the React workspace.
const workspaceIconPaths = {
  ArrowUpRight: ['M7 17l10 -10', 'M7 7h10v10'],
  ArrowsExchange: ['M7 10h14l-4 -4', 'M17 14h-14l4 4'],
  Logout: [
    'M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2',
    'M9 12h12l-3 -3',
    'M18 15l3 -3',
  ],
  UserCircle: [
    'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0',
    'M9 10a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
    'M6.5 19v-1a3 3 0 0 1 3 -3h5a3 3 0 0 1 3 3v1',
  ],
  Users: [
    'M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0',
    'M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2',
    'M16 3.13a4 4 0 0 1 0 7.75',
    'M21 21v-2a4 4 0 0 0 -3 -3.85',
  ],
  FilePencil: [
    'M14 3v4a1 1 0 0 0 1 1h4',
    'M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2',
    'M10 18l5 -5a1.414 1.414 0 0 0 -2 -2l-5 5v2h2',
  ],
  Briefcase: [
    'M3 9a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -9',
    'M8 7v-2a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v2',
    'M12 12l0 .01',
    'M3 13a20 20 0 0 0 18 0',
  ],
  ListDetails: [
    'M13 5h8',
    'M13 9h5',
    'M13 15h8',
    'M13 19h5',
    'M3 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
    'M3 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
  ],
  Settings: [
    'M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065',
    'M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0',
  ],
  LayoutSidebarLeftExpand: [
    'M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12',
    'M9 4v16',
    'M14 10l2 2l-2 2',
  ],
  LayoutSidebarLeftCollapse: [
    'M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12',
    'M9 4v16',
    'M15 10l-2 2l2 2',
  ],
  Plus: ['M12 5l0 14', 'M5 12l14 0'],
} as const;

function workspaceIcon(
  name: keyof typeof workspaceIconPaths,
  size = 16,
): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${workspaceIconPaths[name].map((path) => `<path d="${path}"></path>`).join('')}</svg>`;
}

export function renderSoftwareDocument(
  title: string,
  content: string,
  workspace?: SoftwareWorkspace,
  theme?: SoftwareDocumentTheme,
  currentPath?: string,
  homeHref?: string,
): string {
  const safeTitle = escapeHtml(title);
  const hiringEnabled = isHiringPlatformEnabled();
  const resolvedTheme: SoftwareDocumentTheme =
    theme ?? workspace?.theme ?? 'light';
  const nextTheme: SoftwareDocumentTheme =
    resolvedTheme === 'dark' ? 'light' : 'dark';
  const fallbackHeading = /<h1(?:\s|>)/i.test(content)
    ? ''
    : `<h1>${safeTitle}</h1>`;

  const organizationPath = workspace
    ? `/r23/organizations/${encodeURIComponent(workspace.organizationId)}`
    : '/r23/login';
  const homeBrandHref = escapeHtml(
    homeHref ??
      (workspace
        ? hiringEnabled
          ? `${organizationPath}/candidates`
          : organizationPath
        : '/r23/login'),
  );

  const derivedWorkspacePath = workspace
    ? (workspace.currentPath ??
      (workspace.active === 'settings'
        ? `${organizationPath}/settings`
        : workspace.active === 'candidates'
          ? `${organizationPath}/candidates`
          : workspace.active === 'builder'
            ? `${organizationPath}/builder`
            : workspace.active === 'handoffs'
              ? `${organizationPath}/handoffs`
              : organizationPath))
    : undefined;

  const resolvedNextPath = derivedWorkspacePath ?? currentPath;

  const workspaceNavLinks = workspace
    ? hiringEnabled
      ? (
          [
            ['candidates', '/candidates', 'Candidates', 'Users'],
            ['assessments', '', 'Assessments', 'ListDetails'],
            ['builder', '/builder', 'Assessment Builder', 'FilePencil'],
            ['handoffs', '/handoffs', 'Handoffs', 'Briefcase'],
          ] as const
        )
          .map(([section, suffix, label, icon]) => {
            const safeLabel = escapeHtml(label);
            const href = `${organizationPath}${suffix}`;
            return `<a href="${href}" title="${safeLabel}"${section === 'builder' ? ' aria-label="Assessment Builder"' : ''}${workspace.active === section ? ' aria-current="page"' : ''}>${workspaceIcon(icon)}${section === 'builder' ? '<span class="software-workspace-nav-label">Assessment Builder</span><span class="software-workspace-rail-label" aria-hidden="true">Builder</span>' : `<span>${safeLabel}</span>`}</a>`;
          })
          .join('')
      : `<a href="${organizationPath}"${
          workspace.active === 'assessments' ? ' aria-current="page"' : ''
        }>${
          workspace.role === 'reviewer' ? 'Assigned reviews' : 'Assessments'
        }</a><a data-testid="org-settings-link" href="${organizationPath}/settings"${
          workspace.active === 'settings' ? ' aria-current="page"' : ''
        }>Team &amp; settings</a>`
    : '';

  const settingsNavLinks =
    workspace && hiringEnabled
      ? (
          [
            ...(workspace.role === 'cto'
              ? ([
                  ['settings', '/settings', 'Organization', 'Settings'],
                ] as const)
              : []),
            ['account', '', 'My account', 'UserCircle'] as const,
          ] as const
        )
          .map(([section, suffix, label, icon]) => {
            const safeLabel = escapeHtml(label);
            const href =
              section === 'account'
                ? '/r23/account'
                : `${organizationPath}${suffix}`;
            return `<a href="${href}" title="${safeLabel}"${section === 'settings' ? ' data-testid="org-settings-link"' : ''}${workspace.active === section ? ' aria-current="page"' : ''}>${workspaceIcon(icon)}<span>${safeLabel}</span></a>`;
          })
          .join('')
      : '';

  const navLinks =
    workspace && hiringEnabled
      ? `<span class="software-nav-group-label" aria-hidden="true">Workspace</span>${workspaceNavLinks}<span class="software-nav-group-label" aria-hidden="true">Settings</span>${settingsNavLinks}`
      : workspaceNavLinks;

  const planCard = (() => {
    if (!workspace || !hiringEnabled || !workspace.planTier) return '';
    const planCopy = getSidebarPlanCopy(
      workspace.planTier,
      workspace.planBadge,
    );
    const isUltra = workspace.planTier === 'ultra';
    const currentAttr =
      workspace.active === 'plan' ? ' aria-current="page"' : '';
    const actionLink = isUltra
      ? `<a class="software-sidebar-plan-manage" href="${organizationPath}/plan" title="Plan &amp; add-ons"${currentAttr}><span>${escapeHtml(planCopy.cta)}</span>${workspaceIcon('ArrowUpRight', 14)}</a>`
      : `<a class="software-workspace-upgrade" href="${organizationPath}/upgrade" title="Upgrade"${currentAttr}><span>${escapeHtml(planCopy.cta)}</span>${workspaceIcon('ArrowUpRight', 14)}</a>`;
    return `<div class="software-sidebar-plan-card" data-tier="${escapeHtml(workspace.planTier)}">
      <div class="software-sidebar-plan-head">
        <span class="software-sidebar-plan-dot" aria-hidden="true"></span>
        <span class="software-sidebar-plan-tier">${escapeHtml(planCopy.badge)}</span>
      </div>
      <p class="software-sidebar-plan-copy">${escapeHtml(planCopy.hook)}</p>
      ${actionLink}
    </div>`;
  })();

  const orgInitial = workspace
    ? escapeHtml((workspace.organizationName.trim()[0] ?? 'W').toUpperCase())
    : '';
  const userInitial = workspace
    ? escapeHtml((workspace.email.trim()[0] ?? 'U').toUpperCase())
    : '';

  const identityBlock = workspace
    ? hiringEnabled
      ? `<div class="software-workspace-identity" role="region" aria-label="Active organization"><span class="software-org-avatar" aria-hidden="true">${orgInitial}</span><div class="software-workspace-identity-copy"><strong>${escapeHtml(
          workspace.organizationName,
        )}</strong><span>${resolveWorkspaceRoleLabel(workspace.role, true)}</span></div></div>`
      : `<div class="software-workspace-identity" role="region" aria-label="Active organization"><span class="software-eyebrow">Your workspace</span><strong>${escapeHtml(
          workspace.organizationName,
        )}</strong><span>${resolveWorkspaceRoleLabel(workspace.role, false)}</span></div>`
    : '';

  const footerBlock = workspace
    ? hiringEnabled
      ? `<div class="software-workspace-sidebar-footer"><div class="software-sidebar-user"><span class="software-user-avatar" aria-hidden="true">${userInitial}</span><span class="software-sidebar-user-email" title="${escapeHtml(workspace.email)}">${escapeHtml(
          workspace.email,
        )}</span></div><div class="software-sidebar-footer-actions"><a href="/r23/organizations" class="software-sidebar-action" title="Switch workspace">${workspaceIcon('ArrowsExchange', 14)}<span>Switch workspace</span></a><form action="/r23/auth/logout" method="post"><input type="hidden" name="csrf" value="${escapeHtml(
          workspace.csrf,
        )}"><button type="submit" class="software-sidebar-action software-sidebar-signout">${workspaceIcon('Logout', 14)}<span>Sign out</span></button></form></div></div>`
      : `<div class="software-workspace-sidebar-footer"><span title="${escapeHtml(workspace.email)}">${escapeHtml(
          workspace.email,
        )}</span><a href="/r23/organizations">Switch workspace</a><form action="/r23/auth/logout" method="post"><input type="hidden" name="csrf" value="${escapeHtml(
          workspace.csrf,
        )}"><button type="submit">Sign out</button></form></div>`
    : '';

  const quickActionBlock =
    workspace &&
    hiringEnabled &&
    (workspace.role === 'cto' || workspace.role === 'recruiter')
      ? `<a class="software-sidebar-quick-action" href="${organizationPath}/builder?mode=new" title="New assessment">${workspaceIcon('Plus', 15)}<span class="software-workspace-nav-label">New assessment</span><span class="software-workspace-rail-label" aria-hidden="true">New</span></a>`
      : '';

  const navigation = workspace
    ? `<aside class="software-workspace-sidebar">
        ${
          hiringEnabled
            ? `<label class="software-workspace-rail-control" title="Toggle workspace navigation"><input type="checkbox" aria-label="Show full workspace navigation">${workspaceIcon('LayoutSidebarLeftExpand', 20)}${workspaceIcon('LayoutSidebarLeftCollapse', 20)}<span class="software-workspace-mobile-name">${escapeHtml(workspace.organizationName)}</span></label>`
            : ''
        }
        ${identityBlock}
        ${quickActionBlock}
        <nav aria-label="Workspace navigation">${navLinks}</nav>
        ${planCard}
        ${footerBlock}
      </aside>`
    : '';

  const hiringStylesheet = hiringEnabled
    ? '<link rel="stylesheet" href="/hiring-platform.css">'
    : '';
  const nextInput = resolvedNextPath
    ? `<input type="hidden" name="next" value="${escapeHtml(resolvedNextPath)}">`
    : '';
  const toggleIcon =
    resolvedTheme === 'dark'
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg>';
  const themeToggleForm = hiringEnabled
    ? `<form class="hiring-doc-theme-form" action="/api/theme" method="post"><input type="hidden" name="theme" value="${nextTheme}">${nextInput}<button type="submit" class="hiring-theme-toggle hiring-theme-toggle--header" aria-label="Switch to ${nextTheme} theme"><span class="hiring-theme-toggle-icon" aria-hidden="true">${toggleIcon}</span><span>${resolvedTheme === 'dark' ? 'Light' : 'Dark'}</span></button></form>`
    : '';
  const headerContextHtml =
    workspace && hiringEnabled
      ? `<div class="software-header-context" aria-label="Workspace context"><span class="software-header-context-org">${escapeHtml(workspace.organizationName)}</span><span class="software-header-context-sep" aria-hidden="true">·</span><span class="software-header-context-role">${escapeHtml(resolveWorkspaceRoleLabel(workspace.role, true))}</span></div>`
      : '';
  const headerControlsHtml =
    headerContextHtml || themeToggleForm
      ? `<div class="software-header-controls">${headerContextHtml}${themeToggleForm}</div>`
      : '';
  const htmlThemeAttr = resolvedTheme === 'dark' ? ' data-theme="dark"' : '';

  const isCenteredWorkspacePicker =
    !workspace && resolvedNextPath === '/r23/organizations';
  const bodyAccessClasses = workspace
    ? ` software-document-workspace${hiringEnabled ? ' software-document-compact-nav' : ''}`
    : ' software-document-access software-team-access';

  const accessIntro =
    workspace || isCenteredWorkspacePicker
      ? ''
      : '<div class="software-access-intro"><p class="software-access-kicker">Engineering evaluation</p><p class="software-access-principle">Evidence informs.<br><span>People decide.</span></p><p class="software-access-lead">Review real codebase work, inspect reconstructed timelines, and lead structured hiring discussions.</p></div>';

  return `<!doctype html><html lang="en"${htmlThemeAttr}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" type="image/svg+xml" href="/icon.svg"><link rel="icon" href="/favicon.ico" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="stylesheet" href="/software-ui.css">${hiringStylesheet}<title>${safeTitle}</title></head><body class="software-product software-document-body${bodyAccessClasses}"><a class="software-skip-link" href="#main-content">Skip to main content</a><header class="software-document-header"><a class="software-document-wordmark" href="${homeBrandHref}" aria-label="Hirearchy Software home"><span>Hirearchy</span><span class="software-document-product">Software</span></a>${headerControlsHtml}</header><div class="software-document-layout">${navigation}<main class="software-document-shell${isCenteredWorkspacePicker ? ' software-document-shell--centered' : ''}" id="main-content" tabindex="-1">${accessIntro}<div class="software-document-panel">${fallbackHeading}${content}</div></main></div></body></html>`;
}
