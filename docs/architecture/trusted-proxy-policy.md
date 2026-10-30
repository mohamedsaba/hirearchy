# Trusted-proxy policy for evaluator authentication

Evaluator login rate limiting keys its failure counters on a client identity.
This document defines where that identity comes from, why forwarding headers
are never trusted in this runtime, and what a public deployment must establish
before evaluator access is exposed.

## Why forwarding headers are never authoritative here

`x-forwarded-for` and `x-real-ip` are ordinary request headers. Any client can
send them. Using them as the rate-limit identity lets an attacker mint a fresh
identity per request by rotating the header, which disables brute-force
protection entirely.

Using them correctly requires proving that the immediate peer is a trusted proxy.
This runtime cannot do that:

- The Web `Request` API exposes no peer socket address.
- Next.js 15 and later **removed** `NextRequest.ip` and `NextRequest.geo`,
  because those values are supplied by the hosting provider rather than the
  application. The installed `next/server` request types expose no `ip` or
  socket field.
- The documented replacement (`@vercel/functions`) is Vercel-specific platform
  infrastructure, which this deployment does not use.

Without a verifiable peer address there is no way to distinguish "a proxy
appended this entry" from "the caller sent this entry". A hop count declared in
configuration is not that proof.

## Policy

The rate-limit identity is **always** the single shared fallback bucket, and
forwarding headers are **never** read.

| `HIREARCHY_TRUSTED_PROXY_HOPS` | Behaviour                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset or `0` (default)         | Expected pilot posture. Headers untrusted; one shared bounded bucket.                                                                                                                                     |
| `N` >= 1                       | **Refused.** Headers stay untrusted, the shared bucket still applies, and the refusal is reported on `GET /api/health`, logged once by the login route, and returned by `resolveRateLimitClientIdentity`. |

Values that are not an unambiguous integer between 0 and 8 — including partial
parses such as `"2oops"` — are treated as `0`. The parser fails closed.

Security must not depend on configuration documentation. A positive hop value
therefore produces an explicit, observable refusal instead of silently enabling
header trust.

## Denial-of-service trade-off

One shared bucket means an unauthenticated caller who can reach
`POST /api/evaluator/access` can trigger the block window and lock the
legitimate evaluator out for `blockDurationMs`.

This is an availability trade-off, accepted knowingly in exchange for never
trusting unverified input. It is appropriate for the controlled local pilot and
is **not** acceptable as a public-deployment posture.

## Public deployment requirement

Any deployment reachable by untrusted networks requires a **separately verified
proxy and network security design**, reviewed as its own change. That design
must establish both of the following:

1. **A trusted proxy that overwrites `x-forwarded-for`** rather than passing a
   client-supplied value through unchanged.
2. **A network boundary that makes the application port reachable only through
   that proxy**, so a caller cannot bypass the proxy entirely.

Only when both hold does a hop count become meaningful, and only then should
header-derived identity be introduced as its own reviewed change. Setting
`HIREARCHY_TRUSTED_PROXY_HOPS` alone does not and cannot provide either property.

Rate-limiter state is also held in process memory and does not coordinate across
replicas; a multi-instance deployment must additionally enforce rate limiting at
the proxy or gateway.

## Bounded storage

The number of tracked identities is capped (default 4096) so that identity
rotation cannot grow process memory without bound. Eviction is
least-recently-active first and only lowers protection for the evicted identity.

## Related

- `apps/web/src/access/trusted-proxy-client-identity.ts` — implementation and
  threat model.
- `apps/web/src/access/evaluator-access-rate-limiter.ts` — limiter and key bound.
- `apps/web/app/api/evaluator/access/route.ts` — login route.
- `apps/web/src/health.ts` — operator-visible diagnostic surface.
