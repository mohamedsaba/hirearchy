import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import {
  computeCandidateLinkTokenHash,
  decryptCandidateLinkToken,
  encryptCandidateLinkToken,
  generateOpaqueLinkToken,
  hiringFailureJsonResponse,
  hiringParseJsonBody,
  StagingBadRequest,
  withHiringOrganizationSession,
} from '../../../../../../../src/staging/browser';
import { recordServerTelemetryEvent } from '../../../../../../../src/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

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
      async ({ dispatch, organizationId: orgId, orgContext, plan }) => {
        const definitionId = String(body.definitionId ?? '').trim();
        const validatedVersionId = String(body.validatedVersionId ?? '').trim();
        const candidateEmail = String(body.candidateEmail ?? '')
          .trim()
          .toLowerCase();
        const reviewerPrincipalId = String(
          body.reviewerPrincipalId ?? '',
        ).trim();
        const targetRole = String(body.targetRole ?? '').trim();
        const experienceLevel = String(body.experienceLevel ?? 'mid').trim();
        const invitationNote = String(body.invitationNote ?? '')
          .trim()
          .slice(0, 1000);
        const skills = Array.isArray(body.skills)
          ? body.skills
              .filter((s): s is string => typeof s === 'string')
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, 12)
          : [];
        const rawDays = Number(body.expiresInDays ?? 7);
        const expiresInDays = Number.isFinite(rawDays)
          ? Math.max(1, Math.min(30, Math.trunc(rawDays)))
          : 7;
        const requestId =
          typeof body.requestId === 'string' &&
          body.requestId.trim().length >= 8
            ? body.requestId.trim()
            : randomUUID();

        if (
          !definitionId ||
          !validatedVersionId ||
          !candidateEmail.includes('@')
        ) {
          throw new StagingBadRequest();
        }

        const sessionId = `sess_${randomUUID()}`;
        const rawToken = generateOpaqueLinkToken();
        const tokenHash = computeCandidateLinkTokenHash(rawToken);
        const ciphertext = encryptCandidateLinkToken(rawToken, sessionId);
        const expiresAt = new Date(
          Date.now() + expiresInDays * 86400000,
        ).toISOString();

        const res = (await dispatch('hiring.assessment.issue', {
          organizationId: orgId,
          input: {
            sessionId,
            definitionId,
            validatedVersionId,
            candidateEmail,
            ...(reviewerPrincipalId ? { reviewerPrincipalId } : {}),
            targetRole: targetRole || 'Software Engineer',
            experienceLevel,
            skills,
            invitationNote,
            expiresAt,
            requestId,
            candidateTokenHash: tokenHash,
            candidateTokenCiphertext: ciphertext,
          },
        })) as Record<string, unknown>;

        if (!res?.ok) {
          recordServerTelemetryEvent({
            eventName: 'monetization.plan_gate_hit',
            category: 'monetization',
            actorType: 'team_member',
            organizationId: orgId,
            principalId: orgContext.principalId,
            planTier: plan.planTier,
            status: 'blocked',
            route: '/r23/organizations/:id/builder',
            properties: {
              feature: 'issue_assessment',
              errorCode: String(res?.errorCode ?? 'PLAN_REQUIRED'),
            },
          });
          return NextResponse.json(
            {
              error: {
                code: String(res?.errorCode ?? 'PLAN_REQUIRED'),
                message: String(
                  res?.message ??
                    'An active plan or candidate credit is required before issuing.',
                ),
              },
              creditsUsed: res?.creditsUsed,
              creditsPurchased: res?.creditsPurchased,
            },
            { status: 402, headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        const issuedSessionId = String(res.sessionId ?? sessionId);
        recordServerTelemetryEvent({
          eventName: 'hiring.assessment.issued',
          category: 'team_funnel',
          actorType: 'team_member',
          organizationId: orgId,
          principalId: orgContext.principalId,
          sessionId: issuedSessionId,
          planTier: plan.planTier,
          route: '/r23/organizations/:id/builder',
          properties: {
            targetRole: targetRole || 'Software Engineer',
            experienceLevel,
            skillCount: skills.length,
            replayed: Boolean(res.replayed),
          },
        });
        let tokenToShare = rawToken;
        if (res.replayed && typeof res.candidateTokenCiphertext === 'string') {
          tokenToShare = decryptCandidateLinkToken(
            res.candidateTokenCiphertext,
            issuedSessionId,
          );
        }

        return NextResponse.json(
          {
            ok: true,
            replayed: Boolean(res.replayed),
            sessionId: issuedSessionId,
            candidateLink: `/r26/candidate/${encodeURIComponent(issuedSessionId)}#token=${encodeURIComponent(tokenToShare)}`,
            expiresAt: String(res.expiresAt ?? expiresAt),
            creditConsumed: Boolean(res.creditConsumed),
            creditsUsed: res.creditsUsed ?? 0,
            creditsPurchased: res.creditsPurchased ?? 0,
          },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}
