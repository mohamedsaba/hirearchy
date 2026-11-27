'use client';

import { useId, useState, type ReactNode } from 'react';
import { IconChevronDown } from '@tabler/icons-react';

export interface SmoothDisclosureProps {
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly id?: string;
  readonly className?: string;
  readonly triggerClassName?: string;
  readonly panelClassName?: string;
  readonly badge?: ReactNode;
  readonly testId?: string;
}

/**
 * Cross-browser smooth CSS grid (0fr -> 1fr) disclosure with rotating chevron.
 */
export function SmoothDisclosure({
  summary,
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  id,
  className = '',
  triggerClassName = '',
  panelClassName = '',
  badge,
  testId,
}: SmoothDisclosureProps) {
  const generatedId = useId();
  const panelId = id ? `${id}-panel` : `ct-disclosure-${generatedId}`;
  const isControlled = open !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = isControlled ? open : internalOpen;

  const toggle = () => {
    const next = !isOpen;
    if (!isControlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  };

  return (
    <div
      className={className ? `ct-disclosure ${className}` : 'ct-disclosure'}
      data-open={isOpen ? 'true' : 'false'}
      data-testid={testId}
    >
      <button
        type="button"
        id={id}
        className={
          triggerClassName
            ? `ct-disclosure-trigger ${triggerClassName}`
            : 'ct-disclosure-trigger'
        }
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={toggle}
      >
        <span className="ct-disclosure-summary">{summary}</span>
        {badge ? <span className="ct-disclosure-badge">{badge}</span> : null}
        <IconChevronDown
          size={16}
          stroke={2}
          aria-hidden="true"
          className="ct-disclosure-chevron"
        />
      </button>
      <div
        id={panelId}
        className={
          panelClassName
            ? `ct-disclosure-panel ${panelClassName}`
            : 'ct-disclosure-panel'
        }
        data-open={isOpen ? 'true' : 'false'}
        aria-hidden={!isOpen || undefined}
        inert={!isOpen}
      >
        <div className="ct-disclosure-inner">{children}</div>
      </div>
    </div>
  );
}
