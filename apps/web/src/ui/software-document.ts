import { isHiringPlatformEnabled } from '../runtime/profile';

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
  'assessments' | 'settings' | 'candidates' | 'builder' | 'handoffs';

export type SoftwareWorkspace = Readonly<{
  organizationId: string;
  organizationName: string;
  email: string;
  role: string;
  csrf: string;
  active: SoftwareWorkspaceActiveSection;
  planBadge?: string;
}>;

function resolveRoleLabel(role: string, hiringEnabled: boolean): string {
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

export function renderSoftwareDocument(
  title: string,
  content: string,
  workspace?: SoftwareWorkspace,
): string {
  const safeTitle = escapeHtml(title);
  const hiringEnabled = isHiringPlatformEnabled();
  const fallbackHeading = /<h1(?:\s|>)/i.test(content)
    ? ''
    : `<h1>${safeTitle}</h1>`;

  const organizationPath = workspace
    ? `/r23/organizations/${encodeURIComponent(workspace.organizationId)}`
    : '/r23/login';

  const navLinks = workspace
    ? hiringEnabled
      ? `<a href="${organizationPath}/candidates"${
          workspace.active === 'candidates' ? ' aria-current="page"' : ''
        }>Candidates</a><a href="${organizationPath}/builder"${
          workspace.active === 'builder' ? ' aria-current="page"' : ''
        }>Assessment Builder</a><a href="${organizationPath}/handoffs"${
          workspace.active === 'handoffs' ? ' aria-current="page"' : ''
        }>Handoffs</a><a href="${organizationPath}"${
          workspace.active === 'assessments' ? ' aria-current="page"' : ''
        }>Sessions</a><a data-testid="org-settings-link" href="${organizationPath}/settings"${
          workspace.active === 'settings' ? ' aria-current="page"' : ''
        }>Team &amp; Plan</a>`
      : `<a href="${organizationPath}"${
          workspace.active === 'assessments' ? ' aria-current="page"' : ''
        }>${
          workspace.role === 'reviewer' ? 'Assigned reviews' : 'Assessments'
        }</a><a data-testid="org-settings-link" href="${organizationPath}/settings"${
          workspace.active === 'settings' ? ' aria-current="page"' : ''
        }>Team &amp; settings</a>`
    : '';

  const planChip =
    workspace && hiringEnabled && workspace.planBadge
      ? `<span class="hiring-sidebar-plan-badge">${escapeHtml(workspace.planBadge)}</span>`
      : '';

  const navigation = workspace
    ? `<aside class="software-workspace-sidebar">
        <div class="software-workspace-identity" role="region" aria-label="Active organization"><span class="software-eyebrow">Your workspace</span><strong>${escapeHtml(
          workspace.organizationName,
        )}</strong><span>${resolveRoleLabel(workspace.role, hiringEnabled)}</span>${planChip}</div>
        <nav aria-label="Workspace navigation">${navLinks}</nav>
        <div class="software-workspace-sidebar-footer"><a href="/r23/organizations">Switch workspace</a><span>${escapeHtml(
          workspace.email,
        )}</span><form action="/r23/auth/logout" method="post"><input type="hidden" name="csrf" value="${escapeHtml(
          workspace.csrf,
        )}"><button type="submit">Sign out</button></form></div>
      </aside>`
    : '';

  const hiringStylesheet = hiringEnabled
    ? '<link rel="stylesheet" href="/hiring-platform.css">'
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/software-ui.css">${hiringStylesheet}<title>${safeTitle}</title></head><body class="software-product software-document-body${
    workspace ? ' software-document-workspace' : ''
  }"><header class="software-document-header"><a class="software-document-wordmark" href="${organizationPath}" aria-label="Hirearchy Software home"><span>Hirearchy</span><span class="software-document-product">Software</span></a></header><div class="software-document-layout">${navigation}<main class="software-document-shell"><div class="software-document-panel">${fallbackHeading}${content}</div></main></div></body></html>`;
}
