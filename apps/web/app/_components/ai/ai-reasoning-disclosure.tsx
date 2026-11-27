'use client';

import { useId, useState, type ReactNode } from 'react';
import './ai-primitives.css';
import { CommonThreadSpark } from './common-thread-spark';

export type AiReasoningTraceStatus =
  'observed' | 'verified' | 'partial' | 'pending';

export interface AiReasoningTraceItem {
  readonly label: string;
  readonly status?: AiReasoningTraceStatus;
  readonly detail?: string;
}

export interface AiReasoningDisclosureProps {
  readonly title: string;
  readonly status: 'thinking' | 'settled';
  readonly durationSeconds?: number;
  readonly badge?: string;
  readonly defaultOpen?: boolean;
  readonly summaryText?: string;
  readonly items?: readonly AiReasoningTraceItem[];
  readonly children?: ReactNode;
  readonly testId?: string;
  readonly className?: string;
}

function formatDurationSeconds(seconds: number): string {
  if (Number.isInteger(seconds)) {
    return `${seconds}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

/**
 * Cross-browser CSS grid 0fr->1fr collapsible reasoning / context trace
 * disclosure with optional settled duration pill and neutral/advisory badge.
 */
export function AiReasoningDisclosure({
  title,
  status,
  durationSeconds,
  badge,
  defaultOpen,
  summaryText,
  items,
  children,
  testId,
  className = '',
}: AiReasoningDisclosureProps) {
  const panelId = useId();
  const [isOpen, setIsOpen] = useState<boolean>(
    () => defaultOpen ?? status === 'thinking',
  );

  const formattedDuration =
    durationSeconds !== undefined && Number.isFinite(durationSeconds)
      ? formatDurationSeconds(Math.max(0, durationSeconds))
      : null;

  const classes = ['ct-ai-reasoning', `ct-ai-reasoning--${status}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      data-status={status}
      data-open={isOpen ? 'true' : 'false'}
      data-testid={testId}
    >
      <button
        type="button"
        className="ct-ai-reasoning-trigger"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="ct-ai-reasoning-lead">
          <CommonThreadSpark
            compact
            status={status === 'thinking' ? 'active' : 'idle'}
          />
          <span
            className={`ct-ai-reasoning-title ${
              status === 'thinking' ? 'ct-ai-shimmer ct-ai-shimmer--active' : ''
            }`}
          >
            {title}
          </span>
        </span>

        <span className="ct-ai-reasoning-meta">
          {formattedDuration ? (
            <span className="ct-ai-reasoning-duration">
              {formattedDuration}
            </span>
          ) : null}
          {badge ? <span className="ct-ai-badge">{badge}</span> : null}
          <svg
            className="ct-ai-reasoning-chevron"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M4 6L8 10L12 6"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      <div
        id={panelId}
        className="ct-ai-reasoning-body"
        data-open={isOpen ? 'true' : 'false'}
        aria-hidden={!isOpen}
      >
        <div className="ct-ai-reasoning-inner">
          <div className="ct-ai-reasoning-content">
            {summaryText ? (
              <p className="ct-ai-reasoning-summary">{summaryText}</p>
            ) : null}

            {items && items.length > 0 ? (
              <ul className="ct-ai-reasoning-items">
                {items.map((item, idx) => (
                  <li
                    key={`${item.label}-${idx}`}
                    className="ct-ai-reasoning-item"
                    data-status={item.status ?? 'observed'}
                  >
                    <span
                      className="ct-ai-reasoning-item-dot"
                      aria-hidden="true"
                    />
                    <span className="ct-ai-reasoning-item-copy">
                      <span className="ct-ai-reasoning-item-label">
                        {item.label}
                      </span>
                      {item.detail ? (
                        <span className="ct-ai-reasoning-item-detail">
                          {item.detail}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
