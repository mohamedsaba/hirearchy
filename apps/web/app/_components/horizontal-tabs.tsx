'use client';

import { useRef, type ReactNode } from 'react';
import { useSlidingIndicator } from '../../src/ui/use-sliding-indicator';

export function HorizontalTabs<T extends string>({
  id,
  label,
  active,
  tabs,
  onSelect,
  className,
  tabClassName,
}: Readonly<{
  id: string;
  label: string;
  active: T;
  tabs: readonly {
    id: T;
    label: ReactNode;
    ariaLabel?: string;
    testId?: string;
  }[];
  onSelect: (id: T) => void;
  className: string;
  tabClassName: string;
}>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const indicatorReady = useSlidingIndicator(containerRef, active);

  return (
    <div
      ref={containerRef}
      className={className ? `ct-tabs-root ${className}` : 'ct-tabs-root'}
      role="tablist"
      aria-label={label}
      data-indicator-ready={indicatorReady ? 'true' : undefined}
    >
      <span className="ct-tab-indicator" aria-hidden="true" />
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          id={`${id}-${tab.id}`}
          type="button"
          role="tab"
          aria-label={tab.ariaLabel}
          aria-selected={active === tab.id}
          aria-controls={`${id}-panel`}
          tabIndex={active === tab.id ? 0 : -1}
          className={tabClassName}
          data-testid={tab.testId}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            const next =
              event.key === 'ArrowRight'
                ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft'
                  ? (index + tabs.length - 1) % tabs.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            onSelect(tabs[next].id);
            document.getElementById(`${id}-${tabs[next].id}`)?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
