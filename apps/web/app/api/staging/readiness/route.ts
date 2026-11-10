import { checkOperationalReadiness } from '../../../../src/observability/readiness.mjs';
import { getFounderUatAutomationRunId } from '../../../../src/runtime/founder-uat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const report = await checkOperationalReadiness();
  const founderUatAutomationRunId = getFounderUatAutomationRunId();
  const responseBody = founderUatAutomationRunId
    ? { ...report, founderUatAutomationRunId }
    : report;
  const statusCode = report.status === 'ready' ? 200 : 503;

  return Response.json(responseBody, {
    status: statusCode,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
