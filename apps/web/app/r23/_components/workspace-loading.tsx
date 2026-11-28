import {
  SkeletonBlock,
  SkeletonText,
  WorkspaceSkeletonShell,
} from '../../_components/skeleton';

export type LoadingSection =
  'candidates' | 'builder' | 'handoffs' | 'dossier' | 'problems';

const sectionLabels = {
  candidates: 'Candidates',
  builder: 'Assessment Builder',
  handoffs: 'Interview handoffs',
  dossier: 'Candidate dossier',
  problems: 'Problems',
} satisfies Record<LoadingSection, string>;

const sectionSubtitles: Partial<Record<LoadingSection, string>> = {
  builder: 'Choose a template, generate with AI, or load a saved problem.',
  problems: 'Reusable repository tasks, health signals, and quick issuance.',
};

function CandidateRowSkeleton({ index }: { index: number }) {
  return (
    <div className="hiring-card team-skel-card">
      <div className="team-skel-row-head">
        <div className="team-skel-identity">
          <SkeletonBlock
            width="2.5rem"
            height="2.5rem"
            radius="999px"
            tone="accent"
            index={index}
          />
          <div className="team-skel-stack-xs">
            <div className="team-skel-inline">
              <SkeletonBlock
                width="10.5rem"
                height="1.1rem"
                index={index + 1}
              />
              <SkeletonBlock
                width="6.5rem"
                height="1.35rem"
                radius="999px"
                tone="accent"
                index={index + 2}
              />
            </div>
            <SkeletonBlock
              width="17rem"
              height="0.82rem"
              tone="muted"
              index={index + 2}
            />
          </div>
        </div>
        <div className="team-skel-inline">
          <SkeletonBlock
            width="5.5rem"
            height="1.95rem"
            radius="8px"
            index={index + 3}
          />
        </div>
      </div>
      <div className="team-skel-subrow">
        <div className="team-skel-stack-xs">
          <SkeletonBlock width="13rem" height="0.95rem" index={index + 2} />
          <SkeletonBlock
            width="15rem"
            height="0.8rem"
            tone="muted"
            index={index + 3}
          />
        </div>
        <SkeletonBlock
          width="8.75rem"
          height="2.125rem"
          radius="8px"
          tone="accent"
          index={index + 4}
        />
      </div>
    </div>
  );
}

