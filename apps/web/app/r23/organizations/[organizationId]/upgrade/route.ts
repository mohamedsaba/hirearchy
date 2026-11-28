import { stagingOrganizationPlanGet } from '../../../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  const { organizationId } = await params;
  return stagingOrganizationPlanGet(request, organizationId, 'upgrade');
}
