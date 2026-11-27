'use client';

import {
  normalizeRoutePath,
  sanitizeTelemetryEvent,
  type ProductFeedbackInput,
  type SanitizedTelemetryEvent,
  type TelemetryAttribution,
  type TelemetryEventInput,
} from './catalog';

const ANON_KEY = 'hirearchy:anon:v1';
const ATTR_KEY = 'hirearchy:attr:v1';

let eventQueue: SanitizedTelemetryEvent[] = [];
let flushTimer: number | null = null;

function setCookieValue(name: string, value: string, maxAgeSeconds: number) {
  if (typeof document === 'undefined') return;
  try {
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`;
  } catch {
    // Ignore cookie errors in restricted contexts
  }
}

export function getOrCreateAnonymousId(): string {
  if (typeof window === 'undefined') return '';
  try {
    const existing = window.localStorage.getItem(ANON_KEY);
    if (existing && existing.length >= 8 && existing.length <= 80) {
      return existing;
    }
    const generated =
      typeof window.crypto?.randomUUID === 'function'
        ? `anon_${window.crypto.randomUUID().replace(/-/g, '')}`
        : `anon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    window.localStorage.setItem(ANON_KEY, generated);
    setCookieValue('hirearchy-anon', generated, 31536000);
    return generated;
  } catch {
    return '';
  }
}

export function captureClientAttribution(): TelemetryAttribution | null {
  if (typeof window === 'undefined') return null;
  const anonymousId = getOrCreateAnonymousId();
  if (!anonymousId) return null;

  try {
    const url = new URL(window.location.href);
    const params = url.searchParams;
    const utmSource = params.get('utm_source')?.trim().slice(0, 160) ?? '';
    const utmMedium = params.get('utm_medium')?.trim().slice(0, 160) ?? '';
    const utmCampaign = params.get('utm_campaign')?.trim().slice(0, 160) ?? '';
    const utmTerm = params.get('utm_term')?.trim().slice(0, 160) ?? '';
    const utmContent = params.get('utm_content')?.trim().slice(0, 160) ?? '';

    let referrerDomain = '';
    if (document.referrer) {
      try {
        const refUrl = new URL(document.referrer);
        if (refUrl.host && refUrl.host !== window.location.host) {
          referrerDomain = refUrl.hostname.slice(0, 160);
        }
      } catch {
        // Ignore invalid referrer
      }
    }

    const landingPath = normalizeRoutePath(url.pathname);
    const existingRaw = window.localStorage.getItem(ATTR_KEY);
    let stored: TelemetryAttribution | null = null;
    if (existingRaw) {
      try {
        stored = JSON.parse(existingRaw) as TelemetryAttribution;
      } catch {
        stored = null;
      }
    }

    const next: TelemetryAttribution = stored
      ? {
          anonymousId,
          utmSource: utmSource || stored.utmSource,
          utmMedium: utmMedium || stored.utmMedium,
          utmCampaign: utmCampaign || stored.utmCampaign,
          utmTerm: utmTerm || stored.utmTerm,
          utmContent: utmContent || stored.utmContent,
          referrerDomain: referrerDomain || stored.referrerDomain,
          landingPath: stored.landingPath || landingPath,
        }
      : {
          anonymousId,
          ...(utmSource ? { utmSource } : {}),
          ...(utmMedium ? { utmMedium } : {}),
          ...(utmCampaign ? { utmCampaign } : {}),
          ...(utmTerm ? { utmTerm } : {}),
          ...(utmContent ? { utmContent } : {}),
          ...(referrerDomain ? { referrerDomain } : {}),
          landingPath,
        };

    window.localStorage.setItem(ATTR_KEY, JSON.stringify(next));
    setCookieValue('hirearchy-attr', JSON.stringify(next), 2592000);
    return next;
  } catch {
    return { anonymousId };
  }
}

export function flushClientTelemetry(): void {
  if (typeof window === 'undefined' || eventQueue.length === 0) return;
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }

  const batch = eventQueue.slice(0, 25);
  eventQueue = eventQueue.slice(25);
  const body = JSON.stringify({ events: batch });

  try {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function'
    ) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon('/api/telemetry', blob)) {
        return;
      }
    }
    void fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => null);
  } catch {
    // Telemetry is strictly non-blocking.
  }
}

export function trackClientEvent(event: TelemetryEventInput): void {
  if (typeof window === 'undefined') return;
  const anonymousId = event.anonymousId ?? getOrCreateAnonymousId();
  const route = event.route ?? normalizeRoutePath(window.location.pathname);
  const sanitized = sanitizeTelemetryEvent({
    ...event,
    anonymousId,
    route,
  });
  if (!sanitized) return;

  eventQueue.push(sanitized);
  if (eventQueue.length >= 10) {
    flushClientTelemetry();
    return;
  }
  if (flushTimer === null) {
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      flushClientTelemetry();
    }, 3500);
  }
}

export async function submitProductFeedback(
  input: ProductFeedbackInput,
): Promise<{ ok: boolean; id?: string }> {
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        ...input,
        context: {
          ...(input.context ?? {}),
          route:
            typeof window !== 'undefined'
              ? normalizeRoutePath(window.location.pathname)
              : '',
        },
      }),
    });
    if (!response.ok) return { ok: false };
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      id?: string;
    } | null;
    return { ok: true, ...(data?.id ? { id: data.id } : {}) };
  } catch {
    return { ok: false };
  }
}
