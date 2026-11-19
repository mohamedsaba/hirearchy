import { withHiringCandidateSession } from '../../../../../src/staging/browser';
import {
  r26CandidateAction,
  r26CandidateRead,
} from '../../../../../src/r26-candidate/server';

type CandidateRouteContext = Readonly<{
  params: Promise<{ sessionId: string }>;
}>;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request, context: CandidateRouteContext) {
  const { sessionId } = await context.params;
  return withHiringCandidateSession(request, sessionId, () =>
    r26CandidateRead(request, sessionId),
  );
}

export async function POST(request: Request, context: CandidateRouteContext) {
  const { sessionId } = await context.params;
  return withHiringCandidateSession(request, sessionId, () =>
    r26CandidateAction(request, sessionId),
  );
}
