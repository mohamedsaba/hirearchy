import {
  stagingOrganizationPlanGet,
  stagingOrganizationSettingsPost,
} from '../../../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  const { organizationId } = await params;
  return stagingOrganizationPlanGet(request, organizationId, 'plan');
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  const { organizationId } = await params;
  return stagingOrganizationSettingsPost(request, organizationId, 'plan');
}
