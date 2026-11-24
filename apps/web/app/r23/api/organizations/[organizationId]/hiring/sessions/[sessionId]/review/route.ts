import { NextResponse } from 'next/server';

import { generateAcceptancePerformanceReport } from '../../../../../../../../../src/hiring/ai-performance-report';
import {
  buildPeerReviewRequestEmail,
  buildPeerReviewResponseEmail,
  deliverHiringNotificationEmail,
} from '../../../../../../../../../src/hiring/mail';
import type {
  HandoffDossierItem,
  PeerReviewRequestContext,
  PeerReviewVerdict,
  PerformanceFitReport,
  SessionHiringReviewContext,
} from '../../../../../../../../../src/hiring/types';
import { hasPlanFeature } from '../../../../../../../../../src/plans/entitlements';
import {
  hiringFailureJsonResponse,
  hiringParseJsonBody,
  resolveStagingPublicOrigin,
  StagingBadRequest,
  stagingLoadR27Evidence,
  withHiringOrganizationSession,
} from '../../../../../../../../../src/staging/browser';

function sanitizeStringList(
  value: unknown,
  maxItems: number,
  maxChars: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().slice(0, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sanitizePeerReviewRequestContext(
  raw: unknown,
): PeerReviewRequestContext {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const evaluatorStrengths = sanitizeStringList(obj.evaluatorStrengths, 8, 240);
  const evaluatorWeaknesses = sanitizeStringList(
    obj.evaluatorWeaknesses,
    8,
    240,
  );
  const internalNotesExcerpt =
    typeof obj.internalNotesExcerpt === 'string'
      ? obj.internalNotesExcerpt.trim().slice(0, 1500)
      : '';
  let aiAdvisory: PeerReviewRequestContext['aiAdvisory'] = null;
  if (
    obj.aiAdvisory &&
    typeof obj.aiAdvisory === 'object' &&
    !Array.isArray(obj.aiAdvisory)
  ) {
    const ai = obj.aiAdvisory as Record<string, unknown>;
    const headline =
      typeof ai.headline === 'string' ? ai.headline.trim().slice(0, 240) : '';
    const rationale =
      typeof ai.rationale === 'string'
        ? ai.rationale.trim().slice(0, 1200)
        : '';
    const verdictLabel =
      typeof ai.verdictLabel === 'string'
        ? ai.verdictLabel.trim().slice(0, 80)
        : '';
    const providerLabel =
      typeof ai.providerLabel === 'string'
        ? ai.providerLabel.trim().slice(0, 120)
        : 'Advisory AI Review';
    const rawScore = Number(ai.score);
    const score = Number.isFinite(rawScore)
      ? Math.max(0, Math.min(100, Math.round(rawScore)))
      : 0;
    if (headline || rationale) {
      aiAdvisory = {
        headline,
        score,
        verdictLabel: verdictLabel || 'Advisory signal',
        rationale,
        providerLabel,
      };
    }
  }
  return {
    ...(evaluatorStrengths.length > 0 ? { evaluatorStrengths } : {}),
    ...(evaluatorWeaknesses.length > 0 ? { evaluatorWeaknesses } : {}),
    ...(internalNotesExcerpt ? { internalNotesExcerpt } : {}),
    ...(aiAdvisory ? { aiAdvisory } : {}),
  };
}

function parsePeerReviewVerdict(value: unknown): PeerReviewVerdict {
  if (value === 'approve' || value === 'request_changes') return value;
  return 'comment';
}

function workspaceRoleLabel(role: string | undefined): string {
  switch (role) {
    case 'cto':
      return 'CTO / Engineering Lead';
    case 'reviewer':
      return 'Evaluator';
    case 'recruiter':
      return 'Recruiter';
    default:
      return 'Team member';
  }
}

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
                    'Automated Managerial Fit Reports require the Ultra plan.',
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
      async ({ dispatch, organizationId: orgId, plan }) => {
        if (action === 'request_second_opinion') {
          const reviewerPrincipalId = String(
            body.reviewerPrincipalId ?? '',
          ).trim();
          const note = String(body.note ?? '')
            .trim()
            .slice(0, 2000);
          if (!reviewerPrincipalId) throw new StagingBadRequest();
          const requestContext = sanitizePeerReviewRequestContext(
            body.requestContext,
          );

          const reviewContext = (await dispatch(
            'hiring.second_opinion.create',
            {
              organizationId: orgId,
              sessionId,
              reviewerPrincipalId,
              note,
              requestContext,
            },
          )) as SessionHiringReviewContext;

          const createdOpinion =
            reviewContext.secondOpinions.find(
              (opinion) =>
                opinion.requestedReviewerPrincipalId === reviewerPrincipalId &&
                opinion.status === 'pending',
            ) ?? reviewContext.secondOpinions[0];
          const recipientMember = reviewContext.teamMembers.find(
            (member) => member.principalId === reviewerPrincipalId,
          );
          const requesterMember = reviewContext.teamMembers.find(
            (member) => member.principalId === reviewContext.currentPrincipalId,
          );
          const recipientEmail =
            createdOpinion?.requestedReviewerEmail ||
            recipientMember?.email ||
            '';
          const publicOrigin = resolveStagingPublicOrigin(request);
          const reviewUrl = `${publicOrigin}/r27/organizations/${encodeURIComponent(
            orgId,
          )}/sessions/${encodeURIComponent(sessionId)}?tab=review${
            createdOpinion
              ? `&peerReview=${encodeURIComponent(createdOpinion.id)}`
              : ''
          }`;
          const emailDelivery = await deliverHiringNotificationEmail(
            recipientEmail,
            buildPeerReviewRequestEmail({
              organizationName:
                reviewContext.organizationName || 'Hirearchy Workspace',
              organizationId: orgId,
              sessionId,
              opinionId: createdOpinion?.id ?? '',
              scenarioTitle:
                reviewContext.scenarioTitle ||
                reviewContext.targetRole ||
                'Engineering Assessment',
              candidateName:
                reviewContext.candidateName ||
                reviewContext.candidateEmail ||
                'Candidate',
              candidateCode: reviewContext.candidateCode,
              targetRole: reviewContext.targetRole || 'Software Engineer',
              requesterName:
                createdOpinion?.requestedByName ||
                requesterMember?.displayName ||
                requesterMember?.email ||
                'Teammate',
              requesterRole: workspaceRoleLabel(requesterMember?.role),
              recipientName:
                createdOpinion?.requestedReviewerName ||
                recipientMember?.displayName ||
                recipientEmail ||
                'Teammate',
              recipientEmail,
              requestNote: note,
              requestContext,
              reviewUrl,
            }),
          );

          return NextResponse.json(
            { reviewContext, emailDelivery },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        if (action === 'respond_second_opinion') {
          const opinionId = String(body.opinionId ?? '').trim();
          const responseNote = String(body.responseNote ?? '')
            .trim()
            .slice(0, 4000);
          const verdict = parsePeerReviewVerdict(body.verdict);
          if (!opinionId || !responseNote) throw new StagingBadRequest();

          const reviewContext = (await dispatch(
            'hiring.second_opinion.respond',
            {
              organizationId: orgId,
              opinionId,
              responseNote,
              verdict,
            },
          )) as SessionHiringReviewContext;

          const updatedOpinion = reviewContext.secondOpinions.find(
            (opinion) => opinion.id === opinionId,
          );
          const requesterMember = reviewContext.teamMembers.find(
            (member) =>
              member.principalId === updatedOpinion?.requestedByPrincipalId,
          );
          const reviewerMember = reviewContext.teamMembers.find(
            (member) => member.principalId === reviewContext.currentPrincipalId,
          );
          const requesterEmail =
            updatedOpinion?.requestedByEmail || requesterMember?.email || '';
          const publicOrigin = resolveStagingPublicOrigin(request);
          const reviewUrl = `${publicOrigin}/r27/organizations/${encodeURIComponent(
            orgId,
          )}/sessions/${encodeURIComponent(sessionId)}?tab=review&peerReview=${encodeURIComponent(
            opinionId,
          )}`;
          const emailDelivery = await deliverHiringNotificationEmail(
            requesterEmail,
            buildPeerReviewResponseEmail({
              organizationName:
                reviewContext.organizationName || 'Hirearchy Workspace',
              organizationId: orgId,
              sessionId,
              opinionId,
              scenarioTitle:
                reviewContext.scenarioTitle ||
                reviewContext.targetRole ||
                'Engineering Assessment',
              candidateName:
                reviewContext.candidateName ||
                reviewContext.candidateEmail ||
                'Candidate',
              targetRole: reviewContext.targetRole || 'Software Engineer',
              reviewerName:
                updatedOpinion?.requestedReviewerName ||
                reviewerMember?.displayName ||
                reviewerMember?.email ||
                'Teammate',
              recipientName:
                updatedOpinion?.requestedByName ||
                requesterMember?.displayName ||
                requesterEmail ||
                'Teammate',
              recipientEmail: requesterEmail,
              verdict,
              responseNote,
              reviewUrl,
            }),
          );

          return NextResponse.json(
            { reviewContext, emailDelivery },
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

          let reviewContext = (await dispatch('hiring.decision.publish', {
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

          const published = reviewContext.decision;
          let reportError: string | undefined;
          if (
            published?.decision === 'accepted' &&
            !published.performanceReport &&
            hasPlanFeature(plan.planTier, 'aiPerformanceReport')
          ) {
            try {
              const evidence = await stagingLoadR27Evidence(
                request,
                orgId,
                sessionId,
                { limit: 100 },
              );
              if (!evidence)
                throw new Error('Submitted evidence is unavailable.');
              const performanceReport =
                await generateAcceptancePerformanceReport({
                  evidence,
                  targetRole: reviewContext.targetRole,
                  experienceLevel: reviewContext.experienceLevel,
                  skills: reviewContext.skills,
                  evaluatorStrengths: published.candidateStrengths,
                  evaluatorWeaknesses: published.candidateWeaknesses,
                  evaluatorFeedbackNote: published.candidateFeedbackNote,
                  internalNotes: published.internalNotes,
                  nextStageLabel:
                    published.nextStageLabel ?? 'Managerial Interview',
                  allowLiveAi: true,
                });
              const updated = (await dispatch('hiring.handoff.update', {
                organizationId: orgId,
                sessionId,
                input: {
                  performanceReport,
                  expectedUpdatedAt: published.updatedAt,
                },
              })) as { handoffs: HandoffDossierItem[] };
              const handoff = updated.handoffs.find(
                (item) => item.sessionId === sessionId,
              );
              if (handoff)
                reviewContext = {
                  ...reviewContext,
                  decision: handoff.decision,
                };
            } catch {
              reportError =
                'The acceptance is published. Open the handoff to retry the report.';
            }
          }

          return NextResponse.json(
            { reviewContext, reportError },
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
