import { cookies } from 'next/headers';
import { candidateEntryPath } from '../../../src/hiring/candidate-entry';
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
  searchParams: Promise<{ next?: string; verified?: string; reset?: string }>;
}) {
  if (!isHiringPlatformEnabled()) notFound();
  const params = await searchParams;
  const targetPath = candidateEntryPath(params.next) ?? '/candidate';
  const jar = await cookies();
  const account = await tryReadHiringAccountFromCookie(jar.toString()).catch(
    () => null,
  );
  let hasCandidateContext = false;
  let hasTeamWorkspace = false;
  if (account) {
    if (targetPath !== '/candidate') {
      const access = (await account
        .dispatch('candidate.session.verify_access', {
          sessionId: targetPath.slice(targetPath.lastIndexOf('/') + 1),
        })
        .catch(() => null)) as { gateState?: string } | null;
      if (
        access?.gateState === 'ready' ||
        access?.gateState === 'profile_required'
      ) {
        redirect(targetPath);
      }
    } else {
      const portal = (await account
        .dispatch('candidate.portal.list', {})
        .catch(() => null)) as {
        profile?: unknown;
        assessments?: unknown[];
      } | null;
      hasCandidateContext = Boolean(
        portal?.profile ||
        (Array.isArray(portal?.assessments) && portal.assessments.length > 0),
      );
    }
    if (!hasCandidateContext) {
      const onboarding = (await account
        .dispatch('onboarding.status', {})
        .catch(() => null)) as { status?: string } | null;
      hasTeamWorkspace = onboarding?.status === 'has_active_membership';
    }
  }
  return (
    <CandidateAuthClient
      mode="login"
      nextPath={targetPath}
      verified={params.verified === '1'}
      reset={params.reset === '1'}
      activeAccount={
        account?.identity.email
          ? {
              email: account.identity.email,
              csrfToken: account.csrfToken,
              hasCandidateContext,
              hasTeamWorkspace,
            }
          : null
      }
    />
  );
}
