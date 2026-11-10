import type { R23Config } from './config';

export type R23IdentityConfig = Pick<
  R23Config,
  'authUrl' | 'authIssuer' | 'authAudience'
>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const verifiedIdentities = new WeakSet<object>();

export type R23VerifiedIdentity = Readonly<{
  subjectId: string;
  sessionId: string;
  assurance: 'aal1' | 'aal2';
  email: string | null;
  emailVerified: boolean;
  isRecovery: boolean | null;
  authMethods: readonly string[];
  expiresAt: number;
}>;

export class R23AuthenticationDenied extends Error {
  readonly code = 'AUTHENTICATION_DENIED';

  constructor() {
    super('Authentication denied');
    this.name = 'R23AuthenticationDenied';
  }
}

export class R23AuthUnavailable extends Error {
  readonly code = 'AUTH_SERVICE_UNAVAILABLE';

  constructor() {
    super('Authentication service unavailable');
    this.name = 'R23AuthUnavailable';
  }
}

export class R23PasswordUpdateDenied extends Error {
  readonly code = 'PASSWORD_UPDATE_DENIED';

  constructor() {
    super('Password update denied');
    this.name = 'R23PasswordUpdateDenied';
  }
}

type Claims = Record<string, unknown> & {
  sub: string;
  session_id: string;
  aal: 'aal1' | 'aal2';
  exp: number;
};

function denied(): never {
  throw new R23AuthenticationDenied();
}

const KNOWN_AMR_METHODS = new Set([
  'password',
  'otp',
  'magiclink',
  'recovery',
  'mfa/totp',
]);

function classifyAmr(
  amr: unknown,
): { isRecovery: boolean; methods: readonly string[] } | null {
  if (!Array.isArray(amr) || amr.length === 0) return null;
  let isRecovery = false;
  const methods: string[] = [];
  for (const entry of amr) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return null;
    const { method, timestamp } = entry as Record<string, unknown>;
    if (
      typeof method !== 'string' ||
      method.trim().length === 0 ||
      !KNOWN_AMR_METHODS.has(method) ||
      typeof timestamp !== 'number' ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0
    ) {
      return null;
    }
    if (method === 'recovery') isRecovery = true;
    methods.push(method);
  }
  return Object.freeze({ isRecovery, methods: Object.freeze(methods) });
}

function parseSegment(segment: string): Record<string, unknown> {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return denied();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return denied();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return denied();
  return value as Record<string, unknown>;
}

export function readR23Claims(
  token: string,
  config: R23IdentityConfig,
): Claims {
  if (token.length > 16384) return denied();
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[2]) return denied();
  const header = parseSegment(parts[0]);
  const claims = parseSegment(parts[1]);
  const audiences = claims.aud;
  if (
    typeof header.alg !== 'string' ||
    header.alg.toLowerCase() === 'none' ||
    typeof claims.sub !== 'string' ||
    !UUID.test(claims.sub) ||
    typeof claims.session_id !== 'string' ||
    !UUID.test(claims.session_id) ||
    claims.iss !== config.authIssuer ||
    !(
      audiences === config.authAudience ||
      (Array.isArray(audiences) && audiences.includes(config.authAudience))
    ) ||
    (claims.aal !== 'aal1' && claims.aal !== 'aal2') ||
    !Number.isFinite(claims.exp)
  ) {
    return denied();
  }
  return claims as Claims;
}

async function readJson(response: Response, limit: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) return denied();
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        try {
          await reader.cancel();
        } catch {
          throw new R23AuthUnavailable();
        }
        throw new R23AuthUnavailable();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return denied();
    return value as Record<string, unknown>;
  } catch {
    return denied();
  }
}

async function requestAuth(url: URL, init: RequestInit): Promise<Response> {
  try {
    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (response.status >= 500 || response.status === 429)
      throw new R23AuthUnavailable();
    return response;
  } catch (error) {
    if (error instanceof R23AuthUnavailable) throw error;
    throw new R23AuthUnavailable();
  }
}

function endpoint(config: R23IdentityConfig, path: string): URL {
  return new URL(path, config.authUrl);
}

export type R23CredentialPair = Readonly<{
  accessToken: string;
  refreshToken: string;
}>;

export type R23TokenGrant = R23CredentialPair &
  Readonly<{
    expiresIn: number;
    reportedExpiresAt: number | null;
  }>;

function credentialPair(value: Record<string, unknown>): R23TokenGrant {
  if (
    typeof value.access_token !== 'string' ||
    value.access_token.length === 0 ||
    value.access_token.length > 16384 ||
    typeof value.refresh_token !== 'string' ||
    value.refresh_token.length === 0 ||
    value.refresh_token.length > 16384 ||
    typeof value.expires_in !== 'number' ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    (value.expires_at !== undefined &&
      (typeof value.expires_at !== 'number' ||
        !Number.isFinite(value.expires_at)))
  ) {
    return denied();
  }
  return Object.freeze({
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresIn: value.expires_in,
    reportedExpiresAt:
      typeof value.expires_at === 'number' ? value.expires_at : null,
  });
}

