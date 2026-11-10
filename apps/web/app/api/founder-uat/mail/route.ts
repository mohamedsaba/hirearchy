import { enforceRateLimit } from '../../../../src/security/rate-limit';
import {
  readFounderUatConfiguration,
  isValidFounderUatEmail,
} from '../../../../src/runtime/founder-uat';
import {
  FounderUatMailUnavailable,
  listFounderUatMessages,
} from '../../../../src/runtime/founder-uat-mail';
import {
  founderUatJson,
  founderUatNotFound,
} from '../../../../src/r23-auth/founder-uat-server';
import { isFounderUatProfile } from '../../../../src/runtime/profile';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  if (!isFounderUatProfile()) return founderUatNotFound();
  const config = readFounderUatConfiguration();
  if (!config) return founderUatNotFound();
  const rateLimitResponse = enforceRateLimit(request, 'auth');
  if (rateLimitResponse) return rateLimitResponse;

  const url = new URL(request.url);
  const values = url.searchParams.getAll('email');
  if (values.length !== 1 || !isValidFounderUatEmail(values[0])) {
    return founderUatJson({ error: 'A valid email address is required.' }, 400);
  }
  try {
    const messages = await listFounderUatMessages(config, values[0]);
    return founderUatJson({ messages });
  } catch (error) {
    if (error instanceof FounderUatMailUnavailable) {
      return founderUatJson(
        { error: 'Local inbox is temporarily unavailable.' },
        503,
      );
    }
    return founderUatJson({ error: 'A valid email address is required.' }, 400);
  }
}
