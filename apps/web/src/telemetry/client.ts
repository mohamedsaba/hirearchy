'use client';

import {
  normalizeRoutePath,
  sanitizeTelemetryEvent,
  type ProductFeedbackInput,
  type SanitizedTelemetryEvent,
  type TelemetryAttribution,
  type TelemetryEventInput,
} from './catalog';

const ANON_COOKIE = 'hirearchy-anon';
const ATTR_COOKIE = 'hirearchy-attr';

let memoryAnonId: string | null = null;
let memoryAttribution: TelemetryAttribution | null = null;
let eventQueue: SanitizedTelemetryEvent[] = [];
let flushTimer: number | null = null;

function getCookieValue(name: string): string | null {
  if (typeof document === 'undefined' || !document.cookie) return null;
  try {
    const prefix = `${name}=`;
    for (const part of document.cookie.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith(prefix)) {
        return decodeURIComponent(trimmed.slice(prefix.length));
      }
    }
  } catch {
    // Ignore cookie decode errors in restricted contexts
  }
  return null;
}

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
    const existing = getCookieValue(ANON_COOKIE) ?? memoryAnonId;
    if (existing && existing.length >= 8 && existing.length <= 80) {
      memoryAnonId = existing;
      return existing;
    }
    const generated =
      typeof window.crypto?.randomUUID === 'function'
        ? `anon_${window.crypto.randomUUID().replace(/-/g, '')}`
        : `anon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    memoryAnonId = generated;
    setCookieValue(ANON_COOKIE, generated, 31536000);
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
    const existingRaw = getCookieValue(ATTR_COOKIE);
    let stored: TelemetryAttribution | null = memoryAttribution;
    if (existingRaw) {
      try {
        stored = JSON.parse(existingRaw) as TelemetryAttribution;
      } catch {
        stored = memoryAttribution;
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

    memoryAttribution = next;
    setCookieValue(ATTR_COOKIE, JSON.stringify(next), 2592000);
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
