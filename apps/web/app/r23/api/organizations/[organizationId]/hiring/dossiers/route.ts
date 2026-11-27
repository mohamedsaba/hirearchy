import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';

import {
  hiringFailureJsonResponse,
  hiringParseJsonBody,
  resolveStagingPublicOrigin,
  StagingBadRequest,
  withHiringOrganizationSession,
} from '../../../../../../../src/staging/browser';
import { recordServerTelemetryEvent } from '../../../../../../../src/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const SESSION_ID_RE = /^sess_[A-Za-z0-9_-]{1,128}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
): Promise<Response> {
  try {
    const { organizationId } = await params;
    const url = new URL(request.url);
    const sessionId = String(url.searchParams.get('sessionId') ?? '').trim();
    if (!SESSION_ID_RE.test(sessionId)) throw new StagingBadRequest();

    return await withHiringOrganizationSession(
      request,
      organizationId,
      {},
      async ({ dispatch, organizationId: orgId }) => {
        const res = (await dispatch('hiring.dossier.share.list', {
          organizationId: orgId,
          sessionId,
        })) as { links?: unknown[] };
        return NextResponse.json(
          { links: res?.links ?? [] },
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
    const body = await hiringParseJsonBody(request, 16384);
    const action = String(body.action ?? '').trim();

    return await withHiringOrganizationSession(
      request,
      organizationId,
      { requireOriginCsrf: true, body },
      async ({ dispatch, organizationId: orgId, orgContext, plan }) => {
        if (action === 'create') {
          const sessionId = String(body.sessionId ?? '').trim();
          if (!SESSION_ID_RE.test(sessionId)) throw new StagingBadRequest();

          const visibilityMode =
            body.visibilityMode === 'named' ? 'named' : 'redacted';
          const includeAiAdvisory =
            typeof body.includeAiAdvisory === 'boolean'
              ? body.includeAiAdvisory
              : true;
          const includeVerificationQuestions =
            typeof body.includeVerificationQuestions === 'boolean'
              ? body.includeVerificationQuestions
              : true;
          const rawDays = Number(body.expiresDays ?? 14);
          const expiresDays = Number.isFinite(rawDays)
            ? Math.max(1, Math.min(90, Math.trunc(rawDays)))
            : 14;

          const shareToken = randomBytes(32).toString('base64url');
          const tokenHash = createHash('sha256')
            .update(shareToken, 'utf8')
            .digest('hex');

          const link = await dispatch('hiring.dossier.share.create', {
            organizationId: orgId,
            sessionId,
            tokenHash,
            input: {
              visibilityMode,
              includeAiAdvisory,
              includeVerificationQuestions,
              expiresDays,
            },
          });

          const shareUrl = `${resolveStagingPublicOrigin(request)}/dossier/${encodeURIComponent(shareToken)}`;

          recordServerTelemetryEvent({
            eventName: 'dossier.share.created',
            category: 'team_funnel',
            actorType: 'team_member',
            organizationId: orgId,
            principalId: orgContext.principalId,
            sessionId,
            planTier: plan.planTier,
            route: '/r23/organizations/:id/handoffs',
            properties: { visibilityMode, expiresDays },
          });

          return NextResponse.json(
            { link, shareUrl, shareToken },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        if (action === 'revoke') {
          const shareId = String(body.shareId ?? '')
            .trim()
            .toLowerCase();
          if (!UUID_RE.test(shareId)) throw new StagingBadRequest();

          await dispatch('hiring.dossier.share.revoke', {
            organizationId: orgId,
            shareId,
          });

          recordServerTelemetryEvent({
            eventName: 'dossier.share.revoked',
            category: 'team_funnel',
            actorType: 'team_member',
            organizationId: orgId,
            principalId: orgContext.principalId,
            planTier: plan.planTier,
            route: '/r23/organizations/:id/handoffs',
          });

          return NextResponse.json(
            { ok: true },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        throw new StagingBadRequest();
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}
