const verifiedIdentities = new WeakSet();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class AuthenticationDenied extends Error {
  constructor() {
    super('Authentication denied');
    this.name = 'AuthenticationDenied';
    this.code = 'AUTH_DENIED';
  }
}

function deny() {
  throw new AuthenticationDenied();
}

function jsonSegment(segment) {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) deny();
  try {
    const value = JSON.parse(
      Buffer.from(segment, 'base64url').toString('utf8'),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) deny();
    return value;
  } catch {
    deny();
  }
}

function userEndpoint(authUrl) {
  let endpoint;
  try {
    endpoint = new URL(authUrl);
  } catch {
    deny();
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    deny();
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/user`;
  return endpoint;
}

export function assertVerifiedIdentity(identity) {
  if (
    !identity ||
    typeof identity !== 'object' ||
    !verifiedIdentities.has(identity)
  ) {
    deny();
  }
  return identity;
}

export function createAuthVerifier({ authUrl, issuer, audience }) {
  if (
    typeof issuer !== 'string' ||
    !issuer ||
    typeof audience !== 'string' ||
    !audience
  ) {
    deny();
  }
  const endpoint = userEndpoint(authUrl);

  return async function verify(token) {
    if (typeof token !== 'string' || token.length > 16384) deny();
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[2]) deny();
    const header = jsonSegment(parts[0]);
    const claims = jsonSegment(parts[1]);
    if (typeof header.alg !== 'string' || header.alg.toLowerCase() === 'none')
      deny();
    if (
      typeof claims.sub !== 'string' ||
      !UUID.test(claims.sub) ||
      typeof claims.session_id !== 'string' ||
      !UUID.test(claims.session_id) ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= Date.now() / 1000 ||
      claims.iss !== issuer ||
      !(
        claims.aud === audience ||
        (Array.isArray(claims.aud) && claims.aud.includes(audience))
      )
    ) {
      deny();
    }

    let response;
    try {
      response = await fetch(endpoint, {
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      deny();
    }
    if (!response.ok) deny();

    let user;
    try {
      user = await response.json();
    } catch {
      deny();
    }
    if (
      !user ||
      typeof user !== 'object' ||
      Array.isArray(user) ||
      typeof user.id !== 'string' ||
      !UUID.test(user.id) ||
      user.id.toLowerCase() !== claims.sub.toLowerCase() ||
      (user.email_confirmed_at !== undefined &&
        user.email_confirmed_at !== null &&
        (typeof user.email_confirmed_at !== 'string' ||
          !Number.isFinite(Date.parse(user.email_confirmed_at)))) ||
      (user.email !== undefined &&
        user.email !== null &&
        typeof user.email !== 'string')
    ) {
      deny();
    }
    if (claims.exp <= Date.now() / 1000) deny();

    const identity = Object.freeze({
      subjectId: claims.sub.toLowerCase(),
      sessionId: claims.session_id.toLowerCase(),
      assurance:
        claims.aal === 'aal1' || claims.aal === 'aal2' ? claims.aal : null,
      email: user.email ?? null,
      emailVerified: typeof user.email_confirmed_at === 'string',
    });
    verifiedIdentities.add(identity);
    return identity;
  };
}
