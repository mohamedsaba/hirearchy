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

  try {
    const config = loadStagingConfiguration();
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body.email !== 'string' || !body.email.includes('@')) {
      return Response.json(
        { error: 'Invalid email address' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const authResponse = await fetch(
      new URL('/recover', config.auth.authUrl).toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          email: body.email.trim().toLowerCase(),
        }),
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!authResponse.ok) {
      const data = (await authResponse.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      return Response.json(
        {
          error:
            data?.msg ||
            data?.error_description ||
            'Password recovery request failed',
        },
        {
          status: authResponse.status,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }

    return Response.json(
      {
        success: true,
        emailDeliveryEnabled: Boolean(founderUat),
        message: founderUat
          ? 'Check the local inbox for your password recovery code.'
          : 'Password recovery initiated. Automated email delivery is disabled in this environment.',
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
