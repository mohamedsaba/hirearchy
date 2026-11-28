import { NextResponse } from 'next/server';

import { enforceRateLimit } from '../../../src/security/rate-limit';
import type { TelemetryEventInput } from '../../../src/telemetry/catalog';
import {
  readAttributionCookie,
  recordServerTelemetryBatch,
} from '../../../src/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

function isSameOriginBrowserRequest(request: Request): boolean {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const host = request.headers.get('host') ?? new URL(request.url).host;
  try {
    const parsed = new URL(origin);
    return (
      parsed.origin === origin &&
      parsed.host === host &&
      ['http:', 'https:'].includes(parsed.protocol)
    );
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginBrowserRequest(request)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'Invalid origin.' } },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const limited = enforceRateLimit(request, 'staging', {
    maxRequests: 240,
    windowMs: 60_000,
    keyPrefix: 'telemetry',
  });
  if (limited) return limited;

  const rawText = await request.text().catch(() => '');
  if (!rawText || rawText.length > 32768) {
    return NextResponse.json(
      {
        error: { code: 'INVALID_BODY', message: 'Invalid telemetry payload.' },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'Malformed JSON.' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const body = parsed as { events?: unknown[] };
  if (!Array.isArray(body?.events)) {
    return NextResponse.json(
      { error: { code: 'INVALID_BODY', message: 'Expected events array.' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const cookieAttr = readAttributionCookie(request);
  const enriched: TelemetryEventInput[] = body.events
    .slice(0, 25)
    .filter((item): item is TelemetryEventInput =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item)),
    )
    .map((item) => ({
      ...item,
      anonymousId: item.anonymousId ?? cookieAttr?.anonymousId,
      attribution: item.attribution ?? cookieAttr ?? undefined,
    }));

  const accepted = await recordServerTelemetryBatch(enriched);
  return NextResponse.json(
    { ok: true, accepted },
    { status: 202, headers: { 'Cache-Control': 'no-store' } },
  );
}
