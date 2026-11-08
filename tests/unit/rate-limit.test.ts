import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  BoundedRateLimiter,
  enforceRateLimit,
  extractClientIp,
} from '../../apps/web/src/security/rate-limit';

beforeEach(() => {
  delete process.env.HIREARCHY_RATE_LIMIT_ENABLED;
  delete process.env.HIREARCHY_AUTH_RATE_LIMIT_MAX;
  delete process.env.HIREARCHY_AUTH_RATE_LIMIT_WINDOW_MS;
});

afterEach(() => {
  delete process.env.HIREARCHY_RATE_LIMIT_ENABLED;
  delete process.env.HIREARCHY_AUTH_RATE_LIMIT_MAX;
  delete process.env.HIREARCHY_AUTH_RATE_LIMIT_WINDOW_MS;
});

describe('BoundedRateLimiter', () => {
  let limiter: BoundedRateLimiter;

  beforeEach(() => {
    limiter = new BoundedRateLimiter({ maxTrackedKeys: 3 });
  });

  it('allows requests within threshold and tracks remaining count', () => {
    const key = '192.168.1.1';
    const options = { maxRequests: 3, windowMs: 10_000 };
    const now = 1000;

    const r1 = limiter.check(key, options, now);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.check(key, options, now + 100);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.check(key, options, now + 200);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    const r4 = limiter.check(key, options, now + 300);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfterSeconds).toBe(10); // 1000 + 10000 - 1300 = 9700ms -> 10s
  });

  it('slides window and allows new requests after oldest expires', () => {
    const key = '10.0.0.1';
    const options = { maxRequests: 2, windowMs: 1000 };
    const now = 2000;

    expect(limiter.check(key, options, now).allowed).toBe(true);
    expect(limiter.check(key, options, now + 100).allowed).toBe(true);
    expect(limiter.check(key, options, now + 200).allowed).toBe(false);

    // After 1050ms, the first request at 2000 is outside window [1050, 2050]
    const next = limiter.check(key, options, now + 1050);
    expect(next.allowed).toBe(true);
  });

  it('isolates different client IPs and prefixes', () => {
    const options = { maxRequests: 1, windowMs: 5000 };
    expect(limiter.check('1.1.1.1', options, 1000).allowed).toBe(true);
    expect(limiter.check('1.1.1.1', options, 1000).allowed).toBe(false);

    // Different IP is allowed
    expect(limiter.check('2.2.2.2', options, 1000).allowed).toBe(true);

    // Different prefix with same IP is allowed
    expect(
      limiter.check('1.1.1.1', { ...options, keyPrefix: 'alt' }, 1000).allowed,
    ).toBe(true);
  });

  it('bounds memory by evicting oldest entry when maxTrackedKeys is reached', () => {
    const options = { maxRequests: 2, windowMs: 60_000 };
    limiter.check('ip1', options, 1000);
    limiter.check('ip2', options, 1000);
    limiter.check('ip3', options, 1000);

    // Adding 4th key should trigger eviction since limit is 3
    limiter.check('ip4', options, 1000);

    // ip1 was oldest, should have been evicted
    // If it was evicted, it should get a fresh allocation with remaining = 1
    const check1 = limiter.check('ip1', options, 1000);
    expect(check1.allowed).toBe(true);
    expect(check1.remaining).toBe(1);
  });

  it('respects HIREARCHY_RATE_LIMIT_ENABLED=false bypass', () => {
    process.env.HIREARCHY_RATE_LIMIT_ENABLED = 'false';
    const options = { maxRequests: 1, windowMs: 10_000 };
    expect(limiter.check('ip1', options, 1000).allowed).toBe(true);
    expect(limiter.check('ip1', options, 1000).allowed).toBe(true);
    expect(limiter.check('ip1', options, 1000).allowed).toBe(true);
  });
});

describe('enforceRateLimit', () => {
  it('extracts IP from x-forwarded-for or x-real-ip', () => {
    const req1 = new Request('http://localhost/api/test', {
      headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' },
    });
    expect(extractClientIp(req1)).toBe('203.0.113.195');

    const req2 = new Request('http://localhost/api/test', {
      headers: { 'x-real-ip': '198.51.100.1' },
    });
    expect(extractClientIp(req2)).toBe('198.51.100.1');

    const req3 = new Request('http://localhost/api/test');
    expect(extractClientIp(req3)).toBe('127.0.0.1');
  });

  it('returns 429 Response with Retry-After and rate limit headers on breach', async () => {
    const testLimiter = new BoundedRateLimiter();
    const req = new Request('http://localhost/api/auth/signup', {
      headers: { 'x-forwarded-for': '192.0.2.1' },
    });

    const opt = { maxRequests: 2, windowMs: 10_000 };
    expect(enforceRateLimit(req, 'auth', opt, testLimiter)).toBeNull();
    expect(enforceRateLimit(req, 'auth', opt, testLimiter)).toBeNull();

    const response = enforceRateLimit(req, 'auth', opt, testLimiter);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBeTruthy();
    expect(response?.headers.get('X-RateLimit-Limit')).toBe('2');
    expect(response?.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response?.headers.get('X-RateLimit-Reset')).toBeTruthy();

    const json = await response?.json();
    expect(json).toEqual({
      error: 'Too many requests. Please try again later.',
    });
  });
});
