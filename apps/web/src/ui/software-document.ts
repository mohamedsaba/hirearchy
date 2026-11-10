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

export type SoftwareWorkspace = Readonly<{
  organizationId: string;
  organizationName: string;
  email: string;
  role: string;
  csrf: string;
  active: 'assessments' | 'settings';
}>;

export function renderSoftwareDocument(
  title: string,
  content: string,
  workspace?: SoftwareWorkspace,
): string {
  const safeTitle = escapeHtml(title);
  const fallbackHeading = /<h1(?:\s|>)/i.test(content)
    ? ''
    : `<h1>${safeTitle}</h1>`;

  const organizationPath = workspace
    ? `/r23/organizations/${encodeURIComponent(workspace.organizationId)}`
    : '/r23/login';
  const navigation = workspace
    ? `<aside class="software-workspace-sidebar">
        <div class="software-workspace-identity" role="region" aria-label="Active organization"><span class="software-eyebrow">Your workspace</span><strong>${escapeHtml(workspace.organizationName)}</strong><span>${workspace.role === 'recruiter' ? 'Recruiting team' : 'Evaluation team'}</span></div>
        <nav aria-label="Workspace navigation"><a href="${organizationPath}"${workspace.active === 'assessments' ? ' aria-current="page"' : ''}>Assessments</a><a data-testid="org-settings-link" href="${organizationPath}/settings"${workspace.active === 'settings' ? ' aria-current="page"' : ''}>Team &amp; settings</a></nav>
        <div class="software-workspace-sidebar-footer"><a href="/r23/organizations">Switch workspace</a><span>${escapeHtml(workspace.email)}</span><form action="/r23/auth/logout" method="post"><input type="hidden" name="csrf" value="${escapeHtml(workspace.csrf)}"><button type="submit">Sign out</button></form></div>
      </aside>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/software-ui.css"><title>${safeTitle}</title></head><body class="software-product software-document-body${workspace ? ' software-document-workspace' : ''}"><header class="software-document-header"><a class="software-document-wordmark" href="${organizationPath}" aria-label="Hirearchy Software home"><span>Hirearchy</span><span class="software-document-product">Software</span></a><span class="software-document-purpose">Engineering work. Human judgment.</span></header><div class="software-document-layout">${navigation}<main class="software-document-shell"><div class="software-document-panel">${fallbackHeading}${content}</div></main></div></body></html>`;
}
