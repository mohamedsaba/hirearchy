import { NextResponse } from 'next/server';

import { generateAcceptancePerformanceReport } from '../../../../../../../../../src/hiring/ai-performance-report';
import type {
  PerformanceFitReport,
  SessionHiringReviewContext,
} from '../../../../../../../../../src/hiring/types';
import { hasPlanFeature } from '../../../../../../../../../src/plans/entitlements';
import {
  hiringFailureJsonResponse,
  hiringParseJsonBody,
  StagingBadRequest,
  stagingLoadR27Evidence,
  withHiringOrganizationSession,
} from '../../../../../../../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  {
    params,
  }: { params: Promise<{ organizationId: string; sessionId: string }> },
): Promise<Response> {
  try {
    const { organizationId, sessionId } = await params;
    return await withHiringOrganizationSession(
      request,
      organizationId,
      {},
      async ({ dispatch, organizationId: orgId }) => {
        const reviewContext = (await dispatch('hiring.review.context', {
          organizationId: orgId,
          sessionId,
        })) as SessionHiringReviewContext;
        return NextResponse.json(
          { reviewContext },
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
  {
    params,
  }: { params: Promise<{ organizationId: string; sessionId: string }> },
): Promise<Response> {
  try {
    const { organizationId, sessionId } = await params;
    const body = await hiringParseJsonBody(request, 65536);
    const action = String(body.action ?? '').trim();

    if (action === 'generate_performance_report') {
      return await withHiringOrganizationSession(
        request,
        organizationId,
        { requireOriginCsrf: true, body },
        async ({ dispatch, organizationId: orgId, plan }) => {
          if (!hasPlanFeature(plan.planTier, 'aiPerformanceReport')) {
            return NextResponse.json(
              {
                error: {
                  code: 'PLAN_UPGRADE_REQUIRED',
                  requiredPlan: 'ultra',
                  currentPlan: plan.planTier,
                  message:
                    'Automated Managerial Performance & Fit Reports with Kimi K3.1 Pro require the Ultra plan.',
                },
              },
              {
                status: 402,
                headers: { 'Cache-Control': 'private, no-store' },
              },
            );
          }

          const [evidence, reviewContext] = await Promise.all([
            stagingLoadR27Evidence(request, orgId, sessionId, { limit: 100 }),
            dispatch('hiring.review.context', {
              organizationId: orgId,
              sessionId,
            }) as Promise<SessionHiringReviewContext>,
          ]);

          if (!evidence) {
            return NextResponse.json(
              {
                error: {
                  code: 'EVIDENCE_UNAVAILABLE',
                  message: 'Submitted evidence is not available yet.',
                },
              },
              {
                status: 404,
                headers: { 'Cache-Control': 'private, no-store' },
              },
            );
          }

          const toStrArr = (val: unknown): string[] =>
            Array.isArray(val)
              ? val
                  .filter((s): s is string => typeof s === 'string')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .slice(0, 10)
              : [];

          const performanceReport = await generateAcceptancePerformanceReport({
            evidence,
            targetRole: reviewContext.targetRole || 'Software Engineer',
            experienceLevel: reviewContext.experienceLevel || 'mid',
            skills: reviewContext.skills ?? [],
            evaluatorStrengths: toStrArr(body.candidateStrengths),
            evaluatorWeaknesses: toStrArr(body.candidateWeaknesses),
            evaluatorFeedbackNote: String(
              body.candidateFeedbackNote ?? '',
            ).slice(0, 3000),
            internalNotes: String(body.internalNotes ?? '').slice(0, 5000),
            nextStageLabel: String(
              body.nextStageLabel ?? 'Managerial Interview',
            ).slice(0, 120),
            allowLiveAi: true,
          });

          return NextResponse.json(
            { performanceReport },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        },
      );
    }

    return await withHiringOrganizationSession(
      request,
      organizationId,
      { requireOriginCsrf: true, body },
      async ({ dispatch, organizationId: orgId }) => {
        if (action === 'request_second_opinion') {
          const reviewerPrincipalId = String(
            body.reviewerPrincipalId ?? '',
          ).trim();
          const note = String(body.note ?? '')
            .trim()
            .slice(0, 2000);
          if (!reviewerPrincipalId) throw new StagingBadRequest();

          const reviewContext = (await dispatch(
            'hiring.second_opinion.create',
            {
              organizationId: orgId,
              sessionId,
              reviewerPrincipalId,
              note,
            },
          )) as SessionHiringReviewContext;
          return NextResponse.json(
            { reviewContext },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        if (action === 'respond_second_opinion') {
          const opinionId = String(body.opinionId ?? '').trim();
          const responseNote = String(body.responseNote ?? '')
            .trim()
            .slice(0, 4000);
          if (!opinionId || !responseNote) throw new StagingBadRequest();

          const reviewContext = (await dispatch(
            'hiring.second_opinion.respond',
            {
              organizationId: orgId,
              opinionId,
              responseNote,
            },
          )) as SessionHiringReviewContext;
          return NextResponse.json(
            { reviewContext },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        if (action === 'publish_decision') {
          const decision =
            body.decision === 'accepted'
              ? 'accepted'
              : body.decision === 'rejected'
                ? 'rejected'
                : null;
          if (!decision) throw new StagingBadRequest();

          const toStrArr = (val: unknown): string[] =>
            Array.isArray(val)
              ? val
                  .filter((s): s is string => typeof s === 'string')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .slice(0, 12)
              : [];

          const reviewContext = (await dispatch('hiring.decision.publish', {
            organizationId: orgId,
            sessionId,
            input: {
              decision,
              candidateStrengths: toStrArr(body.candidateStrengths),
              candidateWeaknesses: toStrArr(body.candidateWeaknesses),
              candidateFeedbackNote: String(body.candidateFeedbackNote ?? '')
                .trim()
                .slice(0, 5000),
              internalNotes: String(body.internalNotes ?? '')
                .trim()
                .slice(0, 10000),
              ...(decision === 'accepted'
                ? {
                    nextStageLabel: String(
                      body.nextStageLabel ?? 'Managerial Interview',
                    ).trim(),
                    handoffRecipientPrincipalId:
                      String(body.handoffRecipientPrincipalId ?? '').trim() ||
                      null,
                    performanceReport:
                      (body.performanceReport as PerformanceFitReport | null) ??
                      null,
                  }
                : {}),
            },
          })) as SessionHiringReviewContext;

          return NextResponse.json(
            { reviewContext },
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
