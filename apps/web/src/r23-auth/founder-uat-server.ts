import {
  founderUatPostMatchesOrigin,
  readFounderUatConfiguration,
  type FounderUatConfiguration,
} from '../runtime/founder-uat';
import { isFounderUatProfile } from '../runtime/profile';

export class FounderUatInvalidRequest extends Error {}
export class FounderUatRequestTooLarge extends Error {}

export function founderUatJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function founderUatNotFound(): Response {
  return founderUatJson({ error: 'Not found' }, 404);
}

export function founderUatPostConfiguration(
  request: Request,
): FounderUatConfiguration | Response {
  if (!isFounderUatProfile()) return founderUatNotFound();
  const config = readFounderUatConfiguration();
  if (!config) return founderUatNotFound();
  if (!founderUatPostMatchesOrigin(request, config)) {
    return founderUatJson({ error: 'Request origin denied' }, 403);
  }
  return config;
}

export function founderUatRedirect(
  config: FounderUatConfiguration,
  path:
    | '/r23/login?verified=1'
    | '/r23/login?reset=1'
    | '/r23/login'
    | '/r23/signup'
    | '/r23/reset-password'
    | '/r23/reset-password?error=expired'
    | '/r23/reset-password?error=password'
    | '/r23/reset-password?error=unavailable'
    | '/r23/invitations/accept?pending=1',
  cookies: string[] = [],
): Response {
  const headers = new Headers({
    'Cache-Control': 'private, no-store, max-age=0',
    Location: new URL(path, config.appOrigin).toString(),
    'Referrer-Policy': 'no-referrer',
  });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

export async function founderUatForm(
  request: Request,
  allowedFields: readonly string[],
): Promise<Record<string, string>> {
  if (
    request.headers.get('content-type')?.split(';')[0].trim() !==
    'application/x-www-form-urlencoded'
  ) {
    throw new FounderUatInvalidRequest();
  }
  const length = request.headers.get('content-length');
  if (length !== null && !/^\d+$/.test(length)) {
    throw new FounderUatInvalidRequest();
  }
  if (length !== null && Number(length) > 8192) {
    throw new FounderUatRequestTooLarge();
  }
  if (!request.body) throw new FounderUatInvalidRequest();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel().catch(() => undefined);
        throw new FounderUatRequestTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new FounderUatInvalidRequest();
  }
  const form = new URLSearchParams(decoded);
  const result: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [key, value] of form) {
    if (!allowedFields.includes(key) || Object.hasOwn(result, key)) {
      throw new FounderUatInvalidRequest();
    }
    result[key] = value;
  }
  return result;
}
