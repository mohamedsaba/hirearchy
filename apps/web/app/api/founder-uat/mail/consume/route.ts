import { enforceRateLimit } from '../../../../../src/security/rate-limit';
import {
  FounderUatMailMessageDenied,
  FounderUatMailUnavailable,
  readFounderUatMessageOtp,
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
    const form = await founderUatForm(request, ['email', 'messageId']);
    const email = form.email?.trim().toLowerCase() ?? '';
    const messageId = form.messageId ?? '';
    if (!isValidFounderUatEmail(email)) throw new FounderUatInvalidRequest();

    const message = await readFounderUatMessageOtp(config, email, messageId);
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

    if (verificationType === 'signup') {
      return founderUatRedirect(config, '/r23/login?verified=1', [
        clearFounderUatRecovery(),
      ]);
    }

    return founderUatRedirect(config, '/r23/reset-password', [
      founderUatRecoveryCookie({
        subjectId: identity.subjectId,
        email,
        accessToken: grant.accessToken,
        expiresAt: identity.expiresAt,
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
