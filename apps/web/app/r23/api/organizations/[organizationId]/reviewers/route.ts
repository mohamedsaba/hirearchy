import {
  disabledResponse,
  r23IsEnabled,
  r25OrganizationReviewersApiGet,
} from '../../../../../../src/r23-auth/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
) => {
  const { organizationId } = await params;
  return r25OrganizationReviewersApiGet(request, organizationId);
};

export const POST = async (request: Request) => {
  if (!r23IsEnabled()) return disabledResponse(request);
  return new Response(null, { status: 405 });
};
