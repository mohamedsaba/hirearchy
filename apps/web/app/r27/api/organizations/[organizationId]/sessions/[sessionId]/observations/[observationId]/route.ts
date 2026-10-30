import {
  r29ObservationApiGet,
  r29ObservationApiPatch,
} from '../../../../../../../../../src/r23-auth/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const GET = async (
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      organizationId: string;
      sessionId: string;
      observationId: string;
    }>;
  },
) => {
  const { organizationId, sessionId, observationId } = await params;
  return r29ObservationApiGet(
    request,
    organizationId,
    sessionId,
    observationId,
  );
};

export const PATCH = async (
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      organizationId: string;
      sessionId: string;
      observationId: string;
    }>;
  },
) => {
  const { organizationId, sessionId, observationId } = await params;
  return r29ObservationApiPatch(
    request,
    organizationId,
    sessionId,
    observationId,
  );
};
