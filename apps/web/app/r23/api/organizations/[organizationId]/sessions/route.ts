import {
  r24OrganizationSessionsApiGet,
  r25AssessmentIssuanceApiPost,
} from '../../../../../../src/r23-auth/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
) => {
  const { organizationId } = await params;
  return r24OrganizationSessionsApiGet(request, organizationId);
};

export const POST = async (
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
) => {
  const { organizationId } = await params;
  return r25AssessmentIssuanceApiPost(request, organizationId);
};
