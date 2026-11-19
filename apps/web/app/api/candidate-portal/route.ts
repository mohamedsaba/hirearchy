import { NextResponse } from 'next/server';

import { deriveSessionPipelineStatus } from '../../../src/hiring/candidates-view';
import type {
  CandidatePortalAssessmentItem,
  CandidateProfile,
  SafePortalAssessmentView,
} from '../../../src/hiring/types';
import { isHiringPlatformEnabled } from '../../../src/runtime/profile';
import {
  authenticateCandidatePasswordLogin,
  clearHiringAuthCookies,
  decryptCandidateLinkToken,
  hiringFailureJsonResponse,
  hiringParseJsonBody,
  registerCandidateAccount,
  StagingBadRequest,
  withHiringAccountSession,
} from '../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

interface RawPortalAssessment {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly scenarioTitle: string;
  readonly targetRole: string;
  readonly experienceLevel: string;
  readonly skills: readonly string[];
  readonly durationSeconds: number | null;
  readonly status: 'CREATED' | 'ACTIVE' | 'SUBMITTED';
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly submittedAt: string | null;
  readonly invitationExpiresAt: string | null;
  readonly invitationRevokedAt: string | null;
  readonly invitationActive: boolean;
  readonly candidateTokenCiphertext: string | null;
  readonly publishedOutcome: CandidatePortalAssessmentItem['publishedOutcome'];
}

// Sanitized view type defined in src/hiring/types.ts

function sanitizePortalAssessments(
  raw: readonly RawPortalAssessment[],
): SafePortalAssessmentView[] {
  return raw.map((item) => {
    const pipelineStatus = deriveSessionPipelineStatus({
      lifecycleStatus: item.status,
      decision: item.publishedOutcome
        ? {
            sessionId: item.sessionId,
            organizationId: item.organizationId,
            decidedByPrincipalId: '',
            decidedByName: '',
            decision: item.publishedOutcome.decision,
            candidateStrengths: item.publishedOutcome.strengths,
            candidateWeaknesses: item.publishedOutcome.weaknesses,
            candidateFeedbackNote: item.publishedOutcome.feedbackNote,
            internalNotes: '',
            nextStageLabel: item.publishedOutcome.nextStageLabel,
            handoffRecipientPrincipalId: null,
            handoffRecipientName: null,
            handoffStatus: 'none',
            performanceReport: null,
            publishedAt: item.publishedOutcome.publishedAt,
            updatedAt: item.publishedOutcome.publishedAt,
          }
        : null,
    });
    return {
      sessionId: item.sessionId,
      organizationId: item.organizationId,
      organizationName: item.organizationName,
      scenarioTitle: item.scenarioTitle,
      targetRole: item.targetRole,
      experienceLevel: item.experienceLevel,
      skills: Array.isArray(item.skills) ? item.skills : [],
      durationSeconds: item.durationSeconds,
      status: item.status,
      pipelineStatus,
      createdAt: item.createdAt,
      activatedAt: item.activatedAt,
      submittedAt: item.submittedAt,
      invitationExpiresAt: item.invitationExpiresAt,
      invitationRevokedAt: item.invitationRevokedAt,
      invitationActive: Boolean(item.invitationActive),
      publishedOutcome: item.publishedOutcome ?? null,
      canLaunch: Boolean(
        item.invitationActive &&
        item.candidateTokenCiphertext &&
        item.status !== 'SUBMITTED',
      ),
    };
  });
}

function maskDocumentNumber(raw: string): string {
  const compact = raw.replace(/\s+/g, '');
  if (!compact) return '';
  if (compact.length <= 4) return `••••${compact}`;
  return `••••${compact.slice(-4)}`;
}

function safeNextRedirect(value: unknown, fallback = '/candidate'): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (
    trimmed.startsWith('/candidate') ||
    trimmed.startsWith('/r26/candidate/')
  ) {
    if (!trimmed.startsWith('//') && !trimmed.includes('..')) {
      return trimmed;
    }
  }
  return fallback;
}

