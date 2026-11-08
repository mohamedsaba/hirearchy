import { checkOperationalReadiness } from '../../../../src/observability/readiness.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const report = await checkOperationalReadiness();
  const statusCode = report.status === 'ready' ? 200 : 503;

  return Response.json(report, {
    status: statusCode,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
