'use client';

import { useEffect, useState } from 'react';

export interface CommonThreadLoaderProps {
  readonly label?: string;
  readonly sublabel?: string;
  readonly stages?: readonly string[];
  readonly stageIntervalMs?: number;
  readonly compact?: boolean;
  readonly className?: string;
}

/**
 * Brand-unique loading mark derived from the Common Thread emblem:
 * the mint shuttle weaves across the two warm-ivory pillars with spring motion.
 */
export function CommonThreadLoader({
  label = 'Loading',
  sublabel,
  stages,
  stageIntervalMs = 2600,
  compact = false,
  className = '',
}: CommonThreadLoaderProps) {
  const [stageIndex, setStageIndex] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setStageIndex(0);
      setElapsedSeconds(0);
    });
    const secTimer = window.setInterval(() => {
      setElapsedSeconds((s) => s + 1);
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
  }, [stages, stageIntervalMs]);

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
        width={compact ? 26 : 38}
        height={compact ? 26 : 38}
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden="true"
        className="ct-loader-mark"
      >
        <rect width="64" height="64" rx="16" fill="#211426" />
        <rect
          x="0.75"
          y="0.75"
          width="62.5"
          height="62.5"
          rx="15.25"
          stroke="#f5efe6"
          strokeOpacity="0.16"
          strokeWidth="1.5"
        />
        <rect
          className="ct-loader-pillar ct-loader-pillar-left"
          x="17.5"
          y="15.5"
          width="7.5"
          height="33"
          rx="2.6"
          fill="#f5efe6"
        />
        <rect
          className="ct-loader-pillar ct-loader-pillar-right"
          x="39"
          y="15.5"
          width="7.5"
          height="33"
          rx="2.6"
          fill="#f5efe6"
        />
        <path
          d="M 21 28.5 H 30.5 C 35.8 28.5 39 25.3 39 20 H 42 V 44 H 39 C 39 38.7 35.8 35.5 30.5 35.5 H 21 Z"
          fill="#f5efe6"
          fillOpacity="0.35"
        />
        <rect
          className="ct-loader-shuttle"
          x="22"
          y="29.5"
          width="14"
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
