import { r28RevisionApiGet } from '../../../../../../../../../../src/r23-auth/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const GET = async (
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      organizationId: string;
      sessionId: string;
      sequence: string;
    }>;
  },
) => {
  const { organizationId, sessionId, sequence } = await params;
  return r28RevisionApiGet(request, organizationId, sessionId, sequence);
};
