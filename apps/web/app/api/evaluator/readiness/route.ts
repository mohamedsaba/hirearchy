import { cookies } from 'next/headers';

import {
  evaluatorCookieName,
  isEvaluatorCookieValid,
} from '../../../../src/access/evaluator-access';
import { inspectApplicationReadiness } from '../../../../src/readiness';

export const dynamic = 'force-dynamic';

export const GET = async () => {
  const cookieStore = await cookies();
  if (!isEvaluatorCookieValid(cookieStore.get(evaluatorCookieName)?.value)) {
    return Response.json(
      {
        error: {
          code: 'EVALUATOR_ACCESS_REQUIRED',
          message: 'Evaluator access is required to view readiness.',
        },
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let report: Awaited<ReturnType<typeof inspectApplicationReadiness>>;
  try {
    report = await inspectApplicationReadiness();
  } catch {
    report = {
      service: 'hirearchy-web',
      status: 'not_ready',
      checks: {
        startup: 'failed',
        keyConfiguration: 'not_checked',
        keyAssociation: 'not_checked',
        database: 'not_ready',
        schema: 'not_checked',
        docker: 'not_ready',
        images: { scenario001: 'not_checked', scenario002: 'not_checked' },
        reconciliation: 'not_checked',
        provisioning: 'not_checked',
        ai: 'not_checked',
      },
    };
  }
  return Response.json(report, {
    status: report.status === 'ready' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
};
