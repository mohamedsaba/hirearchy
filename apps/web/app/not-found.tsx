export default function PageNotFound() {
  return (
    <div className="software-product software-document-body">
      <header className="software-document-header">
        <a
          className="software-document-wordmark"
          href="/"
          aria-label="Hirearchy Software home"
        >
          <span>Hirearchy</span>
          <span className="software-document-product">Software</span>
        </a>
      </header>
      <main className="software-document-shell">
        <section
          className="software-document-panel"
          aria-labelledby="page-unavailable-title"
        >
          <p className="software-eyebrow">Page unavailable</p>
          <h1 id="page-unavailable-title">Let’s get you back.</h1>
          <p>
            This page or invitation could not be found. Check the link, or ask
            the person who shared it for a new one.
          </p>
          <a className="software-document-primary-link" href="/">
            Return to Hirearchy
          </a>
        </section>
      </main>
    </div>
  );
}
