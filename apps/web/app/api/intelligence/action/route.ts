import { NextResponse } from 'next/server';

import { isFounderUatEnabled } from '../../../../src/runtime/founder-uat';
import type { NudgeKey } from '../../../../src/telemetry/catalog';
import { updateOperatorNudge } from '../../../../src/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_NUDGE_KEYS = new Set<NudgeKey>([
  'no_assessment_48h',
  'unreviewed_submission_48h',
  'plan_gate_no_upgrade',
  'problem_health_alert',
  'connect_slack_webhook',
]);
const VALID_STATUSES = new Set<'contacted' | 'snoozed' | 'resolved'>([
  'contacted',
  'snoozed',
  'resolved',
]);

function isIntelligenceEnabled(): boolean {
  return (
    isFounderUatEnabled() ||
    process.env.HIREARCHY_OPERATOR_ANALYTICS_ENABLED === 'true'
  );
}

function isSameOrigin(request: Request): boolean {
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
  if (!isIntelligenceEnabled()) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Not found.' } },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (!isSameOrigin(request)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'Invalid origin.' } },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json(
      { error: { code: 'INVALID_BODY', message: 'Invalid request body.' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const organizationId =
    typeof body.organizationId === 'string'
      ? body.organizationId.trim().toLowerCase()
      : '';
  const nudgeKey =
    typeof body.nudgeKey === 'string'
      ? (body.nudgeKey.trim() as NudgeKey)
      : ('' as NudgeKey);
  const status =
    typeof body.status === 'string'
      ? (body.status.trim() as 'contacted' | 'snoozed' | 'resolved')
      : ('' as 'contacted');
  const targetRef =
    typeof body.targetRef === 'string'
      ? body.targetRef.trim().slice(0, 200)
      : '';
  const founderNote =
    typeof body.founderNote === 'string'
      ? body.founderNote.trim().slice(0, 1000)
      : '';

  if (
    !UUID_RE.test(organizationId) ||
    !VALID_NUDGE_KEYS.has(nudgeKey) ||
    !VALID_STATUSES.has(status)
  ) {
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid organizationId, nudgeKey, or status.',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const ok = await updateOperatorNudge({
    organizationId,
    nudgeKey,
    targetRef,
    status,
    founderNote,
  });
  if (!ok) {
    return NextResponse.json(
      {
        error: {
          code: 'INTELLIGENCE_UNAVAILABLE',
          message: 'Unable to update operator action item.',
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(
    { ok: true },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
