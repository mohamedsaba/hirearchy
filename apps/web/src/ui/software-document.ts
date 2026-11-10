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

export function renderSoftwareDocument(title: string, content: string): string {
  const safeTitle = escapeHtml(title);
  const fallbackHeading = /<h1(?:\s|>)/i.test(content)
    ? ''
    : `<h1>${safeTitle}</h1>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/software-ui.css"><title>${safeTitle}</title></head><body class="software-product software-document-body"><header class="software-document-header"><a class="software-document-wordmark" href="/r23/login" aria-label="Hirearchy Software home"><span>Hirearchy</span><span class="software-document-product">Software</span></a></header><main class="software-document-shell"><div class="software-document-panel">${fallbackHeading}${content}</div></main></body></html>`;
}
