import { withHiringCandidateSession } from '../../../../../../src/staging/browser';
import {
  r214CandidateExecutionAction,
  r214CandidateExecutionRead,
} from '../../../../../../src/r214-execution/server';

type CandidateRouteContext = Readonly<{
  params: Promise<{ sessionId: string }>;
}>;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request, context: CandidateRouteContext) {
  const { sessionId } = await context.params;
  return withHiringCandidateSession(request, sessionId, () =>
    r214CandidateExecutionRead(request, sessionId),
  );
}

export async function POST(request: Request, context: CandidateRouteContext) {
  const { sessionId } = await context.params;
  return withHiringCandidateSession(request, sessionId, () =>
    r214CandidateExecutionAction(request, sessionId),
  );
}
