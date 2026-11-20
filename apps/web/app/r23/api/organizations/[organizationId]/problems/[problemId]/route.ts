import { r211ReusableProblemApi } from '../../../../../../../src/r23-auth/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

type Context = {
  params: Promise<{ organizationId: string; problemId: string }>;
};

export const GET = async (request: Request, { params }: Context) => {
  const { organizationId, problemId } = await params;
  return r211ReusableProblemApi(request, organizationId, 'get', problemId);
};

export const PATCH = async (request: Request, { params }: Context) => {
  const { organizationId, problemId } = await params;
  return r211ReusableProblemApi(request, organizationId, 'update', problemId);
};

export const DELETE = async (request: Request, { params }: Context) => {
  const { organizationId, problemId } = await params;
  return r211ReusableProblemApi(request, organizationId, 'delete', problemId);
};