export async function GET(request: Request): Promise<Response> {
  try {
    return await withHiringAccountSession(request, {}, async ({ dispatch }) => {
      const res = (await dispatch('candidate.portal.list', {})) as {
        email: string;
        profile: CandidateProfile | null;
        assessments: RawPortalAssessment[];
      };
      return NextResponse.json(
        {
          email: res.email,
          profile: res.profile ?? null,
          assessments: sanitizePortalAssessments(res.assessments ?? []),
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    });
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isHiringPlatformEnabled()) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Not found.' } },
      { status: 404 },
    );
  }

  try {
    const body = await hiringParseJsonBody(request, 32768);
    const action = String(body.action ?? '').trim();

    if (action === 'login') {
      const email = String(body.email ?? '');
      const password = String(body.password ?? '');
      const nextPath = safeNextRedirect(body.next, '/candidate');
      const authRes = await authenticateCandidatePasswordLogin(
        request,
        email,
        password,
      );
      if (authRes.status === 'email_confirmation_required') {
        return NextResponse.json(
          {
            error: {
              code: 'EMAIL_CONFIRMATION_REQUIRED',
              message:
                'Confirm your email address before signing in to your candidate account.',
              verifyUrl: authRes.verifyUrl,
            },
          },
          { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }
      const response = NextResponse.json(
        { ok: true, email: authRes.email, redirectTo: nextPath },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
      for (const cookie of authRes.cookies) {
        response.headers.append('Set-Cookie', cookie);
      }
      return response;
    }

    if (action === 'signup') {
      const email = String(body.email ?? '');
      const password = String(body.password ?? '');
      const signupRes = await registerCandidateAccount(
        request,
        email,
        password,
      );
      if (!signupRes.ok) {
        return NextResponse.json(
          {
            error: {
              code: 'SIGNUP_FAILED',
              message: signupRes.message,
            },
          },
          {
            status: signupRes.status >= 400 ? signupRes.status : 400,
            headers: { 'Cache-Control': 'private, no-store' },
          },
        );
      }
      return NextResponse.json(
        {
          ok: true,
          email: signupRes.email,
          confirmationInboxUrl: signupRes.confirmationInboxUrl,
          verifyEmailUrl: signupRes.verifyEmailUrl,
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    }

    if (action === 'logout') {
      const response = NextResponse.json(
        { ok: true },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
      for (const cookie of clearHiringAuthCookies()) {
        response.headers.append('Set-Cookie', cookie);
      }
      return response;
    }

    return await withHiringAccountSession(
      request,
      { requireOriginCsrf: true, body },
      async ({ dispatch }) => {
        if (action === 'save_profile') {
          const fullName = String(body.fullName ?? '').trim();
          if (fullName.length < 2 || fullName.length > 120) {
            throw new StagingBadRequest();
          }
          const rawBirthYear =
            body.birthYear !== null &&
            body.birthYear !== undefined &&
            body.birthYear !== ''
              ? Number(body.birthYear)
              : null;
          const birthYear =
            rawBirthYear !== null &&
            Number.isFinite(rawBirthYear) &&
            rawBirthYear >= 1940 &&
            rawBirthYear <= 2012
              ? Math.trunc(rawBirthYear)
              : null;
          const yearsRaw = Number(body.yearsExperience ?? 0);
          const yearsExperience = Number.isFinite(yearsRaw)
            ? Math.max(0, Math.min(50, Math.trunc(yearsRaw)))
            : 0;
          const skills = Array.isArray(body.skills)
            ? body.skills
                .filter((s): s is string => typeof s === 'string')
                .map((s) => s.trim())
                .filter(Boolean)
                .slice(0, 20)
            : [];
          const idDocType = String(body.idDocumentType ?? '').trim();
          const rawIdNum = String(body.idDocumentNumber ?? '').trim();
          const idDocumentMasked = rawIdNum ? maskDocumentNumber(rawIdNum) : '';

          const res = (await dispatch('candidate.profile.upsert', {
            profile: {
              fullName,
              phone: String(body.phone ?? '')
                .trim()
                .slice(0, 40),
              birthYear,
              locationCountry: String(body.locationCountry ?? '')
                .trim()
                .slice(0, 100),
              locationCity: String(body.locationCity ?? '')
                .trim()
                .slice(0, 100),
              workMode: String(body.workMode ?? 'remote').trim(),
              headlineRole: String(body.headlineRole ?? '')
                .trim()
                .slice(0, 120),
              yearsExperience,
              experienceLevel: String(body.experienceLevel ?? 'mid').trim(),
              skills,
              ...(idDocType ? { idDocumentType: idDocType } : {}),
              ...(idDocumentMasked ? { idDocumentMasked } : {}),
              linkedinUrl: String(body.linkedinUrl ?? '')
                .trim()
                .slice(0, 300),
              githubUrl: String(body.githubUrl ?? '')
                .trim()
                .slice(0, 300),
              portfolioUrl: String(body.portfolioUrl ?? '')
                .trim()
                .slice(0, 300),
              bio: String(body.bio ?? '')
                .trim()
                .slice(0, 2000),
            },
          })) as { email: string; profile: CandidateProfile | null };

          return NextResponse.json(
            { profile: res.profile },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        if (action === 'launch_session') {
          const sessionId = String(body.sessionId ?? '').trim();
          if (!sessionId) throw new StagingBadRequest();

          const portalRes = (await dispatch('candidate.portal.list', {})) as {
            profile: CandidateProfile | null;
            assessments: RawPortalAssessment[];
          };

          if (!portalRes?.profile?.profileCompletedAt) {
            return NextResponse.json(
              {
                error: {
                  code: 'PROFILE_REQUIRED',
                  message:
                    'Complete your candidate profile and identity details before starting an assessment.',
                },
              },
              {
                status: 400,
                headers: { 'Cache-Control': 'private, no-store' },
              },
            );
          }

          const match = (portalRes.assessments ?? []).find(
            (a) => a.sessionId === sessionId,
          );
          if (
            !match ||
            !match.invitationActive ||
            !match.candidateTokenCiphertext ||
            match.status === 'SUBMITTED'
          ) {
            return NextResponse.json(
              {
                error: {
                  code: 'ASSESSMENT_UNAVAILABLE',
                  message:
                    'This assessment link is no longer active for your account.',
                },
              },
              {
                status: 404,
                headers: { 'Cache-Control': 'private, no-store' },
              },
            );
          }

          const rawToken = decryptCandidateLinkToken(
            match.candidateTokenCiphertext,
            match.sessionId,
          );
          return NextResponse.json(
            {
              launchUrl: `/r26/candidate/${encodeURIComponent(match.sessionId)}#token=${encodeURIComponent(rawToken)}`,
            },
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
