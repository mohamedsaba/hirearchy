import { NextResponse } from 'next/server';
import { isFounderUatEnabled } from '../../../../../../../src/runtime/profile';

import {
  isPlanTier,
  type OrganizationPlanSummary,
} from '../../../../../../../src/plans/entitlements';
import {
  hiringFailureJsonResponse,
  hiringParseJsonBody,
  StagingBadRequest,
  withHiringOrganizationSession,
} from '../../../../../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

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
      async ({ plan, orgContext }) =>
        NextResponse.json(
          {
            plan,
            currentRole: orgContext.role,
            isOwner: Boolean(orgContext.isOwner),
          },
          { headers: { 'Cache-Control': 'private, no-store' } },
        ),
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
): Promise<Response> {
  if (!isFounderUatEnabled()) return new Response(null, { status: 403 });
  try {
    const { organizationId } = await params;
    const body = await hiringParseJsonBody(request, 8192);
    return await withHiringOrganizationSession(
      request,
      organizationId,
      { requireOriginCsrf: true, body },
      async ({ dispatch, organizationId: orgId }) => {
        const planTier = body.planTier;
        if (!isPlanTier(planTier)) throw new StagingBadRequest();
        const creditsMode = body.creditsMode === 'set' ? 'set' : 'add';
        const creditsRaw = Number(body.creditsAmount ?? 0);
        const creditsAmount = Number.isFinite(creditsRaw)
          ? Math.min(10000, Math.max(0, Math.trunc(creditsRaw)))
          : 0;

        const updated = (await dispatch('hiring.plan.update', {
          organizationId: orgId,
          planTier,
          creditsMode,
          creditsAmount,
        })) as OrganizationPlanSummary;

        return NextResponse.json(
          { plan: updated },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}
