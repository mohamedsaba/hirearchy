import { r211ReusableProblemApi } from '../../../../../../src/r23-auth/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

type Context = { params: Promise<{ organizationId: string }> };

export const GET = async (request: Request, { params }: Context) => {
  const { organizationId } = await params;
  return r211ReusableProblemApi(request, organizationId, 'list');
};

export const POST = async (request: Request, { params }: Context) => {
  const { organizationId } = await params;
  return r211ReusableProblemApi(request, organizationId, 'create');
};
