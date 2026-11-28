'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { normalizeRoutePath } from '../../src/telemetry/catalog';
import {
  captureClientAttribution,
  flushClientTelemetry,
  trackClientEvent,
} from '../../src/telemetry/client';

function resolveViewportBucket(): 'mobile' | 'tablet' | 'desktop' {
  if (typeof window === 'undefined') return 'desktop';
  const width = window.innerWidth;
  if (width <= 700) return 'mobile';
  if (width <= 1024) return 'tablet';
  return 'desktop';
}

function resolveActorType(
  pathname: string,
): 'candidate' | 'team_member' | 'visitor' {
  if (
    pathname.startsWith('/candidate') ||
    pathname.startsWith('/r26/candidate')
  ) {
    return 'candidate';
  }
  if (
    pathname.startsWith('/r23/organizations') ||
    pathname.startsWith('/r23/account') ||
    pathname.startsWith('/r27/') ||
    pathname.startsWith('/evaluator')
  ) {
    return 'team_member';
  }
  return 'visitor';
}

/**
 * Zero-DOM global telemetry listener tracking normalized route views, marketing attribution,
 * theme/viewport distribution, and unhandled client runtime errors.
 */
export function TelemetryTracker({ enabled = true }: { enabled?: boolean }) {
  const pathname = usePathname() ?? '/';
  const lastTrackedPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const attribution = captureClientAttribution();
    const normalized = normalizeRoutePath(pathname);
    if (lastTrackedPathRef.current === normalized) return;
    lastTrackedPathRef.current = normalized;

    const theme =
      document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'dark'
        : 'light';

    trackClientEvent({
      eventName: 'ux.page_view',
      category:
        resolveActorType(normalized) === 'visitor'
          ? 'acquisition'
          : 'performance',
      actorType: resolveActorType(normalized),
      route: normalized,
      status: 'ok',
      properties: {
        theme,
        viewport: resolveViewportBucket(),
        hasUtm: Boolean(attribution?.utmSource),
      },
      attribution,
    });
  }, [enabled, pathname]);

  useEffect(() => {
    if (!enabled) return;
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushClientTelemetry();
      }
    };
    const handlePageHide = () => {
      flushClientTelemetry();
    };
    const handleError = (event: ErrorEvent) => {
      trackClientEvent({
        eventName: 'error.client_runtime',
        category: 'error',
        actorType: resolveActorType(window.location.pathname),
        route: normalizeRoutePath(window.location.pathname),
        status: 'error',
        properties: {
          kind: 'window_error',
          message: String(event.message ?? 'Unexpected error').slice(0, 120),
        },
      });
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason =
        event.reason instanceof Error
          ? event.reason.name
          : typeof event.reason === 'string'
            ? event.reason
            : 'unhandled_rejection';
      trackClientEvent({
        eventName: 'error.client_runtime',
        category: 'error',
        actorType: resolveActorType(window.location.pathname),
        route: normalizeRoutePath(window.location.pathname),
        status: 'error',
        properties: {
          kind: 'unhandled_rejection',
          message: String(reason).slice(0, 120),
        },
      });
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
      flushClientTelemetry();
    };
  }, [enabled]);

  return null;
}
