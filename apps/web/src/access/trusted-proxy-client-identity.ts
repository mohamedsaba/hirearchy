/**
 * Rate-limit client identity for evaluator authentication.
 *
 * Threat model
 * ------------
 * `x-forwarded-for` and `x-real-ip` are ordinary request headers that any
 * caller can set. Using them as the rate-limit identity lets an attacker mint
 * unlimited identities by rotating the header, which disables brute-force
 * protection entirely.
 *
 * Why forwarding headers are NEVER authoritative in this runtime
 * --------------------------------------------------------------
 * Deriving identity from those headers is only sound when the application can
 * verify that the immediate peer is a trusted proxy. It cannot:
 *
 *   - The Web `Request` API exposes no peer socket address.
 *   - Next.js 15 and later REMOVED `NextRequest.ip` and `NextRequest.geo`
 *     precisely because those values are supplied by the hosting provider.
 *     The local `next/server` request types expose no ip or socket field.
 *   - The documented replacement (`@vercel/functions`) is Vercel-specific
 *     platform infrastructure, which this deployment does not use.
 *
 * Without a verifiable peer address there is no way to distinguish "the proxy
 * appended this entry" from "the caller sent this entry". A hop count declared
 * in configuration cannot substitute for that proof, so this runtime does not
 * honor one.
 *
 * Policy
 * ------
 * The identity is always the single shared fallback bucket, and forwarding
 * headers are never read. A positive `HIREARCHY_TRUSTED_PROXY_HOPS` value is
 * REFUSED rather than silently downgraded:
 *   - it fails securely, because the headers stay untrusted and the shared
 *     bounded bucket still applies;
 *   - it fails visibly, because the refusal is reported on `GET /api/health`,
 *     logged by the login route, and returned by `resolveRateLimitClientIdentity`.
 *
 * An operator who believes forwarding headers are in use gets an explicit
 * signal, not silent weakening.
 *
 * DENIAL-OF-SERVICE TRADE-OFF (accepted for the controlled pilot)
 * --------------------------------------------------------------
 * One shared bucket means an unauthenticated caller who can reach
 * `POST /api/evaluator/access` can trigger the block window and lock the
 * legitimate evaluator out for `blockDurationMs`. That is an availability
 * trade-off, accepted knowingly in exchange for never trusting unverified
 * input. It is appropriate only for the controlled local pilot.
 *
 * PUBLIC DEPLOYMENT REQUIREMENT
 * -----------------------------
 * Any deployment reachable by untrusted networks requires a SEPARATELY
 * VERIFIED proxy and network security design before evaluator access is
 * exposed. That design must establish a trustworthy peer address — a trusted
 * proxy that overwrites `x-forwarded-for` combined with a network boundary that
 * makes the application port reachable only through that proxy — and must be
 * reviewed as its own change. Enabling `HIREARCHY_TRUSTED_PROXY_HOPS` alone
 * does not and cannot provide it.
 *
 * See `docs/architecture/trusted-proxy-policy.md`.
 */

export const DEFAULT_TRUSTED_PROXY_HOPS = 0;
export const MAX_TRUSTED_PROXY_HOPS = 8;

/** Shared identity used whenever no trustworthy client address is available. */
export const UNIDENTIFIED_CLIENT_KEY = 'unidentified-client';

const HOP_COUNT_PATTERN = /^\d{1,3}$/;

export type TrustedProxyBoundaryStatus =
  /** No trusted proxy was declared. Expected posture for the local pilot. */
  | 'not-configured'
  /**
   * A trusted proxy was declared, but this runtime cannot verify a proxy
   * boundary, so the configuration is refused and headers stay untrusted.
   */
  | 'refused-unverified-boundary';

export type RateLimitClientIdentity = Readonly<{
  /** Always the shared bucket: this runtime has no trustworthy peer address. */
  key: typeof UNIDENTIFIED_CLIENT_KEY;
  source: 'shared-fallback';
  /** Always false. Forwarding headers are never read. */
  forwardingHeadersAuthoritative: false;
  boundaryStatus: TrustedProxyBoundaryStatus;
  configuredTrustedProxyHops: number;
  effectiveTrustedProxyHops: 0;
  /** Present only when a positive hop configuration was refused. */
  operatorWarning?: string;
}>;

