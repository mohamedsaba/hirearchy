import { r211ReusableProblemApi } from '../../../../../../../../src/r23-auth/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

type Context = {
  params: Promise<{ organizationId: string; problemId: string }>;
};

export const POST = async (request: Request, { params }: Context) => {
  const { organizationId, problemId } = await params;
  return r211ReusableProblemApi(request, organizationId, 'reuse', problemId);
};
