import { enforceRateLimit } from '../../../../../src/security/rate-limit';
import { founderUatInvitationCookie } from '../../../../../src/r23-auth/founder-uat-state';
import {
  founderUatForm,
  founderUatJson,
  founderUatPostConfiguration,
  founderUatRedirect,
  FounderUatInvalidRequest,
  FounderUatRequestTooLarge,
} from '../../../../../src/r23-auth/founder-uat-server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const destinations = {
  login: '/r23/login',
  signup: '/r23/signup',
  accept: '/r23/invitations/accept?pending=1',
} as const;

export async function POST(request: Request): Promise<Response> {
  const config = founderUatPostConfiguration(request);
  if (config instanceof Response) return config;
  const rateLimitResponse = enforceRateLimit(request, 'auth');
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const form = await founderUatForm(request, ['token', 'destination']);
    const token = form.token ?? '';
    const destination = form.destination as keyof typeof destinations;
    if (
      typeof destination !== 'string' ||
      !Object.hasOwn(destinations, destination)
    ) {
      throw new FounderUatInvalidRequest();
    }
    const cookie = founderUatInvitationCookie(token, destination);
    return founderUatRedirect(config, destinations[destination], [cookie]);
  } catch (error) {
    if (error instanceof FounderUatRequestTooLarge) {
      return founderUatJson({ error: 'Request too large.' }, 413);
    }
    return founderUatJson(
      { error: 'Invitation context is invalid or expired.' },
      400,
    );
  }
}
