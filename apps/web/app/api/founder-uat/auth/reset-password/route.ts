import {
  candidateEntryPath,
  candidateResetPasswordPath,
  candidateSignInPath,
} from '../../../../../src/hiring/candidate-entry';
import { isHiringPlatformEnabled } from '../../../../../src/runtime/profile';
import { enforceRateLimit } from '../../../../../src/security/rate-limit';
import {
  R23AuthenticationDenied,
  R23AuthUnavailable,
  R23PasswordUpdateDenied,
  updateR23Password,
  verifyR23AccessToken,
} from '../../../../../src/r23-auth/identity';
import {
  clearFounderUatRecovery,
  readFounderUatRecovery,
} from '../../../../../src/r23-auth/founder-uat-state';
import {
  founderUatForm,
  founderUatPostConfiguration,
  founderUatRedirect,
  FounderUatInvalidRequest,
  FounderUatRequestTooLarge,
} from '../../../../../src/r23-auth/founder-uat-server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const config = founderUatPostConfiguration(request);
  if (config instanceof Response) return config;
  const rateLimitResponse = enforceRateLimit(request, 'auth');
  if (rateLimitResponse) return rateLimitResponse;

  const recovery = readFounderUatRecovery(request);
  const recoveryCandidateNext =
    isHiringPlatformEnabled() && recovery?.audience === 'candidate'
      ? candidateEntryPath(recovery.next)
      : null;

  let password: string;
  let formCandidateAudience = false;
  let formCandidateNext: string | null = null;
  try {
    const form = await founderUatForm(request, [
      'password',
      'audience',
      'next',
    ]);
    formCandidateAudience =
      isHiringPlatformEnabled() && form.audience === 'candidate';
    formCandidateNext = formCandidateAudience
      ? candidateEntryPath(form.next)
      : null;
    password = form.password ?? '';
  } catch (error) {
    const isCandidate = Boolean(recovery?.audience === 'candidate');
    const candidateNext = isCandidate ? recoveryCandidateNext : null;
    if (!recovery) {
      return founderUatRedirect(
        config,
        isCandidate
          ? candidateResetPasswordPath(candidateNext, { error: 'expired' })
          : '/r23/reset-password?error=expired',
        [clearFounderUatRecovery()],
      );
    }
    if (
      error instanceof FounderUatRequestTooLarge ||
      error instanceof FounderUatInvalidRequest
    ) {
      return founderUatRedirect(
        config,
        isCandidate
          ? candidateResetPasswordPath(candidateNext, { error: 'password' })
          : '/r23/reset-password?error=password',
      );
    }
    return founderUatRedirect(
      config,
      isCandidate
        ? candidateResetPasswordPath(candidateNext, { error: 'unavailable' })
        : '/r23/reset-password?error=unavailable',
    );
  }

  const isCandidate =
    recovery?.audience === 'candidate' || formCandidateAudience;
  const candidateNext = isCandidate
    ? (recoveryCandidateNext ?? formCandidateNext)
    : null;
  const resetErrorRedirect = (
    errorCode: 'expired' | 'password' | 'unavailable',
  ): `/r23/reset-password?${string}` =>
    isCandidate
      ? candidateResetPasswordPath(candidateNext, { error: errorCode })
      : `/r23/reset-password?error=${errorCode}`;

  if (!recovery) {
    return founderUatRedirect(config, resetErrorRedirect('expired'), [
      clearFounderUatRecovery(),
    ]);
  }

  if (password.length < 6 || password.length > 1024) {
    return founderUatRedirect(config, resetErrorRedirect('password'));
  }

  try {
    const identity = await verifyR23AccessToken(config, recovery.accessToken);
    // GoTrue's OTP verify grant is an `otp` AMR for both signup and recovery.
    // Recovery purpose is therefore bound to this sealed state, created only
    // after a recovery-typed email and recipient-matched GoTrue OTP exchange.
    if (
      identity.isRecovery === null ||
      !identity.authMethods.includes('otp') ||
      !identity.emailVerified ||
      identity.subjectId !== recovery.subjectId ||
      identity.email?.trim().toLowerCase() !== recovery.email
    ) {
      return founderUatRedirect(config, resetErrorRedirect('expired'), [
        clearFounderUatRecovery(),
      ]);
    }
    await updateR23Password(config, recovery.accessToken, password);
    const signInDestination = isCandidate
      ? candidateSignInPath(candidateNext, { reset: true })
      : '/r23/login?reset=1';
    return founderUatRedirect(config, signInDestination, [
      clearFounderUatRecovery(),
    ]);
  } catch (error) {
    if (error instanceof R23PasswordUpdateDenied) {
      return founderUatRedirect(config, resetErrorRedirect('password'));
    }
    if (error instanceof R23AuthenticationDenied) {
      return founderUatRedirect(config, resetErrorRedirect('expired'), [
        clearFounderUatRecovery(),
      ]);
    }
    if (error instanceof R23AuthUnavailable) {
      return founderUatRedirect(config, resetErrorRedirect('unavailable'));
    }
    return founderUatRedirect(config, resetErrorRedirect('unavailable'));
  }
}
