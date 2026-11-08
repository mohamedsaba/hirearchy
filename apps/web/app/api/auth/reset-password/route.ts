import { verifyR23AccessToken } from '../../../../src/r23-auth/identity';
import { enforceRateLimit } from '../../../../src/security/rate-limit';
import { loadStagingConfiguration } from '../../../../src/staging/server';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const rateLimitResponse = enforceRateLimit(request, 'auth');
  if (rateLimitResponse) return rateLimitResponse;

  const authHeader = request.headers.get('authorization');
  const match = authHeader?.match(/^Bearer ([A-Za-z0-9._-]{1,16384})$/);
  if (!match) {
    return Response.json(
      { error: 'Authentication denied' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const config = loadStagingConfiguration();
    const token = match[1];

    // Verify token with GoTrue
    const identity = await verifyR23AccessToken(config.auth, token);
    if (identity.isRecovery !== true) {
      return Response.json(
        { error: 'Recovery credential required for password reset' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (
      !body ||
      typeof body.password !== 'string' ||
      body.password.length < 6
    ) {
      return Response.json(
        { error: 'New password must be at least 6 characters' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // Call GoTrue PUT /user to update password
    const updateResponse = await fetch(
      new URL('/user', config.auth.authUrl).toString(),
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        body: JSON.stringify({ password: body.password }),
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!updateResponse.ok) {
      const data = (await updateResponse.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      return Response.json(
        {
          error:
            data?.msg || data?.error_description || 'Password update failed',
        },
        {
          status: updateResponse.status,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }

    return Response.json(
      {
        success: true,
        message:
          'Password updated successfully. Please sign in with your new credentials.',
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
