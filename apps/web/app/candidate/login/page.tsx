import { notFound } from 'next/navigation';

import { isHiringPlatformEnabled } from '../../../src/runtime/profile';
import { CandidateAuthClient } from './candidate-auth-client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function safeNext(raw: string | undefined): string {
  if (
    raw &&
    (raw.startsWith('/candidate') || raw.startsWith('/r26/candidate/')) &&
    !raw.startsWith('//') &&
    !raw.includes('..')
  ) {
    return raw;
  }
  return '/candidate';
}

export default async function CandidateLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (!isHiringPlatformEnabled()) notFound();
  const params = await searchParams;
  return <CandidateAuthClient mode="login" nextPath={safeNext(params.next)} />;
}
