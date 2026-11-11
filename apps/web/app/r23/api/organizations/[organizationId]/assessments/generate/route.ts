import { stagingAssessmentGenerateApiPost } from '../../../../../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const POST = async (
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
) => {
  const { organizationId } = await params;
  return stagingAssessmentGenerateApiPost(request, organizationId);
};
