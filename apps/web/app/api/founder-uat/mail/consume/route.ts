import {
  candidateEntryPath,
  candidateResetPasswordPath,
  candidateSignInPath,
} from '../../../../../src/hiring/candidate-entry';
import { isHiringPlatformEnabled } from '../../../../../src/runtime/profile';
import { enforceRateLimit } from '../../../../../src/security/rate-limit';
import {
  FounderUatMailMessageDenied,
  FounderUatMailUnavailable,
  readFounderUatMessageAction,
} from '../../../../../src/runtime/founder-uat-mail';
import { isValidFounderUatEmail } from '../../../../../src/runtime/founder-uat';
import {
  assertR23VerifiedIdentity,
  R23AuthenticationDenied,
  R23AuthUnavailable,
  verifyR23AccessToken,
  verifyR23Otp,
} from '../../../../../src/r23-auth/identity';
import {
  clearFounderUatRecovery,
  founderUatRecoveryCookie,
} from '../../../../../src/r23-auth/founder-uat-state';
import {
  founderUatForm,
  founderUatJson,
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

  try {
    const form = await founderUatForm(request, [
      'email',
      'messageId',
      'audience',
      'next',
    ]);
    const email = form.email?.trim().toLowerCase() ?? '';
    const messageId = form.messageId ?? '';
    if (!isValidFounderUatEmail(email)) throw new FounderUatInvalidRequest();

    const message = await readFounderUatMessageAction(config, email, messageId);
    if ('reviewPath' in message) {
      if (
        form.audience === 'candidate' ||
        !message.reviewPath.startsWith('/r27/organizations/')
      ) {
        throw new FounderUatMailMessageDenied();
      }
      return founderUatRedirect(
        config,
        message.reviewPath as `/r27/organizations/${string}`,
      );
    }

    const verificationType =
      message.kind === 'confirmation' ? 'signup' : 'recovery';
    const grant = await verifyR23Otp(
      config,
      email,
      message.otp,
      verificationType,
    );
    const identity = assertR23VerifiedIdentity(
      await verifyR23AccessToken(config, grant.accessToken, grant),
    );
    if (
      !identity.emailVerified ||
      identity.email?.trim().toLowerCase() !== email ||
      !identity.authMethods.includes('otp') ||
      (verificationType === 'signup' && identity.isRecovery !== false) ||
      (verificationType === 'recovery' && identity.isRecovery === null)
    ) {
      return founderUatJson(
        {
          error:
            'This message can no longer be verified. Check for a newer message and try again.',
        },
        400,
      );
    }

    const isCandidate =
      isHiringPlatformEnabled() && form.audience === 'candidate';
    const candidateNext = isCandidate ? candidateEntryPath(form.next) : null;

    if (verificationType === 'signup') {
      const signIn = isCandidate
        ? candidateSignInPath(candidateNext, { verified: true })
        : '/r23/login?verified=1';
      return founderUatRedirect(config, signIn, [clearFounderUatRecovery()]);
    }

    const resetDestination = isCandidate
      ? candidateResetPasswordPath(candidateNext)
      : '/r23/reset-password';

    return founderUatRedirect(config, resetDestination, [
      founderUatRecoveryCookie({
        subjectId: identity.subjectId,
        email,
        accessToken: grant.accessToken,
        expiresAt: identity.expiresAt,
        ...(isCandidate ? { audience: 'candidate' as const } : {}),
        ...(candidateNext ? { next: candidateNext } : {}),
      }),
    ]);
  } catch (error) {
    if (
      error instanceof R23AuthUnavailable ||
      error instanceof FounderUatMailUnavailable
    ) {
      return founderUatJson(
        {
          error:
            'Local verification is temporarily unavailable. Try again later.',
        },
        503,
      );
    }
    if (
      error instanceof FounderUatMailMessageDenied ||
      error instanceof FounderUatInvalidRequest ||
      error instanceof R23AuthenticationDenied
    ) {
      return founderUatJson(
        {
          error:
            'This message can no longer be verified. Check for a newer message and try again.',
        },
        400,
      );
    }
    if (error instanceof FounderUatRequestTooLarge) {
      return founderUatJson({ error: 'Request too large.' }, 413);
    }
    return founderUatJson(
      {
        error:
          'Local verification is temporarily unavailable. Try again later.',
      },
      503,
    );
  }
}
