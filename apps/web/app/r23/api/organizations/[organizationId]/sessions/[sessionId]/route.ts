import { r24OrganizationSessionSummaryApiGet } from '../../../../../../../src/r23-auth/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const GET = async (
  request: Request,
  {
    params,
  }: { params: Promise<{ organizationId: string; sessionId: string }> },
) => {
  const { organizationId, sessionId } = await params;
  return r24OrganizationSessionSummaryApiGet(
    request,
    organizationId,
    sessionId,
  );
};