export async function passwordGrant(
  config: R23IdentityConfig,
  email: string,
  password: string,
): Promise<R23TokenGrant> {
  const response = await requestAuth(
    endpoint(config, '/token?grant_type=password'),
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    },
  );
  if (!response.ok) return denied();
  return credentialPair(await readJson(response, 65536));
}

export async function refreshGrant(
  config: R23IdentityConfig,
  refreshToken: string,
): Promise<R23TokenGrant> {
  const response = await requestAuth(
    endpoint(config, '/token?grant_type=refresh_token'),
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
  );
  if (!response.ok) return denied();
  return credentialPair(await readJson(response, 65536));
}

export async function revokeAuthSession(
  config: R23IdentityConfig,
  accessToken: string,
): Promise<void> {
  const response = await requestAuth(endpoint(config, '/logout?scope=local'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!response.ok) return denied();
}

export async function verifyR23Otp(
  config: R23IdentityConfig,
  email: string,
  token: string,
  type: 'signup' | 'recovery',
): Promise<R23TokenGrant & { type: 'signup' | 'recovery' }> {
  if (!email || email.length > 320 || !/^\d{6}$/.test(token)) return denied();
  const response = await requestAuth(endpoint(config, '/verify'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, token, type }),
  });
  if (!response.ok) return denied();
  const value = await readJson(response, 65536);
  return Object.freeze({ ...credentialPair(value), type });
}

export async function updateR23Password(
  config: R23IdentityConfig,
  accessToken: string,
  password: string,
): Promise<void> {
  const response = await requestAuth(endpoint(config, '/user'), {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });
  if (response.status === 400 || response.status === 422) {
    throw new R23PasswordUpdateDenied();
  }
  if (!response.ok) return denied();
  await readJson(response, 65536);
}

export async function verifyR23AccessToken(
  config: R23IdentityConfig,
  accessToken: string,
  expectedExpiry?: Pick<R23TokenGrant, 'expiresIn' | 'reportedExpiresAt'>,
): Promise<R23VerifiedIdentity> {
  if (typeof accessToken !== 'string' || !accessToken) return denied();
  const claims = readR23Claims(accessToken, config);
  if (claims.exp <= Date.now() / 1000) return denied();
  if (
    expectedExpiry &&
    (Math.abs(claims.exp - (Date.now() / 1000 + expectedExpiry.expiresIn)) >
      60 ||
      (expectedExpiry.reportedExpiresAt !== null &&
        Math.abs(claims.exp - expectedExpiry.reportedExpiresAt) > 60))
  ) {
    return denied();
  }
  const response = await requestAuth(endpoint(config, '/user'), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) return denied();
  const user = await readJson(response, 16384);
  if (
    typeof user.id !== 'string' ||
    !UUID.test(user.id) ||
    user.id.toLowerCase() !== claims.sub.toLowerCase() ||
    (user.email !== undefined &&
      user.email !== null &&
      typeof user.email !== 'string') ||
    (user.email_confirmed_at !== undefined &&
      user.email_confirmed_at !== null &&
      (typeof user.email_confirmed_at !== 'string' ||
        !Number.isFinite(Date.parse(user.email_confirmed_at))))
  ) {
    return denied();
  }
  if (claims.exp <= Date.now() / 1000) return denied();
  const amr = classifyAmr(claims.amr);
  const identity = Object.freeze({
    subjectId: claims.sub.toLowerCase(),
    sessionId: claims.session_id.toLowerCase(),
    assurance: claims.aal,
    email: typeof user.email === 'string' ? user.email : null,
    emailVerified: typeof user.email_confirmed_at === 'string',
    isRecovery: amr?.isRecovery ?? null,
    authMethods: amr?.methods ?? Object.freeze([]),
    expiresAt: claims.exp,
  });
  verifiedIdentities.add(identity);
  return identity;
}

export function assertR23VerifiedIdentity(value: unknown): R23VerifiedIdentity {
  if (!value || typeof value !== 'object' || !verifiedIdentities.has(value))
    return denied();
  return value as R23VerifiedIdentity;
}

export function assertR23StagingEligibleIdentity(
  value: unknown,
): R23VerifiedIdentity {
  const identity = assertR23VerifiedIdentity(value);
  if (
    identity.isRecovery !== false ||
    !identity.authMethods.includes('password')
  ) {
    return denied();
  }
  return identity;
}
