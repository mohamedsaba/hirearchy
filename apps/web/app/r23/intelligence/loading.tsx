import { SkeletonBlock, SkeletonText } from '../../_components/skeleton';

export default function IntelligenceLoading() {
  return (
    <div
      className="software-product software-document-body intel-page-shell"
      aria-busy="true"
    >
      <header className="software-document-header">
        <span className="software-document-wordmark">
          <span>Hirearchy</span>
          <span className="software-document-product">Software</span>
        </span>
        <div className="software-header-controls" aria-hidden="true">
          <SkeletonBlock width="6rem" height="2rem" radius="8px" index={0} />
          <SkeletonBlock
            width="2rem"
            height="2rem"
            radius="999px"
            tone="muted"
            index={1}
          />
        </div>
      </header>

      <main className="intel-main">
        <div role="status" aria-live="polite" className="ct-sr-only">
          Loading product and hiring intelligence…
        </div>
        <div className="intel-stack" aria-hidden="true">
          <header className="intel-header">
            <div className="team-skel-stack-xs">
              <SkeletonBlock
                width="8rem"
                height="0.8rem"
                tone="muted"
                index={0}
              />
              <SkeletonBlock width="22rem" height="2rem" index={1} />
              <SkeletonBlock
                width="28rem"
                height="0.95rem"
                tone="muted"
                index={2}
              />
            </div>
            <div className="intel-controls">
              <SkeletonBlock
                width="16rem"
                height="2.6rem"
                radius="10px"
                index={1}
              />
              <SkeletonBlock
                width="14rem"
                height="2.25rem"
                radius="8px"
                tone="accent"
                index={2}
              />
            </div>
          </header>

          <div className="intel-jump-nav">
            <SkeletonBlock
              width="8.5rem"
              height="2.1rem"
              radius="8px"
              tone="accent"
              index={0}
            />
            <SkeletonBlock
              width="7.5rem"
              height="2.1rem"
              radius="8px"
              index={1}
            />
            <SkeletonBlock
              width="9.5rem"
              height="2.1rem"
              radius="8px"
              index={2}
            />
            <SkeletonBlock
              width="10rem"
              height="2.1rem"
              radius="8px"
              index={3}
            />
          </div>

          <section className="intel-section">
            <div className="intel-kpi-grid intel-kpi-grid--executive">
              {[0, 1, 2, 3].map((idx) => (
                <div key={idx} className="hiring-card intel-kpi-card">
                  <SkeletonBlock
                    width="7.5rem"
                    height="0.8rem"
                    tone="muted"
                    index={idx}
                  />
                  <SkeletonBlock
                    width="6rem"
                    height="2rem"
                    tone={idx === 0 ? 'accent' : 'default'}
                    index={idx + 1}
                  />
                  <SkeletonBlock
                    width="10.5rem"
                    height="0.78rem"
                    tone="muted"
                    index={idx + 2}
                  />
                </div>
              ))}
            </div>
          </section>

          <div className="intel-two-col">
            <div className="hiring-card team-skel-card">
              <SkeletonBlock width="12rem" height="1.15rem" index={1} />
              <SkeletonText lines={5} lastLineWidth="82%" index={2} />
            </div>
            <div className="hiring-card team-skel-card">
              <SkeletonBlock width="14rem" height="1.15rem" index={2} />
              <SkeletonText lines={5} lastLineWidth="74%" index={3} />
            </div>
          </div>

          <div className="hiring-card team-skel-card">
            <div className="team-skel-row-head">
              <SkeletonBlock width="13rem" height="1.15rem" index={2} />
              <SkeletonBlock
                width="20rem"
                height="2.25rem"
                radius="10px"
                index={3}
              />
            </div>
            <SkeletonText lines={4} lastLineWidth="88%" index={4} />
          </div>
        </div>
      </main>
    </div>
  );
}
