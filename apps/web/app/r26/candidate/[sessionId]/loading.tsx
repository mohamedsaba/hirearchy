import { SkeletonBlock, SkeletonText } from '../../../_components/skeleton';
import './candidate-workspace.css';

export default function CandidateWorkspaceLoading() {
  return (
    <main
      className="r26-candidate software-product"
      data-active-workspace="true"
      aria-busy="true"
    >
      <div role="status" aria-live="polite" className="ct-sr-only">
        Loading candidate workspace…
      </div>

      <header className="r26-header" aria-hidden="true">
        <div className="r26-brand">
          <strong>Hirearchy</strong>
          <span className="r26-product-tab">Software</span>
          <span className="r26-workspace-label">
            <SkeletonBlock
              width="11rem"
              height="0.85rem"
              tone="muted"
              index={0}
            />
          </span>
        </div>
        <div className="r26-header-status">
          <SkeletonBlock width="2rem" height="2rem" radius="999px" index={0} />
          <SkeletonBlock
            width="8.5rem"
            height="2.15rem"
            radius="8px"
            tone="accent"
            index={1}
          />
          <SkeletonBlock
            width="4.5rem"
            height="2.15rem"
            radius="8px"
            index={2}
          />
          <SkeletonBlock
            width="4.75rem"
            height="2.15rem"
            radius="8px"
            index={3}
          />
          <SkeletonBlock
            width="5.5rem"
            height="2.15rem"
            radius="8px"
            tone="accent"
            index={4}
          />
        </div>
      </header>

      <div
        className="r26-workspace r26-loading-workspace"
        data-task-open="true"
        data-ai-enabled="false"
        aria-hidden="true"
      >
        <aside className="r26-desktop-files">
          <h2>Files</h2>
          <div className="r26-loading-tree">
            <SkeletonBlock width="68%" height="1.5rem" radius="6px" index={0} />
            <SkeletonBlock width="84%" height="1.5rem" radius="6px" index={1} />
            <SkeletonBlock
              width="78%"
              height="1.5rem"
              radius="6px"
              tone="accent"
              index={2}
            />
            <SkeletonBlock width="72%" height="1.5rem" radius="6px" index={3} />
            <SkeletonBlock width="60%" height="1.5rem" radius="6px" index={4} />
          </div>
        </aside>

        <section className="r26-editor-panel">
          <div className="r26-editor-tabbar">
            <div className="r26-loading-tabs">
              <SkeletonBlock
                width="8.5rem"
                height="2rem"
                radius="6px"
                tone="accent"
                index={1}
              />
              <SkeletonBlock
                width="7.25rem"
                height="2rem"
                radius="6px"
                index={2}
              />
            </div>
            <div className="r26-editor-tabbar-actions">
              <SkeletonBlock
                width="2rem"
                height="1.9rem"
                radius="6px"
                index={3}
              />
              <SkeletonBlock
                width="4.25rem"
                height="1.9rem"
                radius="6px"
                index={4}
              />
            </div>
          </div>

          <div className="r26-loading-editor-lines">
            {[
              '42%',
              '68%',
              '56%',
              '78%',
              '34%',
              '72%',
              '64%',
              '48%',
              '82%',
              '58%',
              '40%',
              '62%',
            ].map((lineWidth, idx) => (
              <div key={idx} className="r26-loading-code-row">
                <SkeletonBlock
                  width="1.5rem"
                  height="0.8rem"
                  radius="4px"
                  tone="muted"
                  index={idx}
                />
                <SkeletonBlock
                  width={lineWidth}
                  height="0.85rem"
                  radius="4px"
                  index={idx + 1}
                />
              </div>
            ))}
          </div>
        </section>

        <aside className="r26-task-panel">
          <div className="r26-task-panel-bar">
            <span>Task</span>
          </div>
          <div className="r26-loading-task-body">
            <SkeletonBlock width="76%" height="1.5rem" radius="6px" index={1} />
            <SkeletonText lines={4} lastLineWidth="58%" index={2} />
            <div className="r26-loading-task-card">
              <SkeletonBlock
                width="54%"
                height="1rem"
                tone="accent"
                index={4}
              />
              <SkeletonText lines={3} lastLineWidth="72%" index={5} />
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
