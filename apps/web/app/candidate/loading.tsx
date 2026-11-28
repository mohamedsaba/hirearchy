import { SkeletonBlock, SkeletonText } from '../_components/skeleton';

export default function CandidatePortalLoading() {
  return (
    <div className="hiring-candidate-portal software-product" aria-busy="true">
      <header className="software-document-header hiring-portal-header">
        <div className="hiring-portal-brand">
          <span className="software-document-wordmark">
            <span>Hirearchy</span>
            <span className="software-document-product">Software</span>
          </span>
        </div>
        <div className="hiring-header-actions" aria-hidden="true">
          <SkeletonBlock width="10.5rem" height="0.9rem" index={0} />
          <SkeletonBlock width="2rem" height="2rem" radius="999px" index={1} />
          <SkeletonBlock
            width="5.25rem"
            height="2.1rem"
            radius="8px"
            index={2}
          />
        </div>
      </header>

      <main className="hiring-portal-main software-portal-document">
        <div role="status" aria-live="polite" className="ct-sr-only">
          Loading your assessments…
        </div>

        <div className="hiring-page-header" aria-hidden="true">
          <SkeletonBlock
            width="12.5rem"
            height="2.1rem"
            radius="8px"
            index={0}
          />
          <SkeletonBlock
            width="6.5rem"
            height="2.1rem"
            radius="8px"
            index={1}
          />
        </div>

        <div
          className="hiring-builder-tabs"
          aria-hidden="true"
          style={{ width: 'fit-content' }}
        >
          <SkeletonBlock
            width="8.5rem"
            height="2.2rem"
            radius="8px"
            tone="accent"
            index={1}
          />
          <SkeletonBlock
            width="7.25rem"
            height="2.2rem"
            radius="8px"
            index={2}
          />
        </div>

        <section className="hiring-filter-bar" aria-hidden="true">
          <div className="hiring-filter-grid">
            <SkeletonBlock
              width="100%"
              height="2.6rem"
              radius="8px"
              index={2}
            />
            <SkeletonBlock
              width="100%"
              height="2.6rem"
              radius="8px"
              index={3}
            />
            <SkeletonBlock
              width="100%"
              height="2.6rem"
              radius="8px"
              index={4}
            />
            <SkeletonBlock
              width="100%"
              height="2.6rem"
              radius="8px"
              index={5}
            />
          </div>
        </section>

        <section className="software-directory-results" aria-hidden="true">
          <div className="hiring-candidate-list">
            {[0, 1].map((cardIndex) => (
              <article
                key={cardIndex}
                className="hiring-card"
                style={{
                  borderInlineStart:
                    cardIndex === 0
                      ? '3px solid var(--software-mint)'
                      : '3px solid var(--software-border-strong)',
                }}
              >
                <div className="hiring-portal-card-head">
                  <div
                    style={{
                      display: 'grid',
                      gap: '0.65rem',
                      flex: '1 1 20rem',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                      }}
                    >
                      <SkeletonBlock
                        width="7.5rem"
                        height="0.8rem"
                        index={cardIndex * 3 + 1}
                      />
                      <SkeletonBlock
                        width="5.5rem"
                        height="1.35rem"
                        radius="999px"
                        tone={cardIndex === 0 ? 'accent' : 'muted'}
                        index={cardIndex * 3 + 2}
                      />
                    </div>
                    <SkeletonBlock
                      width="18rem"
                      height="1.45rem"
                      index={cardIndex * 3 + 2}
                    />
                    <SkeletonText
                      lines={1}
                      lastLineWidth="22rem"
                      index={cardIndex * 3 + 3}
                    />
                  </div>
                  <SkeletonBlock
                    width="10.5rem"
                    height="2.5rem"
                    radius="8px"
                    tone={cardIndex === 0 ? 'accent' : 'default'}
                    index={cardIndex * 3 + 4}
                  />
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
