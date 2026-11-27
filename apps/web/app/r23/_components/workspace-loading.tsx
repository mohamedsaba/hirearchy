type LoadingSection = 'candidates' | 'builder' | 'handoffs' | 'dossier';

const sectionLabels = {
  candidates: 'Candidates',
  builder: 'Assessment Builder',
  handoffs: 'Interview handoffs',
  dossier: 'Candidate dossier',
} satisfies Record<LoadingSection, string>;

export function WorkspaceContentLoading({
  section,
}: {
  section: LoadingSection;
}) {
  return (
    <div className="team-workspace-loading" data-section={section}>
      <p className="team-loading-label" role="status">
        Loading {sectionLabels[section].toLowerCase()}…
      </p>
      <div className="team-loading-content" aria-hidden="true">
        {section === 'builder' ? (
          <div className="team-loading-steps">
            <span />
            <span />
            <span />
          </div>
        ) : null}
        <div className="team-loading-main">
          {section === 'candidates' ? (
            <div className="team-loading-filter">
              <span />
              <span />
            </div>
          ) : null}
          <div className="team-loading-card">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    </div>
  );
}

export function WorkspaceRouteLoading({
  section,
}: {
  section: LoadingSection;
}) {
  return (
    <div className="software-product software-document-body software-document-workspace software-document-compact-nav">
      <header className="software-document-header">
        <span className="software-document-wordmark">
          <span>Hirearchy</span>
          <span className="software-document-product">Software</span>
        </span>
      </header>
      <div className="software-document-layout">
        <aside
          className="software-workspace-sidebar team-loading-nav"
          aria-hidden="true"
        >
          <span />
          <span />
          <span />
          <span />
          <span />
        </aside>
        <main className="software-document-shell">
          <div className="software-document-panel hiring-page-shell">
            <header className="hiring-page-header">
              <h1>{sectionLabels[section]}</h1>
            </header>
            <WorkspaceContentLoading section={section} />
          </div>
        </main>
      </div>
    </div>
  );
}
