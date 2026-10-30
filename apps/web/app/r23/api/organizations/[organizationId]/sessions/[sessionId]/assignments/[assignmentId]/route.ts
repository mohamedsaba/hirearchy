import { r25SessionAssignmentRevocationApi } from '../../../../../../../../../src/r23-auth/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const POST = async (
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      organizationId: string;
      sessionId: string;
      assignmentId: string;
    }>;
  },
) => {
  const { organizationId, sessionId, assignmentId } = await params;
  return r25SessionAssignmentRevocationApi(
    request,
    organizationId,
    sessionId,
    assignmentId,
  );
};

export const DELETE = async (
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      organizationId: string;
      sessionId: string;
      assignmentId: string;
    }>;
  },
) => {
  const { organizationId, sessionId, assignmentId } = await params;
  return r25SessionAssignmentRevocationApi(
    request,
    organizationId,
    sessionId,
    assignmentId,
  );
};