export type RateLimitIdentityStatus = Readonly<{
  forwardingHeadersAuthoritative: false;
  clientIdentitySource: 'shared-fallback';
  trustedProxyHopsConfigured: number;
  trustedProxyHopsEffective: 0;
  boundaryStatus: TrustedProxyBoundaryStatus;
  operatorWarning?: string;
}>;

export const buildUnverifiedBoundaryWarning = (
  configuredTrustedProxyHops: number,
): string =>
  `REFUSED: HIREARCHY_TRUSTED_PROXY_HOPS=${configuredTrustedProxyHops} is configured, but this runtime cannot verify a trusted proxy peer address, so x-forwarded-for is NOT trusted. All evaluator login rate-limit attempts share one bounded bucket. Remove the variable for the local pilot, or implement a separately verified proxy/network design before exposing evaluator access to untrusted networks.`;

/**
 * Parse the declared trusted-proxy hop count, failing closed to 0.
 *
 * An unparseable, negative, or out-of-range value is treated as 0. Note that
 * even a well-formed positive value is refused by
 * `resolveRateLimitClientIdentity`, because no peer boundary can be verified.
 */
export const parseTrustedProxyHops = (
  value: string | undefined = process.env.HIREARCHY_TRUSTED_PROXY_HOPS,
): number => {
  if (typeof value !== 'string') {
    return DEFAULT_TRUSTED_PROXY_HOPS;
  }

  const trimmed = value.trim();
  if (!HOP_COUNT_PATTERN.test(trimmed)) {
    return DEFAULT_TRUSTED_PROXY_HOPS;
  }

  const hops = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(hops) || hops > MAX_TRUSTED_PROXY_HOPS) {
    return DEFAULT_TRUSTED_PROXY_HOPS;
  }

  return hops;
};

/**
 * Resolve the rate-limit identity for an evaluator login attempt.
 *
 * Takes no request: the request is deliberately not consulted, because every
 * forwarding header it carries is attacker-controllable in this runtime.
 */
export const resolveRateLimitClientIdentity = (
  trustedProxyHops: number = parseTrustedProxyHops(),
): RateLimitClientIdentity => {
  if (trustedProxyHops > 0) {
    return {
      key: UNIDENTIFIED_CLIENT_KEY,
      source: 'shared-fallback',
      forwardingHeadersAuthoritative: false,
      boundaryStatus: 'refused-unverified-boundary',
      configuredTrustedProxyHops: trustedProxyHops,
      effectiveTrustedProxyHops: 0,
      operatorWarning: buildUnverifiedBoundaryWarning(trustedProxyHops),
    };
  }

  return {
    key: UNIDENTIFIED_CLIENT_KEY,
    source: 'shared-fallback',
    forwardingHeadersAuthoritative: false,
    boundaryStatus: 'not-configured',
    configuredTrustedProxyHops: 0,
    effectiveTrustedProxyHops: 0,
  };
};

/**
 * Diagnostic view of the trust policy, surfaced on `GET /api/health` so a
 * refused configuration is visible to operators and monitoring.
 */
export const getRateLimitIdentityStatus = (
  trustedProxyHops: number = parseTrustedProxyHops(),
): RateLimitIdentityStatus => {
  const identity = resolveRateLimitClientIdentity(trustedProxyHops);
  return {
    forwardingHeadersAuthoritative: identity.forwardingHeadersAuthoritative,
    clientIdentitySource: identity.source,
    trustedProxyHopsConfigured: identity.configuredTrustedProxyHops,
    trustedProxyHopsEffective: identity.effectiveTrustedProxyHops,
    boundaryStatus: identity.boundaryStatus,
    ...(identity.operatorWarning
      ? { operatorWarning: identity.operatorWarning }
      : {}),
  };
};
