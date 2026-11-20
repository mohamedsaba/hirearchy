import { candidateAssessmentPath } from '../../../src/hiring/candidate-entry';
import { notFound } from 'next/navigation';

import { isHiringPlatformEnabled } from '../../../src/runtime/profile';
import { CandidateAuthClient } from './candidate-auth-client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata = { title: 'Candidate sign in' };

export default async function CandidateLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; verified?: string }>;
}) {
  if (!isHiringPlatformEnabled()) notFound();
  const params = await searchParams;
  return (
    <CandidateAuthClient
      mode="login"
      nextPath={candidateAssessmentPath(params.next) ?? '/candidate'}
      verified={params.verified === '1'}
    />
  );
}
