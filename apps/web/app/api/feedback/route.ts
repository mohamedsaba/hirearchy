import { NextResponse } from 'next/server';

import { enforceRateLimit } from '../../../src/security/rate-limit';
import { sanitizeFeedbackInput } from '../../../src/telemetry/catalog';
import { recordProductFeedback } from '../../../src/telemetry/server';

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
    maxRequests: 40,
    windowMs: 60_000,
    keyPrefix: 'feedback',
  });
  if (limited) return limited;

  const rawText = await request.text().catch(() => '');
  if (!rawText || rawText.length > 8192) {
    return NextResponse.json(
      { error: { code: 'INVALID_BODY', message: 'Invalid feedback payload.' } },
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

  const cleaned = sanitizeFeedbackInput(parsed);
  if (!cleaned) {
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_FEEDBACK',
          message: 'Please choose a rating between 1 and 5.',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const stored = await recordProductFeedback(cleaned);
  return NextResponse.json(
    stored
      ? { ok: true, id: stored.id, createdAt: stored.createdAt }
      : { ok: true },
    { status: stored ? 201 : 202, headers: { 'Cache-Control': 'no-store' } },
  );
}
