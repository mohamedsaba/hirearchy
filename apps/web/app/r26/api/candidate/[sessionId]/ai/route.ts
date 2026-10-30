import {
  r212CandidateAiAction,
  r212CandidateAiRead,
} from '../../../../../../src/r212-ai/server';

type CandidateRouteContext = Readonly<{
  params: Promise<{ sessionId: string }>;
}>;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request, context: CandidateRouteContext) {
  const { sessionId } = await context.params;
  return r212CandidateAiRead(request, sessionId);
}

export async function POST(request: Request, context: CandidateRouteContext) {
  const { sessionId } = await context.params;
  return r212CandidateAiAction(request, sessionId);
}
