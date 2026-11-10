import { readFounderUatConfiguration } from '../../../../../../src/runtime/founder-uat';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const templates = {
  confirmation:
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Confirm your Hirearchy account</title><body><h1>Confirm your Hirearchy account</h1><p>Use this one-time code to confirm your email address:</p><p><strong>{{ .Token }}</strong></p><p>Return to Hirearchy to enter the code.</p></body></html>',
  recovery:
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Reset your Hirearchy password</title><body><h1>Reset your Hirearchy password</h1><p>Use this one-time code to continue your password reset:</p><p><strong>{{ .Token }}</strong></p><p>If you did not request this, you can ignore this message.</p></body></html>',
} as const;

export async function GET(
  _request: Request,
  context: { params: Promise<{ kind: string }> },
): Promise<Response> {
  if (!readFounderUatConfiguration()) {
    return new Response(null, {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const { kind } = await context.params;
  if (kind !== 'confirmation' && kind !== 'recovery') {
    return new Response(null, {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  return new Response(templates[kind], {
    status: 200,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
