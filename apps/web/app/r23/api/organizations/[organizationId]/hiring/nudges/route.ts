import { NextResponse } from 'next/server';

import {
  hiringFailureJsonResponse,
  hiringParseJsonBody,
  StagingBadRequest,
  withHiringOrganizationSession,
} from '../../../../../../../src/staging/browser';
import type { NudgeKey } from '../../../../../../../src/telemetry/catalog';
import { recordServerTelemetryEvent } from '../../../../../../../src/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const VALID_NUDGE_KEYS = new Set<NudgeKey>([
  'no_assessment_48h',
  'unreviewed_submission_48h',
  'plan_gate_no_upgrade',
  'problem_health_alert',
  'connect_slack_webhook',
]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
): Promise<Response> {
  try {
    const { organizationId } = await params;
    return await withHiringOrganizationSession(
      request,
      organizationId,
      {},
      async ({ dispatch, organizationId: orgId }) => {
        const res = (await dispatch('hiring.nudges.get', {
          organizationId: orgId,
        })) as { nudges?: unknown[] };
        return NextResponse.json(
          { nudges: res?.nudges ?? [] },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
): Promise<Response> {
  try {
    const { organizationId } = await params;
    const body = await hiringParseJsonBody(request, 8192);
    return await withHiringOrganizationSession(
      request,
      organizationId,
      { requireOriginCsrf: true, body },
      async ({ dispatch, organizationId: orgId, orgContext, plan }) => {
        const nudgeKey = String(body.nudgeKey ?? '').trim() as NudgeKey;
        const action = String(body.action ?? '').trim();
        const targetRef =
          typeof body.targetRef === 'string'
            ? body.targetRef.trim().slice(0, 200)
            : '';

        if (
          !VALID_NUDGE_KEYS.has(nudgeKey) ||
          (action !== 'snooze' && action !== 'dismiss')
        ) {
          throw new StagingBadRequest();
        }

        await dispatch('hiring.nudge.dismiss', {
          organizationId: orgId,
          nudgeKey,
          targetRef,
          action,
        });

        recordServerTelemetryEvent({
          eventName: action === 'snooze' ? 'nudge.snoozed' : 'nudge.dismissed',
          category: 'team_funnel',
          actorType: 'team_member',
          organizationId: orgId,
          principalId: orgContext.principalId,
          planTier: plan.planTier,
          route: '/r23/organizations/:id/candidates',
          properties: { nudgeKey },
        });

        return NextResponse.json(
          { ok: true },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}
