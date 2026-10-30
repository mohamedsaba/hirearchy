import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const evaluatorCookieName = 'hirearchy_evaluator';
export const EVALUATOR_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60; // 8 hours
export const EVALUATOR_TOKEN_MAX_AGE_MS =
  EVALUATOR_COOKIE_MAX_AGE_SECONDS * 1000;
/** Tolerance for clock skew between the issuing and validating processes. */
export const EVALUATOR_TOKEN_CLOCK_SKEW_TOLERANCE_MS = 60_000;

/**
 * Signed evaluator tokens are the ONLY accepted cookie value.
 *
 * `v1.<issuedAtMs>.<base64url signature>` — strict format, strict digits,
 * time-bounded, and compared in constant time. Unsigned/legacy values are
 * rejected outright so a stale static cookie can never authenticate.
 */
const EVALUATOR_TOKEN_PATTERN = /^v1\.(\d{1,15})\.([A-Za-z0-9_-]{1,128})$/;

export const getConfiguredEvaluatorCredential = () =>
  process.env.HIREARCHY_EVALUATOR_KEY ?? process.env.DELIMIT_EVALUATOR_KEY;

/**
 * Credential digest used for constant-time comparison of the raw shared
 * credential. This is NOT a cookie value and must never be issued as one.
 */
export const createEvaluatorCredentialDigest = (credential: string) =>
  createHash('sha256')
    .update(`hirearchy-evaluator:${credential}`)
    .digest('base64url');

export const createSignedEvaluatorToken = (
  credential: string,
  issuedAtMs = Date.now(),
) => {
  const payload = `v1:${issuedAtMs}`;
  const signature = createHmac('sha256', credential)
    .update(payload)
    .digest('base64url');
  return `v1.${issuedAtMs}.${signature}`;
};

export const isEvaluatorCredentialValid = (
  suppliedCredential: string,
  configuredCredential = getConfiguredEvaluatorCredential(),
) => {
  if (!configuredCredential || typeof suppliedCredential !== 'string') {
    return false;
  }

  const supplied = Buffer.from(
    createEvaluatorCredentialDigest(suppliedCredential),
  );
  const configured = Buffer.from(
    createEvaluatorCredentialDigest(configuredCredential),
  );

  return (
    supplied.length === configured.length &&
    timingSafeEqual(supplied, configured)
  );
};

export const isEvaluatorCookieValid = (
  suppliedCookie: string | undefined,
  configuredCredential = getConfiguredEvaluatorCredential(),
  nowMs = Date.now(),
) => {
  if (
    !suppliedCookie ||
    !configuredCredential ||
    typeof suppliedCookie !== 'string'
  ) {
    return false;
  }

  const match = EVALUATOR_TOKEN_PATTERN.exec(suppliedCookie);
  if (!match) {
    // Fails closed. Legacy static digest cookies are not accepted at all: they
    // carry no issuance time and can never be expired or revoked.
    return false;
  }

  const issuedAt = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    return false;
  }

  // Enforce expiration and reject tokens claiming implausible future issuance.
  if (
    nowMs - issuedAt > EVALUATOR_TOKEN_MAX_AGE_MS ||
    issuedAt > nowMs + EVALUATOR_TOKEN_CLOCK_SKEW_TOLERANCE_MS
  ) {
    return false;
  }

  const expectedSignature = createHmac('sha256', configuredCredential)
    .update(`v1:${issuedAt}`)
    .digest('base64url');
  const suppliedSig = Buffer.from(match[2], 'utf8');
  const expectedSig = Buffer.from(expectedSignature, 'utf8');

  return (
    suppliedSig.length === expectedSig.length &&
    timingSafeEqual(suppliedSig, expectedSig)
  );
};

export const isEvaluatorRequestAuthorized = (
  request: Request,
  cookieStore?: { get(name: string): { value: string } | undefined } | null,
  configuredCredential = getConfiguredEvaluatorCredential(),
): boolean => {
  if (!configuredCredential) {
    return false;
  }

  // 1. Next.js cookieStore
  const cookieFromStore = cookieStore?.get(evaluatorCookieName)?.value;
  if (
    cookieFromStore &&
    isEvaluatorCookieValid(cookieFromStore, configuredCredential)
  ) {
    return true;
  }

  // 2. Cookie header in request
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map((s) => s.trim());
    const prefix = `${evaluatorCookieName}=`;
    const found = cookies.find((c) => c.startsWith(prefix));
    if (found) {
      const val = found.slice(prefix.length);
      if (isEvaluatorCookieValid(val, configuredCredential)) {
        return true;
      }
    }
  }

  // 3. Authorization header: Bearer <token_or_credential>
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (
      isEvaluatorCookieValid(bearer, configuredCredential) ||
      isEvaluatorCredentialValid(bearer, configuredCredential)
    ) {
      return true;
    }
  }

  // 4. x-evaluator-key header
  const customHeader = request.headers.get('x-evaluator-key');
  if (customHeader) {
    const key = customHeader.trim();
    if (
      isEvaluatorCookieValid(key, configuredCredential) ||
      isEvaluatorCredentialValid(key, configuredCredential)
    ) {
      return true;
    }
  }

  return false;
};
