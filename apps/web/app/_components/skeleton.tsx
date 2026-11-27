import type { CSSProperties, ReactNode } from 'react';

export type SkeletonTone = 'default' | 'muted' | 'accent';

export interface SkeletonBlockProps {
  readonly width?: string | number;
  readonly height?: string | number;
  readonly radius?: string | number;
  readonly index?: number;
  readonly tone?: SkeletonTone;
  readonly className?: string;
  readonly ariaLabel?: string;
}

function toCssSize(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? `${value}px` : value;
}

/**
 * Atomic GPU-composited shimmer block with staggered wave index.
 */
export function SkeletonBlock({
  width,
  height = '1rem',
  radius,
  index = 0,
  tone = 'default',
  className = '',
  ariaLabel,
}: SkeletonBlockProps) {
  const style: CSSProperties & Record<string, string | number | undefined> = {
    width: toCssSize(width),
    height: toCssSize(height),
    '--skel-radius': toCssSize(radius),
    '--skel-index': index,
  };

  return (
    <span
      className={className ? `ct-skel ${className}` : 'ct-skel'}
      data-skel-tone={tone}
      style={style}
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
    />
  );
}

const LINE_WIDTHS = ['100%', '92%', '86%', '94%', '78%'] as const;

export interface SkeletonTextProps {
  readonly lines?: number;
  readonly lastLineWidth?: string;
  readonly index?: number;
  readonly className?: string;
}

/**
 * Variable-width stacked text lines that match natural prose cadence.
 */
export function SkeletonText({
  lines = 3,
  lastLineWidth = '62%',
  index = 0,
  className = '',
}: SkeletonTextProps) {
  const count = Math.max(1, lines);
  return (
    <div
      className={className ? `ct-skel-text ${className}` : 'ct-skel-text'}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, lineIdx) => {
        const isLast = count > 1 && lineIdx === count - 1;
        const width = isLast
          ? lastLineWidth
          : LINE_WIDTHS[lineIdx % LINE_WIDTHS.length];
        return (
          <SkeletonBlock
            key={lineIdx}
            width={width}
            height="0.875rem"
            radius="6px"
            index={index + lineIdx}
          />
        );
      })}
    </div>
  );
}

export interface WorkspaceSkeletonShellProps {
  readonly activeSection?: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly hasSidebar?: boolean;
  readonly children?: ReactNode;
}

/**
 * Authenticated organization workspace loading shell mirroring OrganizationWorkspaceShell.
 */
