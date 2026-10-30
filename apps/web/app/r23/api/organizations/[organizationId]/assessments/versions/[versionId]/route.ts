import { r211AssessmentVersionApiGet } from '../../../../../../../../src/r23-auth/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const GET = async (
  request: Request,
  {
    params,
  }: { params: Promise<{ organizationId: string; versionId: string }> },
) => {
  const { organizationId, versionId } = await params;
  return r211AssessmentVersionApiGet(request, organizationId, versionId);
};
