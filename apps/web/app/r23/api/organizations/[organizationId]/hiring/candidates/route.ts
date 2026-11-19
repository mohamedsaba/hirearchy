import { NextResponse } from 'next/server';

import {
  groupCandidateSessions,
  type RawHiringCandidateSessionRow,
} from '../../../../../../../src/hiring/candidates-view';
import type { WorkspaceRoleKind } from '../../../../../../../src/hiring/types';
import type { OrganizationPlanSummary } from '../../../../../../../src/plans/entitlements';
import {
  hiringFailureJsonResponse,
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
      async ({ dispatch, organizationId: orgId }) => {
        const raw = (await dispatch('hiring.candidates.list', {
          organizationId: orgId,
        })) as {
          rows?: RawHiringCandidateSessionRow[];
          plan?: OrganizationPlanSummary;
          currentRole?: WorkspaceRoleKind;
          isOwner?: boolean;
        };

        const candidates = groupCandidateSessions(raw?.rows ?? []);

        return NextResponse.json(
          {
            candidates,
            plan: raw?.plan ?? null,
            currentRole: raw?.currentRole ?? 'reviewer',
            isOwner: Boolean(raw?.isOwner),
          },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}
