import { SkeletonBlock, SkeletonText } from '../../_components/skeleton';
import '../dossier.css';

export default function DossierLoading() {
  return (
    <div className="software-product dossier-page" aria-busy="true">
      <header className="dossier-topbar dossier-no-print" aria-hidden="true">
        <div className="dossier-topbar-brand">
          <span className="software-document-wordmark">
            <span>Hirearchy</span>
            <span className="software-document-product">Software</span>
          </span>
          <SkeletonBlock width="10rem" height="1rem" index={0} />
          <SkeletonBlock
            width="11rem"
            height="1.45rem"
            radius="999px"
            tone="accent"
            index={1}
          />
        </div>
        <div className="hiring-header-actions dossier-topbar-actions">
          <SkeletonBlock width="2rem" height="2rem" radius="999px" index={1} />
          <SkeletonBlock
            width="8.5rem"
            height="2.1rem"
            radius="8px"
            tone="accent"
            index={2}
          />
        </div>
      </header>

      <main className="dossier-container">
        <div role="status" aria-live="polite" className="ct-sr-only">
          Loading executive dossier…
        </div>

        <section
          className="dossier-card dossier-header-card"
          aria-hidden="true"
        >
          <div className="dossier-header-top">
            <div style={{ display: 'grid', gap: '0.6rem', minWidth: '14rem' }}>
              <SkeletonBlock width="11rem" height="0.8rem" index={0} />
              <SkeletonBlock width="15rem" height="2rem" index={1} />
              <SkeletonBlock
                width="18rem"
                height="0.95rem"
                tone="muted"
                index={2}
              />
            </div>
            <div
              style={{ display: 'grid', gap: '0.45rem', justifyItems: 'end' }}
            >
              <SkeletonBlock
                width="10.5rem"
                height="1.75rem"
                radius="999px"
                tone="accent"
                index={1}
              />
              <SkeletonBlock
                width="12rem"
                height="0.85rem"
                tone="muted"
                index={2}
              />
            </div>
          </div>
          <div className="hiring-chip-group">
            <SkeletonBlock
              width="4.5rem"
              height="1.4rem"
              radius="999px"
              index={2}
            />
            <SkeletonBlock
              width="5.5rem"
              height="1.4rem"
              radius="999px"
              index={3}
            />
            <SkeletonBlock
              width="4rem"
              height="1.4rem"
              radius="999px"
              index={4}
            />
          </div>
        </section>

        <section className="dossier-card" aria-hidden="true">
          <SkeletonBlock width="10rem" height="0.8rem" index={1} />
          <SkeletonBlock
            width="13rem"
            height="1.4rem"
            index={2}
            className="hiring-mt-xs"
          />
          <div className="dossier-stats-grid hiring-mt-sm">
            <SkeletonBlock height="4.75rem" radius="0.65rem" index={2} />
            <SkeletonBlock height="4.75rem" radius="0.65rem" index={3} />
            <SkeletonBlock
              height="4.75rem"
              radius="0.65rem"
              tone="accent"
              index={4}
            />
            <SkeletonBlock height="4.75rem" radius="0.65rem" index={5} />
          </div>
        </section>

        <section className="dossier-card" aria-hidden="true">
          <SkeletonBlock width="11rem" height="0.8rem" index={2} />
          <SkeletonBlock
            width="15rem"
            height="1.4rem"
            index={3}
            className="hiring-mt-xs"
          />
          <div className="dossier-two-col hiring-mt-sm">
            <div className="dossier-stat-card">
              <SkeletonBlock width="55%" height="1rem" index={3} />
              <SkeletonText lines={3} index={4} className="hiring-mt-xs" />
            </div>
            <div className="dossier-stat-card">
              <SkeletonBlock width="62%" height="1rem" index={4} />
              <SkeletonText lines={3} index={5} className="hiring-mt-xs" />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
