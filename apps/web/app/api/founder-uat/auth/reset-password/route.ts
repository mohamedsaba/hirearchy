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
  if (!recovery) {
    return founderUatRedirect(config, '/r23/reset-password?error=expired', [
      clearFounderUatRecovery(),
    ]);
  }

  let password: string;
  try {
    const form = await founderUatForm(request, ['password']);
    password = form.password ?? '';
    if (password.length < 6 || password.length > 1024) {
      return founderUatRedirect(config, '/r23/reset-password?error=password');
    }
  } catch (error) {
    if (error instanceof FounderUatRequestTooLarge) {
      return founderUatRedirect(config, '/r23/reset-password?error=password');
    }
    if (error instanceof FounderUatInvalidRequest) {
      return founderUatRedirect(config, '/r23/reset-password?error=password');
    }
    return founderUatRedirect(config, '/r23/reset-password?error=unavailable');
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
      return founderUatRedirect(config, '/r23/reset-password?error=expired', [
        clearFounderUatRecovery(),
      ]);
    }
    await updateR23Password(config, recovery.accessToken, password);
    return founderUatRedirect(config, '/r23/login?reset=1', [
      clearFounderUatRecovery(),
    ]);
  } catch (error) {
    if (error instanceof R23PasswordUpdateDenied) {
      return founderUatRedirect(config, '/r23/reset-password?error=password');
    }
    if (error instanceof R23AuthenticationDenied) {
      return founderUatRedirect(config, '/r23/reset-password?error=expired', [
        clearFounderUatRecovery(),
      ]);
    }
    if (error instanceof R23AuthUnavailable) {
      return founderUatRedirect(
        config,
        '/r23/reset-password?error=unavailable',
      );
    }
    return founderUatRedirect(config, '/r23/reset-password?error=unavailable');
  }
}
