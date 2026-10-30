import {
  r211AssessmentDraftApiGet,
  r211AssessmentDraftApiPut,
} from '../../../../../../../src/r23-auth/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
) => {
  const { organizationId } = await params;
  return r211AssessmentDraftApiGet(request, organizationId);
};

export const PUT = async (
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
) => {
  const { organizationId } = await params;
  return r211AssessmentDraftApiPut(request, organizationId);
};
