import { cookies } from 'next/headers';
import { candidateAssessmentPath } from '../../../src/hiring/candidate-entry';
import { notFound, redirect } from 'next/navigation';

import { isHiringPlatformEnabled } from '../../../src/runtime/profile';
import { tryReadHiringAccountFromCookie } from '../../../src/staging/browser';
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
  const targetPath = candidateAssessmentPath(params.next) ?? '/candidate';
  const jar = await cookies();
  const account = await tryReadHiringAccountFromCookie(jar.toString()).catch(
    () => null,
  );
  if (account) {
    redirect(targetPath);
  }
  return (
    <CandidateAuthClient
      mode="login"
      nextPath={targetPath}
      verified={params.verified === '1'}
    />
  );
}
