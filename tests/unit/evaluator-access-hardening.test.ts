import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST } from '../../apps/web/app/api/evaluator/access/route';
import {
  createEvaluatorCredentialDigest,
  createSignedEvaluatorToken,
  EVALUATOR_COOKIE_MAX_AGE_SECONDS,
  isEvaluatorCookieValid,
} from '../../apps/web/src/access/evaluator-access';
import {
  EvaluatorAccessRateLimiter,
  evaluatorAccessRateLimiter,
} from '../../apps/web/src/access/evaluator-access-rate-limiter';
import {
  getRateLimitIdentityStatus,
  parseTrustedProxyHops,
  resolveRateLimitClientIdentity,
  UNIDENTIFIED_CLIENT_KEY,
} from '../../apps/web/src/access/trusted-proxy-client-identity';

describe('Evaluator Access Hardening', () => {
  const testKey = 'test-evaluator-super-secret-key-123';
  let originalKey: string | undefined;
  let originalTrustedProxyHops: string | undefined;

  beforeEach(() => {
    evaluatorAccessRateLimiter.reset();
    originalKey = process.env.HIREARCHY_EVALUATOR_KEY;
    originalTrustedProxyHops = process.env.HIREARCHY_TRUSTED_PROXY_HOPS;
    process.env.HIREARCHY_EVALUATOR_KEY = testKey;
    delete process.env.HIREARCHY_TRUSTED_PROXY_HOPS;
  });

  afterEach(() => {
    evaluatorAccessRateLimiter.reset();
    if (originalKey === undefined) {
      delete process.env.HIREARCHY_EVALUATOR_KEY;
    } else {
      process.env.HIREARCHY_EVALUATOR_KEY = originalKey;
    }
    if (originalTrustedProxyHops === undefined) {
      delete process.env.HIREARCHY_TRUSTED_PROXY_HOPS;
    } else {
      process.env.HIREARCHY_TRUSTED_PROXY_HOPS = originalTrustedProxyHops;
    }
  });

  const request = (
    body: unknown,
    headers: Record<string, string> = {},
  ): Request =>
    new Request('http://localhost/api/evaluator/access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  describe('Malformed JSON handling', () => {
    it('returns 400 INVALID_EVALUATOR_REQUEST for broken JSON', async () => {
      const res = await POST(request('{ broken json '));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'INVALID_EVALUATOR_REQUEST',
          message: 'The evaluator access request must contain valid JSON.',
        },
      });
    });

    it('returns 400 INVALID_EVALUATOR_REQUEST for non-object body', async () => {
      const res = await POST(
        request(JSON.stringify(['array', 'not', 'object'])),
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'INVALID_EVALUATOR_REQUEST',
          message: 'The evaluator access request must be an object.',
        },
      });
    });
  });

  describe('Configuration guard', () => {
    it('returns 503 EVALUATOR_NOT_CONFIGURED when no key is set in environment', async () => {
      delete process.env.HIREARCHY_EVALUATOR_KEY;
      delete process.env.DELIMIT_EVALUATOR_KEY;

      const res = await POST(request({ credential: 'any' }));
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'EVALUATOR_NOT_CONFIGURED',
          message:
            'Set HIREARCHY_EVALUATOR_KEY or DELIMIT_EVALUATOR_KEY before opening evidence review.',
        },
      });
    });
  });

  describe('Brute-force protection', () => {
    it('returns 401 for invalid credentials and allows subsequent valid attempts within threshold', async () => {
      const invalidRes = await POST(
        request(
          { credential: 'wrong-credential' },
          { 'x-forwarded-for': '192.168.1.100' },
        ),
      );
      expect(invalidRes.status).toBe(401);
      const data = await invalidRes.json();
      expect(data).toEqual({
        error: {
          code: 'INVALID_EVALUATOR_CREDENTIAL',
          message: 'The evaluator credential is not valid.',
        },
      });

      const validRes = await POST(
        request(
          { credential: testKey },
          { 'x-forwarded-for': '192.168.1.100' },
        ),
      );
      expect(validRes.status).toBe(200);
    });

    it('locks out the caller with 429 TOO_MANY_ATTEMPTS after 5 consecutive failed attempts', async () => {
      const clientIp = '10.0.0.55';

      for (let i = 0; i < 4; i++) {
        const res = await POST(
          request(
            { credential: `wrong-${i}` },
            { 'x-forwarded-for': clientIp },
          ),
        );
        expect(res.status).toBe(401);
      }

      // 5th attempt triggers lockout
      const fifthRes = await POST(
        request({ credential: 'wrong-5' }, { 'x-forwarded-for': clientIp }),
      );
      expect(fifthRes.status).toBe(429);
      expect(fifthRes.headers.get('Retry-After')).toBeTruthy();
      const data5 = await fifthRes.json();
      expect(data5).toEqual({
        error: {
          code: 'TOO_MANY_ATTEMPTS',
          message:
            'Too many failed authentication attempts. Please try again later.',
        },
      });

      // Subsequent attempt (even with valid credential) is blocked while lockout is active
      const blockedValidRes = await POST(
        request({ credential: testKey }, { 'x-forwarded-for': clientIp }),
      );
      expect(blockedValidRes.status).toBe(429);

      // Rotating the forwarding header cannot escape the lockout, because the
      // default policy trusts no forwarding header at all.
      for (const spoofed of ['10.0.0.56', '203.0.113.9', '198.51.100.4']) {
        const rotated = await POST(
          request({ credential: testKey }, { 'x-forwarded-for': spoofed }),
        );
        expect(rotated.status).toBe(429);
      }

      // A rotation on a different header is equally powerless.
      const realIpRotation = await POST(
        request(
          { credential: testKey },
          { 'x-real-ip': '203.0.113.77', 'x-forwarded-for': '10.0.0.55' },
        ),
      );
      expect(realIpRotation.status).toBe(429);
    });

    it('does not let an unauthenticated caller reset the lockout counter by rotating forwarding headers', async () => {
      // Four failures spread across distinct forwarded addresses must still add
      // up to a block on the next attempt.
      for (const spoofed of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) {
        const res = await POST(
          request(
            { credential: 'wrong' },
            { 'x-forwarded-for': spoofed, 'x-real-ip': spoofed },
          ),
        );
        expect(res.status).toBe(401);
      }

      const blocked = await POST(
        request({ credential: 'wrong' }, { 'x-forwarded-for': '10.0.0.5' }),
      );
      expect(blocked.status).toBe(429);
    });
  });

  describe('Trusted-proxy policy', () => {
    it('cannot be bypassed by header rotation even when a positive hop count is configured', async () => {
      process.env.HIREARCHY_TRUSTED_PROXY_HOPS = '1';

      // The hop count is refused, so every attempt lands in the same bucket
      // despite presenting a different forwarded address each time.
      const spoofedAddresses = [
        '10.0.0.55',
        '10.0.0.56',
        '203.0.113.9',
        '198.51.100.4',
      ];

      for (let i = 0; i < 5; i++) {
        const res = await POST(
          request(
            { credential: `wrong-${i}` },
            {
              'x-forwarded-for': spoofedAddresses[i % spoofedAddresses.length],
            },
          ),
        );
        expect(res.status).toBe(i === 4 ? 429 : 401);
      }

      // A fresh address and a fresh x-real-ip still cannot escape the lockout.
      for (const spoofed of ['192.0.2.77', '203.0.113.200']) {
        const res = await POST(
          request(
            { credential: testKey },
            { 'x-forwarded-for': spoofed, 'x-real-ip': spoofed },
          ),
        );
        expect(res.status).toBe(429);
      }
    });

    it('does not grant a fresh bucket to a distinct forwarded address', async () => {
      process.env.HIREARCHY_TRUSTED_PROXY_HOPS = '2';

      for (const spoofed of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) {
        const res = await POST(
          request(
            { credential: 'wrong' },
            { 'x-forwarded-for': `${spoofed}, 203.0.113.7` },
          ),
        );
        expect(res.status).toBe(401);
      }

      // The fifth failure still lands on the shared bucket.
      const blocked = await POST(
        request(
          { credential: 'wrong' },
          { 'x-forwarded-for': '10.0.0.9, 203.0.113.7' },
        ),
      );
      expect(blocked.status).toBe(429);
    });
  });

  describe('Client identity resolution', () => {
    it('uses the shared fallback when no trusted proxy is declared', () => {
      delete process.env.HIREARCHY_TRUSTED_PROXY_HOPS;

      expect(resolveRateLimitClientIdentity()).toEqual({
        key: UNIDENTIFIED_CLIENT_KEY,
        source: 'shared-fallback',
        forwardingHeadersAuthoritative: false,
        boundaryStatus: 'not-configured',
        configuredTrustedProxyHops: 0,
        effectiveTrustedProxyHops: 0,
      });
    });

    it('refuses a positive hop count instead of trusting unverified headers', () => {
      for (const hops of [1, 2, 8]) {
        const identity = resolveRateLimitClientIdentity(hops);

        expect(identity.key).toBe(UNIDENTIFIED_CLIENT_KEY);
        expect(identity.source).toBe('shared-fallback');
        expect(identity.forwardingHeadersAuthoritative).toBe(false);
        expect(identity.effectiveTrustedProxyHops).toBe(0);
        expect(identity.boundaryStatus).toBe('refused-unverified-boundary');
        expect(identity.configuredTrustedProxyHops).toBe(hops);
        expect(identity.operatorWarning).toContain('REFUSED');
        expect(identity.operatorWarning).toContain(String(hops));
      }
    });

    it('never derives an identity from forwarding headers at any hop count', () => {
      for (const hops of [0, 1, 2, 3, 8]) {
        expect(resolveRateLimitClientIdentity(hops).key).toBe(
          UNIDENTIFIED_CLIENT_KEY,
        );
      }
    });

    it('reports the refused boundary as an operator-visible diagnostic', () => {
      expect(getRateLimitIdentityStatus(0)).toEqual({
        forwardingHeadersAuthoritative: false,
        clientIdentitySource: 'shared-fallback',
        trustedProxyHopsConfigured: 0,
        trustedProxyHopsEffective: 0,
        boundaryStatus: 'not-configured',
      });

      const refused = getRateLimitIdentityStatus(3);
      expect(refused.boundaryStatus).toBe('refused-unverified-boundary');
      expect(refused.trustedProxyHopsConfigured).toBe(3);
      expect(refused.trustedProxyHopsEffective).toBe(0);
      expect(refused.operatorWarning).toContain('REFUSED');
    });

    it('fails closed on malformed or out-of-range hop counts', () => {
      for (const malformed of [
        'abc',
        '-1',
        '1.5',
        '2oops',
        '',
        '   ',
        '999',
        '0x2',
      ]) {
        expect(parseTrustedProxyHops(malformed)).toBe(0);
      }
      expect(parseTrustedProxyHops(undefined)).toBe(0);
      // Well-formed values still parse, but are refused at resolution time.
      expect(parseTrustedProxyHops('2')).toBe(2);
    });
  });

  describe('Rate limiter key bound', () => {
    it('evicts least-recently-active identities beyond the configured bound', () => {
      const limiter = new EvaluatorAccessRateLimiter({ maxTrackedKeys: 3 });
      const now = Date.now();

      for (let i = 0; i < 10; i += 1) {
        limiter.recordFailure(`client-${i}`, now + i);
      }

      // The three most recent identities remain protected...
      expect(limiter.isBlocked('client-9', now + 10).blocked).toBe(false);
      // ...and the bound holds rather than growing with attacker-supplied values.
      const tracked = (limiter as unknown as { attempts: Map<string, unknown> })
        .attempts.size;
      expect(tracked).toBe(3);
    });
  });

  describe('Cookie expiration & token integrity', () => {
    it('sets cookie with explicit maxAge (8 hours)', async () => {
      const res = await POST(request({ credential: testKey }));
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain(
        `Max-Age=${EVALUATOR_COOKIE_MAX_AGE_SECONDS}`,
      );
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie?.toLowerCase()).toContain('samesite=strict');
    });

    it('issues a signed timestamped token that verifies successfully', async () => {
      const now = Date.now();
      const token = createSignedEvaluatorToken(testKey, now);
      expect(isEvaluatorCookieValid(token, testKey, now)).toBe(true);
    });

    it('rejects an expired signed token', async () => {
      const eightHoursOneMinuteAgo = Date.now() - (8 * 60 * 60 + 60) * 1000;
      const expiredToken = createSignedEvaluatorToken(
        testKey,
        eightHoursOneMinuteAgo,
      );

      expect(isEvaluatorCookieValid(expiredToken, testKey, Date.now())).toBe(
        false,
      );
    });

    it('rejects a tampered signed token', async () => {
      const now = Date.now();
      const token = createSignedEvaluatorToken(testKey, now);
      const parts = token.split('.');
      const tampered = `${parts[0]}.${parts[1]}.tampered-signature`;

      expect(isEvaluatorCookieValid(tampered, testKey, now)).toBe(false);
    });

    it('rejects a legacy unsigned static cookie value', () => {
      // The legacy digest cookie carried no issuance time and therefore could
      // never be expired. It must no longer authenticate.
      const legacy = createEvaluatorCredentialDigest(testKey);
      expect(isEvaluatorCookieValid(legacy, testKey)).toBe(false);
      expect(isEvaluatorCookieValid(legacy, testKey, Date.now())).toBe(false);
    });

    it('rejects malformed and missing credential material', () => {
      expect(isEvaluatorCookieValid(undefined, testKey)).toBe(false);
      expect(isEvaluatorCookieValid('', testKey)).toBe(false);

      for (const malformed of [
        'v1',
        'v1.',
        `v1.${Date.now()}`,
        `v1.${Date.now()}.`,
        'v1.abc.def',
        `v2.${Date.now()}.signature`,
        `v1.${Date.now()}.${'a'.repeat(200)}`,
        `v1.-${Date.now()}.signature`,
      ]) {
        expect(isEvaluatorCookieValid(malformed, testKey)).toBe(false);
      }
    });

    it('fails closed when no credential is configured', () => {
      const token = createSignedEvaluatorToken(testKey);

      expect(isEvaluatorCookieValid(token, '')).toBe(false);

      delete process.env.HIREARCHY_EVALUATOR_KEY;
      delete process.env.DELIMIT_EVALUATOR_KEY;
      expect(isEvaluatorCookieValid(token)).toBe(false);

      process.env.HIREARCHY_EVALUATOR_KEY = testKey;
    });

    it('rejects a token whose issuance is implausibly in the future', () => {
      const now = Date.now();
      const futureToken = createSignedEvaluatorToken(
        testKey,
        now + 10 * 60 * 1000,
      );
      expect(isEvaluatorCookieValid(futureToken, testKey, now)).toBe(false);
    });

    it('rejects a token signed with a different credential', () => {
      const now = Date.now();
      const foreignToken = createSignedEvaluatorToken('other-key', now);
      expect(isEvaluatorCookieValid(foreignToken, testKey, now)).toBe(false);
    });
  });
});
