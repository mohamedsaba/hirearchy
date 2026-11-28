import { NextResponse } from 'next/server';

import {
  hiringFailureJsonResponse,
  withHiringOrganizationSession,
} from '../../../../../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
): Promise<Response> {
  try {
    const { organizationId } = await params;
    return await withHiringOrganizationSession(
      request,
      organizationId,
      {},
      async ({ dispatch, organizationId: orgId }) => {
        const res = (await dispatch('hiring.library.health', {
          organizationId: orgId,
        })) as { problems?: unknown[]; benchmarks?: unknown[] };
        return NextResponse.json(
          {
            problems: res?.problems ?? [],
            benchmarks: res?.benchmarks ?? [],
          },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}