export function WorkspaceSkeletonShell({
  activeSection = 'workspace',
  title,
  subtitle,
  hasSidebar = true,
  children,
}: WorkspaceSkeletonShellProps) {
  return (
    <div
      className="software-product software-document-body software-document-workspace software-document-compact-nav"
      data-loading-section={activeSection}
      aria-busy="true"
    >
      <header className="software-document-header">
        <span className="software-document-wordmark">
          <span>Hirearchy</span>
          <span className="software-document-product">Software</span>
        </span>
        <div className="software-header-controls" aria-hidden="true">
          <SkeletonBlock width="2rem" height="2rem" radius="999px" index={0} />
        </div>
      </header>
      <div className="software-document-layout">
        {hasSidebar ? (
          <aside
            className="software-workspace-sidebar skeleton-workspace-nav"
            aria-hidden="true"
          >
            <div className="skeleton-workspace-identity">
              <SkeletonBlock
                width="2.25rem"
                height="2.25rem"
                radius="10px"
                index={0}
              />
              <div className="skeleton-workspace-identity-copy">
                <SkeletonBlock width="72%" height="0.9rem" index={1} />
                <SkeletonBlock
                  width="48%"
                  height="0.72rem"
                  tone="muted"
                  index={2}
                />
              </div>
            </div>
            <div className="skeleton-workspace-links">
              <SkeletonBlock width="100%" height="2.25rem" index={1} />
              <SkeletonBlock width="100%" height="2.25rem" index={2} />
              <SkeletonBlock width="100%" height="2.25rem" index={3} />
              <SkeletonBlock width="100%" height="2.25rem" index={4} />
              <SkeletonBlock width="84%" height="2.25rem" index={5} />
            </div>
            <div className="skeleton-workspace-footer">
              <SkeletonBlock width="100%" height="3.25rem" index={6} />
            </div>
          </aside>
        ) : null}
        <main className="software-document-shell">
          <div className="software-document-panel hiring-page-shell">
            <header className="hiring-page-header">
              <div>
                <h1>{title}</h1>
                {subtitle ? <p>{subtitle}</p> : null}
              </div>
            </header>
            <div role="status" aria-live="polite" className="ct-sr-only">
              Loading {title.toLowerCase()}…
            </div>
            <div className="skeleton-workspace-main" aria-hidden="true">
              {children ?? (
                <div className="skeleton-workbench-card">
                  <SkeletonBlock width="38%" height="1.25rem" index={1} />
                  <SkeletonText lines={3} index={2} />
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export interface EvaluatorWorkbenchSkeletonProps {
  readonly withOrgBreadcrumb?: boolean;
  readonly banner?: ReactNode;
}

/**
 * Shared layout-matched skeleton for /evaluator, /r27, and /demo review workbenches.
 * Renders full-bleed workbench dimensions so hydrated views mount with zero horizontal jump.
 */
export function EvaluatorWorkbenchSkeleton({
  withOrgBreadcrumb = false,
  banner,
}: EvaluatorWorkbenchSkeletonProps) {
  return (
    <div
      className="software-product evaluator-review-layout evaluator-workbench skeleton-workbench"
      data-hiring-review={withOrgBreadcrumb ? 'true' : undefined}
      aria-busy="true"
    >
      {banner}
      <div className="evaluator-workbench-shell">
        <div role="status" aria-live="polite" className="ct-sr-only">
          Loading evaluator workbench…
        </div>
        <header className="skeleton-workbench-header" aria-hidden="true">
          {withOrgBreadcrumb ? (
            <div className="skeleton-workbench-breadcrumb">
              <SkeletonBlock width="8.5rem" height="0.85rem" index={0} />
              <SkeletonBlock
                width="6rem"
                height="0.85rem"
                tone="muted"
                index={1}
              />
            </div>
          ) : null}
          <div className="skeleton-workbench-title-row">
            <div className="skeleton-workbench-person">
              <SkeletonBlock
                width="2.75rem"
                height="2.75rem"
                radius="999px"
                tone="accent"
                index={0}
              />
              <div className="skeleton-workbench-person-copy">
                <SkeletonBlock width="14rem" height="1.5rem" index={1} />
                <div className="skeleton-workbench-pills">
                  <SkeletonBlock
                    width="5.5rem"
                    height="1.35rem"
                    radius="999px"
                    tone="accent"
                    index={2}
                  />
                  <SkeletonBlock
                    width="7rem"
                    height="1.35rem"
                    radius="999px"
                    index={3}
                  />
                  <SkeletonBlock
                    width="6rem"
                    height="1.35rem"
                    radius="999px"
                    tone="muted"
                    index={4}
                  />
                </div>
              </div>
            </div>
            <SkeletonBlock
              width="10.5rem"
              height="2.5rem"
              radius="8px"
              tone="accent"
              index={2}
            />
          </div>
        </header>

        <div
          className="evaluator-workbench-topline skeleton-workbench-tabs"
          aria-hidden="true"
        >
          <div className="skeleton-workbench-tab-list">
            <SkeletonBlock
              width="6.5rem"
              height="2.25rem"
              radius="8px"
              tone="accent"
              index={1}
            />
            <SkeletonBlock
              width="8rem"
              height="2.25rem"
              radius="8px"
              index={2}
            />
            <SkeletonBlock
              width="6rem"
              height="2.25rem"
              radius="8px"
              index={3}
            />
          </div>
          <SkeletonBlock
            width="6.5rem"
            height="2.25rem"
            radius="8px"
            tone="muted"
            index={4}
          />
        </div>

        <div className="skeleton-workbench-grid" aria-hidden="true">
          <div className="skeleton-workbench-column">
            <div className="skeleton-workbench-card">
              <SkeletonBlock width="34%" height="1.1rem" index={2} />
              <div className="skeleton-workbench-metrics">
                <SkeletonBlock height="3.5rem" radius="8px" index={3} />
                <SkeletonBlock height="3.5rem" radius="8px" index={4} />
                <SkeletonBlock height="3.5rem" radius="8px" index={5} />
                <SkeletonBlock height="3.5rem" radius="8px" index={6} />
              </div>
              <SkeletonText lines={4} index={5} />
            </div>
            <div className="skeleton-workbench-card">
              <SkeletonBlock width="42%" height="1.1rem" index={6} />
              <SkeletonText lines={3} lastLineWidth="54%" index={7} />
            </div>
          </div>
          <aside className="skeleton-workbench-column">
            <div className="skeleton-workbench-card">
              <SkeletonBlock
                width="48%"
                height="1.1rem"
                tone="accent"
                index={3}
              />
              <SkeletonText lines={3} lastLineWidth="70%" index={4} />
              <SkeletonBlock
                width="100%"
                height="2.4rem"
                radius="8px"
                index={6}
              />
            </div>
            <div className="skeleton-workbench-card">
              <SkeletonBlock width="55%" height="1rem" index={5} />
              <SkeletonText lines={2} lastLineWidth="48%" index={6} />
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
