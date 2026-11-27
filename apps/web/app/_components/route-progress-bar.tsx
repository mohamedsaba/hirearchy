'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

const SHOW_DELAY_MS = 140;
const COMPLETE_HOLD_MS = 220;
const FAILSAFE_TIMEOUT_MS = 8000;

function isModifiedClick(event: MouseEvent): boolean {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

function isInternalNavigationTarget(anchor: HTMLAnchorElement): boolean {
  if (anchor.hasAttribute('download')) return false;
  if (anchor.hasAttribute('data-no-progress')) return false;
  const target = anchor.getAttribute('target');
  if (target && target !== '_self') return false;
  const rawHref = anchor.getAttribute('href');
  if (!rawHref || rawHref.startsWith('#')) return false;
  if (/^(?:mailto|tel|javascript):/i.test(rawHref)) return false;

  try {
    const destination = new URL(anchor.href, window.location.href);
    if (destination.origin !== window.location.origin) return false;
    const current = new URL(window.location.href);
    const sameRoute =
      destination.pathname === current.pathname &&
      destination.search === current.search;
    if (sameRoute) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Top-edge 2.5px brand-mint progress bar for Next.js App Router transitions.
 * Delays visibility by 140ms so instant prefetched navigations never flash.
 */
export function RouteProgressBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = `${pathname ?? ''}::${searchParams?.toString() ?? ''}`;

  const [visible, setVisible] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [progress, setProgress] = useState(0);

  const pendingRef = useRef(false);
  const delayTimerRef = useRef<number | null>(null);
  const crawlTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const failsafeTimerRef = useRef<number | null>(null);
  const lastRouteRef = useRef(routeKey);

  const clearAllTimers = () => {
    if (delayTimerRef.current !== null) {
      window.clearTimeout(delayTimerRef.current);
      delayTimerRef.current = null;
    }
    if (crawlTimerRef.current !== null) {
      window.clearInterval(crawlTimerRef.current);
      crawlTimerRef.current = null;
    }
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (failsafeTimerRef.current !== null) {
      window.clearTimeout(failsafeTimerRef.current);
      failsafeTimerRef.current = null;
    }
  };

  useEffect(() => {
    const startNavigation = () => {
      if (pendingRef.current) return;
      clearAllTimers();
      pendingRef.current = true;
      setCompleting(false);

      delayTimerRef.current = window.setTimeout(() => {
        delayTimerRef.current = null;
        if (!pendingRef.current) return;
        setVisible(true);
        setProgress(0.12);

        crawlTimerRef.current = window.setInterval(() => {
          setProgress((prev) => {
            if (prev >= 0.92) return prev;
            const step = (0.94 - prev) * 0.24;
            return Math.min(
              0.94,
              Number((prev + Math.max(0.02, step)).toFixed(3)),
            );
          });
        }, 180);
      }, SHOW_DELAY_MS);

      failsafeTimerRef.current = window.setTimeout(() => {
        pendingRef.current = false;
        clearAllTimers();
        setVisible(false);
        setCompleting(false);
        setProgress(0);
      }, FAILSAFE_TIMEOUT_MS);
    };

    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || isModifiedClick(event)) return;
      const target = event.target as Element | null;
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      if (!isInternalNavigationTarget(anchor)) return;
      startNavigation();
    };

    const handlePopState = () => {
      startNavigation();
    };

    const handlePageHide = () => {
      pendingRef.current = false;
      clearAllTimers();
      setVisible(false);
      setCompleting(false);
      setProgress(0);
    };

    document.addEventListener('click', handleClick, true);
    window.addEventListener('popstate', handlePopState);
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      document.removeEventListener('click', handleClick, true);
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('pagehide', handlePageHide);
      clearAllTimers();
    };
  }, []);

  useEffect(() => {
    if (lastRouteRef.current === routeKey) return;
    lastRouteRef.current = routeKey;

    if (!pendingRef.current && !visible) return;
    pendingRef.current = false;

    if (delayTimerRef.current !== null) {
      window.clearTimeout(delayTimerRef.current);
      delayTimerRef.current = null;
    }
    if (crawlTimerRef.current !== null) {
      window.clearInterval(crawlTimerRef.current);
      crawlTimerRef.current = null;
    }
    if (failsafeTimerRef.current !== null) {
      window.clearTimeout(failsafeTimerRef.current);
      failsafeTimerRef.current = null;
    }

    if (!visible) {
      return;
    }

    queueMicrotask(() => {
      setCompleting(true);
      setProgress(1);
    });

    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setVisible(false);
      setCompleting(false);
      setProgress(0);
    }, COMPLETE_HOLD_MS);
  }, [routeKey, visible]);

  if (!visible) return null;

  return (
    <div
      className="ct-route-progress"
      data-completing={completing ? 'true' : 'false'}
      data-testid="route-progress-bar"
      aria-hidden="true"
    >
      <div
        className="ct-route-progress-bar"
        style={{
          transform: `scaleX(${progress})`,
          opacity: completing ? 0 : 1,
        }}
      />
    </div>
  );
}