export function WorkspaceContentLoading({
  section,
}: {
  section: LoadingSection;
}) {
  return (
    <div className="team-workspace-loading" data-section={section}>
      <p className="ct-sr-only" role="status">
        Loading {sectionLabels[section].toLowerCase()}…
      </p>

      {section === 'candidates' ? (
        <div className="team-skel-stack" aria-hidden="true">
          <div className="team-skel-pulse-bar">
            <div className="team-skel-inline">
              <SkeletonBlock
                width="4.5rem"
                height="2rem"
                radius="999px"
                tone="accent"
                index={0}
              />
              <SkeletonBlock
                width="8.5rem"
                height="2rem"
                radius="999px"
                index={1}
              />
              <SkeletonBlock
                width="6.5rem"
                height="2rem"
                radius="999px"
                index={2}
              />
              <SkeletonBlock
                width="5.5rem"
                height="2rem"
                radius="999px"
                index={3}
              />
            </div>
            <SkeletonBlock
              width="10.5rem"
              height="2rem"
              radius="999px"
              tone="muted"
              index={4}
            />
          </div>

          <div className="hiring-filter-bar team-skel-filter-bar">
            <SkeletonBlock
              width="100%"
              height="2.625rem"
              radius="8px"
              index={1}
            />
            <SkeletonBlock
              width="100%"
              height="2.625rem"
              radius="8px"
              index={2}
            />
            <SkeletonBlock
              width="6.5rem"
              height="2.25rem"
              radius="8px"
              tone="muted"
              index={3}
            />
          </div>

          <CandidateRowSkeleton index={1} />
          <CandidateRowSkeleton index={3} />
          <CandidateRowSkeleton index={5} />
        </div>
      ) : null}

      {section === 'builder' ? (
        <div className="software-builder-flow" aria-hidden="true">
          <aside className="team-builder-rail">
            <div className="team-skel-stack-sm">
              <SkeletonBlock
                width="100%"
                height="2.6rem"
                radius="8px"
                tone="accent"
                index={0}
              />
              <SkeletonBlock
                width="100%"
                height="2.6rem"
                radius="8px"
                index={1}
              />
              <SkeletonBlock
                width="100%"
                height="2.6rem"
                radius="8px"
                index={2}
              />
            </div>
            <div className="team-builder-drafts">
              <SkeletonBlock
                width="100%"
                height="2.125rem"
                radius="8px"
                tone="muted"
                index={3}
              />
            </div>
          </aside>
          <div className="software-builder-content">
            <div className="hiring-card team-skel-stack">
              <SkeletonBlock width="10rem" height="1.35rem" index={0} />
              <div className="team-skel-tabs">
                <SkeletonBlock
                  width="6.75rem"
                  height="2.2rem"
                  radius="8px"
                  tone="accent"
                  index={1}
                />
                <SkeletonBlock
                  width="8.5rem"
                  height="2.2rem"
                  radius="8px"
                  index={2}
                />
                <SkeletonBlock
                  width="6rem"
                  height="2.2rem"
                  radius="8px"
                  index={3}
                />
              </div>
              <div className="software-problem-list">
                {[0, 1, 2].map((idx) => (
                  <div key={idx} className="software-problem-row">
                    <div className="team-skel-stack-xs">
                      <SkeletonBlock
                        width="13rem"
                        height="1.15rem"
                        index={idx + 1}
                      />
                      <SkeletonText
                        lines={2}
                        lastLineWidth="76%"
                        index={idx + 2}
                      />
                    </div>
                    <SkeletonBlock
                      width="9.5rem"
                      height="2.4rem"
                      radius="8px"
                      tone={idx === 0 ? 'accent' : 'default'}
                      index={idx + 3}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {section === 'handoffs' ? (
        <div className="team-skel-stack" aria-hidden="true">
          <div className="team-skel-pulse-bar">
            <div className="team-skel-inline">
              <SkeletonBlock
                width="4.5rem"
                height="2rem"
                radius="999px"
                tone="accent"
                index={0}
              />
              <SkeletonBlock
                width="8rem"
                height="2rem"
                radius="999px"
                index={1}
              />
              <SkeletonBlock
                width="6.5rem"
                height="2rem"
                radius="999px"
                index={2}
              />
            </div>
          </div>
          <div className="hiring-filter-bar team-skel-filter-bar">
            <SkeletonBlock
              width="100%"
              height="2.625rem"
              radius="8px"
              index={1}
            />
            <SkeletonBlock
              width="100%"
              height="2.625rem"
              radius="8px"
              index={2}
            />
          </div>
          {[0, 1, 2].map((idx) => (
            <div key={idx} className="hiring-card team-skel-card">
              <div className="team-skel-row-head">
                <div className="team-skel-identity">
                  <SkeletonBlock
                    width="2.5rem"
                    height="2.5rem"
                    radius="999px"
                    tone="accent"
                    index={idx + 1}
                  />
                  <div className="team-skel-stack-xs">
                    <div className="team-skel-inline">
                      <SkeletonBlock
                        width="10rem"
                        height="1.15rem"
                        index={idx + 2}
                      />
                      <SkeletonBlock
                        width="5.5rem"
                        height="1.35rem"
                        radius="999px"
                        tone="accent"
                        index={idx + 3}
                      />
                      <SkeletonBlock
                        width="8rem"
                        height="1.35rem"
                        radius="999px"
                        index={idx + 4}
                      />
                    </div>
                    <SkeletonBlock
                      width="20rem"
                      height="0.82rem"
                      tone="muted"
                      index={idx + 3}
                    />
                  </div>
                </div>
                <SkeletonBlock
                  width="9.5rem"
                  height="2.125rem"
                  radius="8px"
                  tone="accent"
                  index={idx + 4}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {section === 'dossier' ? (
        <div className="software-handoff-layout" aria-hidden="true">
          <aside className="hiring-card software-handoff-next team-skel-stack-sm">
            <SkeletonBlock width="7.5rem" height="1.15rem" index={0} />
            <SkeletonBlock width="10.5rem" height="1rem" index={1} />
            <SkeletonBlock
              width="7rem"
              height="0.85rem"
              tone="muted"
              index={2}
            />
            <div className="team-skel-tabs">
              <SkeletonBlock
                width="32%"
                height="2.1rem"
                radius="8px"
                tone="accent"
                index={2}
              />
              <SkeletonBlock
                width="32%"
                height="2.1rem"
                radius="8px"
                index={3}
              />
              <SkeletonBlock
                width="32%"
                height="2.1rem"
                radius="8px"
                index={4}
              />
            </div>
            <SkeletonBlock
              width="100%"
              height="2.25rem"
              radius="8px"
              tone="accent"
              index={4}
            />
          </aside>
          <div className="hiring-page-shell">
            <div className="hiring-card team-skel-card">
              <div className="team-skel-identity">
                <SkeletonBlock
                  width="2.75rem"
                  height="2.75rem"
                  radius="999px"
                  tone="accent"
                  index={0}
                />
                <div className="team-skel-stack-xs">
                  <SkeletonBlock width="12rem" height="1.25rem" index={1} />
                  <SkeletonBlock
                    width="18rem"
                    height="0.85rem"
                    tone="muted"
                    index={2}
                  />
                </div>
              </div>
              <SkeletonText lines={2} lastLineWidth="68%" index={3} />
            </div>
            <div className="hiring-card team-skel-card">
              <SkeletonBlock width="12rem" height="1.2rem" index={2} />
              <div className="hiring-two-col">
                <div className="hiring-card-subtle team-skel-stack-xs">
                  <SkeletonBlock
                    width="9rem"
                    height="1rem"
                    tone="accent"
                    index={3}
                  />
                  <SkeletonText lines={3} index={4} />
                </div>
                <div className="hiring-card-subtle team-skel-stack-xs">
                  <SkeletonBlock width="10rem" height="1rem" index={3} />
                  <SkeletonText lines={3} index={4} />
                </div>
              </div>
            </div>
            <div className="hiring-card team-skel-card">
              <SkeletonBlock width="14rem" height="1.2rem" index={4} />
              <SkeletonText lines={4} lastLineWidth="58%" index={5} />
            </div>
          </div>
        </div>
      ) : null}

      {section === 'problems' ? (
        <div className="team-skel-stack" aria-hidden="true">
          <div className="hiring-card team-skel-card">
            <div className="team-skel-row-head">
              <SkeletonBlock width="14rem" height="1.15rem" index={0} />
              <SkeletonBlock
                width="8rem"
                height="1.4rem"
                radius="999px"
                tone="accent"
                index={1}
              />
            </div>
            <div className="org-benchmark-grid">
              <div className="hiring-card-subtle team-skel-stack-xs">
                <SkeletonBlock width="9rem" height="1rem" index={1} />
                <SkeletonText lines={2} lastLineWidth="70%" index={2} />
              </div>
              <div className="hiring-card-subtle team-skel-stack-xs">
                <SkeletonBlock width="9rem" height="1rem" index={2} />
                <SkeletonText lines={2} lastLineWidth="64%" index={3} />
              </div>
            </div>
          </div>
          <div className="hiring-card team-skel-card">
            {[0, 1, 2, 3].map((idx) => (
              <div key={idx} className="team-skel-subrow">
                <div className="team-skel-stack-xs">
                  <SkeletonBlock
                    width="13rem"
                    height="1.05rem"
                    index={idx + 1}
                  />
                  <div className="team-skel-inline">
                    <SkeletonBlock
                      width="5.5rem"
                      height="1.3rem"
                      radius="999px"
                      index={idx + 2}
                    />
                    <SkeletonBlock
                      width="4rem"
                      height="1.3rem"
                      radius="999px"
                      tone="muted"
                      index={idx + 3}
                    />
                    <SkeletonBlock
                      width="5rem"
                      height="1.3rem"
                      radius="999px"
                      tone="accent"
                      index={idx + 4}
                    />
                  </div>
                </div>
                <div className="team-skel-inline">
                  <SkeletonBlock
                    width="8.5rem"
                    height="2.125rem"
                    radius="8px"
                    index={idx + 3}
                  />
                  <SkeletonBlock
                    width="4.75rem"
                    height="2.125rem"
                    radius="8px"
                    tone="accent"
                    index={idx + 4}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceRouteLoading({
  section,
}: {
  section: LoadingSection;
}) {
  return (
    <WorkspaceSkeletonShell
      activeSection={section}
      title={sectionLabels[section]}
      subtitle={sectionSubtitles[section]}
    >
      <WorkspaceContentLoading section={section} />
    </WorkspaceSkeletonShell>
  );
}
