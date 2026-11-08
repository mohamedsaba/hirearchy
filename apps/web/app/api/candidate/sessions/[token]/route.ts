import { errorResponse } from '../../../../../src/http/error-response';
import { enforceRateLimit } from '../../../../../src/security/rate-limit';
import { toCandidateSessionView } from '../../../../../src/sessions/candidate-session-view';
import { getSessionService } from '../../../../../src/sessions/session-service';

type CandidateRouteContext = Readonly<{
  params: Promise<{ token: string }>;
}>;

export const GET = async (request: Request, context: CandidateRouteContext) => {
  const rateLimitResponse = enforceRateLimit(request, 'candidate');
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const { token } = await context.params;
    const sessionService = getSessionService();
    const session = sessionService.getCandidateSession(token);
    return Response.json(toCandidateSessionView(session, sessionService.now()));
  } catch (error) {
    return errorResponse(error);
  }
};
