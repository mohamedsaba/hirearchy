import { r210ReviewPacketFinalizeApiPost } from '../../../../../../../../../src/r23-auth/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const POST = async (
  request: Request,
  {
    params,
  }: { params: Promise<{ organizationId: string; sessionId: string }> },
) => {
  const { organizationId, sessionId } = await params;
  return r210ReviewPacketFinalizeApiPost(request, organizationId, sessionId);
};
