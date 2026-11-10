import { enforceRateLimit } from '../../../../src/security/rate-limit';
import { loadStagingConfiguration } from '../../../../src/staging/server';
import { isFounderUatProfile } from '../../../../src/runtime/profile';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  if (isFounderUatProfile()) {
    return Response.json(
      { error: 'Not found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const rateLimitResponse = enforceRateLimit(request, 'auth');
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const config = loadStagingConfiguration();
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const token = body?.token;
    const tokenHash = body?.tokenHash;
    const type = body?.type || 'signup';

    const url = new URL('/verify', config.auth.authUrl);
    if (tokenHash && typeof tokenHash === 'string') {
      url.searchParams.set('token_hash', tokenHash);
    } else if (token && typeof token === 'string') {
      url.searchParams.set('token', token);
    } else {
      return Response.json(
        { error: 'Verification token required' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    url.searchParams.set('type', typeof type === 'string' ? type : 'signup');

    const authResponse = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    if (
      authResponse.status === 200 ||
      authResponse.status === 302 ||
      authResponse.status === 303
    ) {
      return Response.json(
        { success: true, message: 'Email confirmed successfully' },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return Response.json(
      { error: 'Email verification failed' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { error: 'Authentication service unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
