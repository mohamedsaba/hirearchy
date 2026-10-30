import { NextResponse } from 'next/server';

import {
  createSignedEvaluatorToken,
  EVALUATOR_COOKIE_MAX_AGE_SECONDS,
  evaluatorCookieName,
  getConfiguredEvaluatorCredential,
  isEvaluatorCredentialValid,
} from '../../../../src/access/evaluator-access';
import { evaluatorAccessRateLimiter } from '../../../../src/access/evaluator-access-rate-limiter';
import { resolveRateLimitClientIdentity } from '../../../../src/access/trusted-proxy-client-identity';

/**
 * A refused trusted-proxy configuration is a deployment fault, so it is logged
 * once per process rather than on every login attempt.
 */
let hasWarnedAboutRefusedBoundary = false;

export const POST = async (request: Request) => {
  // Forwarding headers are never treated as authoritative: this runtime cannot
  // verify a trusted proxy peer address, so every login attempt shares one
  // bounded bucket. A positive hop configuration is refused, not downgraded
  // silently. See trusted-proxy-client-identity.ts.
  const clientIdentity = resolveRateLimitClientIdentity();
  if (clientIdentity.operatorWarning && !hasWarnedAboutRefusedBoundary) {
    hasWarnedAboutRefusedBoundary = true;
    console.warn(clientIdentity.operatorWarning);
  }
  const clientKey = clientIdentity.key;

  // Check rate limit before reading body
  const { blocked, retryAfterSeconds } =
    evaluatorAccessRateLimiter.isBlocked(clientKey);
  if (blocked) {
    return Response.json(
      {
        error: {
          code: 'TOO_MANY_ATTEMPTS',
          message:
            'Too many failed authentication attempts. Please try again later.',
        },
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(retryAfterSeconds),
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      {
        error: {
          code: 'INVALID_EVALUATOR_REQUEST',
          message: 'The evaluator access request must contain valid JSON.',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json(
      {
        error: {
          code: 'INVALID_EVALUATOR_REQUEST',
          message: 'The evaluator access request must be an object.',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (!getConfiguredEvaluatorCredential()) {
    return Response.json(
      {
        error: {
          code: 'EVALUATOR_NOT_CONFIGURED',
          message:
            'Set HIREARCHY_EVALUATOR_KEY or DELIMIT_EVALUATOR_KEY before opening evidence review.',
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const { credential } = body as { credential?: unknown };

  if (
    typeof credential !== 'string' ||
    !isEvaluatorCredentialValid(credential)
  ) {
    const failureStatus = evaluatorAccessRateLimiter.recordFailure(clientKey);
    if (failureStatus.blocked) {
      return Response.json(
        {
          error: {
            code: 'TOO_MANY_ATTEMPTS',
            message:
              'Too many failed authentication attempts. Please try again later.',
          },
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(failureStatus.retryAfterSeconds),
            'Cache-Control': 'no-store',
          },
        },
      );
    }

    return Response.json(
      {
        error: {
          code: 'INVALID_EVALUATOR_CREDENTIAL',
          message: 'The evaluator credential is not valid.',
        },
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  evaluatorAccessRateLimiter.recordSuccess(clientKey);

  const response = NextResponse.json({ authenticated: true });
  response.cookies.set({
    name: evaluatorCookieName,
    value: createSignedEvaluatorToken(credential),
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: EVALUATOR_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
};
