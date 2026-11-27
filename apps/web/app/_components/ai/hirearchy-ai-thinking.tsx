'use client';

import { useEffect, useState } from 'react';
import './ai-primitives.css';
import { CommonThreadSpark } from './common-thread-spark';

export interface AiThinkingStep {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

export type HirearchyAiThinkingVariant = 'studio' | 'inline' | 'advisory';
export type HirearchyAiThinkingStatus = 'active' | 'completing' | 'error';

export interface HirearchyAiThinkingProps {
  readonly variant?: HirearchyAiThinkingVariant;
  readonly status: HirearchyAiThinkingStatus;
  readonly headline: string;
  readonly sublabel?: string;
  readonly steps?: readonly AiThinkingStep[];
  readonly activeStepIndex?: number;
  readonly stepIntervalMs?: number;
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

function resolveStepStatus(
  index: number,
  activeIndex: number,
  overallStatus: HirearchyAiThinkingStatus,
): 'completed' | 'active' | 'pending' | 'error' {
  if (overallStatus === 'completing') return 'completed';
  if (overallStatus === 'error') {
    if (index < activeIndex) return 'completed';
    if (index === activeIndex) return 'error';
    return 'pending';
  }
  if (index < activeIndex) return 'completed';
  if (index === activeIndex) return 'active';
  return 'pending';
}

/**
 * Stepped AI thinking indicator supporting Studio generation, inline chat,
 * and clearly labeled Advisory synthesis surfaces.
 */
export function HirearchyAiThinking({
  variant = 'inline',
  status,
  headline,
  sublabel,
  steps,
  activeStepIndex,
  stepIntervalMs = 2400,
  startedAt,
  showTimer = true,
  badge,
  testId,
  className = '',
}: HirearchyAiThinkingProps) {
  const [autoStepState, setAutoStepState] = useState<{
    key: string;
    index: number;
  }>({
    key: `${steps?.map((s) => s.id).join('|') ?? ''}:${status}`,
    index: 0,
  });
  const [elapsedState, setElapsedState] = useState<{
    startedAt: number | undefined;
    seconds: number;
  }>(() => ({
    startedAt,
    seconds: computeElapsedSeconds(startedAt),
  }));

  const stepKey = `${steps?.map((s) => s.id).join('|') ?? ''}:${status}`;
  const currentAutoIndex =
    autoStepState.key === stepKey ? autoStepState.index : 0;

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

  useEffect(() => {
    if (
      status !== 'active' ||
      activeStepIndex !== undefined ||
      !steps ||
      steps.length <= 1
    ) {
      return;
    }
    const maxIndex = steps.length - 1;
    const stepTimer = window.setInterval(() => {
      setAutoStepState((prev) => {
        const base = prev.key === stepKey ? prev.index : 0;
        return {
          key: stepKey,
          index: Math.min(maxIndex, base + 1),
        };
      });
    }, stepIntervalMs);
    return () => window.clearInterval(stepTimer);
  }, [status, activeStepIndex, steps, stepIntervalMs, stepKey]);

  const elapsedSeconds =
    elapsedState.startedAt === startedAt
      ? elapsedState.seconds
      : computeElapsedSeconds(startedAt);

  const resolvedStepIndex =
    steps && steps.length > 0
      ? Math.max(
          0,
          Math.min(
            steps.length - 1,
            activeStepIndex !== undefined ? activeStepIndex : currentAutoIndex,
          ),
        )
      : 0;

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
          <div className="ct-ai-thinking-meta">
            <span className="ct-ai-timer" data-testid="ct-ai-timer">
              {elapsedSeconds}s
            </span>
          </div>
        ) : null}
      </div>

      {steps && steps.length > 0 ? (
        <ol className="ct-ai-steps">
          {steps.map((step, index) => {
            const stepStatus = resolveStepStatus(
              index,
              resolvedStepIndex,
              status,
            );
            return (
              <li
                key={step.id}
                className={`ct-ai-step ct-ai-step--${stepStatus}`}
                data-step-status={stepStatus}
              >
                <span className="ct-ai-step-marker" aria-hidden="true">
                  {stepStatus === 'completed' ? (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 12 12"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M2.5 6.2L5 8.7L9.5 3.6"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : stepStatus === 'error' ? (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 12 12"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M3.2 3.2L8.8 8.8M8.8 3.2L3.2 8.8"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : (
                    <span className="ct-ai-step-dot" />
                  )}
                </span>
                <span className="ct-ai-step-copy">
                  <span
                    className={`ct-ai-step-label ${
                      stepStatus === 'active'
                        ? 'ct-ai-shimmer ct-ai-shimmer--active'
                        : ''
                    }`}
                  >
                    {step.label}
                  </span>
                  {step.detail ? (
                    <span className="ct-ai-step-detail">{step.detail}</span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
