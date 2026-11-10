import { enforceRateLimit } from '../../../../src/security/rate-limit';
import { loadStagingConfiguration } from '../../../../src/staging/server';
import {
  founderUatPostMatchesOrigin,
  readFounderUatConfiguration,
} from '../../../../src/runtime/founder-uat';
import { isFounderUatProfile } from '../../../../src/runtime/profile';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const rateLimitResponse = enforceRateLimit(request, 'auth');
  if (rateLimitResponse) return rateLimitResponse;

  const founderUat = readFounderUatConfiguration();
  if (isFounderUatProfile() && !founderUat) {
    return Response.json(
      { error: 'Not found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (founderUat && !founderUatPostMatchesOrigin(request, founderUat)) {
    return Response.json(
      { error: 'Request origin denied' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const enabled =
    process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED === 'true';
  if (!enabled) {
    return Response.json(
      {
        error: 'Self-service onboarding is disabled',
        capabilities: {
          selfServiceOnboardingEnabled: false,
          emailDeliveryEnabled: false,
        },
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const config = loadStagingConfiguration();
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (
      !body ||
      typeof body.email !== 'string' ||
      typeof body.password !== 'string' ||
      !body.email.includes('@') ||
      body.password.length < 6
    ) {
      return Response.json(
        { error: 'Invalid email or password' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const authResponse = await fetch(
      new URL('/signup', config.auth.authUrl).toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          email: body.email.trim().toLowerCase(),
          password: body.password,
        }),
        signal: AbortSignal.timeout(5000),
      },
    );

    const data = (await authResponse.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!authResponse.ok) {
      return Response.json(
        { error: data?.msg || data?.error_description || 'Signup failed' },
        {
          status: authResponse.status,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }

    return Response.json(
      {
        user: data?.id ? data : data?.user,
        emailDeliveryEnabled: Boolean(founderUat),
        message: founderUat
          ? 'Check the local inbox for your verification code.'
          : 'User registration initiated. Automated email delivery is disabled in this environment.',
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (_err) {
    return Response.json(
      { error: 'Authentication service unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
