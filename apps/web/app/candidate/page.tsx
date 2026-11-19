import {
  candidateAssessmentPath,
  candidateSignInPath,
} from '../../src/hiring/candidate-entry';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { deriveSessionPipelineStatus } from '../../src/hiring/candidates-view';
import type {
  CandidatePortalAssessmentItem,
  CandidateProfile,
  SafePortalAssessmentView,
} from '../../src/hiring/types';
import { isHiringPlatformEnabled } from '../../src/runtime/profile';
import { tryReadHiringAccountFromCookie } from '../../src/staging/browser';
import { CandidatePortalClient } from './candidate-portal-client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export default async function CandidatePortalPage({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string; next?: string }>;
}) {
  if (!isHiringPlatformEnabled()) notFound();
  const params = await searchParams;
  const incomingHeaders = await headers();
  const account = await tryReadHiringAccountFromCookie(
    incomingHeaders.get('cookie') ?? '',
  );
  if (!account) {
    redirect(candidateSignInPath(params.next));
  }

  const res = (await account.dispatch('candidate.portal.list', {})) as {
    email: string;
    profile: CandidateProfile | null;
    assessments: Array<
      CandidatePortalAssessmentItem & {
        candidateTokenCiphertext?: string | null;
      }
    >;
  };

  const assessments: SafePortalAssessmentView[] = (res.assessments ?? []).map(
    (item) => {
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
    },
  );

  return (
    <CandidatePortalClient
      email={res.email || account.identity.email || ''}
      initialProfile={res.profile ?? null}
      initialAssessments={assessments}
      setupMode={params.setup === '1'}
      nextPath={candidateAssessmentPath(params.next)}
    />
  );
}
