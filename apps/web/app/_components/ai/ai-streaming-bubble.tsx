'use client';

import { useEffect, useState, type ReactNode } from 'react';
import './ai-primitives.css';
import {
  HirearchyAiThinking,
  type HirearchyAiThinkingProps,
} from './hirearchy-ai-thinking';

export type AiStreamingBubbleStatus =
  'thinking' | 'streaming' | 'complete' | 'failed';

export interface AiStreamingBubbleProps {
  readonly roleLabel: string;
  readonly timestamp?: string;
  readonly status: AiStreamingBubbleStatus;
  readonly content?: string;
  readonly thinkingProps?: Omit<HirearchyAiThinkingProps, 'variant' | 'status'>;
  readonly animateReveal?: boolean;
  readonly disclosure?: ReactNode;
  readonly renderContent: (
    visibleText: string,
    isStreaming: boolean,
  ) => ReactNode;
  readonly errorMessage?: string | null;
  readonly testId?: string;
  readonly className?: string;
}

const MAX_REVEAL_DURATION_MS = 900;

function prefersReducedMotion(): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function snapToWordBoundary(text: string, rawCount: number): number {
  if (rawCount >= text.length) return text.length;
  if (rawCount <= 0) return 0;
  const nextSpace = text.indexOf(' ', rawCount);
  if (nextSpace === -1) return text.length;
  return nextSpace + 1;
}

/**
 * Assistant message bubble uniting inline thinking state, capped <=900ms
 * progressive reveal for completed responses, optional context disclosure,
 * and neutral error reporting.
 */
export function AiStreamingBubble({
  roleLabel,
  timestamp,
  status,
  content = '',
  thinkingProps,
  animateReveal = false,
  disclosure,
  renderContent,
  errorMessage,
  testId,
  className = '',
}: AiStreamingBubbleProps) {
  const shouldReveal =
    status === 'complete' && animateReveal && content.length > 0;

  const [revealState, setRevealState] = useState<{
    target: string;
    visibleCount: number;
    done: boolean;
  }>(() => ({
    target: content,
    visibleCount: shouldReveal ? 0 : content.length,
    done: !shouldReveal,
  }));

  useEffect(() => {
    if (!shouldReveal) return;

    if (
      prefersReducedMotion() ||
      typeof window === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function'
    ) {
      let active = true;
      queueMicrotask(() => {
        if (!active) return;
        setRevealState({
          target: content,
          visibleCount: content.length,
          done: true,
        });
      });
      return () => {
        active = false;
      };
    }

    const wordEstimate = Math.max(1, content.trim().split(/\s+/).length);
    const totalDurationMs = Math.min(
      MAX_REVEAL_DURATION_MS,
      Math.max(180, wordEstimate * 7),
    );
    let frameId = 0;
    let startTime: number | null = null;

    const tick = (now: number) => {
      if (startTime === null) {
        // Seed 16ms so the very first frame renders the opening word instead of an empty flash.
        startTime = now - 16;
      }
      const elapsed = Math.max(16, now - startTime);
      const progress = Math.min(1, elapsed / totalDurationMs);
      if (progress >= 1) {
        setRevealState({
          target: content,
          visibleCount: content.length,
          done: true,
        });
        return;
      }
      const nextCount = snapToWordBoundary(
        content,
        Math.ceil(content.length * progress),
      );
      setRevealState({
        target: content,
        visibleCount: nextCount,
        done: nextCount >= content.length,
      });
      if (nextCount < content.length) {
        frameId = window.requestAnimationFrame(tick);
      }
    };

    frameId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [shouldReveal, content]);

  const isClient = typeof window !== 'undefined';
  const revealActive =
    shouldReveal &&
    isClient &&
    (revealState.target !== content || !revealState.done);

  const visibleText =
    status === 'streaming'
      ? content
      : revealActive
        ? revealState.target === content
          ? content.slice(0, revealState.visibleCount)
          : ''
        : content;

  const isStreamingVisual = status === 'streaming' || revealActive;
  const classes = ['ct-ai-bubble', `ct-ai-bubble--${status}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} data-status={status} data-testid={testId}>
      <div className="ct-ai-bubble-header">
        <strong className="ct-ai-bubble-role">{roleLabel}</strong>
        {timestamp ? (
          <time className="ct-ai-bubble-time">{timestamp}</time>
        ) : null}
      </div>

      {disclosure ? (
        <div className="ct-ai-bubble-disclosure">{disclosure}</div>
      ) : null}

      {status === 'thinking' ? (
        <HirearchyAiThinking
          variant="inline"
          status="active"
          headline={thinkingProps?.headline ?? 'Thinking…'}
          {...thinkingProps}
        />
      ) : status === 'failed' ? (
        <p className="ct-ai-bubble-error" role="alert">
          {errorMessage || 'Failed to generate response.'}
        </p>
      ) : (
        <div className="ct-ai-bubble-body">
          {renderContent(visibleText, isStreamingVisual)}
          {isStreamingVisual ? (
            <span className="ct-ai-caret" aria-hidden="true" />
          ) : null}
        </div>
      )}
    </div>
  );
}
