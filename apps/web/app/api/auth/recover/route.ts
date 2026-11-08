import { loadStagingConfiguration } from '../../../../src/staging/server';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
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
        emailDeliveryEnabled: false,
        message:
          'Password recovery initiated. Automated email delivery is disabled in this environment.',
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
