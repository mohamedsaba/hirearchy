'use client';

import { useEffect, useState } from 'react';

export interface CommonThreadLoaderProps {
  readonly label?: string;
  readonly sublabel?: string;
  readonly stages?: readonly string[];
  readonly stageIntervalMs?: number;
  readonly startedAt?: number;
  readonly compact?: boolean;
  readonly className?: string;
}

function computeElapsedSeconds(startedAt?: number): number {
  if (!startedAt || !Number.isFinite(startedAt)) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

/**
 * Animated loading indicator built around Hirearchy's three-node Common Thread
 * motif (without repeating a product logo mark), supporting real elapsed-time
 * continuation when resuming an in-flight background task.
 */
export function CommonThreadLoader({
  label = 'Loading',
  sublabel,
  stages,
  stageIntervalMs = 2600,
  startedAt,
  compact = false,
  className = '',
}: CommonThreadLoaderProps) {
  const [stageIndex, setStageIndex] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    computeElapsedSeconds(startedAt),
  );

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setStageIndex(0);
      setElapsedSeconds(computeElapsedSeconds(startedAt));
    });
    const secTimer = window.setInterval(() => {
      setElapsedSeconds((prev) =>
        startedAt ? computeElapsedSeconds(startedAt) : prev + 1,
      );
    }, 1000);
    let stageTimer: number | undefined;
    if (stages && stages.length > 1) {
      stageTimer = window.setInterval(() => {
        setStageIndex((idx) => Math.min(stages.length - 1, idx + 1));
      }, stageIntervalMs);
    }
    return () => {
      active = false;
      window.clearInterval(secTimer);
      if (stageTimer !== undefined) window.clearInterval(stageTimer);
    };
  }, [stages, stageIntervalMs, startedAt]);

  const activeStage =
    stages && stages.length > 0 ? stages[stageIndex] : undefined;

  return (
    <div
      className={`ct-loader ${compact ? 'ct-loader--compact' : ''}${className ? ` ${className}` : ''}`}
      role="status"
      aria-live="polite"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={compact ? 24 : 34}
        height={compact ? 24 : 34}
        viewBox="0 0 36 36"
        fill="none"
        aria-hidden="true"
        className="ct-loader-mark"
      >
        <rect
          x="1"
          y="1"
          width="34"
          height="34"
          rx="10"
          fill="#211426"
          stroke="rgba(245, 239, 230, 0.16)"
        />
        <line
          x1="8"
          y1="18"
          x2="28"
          y2="18"
          stroke="rgba(245, 239, 230, 0.28)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <circle cx="9.5" cy="18" r="2.2" fill="#f5efe6" />
        <circle cx="26.5" cy="18" r="2.2" fill="#f5efe6" />
        <rect
          className="ct-loader-shuttle"
          x="12"
          y="15.5"
          width="8"
          height="5"
          rx="2.5"
          fill="#8ee3b8"
        />
      </svg>

      <div className="ct-loader-copy">
        <div className="ct-loader-headline">
          <strong>{activeStage ?? label}</strong>
          {!compact && elapsedSeconds >= 3 ? (
            <span className="ct-loader-elapsed">{elapsedSeconds}s</span>
          ) : null}
        </div>
        {sublabel ? <p className="ct-loader-sublabel">{sublabel}</p> : null}
        {!compact && stages && stages.length > 1 ? (
          <div className="ct-loader-thread-track" aria-hidden="true">
            <div
              className="ct-loader-thread-fill"
              style={{
                width: `${Math.round(((stageIndex + 1) / stages.length) * 100)}%`,
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
