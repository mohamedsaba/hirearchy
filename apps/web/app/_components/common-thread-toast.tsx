'use client';

import { useEffect } from 'react';
import {
  IconAlertTriangle,
  IconCheck,
  IconInfoCircle,
  IconX,
} from '@tabler/icons-react';

export type CommonThreadToastTone = 'success' | 'error' | 'info' | 'warning';

export interface CommonThreadToastProps {
  readonly message: string | null;
  readonly tone?: CommonThreadToastTone;
  readonly onDismiss: () => void;
  readonly durationMs?: number;
}

/**
 * Tactile Common Thread notification toast — solid surfaces, zero glassmorphism.
 */
export function CommonThreadToast({
  message,
  tone = 'success',
  onDismiss,
  durationMs = 3600,
}: CommonThreadToastProps) {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onDismiss, durationMs);
    return () => window.clearTimeout(timer);
  }, [message, durationMs, onDismiss]);

  if (!message) return null;

  return (
    <div
      className={`ct-toast ct-toast--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      <span className="ct-toast-icon" aria-hidden="true">
        {tone === 'success' ? (
          <IconCheck size={16} stroke={2.4} />
        ) : tone === 'error' || tone === 'warning' ? (
          <IconAlertTriangle size={16} stroke={2.2} />
        ) : (
          <IconInfoCircle size={16} stroke={2.2} />
        )}
      </span>
      <span className="ct-toast-message">{message}</span>
      <button
        type="button"
        className="ct-toast-close"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        <IconX size={14} stroke={2} />
      </button>
    </div>
  );
}
