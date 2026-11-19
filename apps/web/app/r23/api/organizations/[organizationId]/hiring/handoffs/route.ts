import { NextResponse } from 'next/server';

import { generateAcceptancePerformanceReport } from '../../../../../../../src/hiring/ai-performance-report';
import type {
  HandoffDossierItem,
  WorkspaceRoleKind,
} from '../../../../../../../src/hiring/types';
import {
  hasPlanFeature,
  type OrganizationPlanSummary,
} from '../../../../../../../src/plans/entitlements';
import {
  hiringFailureJsonResponse,
  hiringParseJsonBody,
  StagingBadRequest,
  stagingLoadR27Evidence,
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
        const res = (await dispatch('hiring.handoffs.list', {
          organizationId: orgId,
        })) as {
          handoffs?: HandoffDossierItem[];
          plan?: OrganizationPlanSummary;
          currentRole?: WorkspaceRoleKind;
          isOwner?: boolean;
        };
        return NextResponse.json(
          {
            handoffs: res?.handoffs ?? [],
            plan: res?.plan ?? null,
            currentRole: res?.currentRole ?? 'reviewer',
            isOwner: Boolean(res?.isOwner),
          },
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
    const body = await hiringParseJsonBody(request, 32768);
    return await withHiringOrganizationSession(
      request,
      organizationId,
      { requireOriginCsrf: true, body },
      async ({ dispatch, organizationId: orgId, plan }) => {
        const sessionId = String(body.sessionId ?? '').trim();
        if (!sessionId) throw new StagingBadRequest();

        if (body.regeneratePerformanceReport === true) {
          if (!hasPlanFeature(plan.planTier, 'aiPerformanceReport')) {
            return NextResponse.json(
              {
                error: {
                  code: 'PLAN_UPGRADE_REQUIRED',
                  requiredPlan: 'ultra',
                  currentPlan: plan.planTier,
                  message:
                    'Regenerating Managerial Performance & Fit Reports with Kimi K3.1 Pro requires the Ultra plan.',
                },
              },
              {
                status: 402,
                headers: { 'Cache-Control': 'private, no-store' },
              },
            );
          }

          const listRes = (await dispatch('hiring.handoffs.list', {
            organizationId: orgId,
          })) as { handoffs?: HandoffDossierItem[] };
          const current = (listRes?.handoffs ?? []).find(
            (h) => h.sessionId === sessionId,
          );
          if (!current) {
            return NextResponse.json(
              { error: { code: 'NOT_FOUND', message: 'Handoff not found.' } },
              {
                status: 404,
                headers: { 'Cache-Control': 'private, no-store' },
              },
            );
          }

          const evidence = await stagingLoadR27Evidence(
            request,
            orgId,
            sessionId,
            { limit: 100 },
          );
          if (!evidence) {
            return NextResponse.json(
              {
                error: {
                  code: 'EVIDENCE_UNAVAILABLE',
                  message: 'Submitted evidence could not be loaded.',
                },
              },
              {
                status: 404,
                headers: { 'Cache-Control': 'private, no-store' },
              },
            );
          }

          const performanceReport = await generateAcceptancePerformanceReport({
            evidence,
            targetRole: current.targetRole,
            experienceLevel: current.experienceLevel,
            skills: current.skills,
            evaluatorStrengths: current.decision.candidateStrengths,
            evaluatorWeaknesses: current.decision.candidateWeaknesses,
            evaluatorFeedbackNote: current.decision.candidateFeedbackNote,
            internalNotes: current.decision.internalNotes,
            nextStageLabel:
              current.decision.nextStageLabel ?? 'Managerial Interview',
            allowLiveAi: true,
          });

          const updated = (await dispatch('hiring.handoff.update', {
            organizationId: orgId,
            sessionId,
            input: { performanceReport },
          })) as { handoffs?: HandoffDossierItem[] };

          return NextResponse.json(
            { handoffs: updated?.handoffs ?? [] },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        const handoffStatus = String(body.handoffStatus ?? '').trim();
        if (!['pending', 'reviewed', 'completed'].includes(handoffStatus)) {
          throw new StagingBadRequest();
        }

        const updated = (await dispatch('hiring.handoff.update', {
          organizationId: orgId,
          sessionId,
          input: { handoffStatus },
        })) as { handoffs?: HandoffDossierItem[] };

        return NextResponse.json(
          { handoffs: updated?.handoffs ?? [] },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}
