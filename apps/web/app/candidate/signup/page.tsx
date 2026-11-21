import { candidateAssessmentPath } from '../../../src/hiring/candidate-entry';
import { notFound } from 'next/navigation';

import { isHiringPlatformEnabled } from '../../../src/runtime/profile';
import { CandidateAuthClient } from '../login/candidate-auth-client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata = { title: 'Create a candidate account' };

export default async function CandidateSignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (!isHiringPlatformEnabled()) notFound();
  const params = await searchParams;
  return (
    <CandidateAuthClient
      mode="signup"
      nextPath={candidateAssessmentPath(params.next) ?? '/candidate'}
    />
  );
}
