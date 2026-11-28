'use client';

import { useEffect, useState } from 'react';
import './ai-primitives.css';
import { CommonThreadSpark } from './common-thread-spark';

export type HirearchyAiThinkingVariant = 'studio' | 'inline' | 'advisory';
export type HirearchyAiThinkingStatus = 'active' | 'completing' | 'error';

export interface HirearchyAiThinkingProps {
  readonly variant?: HirearchyAiThinkingVariant;
  readonly status: HirearchyAiThinkingStatus;
  readonly headline: string;
  readonly sublabel?: string;
  readonly startedAt?: number;
  readonly showTimer?: boolean;
  readonly badge?: string;
  readonly testId?: string;
  readonly className?: string;
}

function computeElapsedSeconds(startedAt?: number): number {
  if (startedAt === undefined || !Number.isFinite(startedAt)) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

export function HirearchyAiThinking({
  variant = 'inline',
  status,
  headline,
  sublabel,
  startedAt,
  showTimer = true,
  badge,
  testId,
  className = '',
}: HirearchyAiThinkingProps) {
  const [elapsedState, setElapsedState] = useState<{
    startedAt: number | undefined;
    seconds: number;
  }>(() => ({
    startedAt,
    seconds: computeElapsedSeconds(startedAt),
  }));

  useEffect(() => {
    if (status !== 'active' || !showTimer) return;
    const secTimer = window.setInterval(() => {
      setElapsedState((prev) => ({
        startedAt,
        seconds:
          startedAt !== undefined
            ? computeElapsedSeconds(startedAt)
            : prev.startedAt === startedAt
              ? prev.seconds + 1
              : 1,
      }));
    }, 1000);
    return () => window.clearInterval(secTimer);
  }, [status, showTimer, startedAt]);

  const elapsedSeconds =
    elapsedState.startedAt === startedAt
      ? elapsedState.seconds
      : computeElapsedSeconds(startedAt);

  const resolvedBadge =
    badge !== undefined
      ? badge
      : variant === 'advisory'
        ? 'AI advisory'
        : undefined;

  const showElapsed =
    showTimer && (elapsedSeconds >= 1 || startedAt !== undefined);

  const classes = ['ct-ai-thinking', `ct-ai-thinking--${variant}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      data-variant={variant}
      data-status={status}
      data-testid={testId}
      role={status === 'error' ? 'alert' : 'status'}
      aria-live={status === 'error' ? 'assertive' : 'polite'}
    >
      <div className="ct-ai-thinking-header">
        {status === 'error' ? (
          <span className="ct-ai-error-icon" aria-hidden="true">
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M8 4.75V8.75M8 11.25H8.01"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </span>
        ) : (
          <CommonThreadSpark
            compact={variant === 'inline'}
            status={status === 'completing' ? 'completing' : 'active'}
          />
        )}

        <div className="ct-ai-thinking-heading">
          <div className="ct-ai-thinking-title-row">
            <span
              className={`ct-ai-thinking-headline ${
                status === 'active'
                  ? 'ct-ai-shimmer ct-ai-shimmer--active'
                  : 'ct-ai-headline-settled'
              }`}
            >
              {headline}
            </span>
            {resolvedBadge ? (
              <span
                className={`ct-ai-badge ${
                  variant === 'advisory' ? 'ct-ai-badge--advisory' : ''
                }`}
              >
                {resolvedBadge}
              </span>
            ) : null}
          </div>
          {sublabel ? (
            <p className="ct-ai-thinking-sublabel">{sublabel}</p>
          ) : null}
        </div>

        {showElapsed ? (
          <div className="ct-ai-thinking-meta" aria-hidden="true">
            <span className="ct-ai-timer" data-testid="ct-ai-timer">
              {elapsedSeconds}s
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
