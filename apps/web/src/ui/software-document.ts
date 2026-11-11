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
  const mark = '<span class="software-brand-mark" aria-hidden="true"></span>';
  const brand = `<a class="software-document-wordmark" href="${organizationPath}" aria-label="Hirearchy Software home">${mark}<span>Hirearchy<span class="software-brand-period">.</span></span></a>`;
  const navigation = workspace
    ? `<div class="software-workspace-switch" role="region" aria-label="Active organization"><a href="/r23/organizations" aria-label="Switch workspace"><span class="software-org-monogram" aria-hidden="true">${escapeHtml(workspace.organizationName.trim().slice(0, 1).toUpperCase() || 'H')}</span><span class="software-org-name">${escapeHtml(workspace.organizationName)}</span><span aria-hidden="true" class="software-chevron"></span></a></div>
        <nav class="software-workspace-tabs" aria-label="Workspace navigation"><a href="${organizationPath}"${workspace.active === 'assessments' ? ' aria-current="page"' : ''}>${workspace.role === 'recruiter' ? 'Assessments' : 'Reviews'}</a><a data-testid="org-settings-link" href="${organizationPath}/settings"${workspace.active === 'settings' ? ' aria-current="page"' : ''}>Team &amp; settings</a></nav>
        <details class="software-account-menu">
          <summary aria-label="Account menu"><span class="software-account-avatar" aria-hidden="true">${escapeHtml(workspace.email.trim().slice(0, 1).toUpperCase() || 'H')}</span><span aria-hidden="true" class="software-chevron"></span></summary>
          <div class="software-account-popover"><p>${escapeHtml(workspace.email)}</p><p>${workspace.role === 'recruiter' ? 'Recruiter' : 'Evaluator'}</p><a href="${organizationPath}/settings#account-profile-heading">Your profile</a><form action="/r23/auth/logout" method="post"><input type="hidden" name="csrf" value="${escapeHtml(workspace.csrf)}"><button type="submit">Sign out</button></form></div>
        </details>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/software-ui.css"><title>${safeTitle}</title></head><body class="software-product software-document-body${workspace ? ' software-document-workspace' : ''}"><header class="software-document-header${workspace ? ' software-workspace-header' : ''}">${brand}${navigation}</header><main class="software-document-shell"><div class="software-document-panel">${fallbackHeading}${content}</div></main></body></html>`;
}
