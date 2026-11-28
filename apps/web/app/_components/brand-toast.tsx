'use client';

import { useEffect, useRef, useState } from 'react';
import {
  IconAlertTriangle,
  IconCheck,
  IconInfoCircle,
  IconX,
} from '@tabler/icons-react';

export type BrandToastTone = 'success' | 'error' | 'info' | 'warning';

export interface EmitToastInput {
  readonly message: string;
  readonly tone?: BrandToastTone;
  readonly description?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly durationMs?: number;
}

interface ToastRecord {
  readonly id: string;
  readonly message: string;
  readonly tone: BrandToastTone;
  readonly description?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly durationMs: number;
  readonly exiting: boolean;
}

const MAX_TOASTS = 3;
const DEFAULT_DURATION_MS = 3600;
const EXIT_DURATION_MS = 160;

type Listener = (toasts: readonly ToastRecord[]) => void;

let counter = 0;
let currentToasts: ToastRecord[] = [];
const listeners = new Set<Listener>();

function notify() {
  const snapshot = [...currentToasts];
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function dismissToast(id: string): void {
  const target = currentToasts.find((item) => item.id === id);
  if (!target || target.exiting) return;

  currentToasts = currentToasts.map((item) =>
    item.id === id ? { ...item, exiting: true } : item,
  );
  notify();

  window.setTimeout(() => {
    currentToasts = currentToasts.filter((item) => item.id !== id);
    notify();
  }, EXIT_DURATION_MS);
}

export function clearToasts(): void {
  currentToasts = [];
  notify();
}

export function emitToast({
  message,
  tone = 'info',
  description,
  actionLabel,
  onAction,
  durationMs = DEFAULT_DURATION_MS,
}: EmitToastInput): string {
  counter += 1;
  const id = `ct-toast-${counter}`;
  const next: ToastRecord = {
    id,
    message,
    tone,
    description,
    actionLabel,
    onAction,
    durationMs,
    exiting: false,
  };
  currentToasts = [...currentToasts, next].slice(-MAX_TOASTS);
  notify();
  return id;
}

function ToastItem({ toast }: { readonly toast: ToastRecord }) {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef<number>(toast.durationMs);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (toast.exiting) return;
    if (!Number.isFinite(toast.durationMs) || toast.durationMs <= 0) return;
    if (paused) return;

    const remaining = Math.max(0, remainingRef.current);
    startedAtRef.current = Date.now();
    const timer = window.setTimeout(() => {
      dismissToast(toast.id);
    }, remaining);

    return () => {
      window.clearTimeout(timer);
      if (startedAtRef.current !== null) {
        const elapsed = Date.now() - startedAtRef.current;
        remainingRef.current = Math.max(0, remainingRef.current - elapsed);
        startedAtRef.current = null;
      }
    };
  }, [toast.id, toast.durationMs, toast.exiting, paused]);

  const pauseTimer = () => setPaused(true);
  const resumeTimer = () => setPaused(false);

  return (
    <div
      className={`ct-toast ct-toast--${toast.tone}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
      data-exiting={toast.exiting ? 'true' : 'false'}
      data-toast-id={toast.id}
      onMouseEnter={pauseTimer}
      onMouseLeave={resumeTimer}
      onFocus={pauseTimer}
      onBlur={resumeTimer}
    >
      <span className="ct-toast-icon" aria-hidden="true">
        {toast.tone === 'success' ? (
          <IconCheck size={16} stroke={2.4} />
        ) : toast.tone === 'error' || toast.tone === 'warning' ? (
          <IconAlertTriangle size={16} stroke={2.2} />
        ) : (
          <IconInfoCircle size={16} stroke={2.2} />
        )}
      </span>
      <div className="ct-toast-body">
        <span className="ct-toast-message">{toast.message}</span>
        {toast.description ? (
          <span className="ct-toast-description">{toast.description}</span>
        ) : null}
      </div>
      <div className="ct-toast-actions">
        {toast.actionLabel && toast.onAction ? (
          <button
            type="button"
            className="ct-toast-action"
            onClick={() => {
              toast.onAction?.();
              dismissToast(toast.id);
            }}
          >
            {toast.actionLabel}
          </button>
        ) : null}
        <button
          type="button"
          className="ct-toast-close"
          onClick={() => dismissToast(toast.id)}
          aria-label="Dismiss notification"
        >
          <IconX size={14} stroke={2} />
        </button>
      </div>
    </div>
  );
}

/**
 * Global stacked toast viewport mounted once in RootLayout.
 * Keeps up to 3 solid-surface Common Thread toasts anchored bottom-right.
 */
export function BrandToastViewport() {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>(
    () => currentToasts,
  );

  useEffect(() => {
    const sync: Listener = (next) => setToasts(next);
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  return (
    <section
      className="ct-toast-viewport"
      aria-label="Notifications"
      data-testid="brand-toast-viewport"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </section>
  );
}
