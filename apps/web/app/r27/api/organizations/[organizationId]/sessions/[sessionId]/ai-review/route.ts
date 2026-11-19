import {
  r27AiReviewApiGet,
  r27AiReviewApiPost,
} from '../../../../../../../../src/r23-auth/server';

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
  return r27AiReviewApiGet(request, organizationId, sessionId);
};

export const POST = async (
  request: Request,
  {
    params,
  }: { params: Promise<{ organizationId: string; sessionId: string }> },
) => {
  const { organizationId, sessionId } = await params;
  return r27AiReviewApiPost(request, organizationId, sessionId);
};
