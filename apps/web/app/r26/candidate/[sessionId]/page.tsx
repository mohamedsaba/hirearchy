import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { r26CandidatePageIsAvailable } from '../../../../src/r26-candidate/config';
import { isHiringPlatformEnabled } from '../../../../src/runtime/profile';
import { tryReadHiringAccountFromCookie } from '../../../../src/staging/browser';
import {
  R26CandidateClient,
  type CandidateAccountGate,
} from './candidate-client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Candidate workspace',
  referrer: 'no-referrer',
};

type CandidatePageProps = Readonly<{
  params: Promise<{ sessionId: string }>;
}>;

export default async function CandidatePage({ params }: CandidatePageProps) {
  const { sessionId } = await params;
  if (
    !r26CandidatePageIsAvailable() ||
    !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
  ) {
    notFound();
  }

  let accountGate: CandidateAccountGate | undefined;
  if (isHiringPlatformEnabled()) {
    const incomingHeaders = await headers();
    const account = await tryReadHiringAccountFromCookie(
      incomingHeaders.get('cookie') ?? '',
    );
    if (!account) {
      accountGate = { state: 'sign_in_required' };
    } else {
      const check = (await account
        .dispatch('candidate.session.verify_access', { sessionId })
        .catch(() => null)) as {
        gateState?: 'ready' | 'profile_required' | 'email_mismatch';
        signedInEmail?: string;
        expectedEmailHint?: string;
        candidateName?: string;
        candidateCode?: string;
      } | null;

      if (!check || !check.gateState) {
        accountGate = { state: 'sign_in_required' };
      } else {
        accountGate = {
          state: check.gateState,
          signedInEmail: check.signedInEmail,
          expectedEmailHint: check.expectedEmailHint,
          candidateName: check.candidateName,
          candidateCode: check.candidateCode,
        };
      }
    }
  }

  return <R26CandidateClient sessionId={sessionId} accountGate={accountGate} />;
}
