'use client';

import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { emitToast } from './brand-toast';

export interface CopyActionButtonProps {
  readonly value: string;
  readonly label?: string;
  readonly copiedLabel?: string;
  readonly toastMessage?: string;
  readonly size?: 'sm' | 'md';
  readonly variant?: 'ghost' | 'secondary';
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly testId?: string;
  readonly disabled?: boolean;
  readonly onCopied?: () => void;
  readonly onCopyError?: (error: unknown) => void;
}

const COPIED_RESET_MS = 2000;

/**
 * Tactile copy action button with spring IconCopy -> IconCheck morph,
 * polite screen-reader announcement, and optional BrandToast confirmation.
 */
export function CopyActionButton({
  value,
  label = 'Copy',
  copiedLabel = 'Copied',
  toastMessage,
  size = 'sm',
  variant = 'secondary',
  className = '',
  ariaLabel,
  testId,
  disabled = false,
  onCopied,
  onCopyError,
}: CopyActionButtonProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const scheduleReset = () => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      setStatus('idle');
    }, COPIED_RESET_MS);
  };

  const handleCopy = async () => {
    if (disabled) return;
    try {
      if (
        typeof navigator === 'undefined' ||
        !navigator.clipboard ||
        typeof navigator.clipboard.writeText !== 'function'
      ) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(value);
      setStatus('copied');
      scheduleReset();
      if (toastMessage) {
        emitToast({ message: toastMessage, tone: 'success' });
      }
      onCopied?.();
    } catch (error) {
      setStatus('error');
      scheduleReset();
      if (toastMessage) {
        emitToast({
          message: 'Clipboard unavailable — copy manually.',
          tone: 'warning',
        });
      }
      onCopyError?.(error);
    }
  };

  const copied = status === 'copied';
  const iconSize = size === 'sm' ? 14 : 16;

  return (
    <button
      type="button"
      className={[
        'ct-copy-btn',
        `ct-copy-btn--${size}`,
        `ct-copy-btn--${variant}`,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-copied={copied ? 'true' : 'false'}
      data-copy-status={status}
      aria-label={ariaLabel ?? (copied ? copiedLabel : label)}
      data-testid={testId}
      disabled={disabled}
      onClick={handleCopy}
    >
      <span className="ct-copy-icon-stack" aria-hidden="true">
        <IconCopy size={iconSize} stroke={1.9} className="ct-copy-icon" />
        <IconCheck size={iconSize} stroke={2.3} className="ct-check-icon" />
      </span>
      <span className="ct-copy-label">{copied ? copiedLabel : label}</span>
      <span className="ct-sr-only" aria-live="polite">
        {status === 'copied'
          ? copiedLabel
          : status === 'error'
            ? 'Clipboard unavailable'
            : ''}
      </span>
    </button>
  );
}
