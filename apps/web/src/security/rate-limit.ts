/**
 * Bounded deterministic in-memory rate limiter for sensitive authentication,
 * onboarding, recovery, and candidate invitation/token endpoints.
 *
 * NOTE ON HORIZONTAL SCALE:
 * This rate limiter maintains state in bounded process memory for single-team staging
 * and local deployment. In multi-instance or serverless environments, rate limiting
 * should be backed by distributed cache (e.g., Redis) or reverse proxy/WAF.
 */

export interface RateLimitOptions {
  /** Maximum number of requests allowed in the time window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Key prefix to distinguish different endpoint categories. */
  keyPrefix?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
  resetAt: number;
}

export interface ClientIdentityOptions {
  /** Explicit client key if already resolved. */
  clientKey?: string;
}

const DEFAULT_MAX_TRACKED_KEYS = 10_000;

export class BoundedRateLimiter {
  private readonly store = new Map<string, number[]>();
  private readonly maxTrackedKeys: number;

  constructor(options?: { maxTrackedKeys?: number }) {
    this.maxTrackedKeys = options?.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  }

  /**
   * Check whether a request under `key` is allowed within `options`.
   */
  check(
    key: string,
    options: RateLimitOptions,
    now = Date.now(),
  ): RateLimitResult {
    // Check if globally disabled via environment variable
    if (process.env.HIREARCHY_RATE_LIMIT_ENABLED === 'false') {
      return {
        allowed: true,
        retryAfterSeconds: 0,
        remaining: options.maxRequests,
        resetAt: Math.ceil((now + options.windowMs) / 1000),
      };
    }

    const scopedKey = options.keyPrefix ? `${options.keyPrefix}:${key}` : key;
    const windowStart = now - options.windowMs;

    let timestamps = this.store.get(scopedKey);
    if (!timestamps) {
      if (this.store.size >= this.maxTrackedKeys) {
        this.evictExpiredOrOldest(now, options.windowMs);
      }
      timestamps = [];
      this.store.set(scopedKey, timestamps);
    }

    // Filter out timestamps outside the current window
    const validTimestamps = timestamps.filter((t) => t > windowStart);

    if (validTimestamps.length >= options.maxRequests) {
      const oldestValid = validTimestamps[0];
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldestValid + options.windowMs - now) / 1000),
      );
      const resetAt = Math.ceil((oldestValid + options.windowMs) / 1000);

      this.store.set(scopedKey, validTimestamps);
      return {
        allowed: false,
        retryAfterSeconds,
        remaining: 0,
        resetAt,
      };
    }

    validTimestamps.push(now);
    this.store.set(scopedKey, validTimestamps);

    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: Math.max(0, options.maxRequests - validTimestamps.length),
      resetAt: Math.ceil((now + options.windowMs) / 1000),
    };
  }

  /**
   * Reset all rate limit tracking state (primarily for test harnesses).
   */
  reset(): void {
    this.store.clear();
  }

  /**
   * Evict expired records to maintain memory bounds.
   */
  private evictExpiredOrOldest(now: number, windowMs: number): void {
    const expiredKeys: string[] = [];
    for (const [key, timestamps] of this.store.entries()) {
      const hasRecent = timestamps.some((t) => now - t < windowMs);
      if (!hasRecent) {
        expiredKeys.push(key);
      }
    }
    for (const key of expiredKeys) {
      this.store.delete(key);
    }
    // If still at capacity, delete the oldest map entry
    if (this.store.size >= this.maxTrackedKeys) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
      }
    }
  }
}

export const globalRateLimiter = new BoundedRateLimiter();

/**
 * Extract trustworthy client IP from Request headers or fallback.
 */
export function extractClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp && realIp.trim()) return realIp.trim();
  return '127.0.0.1';
}

/**
 * Standard rate limit configurations for sensitive endpoints.
 */
export function getEndpointRateLimitConfig(
  type: 'auth' | 'staging' | 'candidate',
): RateLimitOptions {
  switch (type) {
    case 'auth': {
      const maxRequests = Number.parseInt(
        process.env.HIREARCHY_AUTH_RATE_LIMIT_MAX || '20',
        10,
      );
      const windowMs = Number.parseInt(
        process.env.HIREARCHY_AUTH_RATE_LIMIT_WINDOW_MS || '60000',
        10,
      );
      return { maxRequests, windowMs, keyPrefix: 'auth' };
    }
    case 'staging': {
      const maxRequests = Number.parseInt(
        process.env.HIREARCHY_STAGING_RATE_LIMIT_MAX || '100',
        10,
      );
      const windowMs = Number.parseInt(
        process.env.HIREARCHY_STAGING_RATE_LIMIT_WINDOW_MS || '60000',
        10,
      );
      return { maxRequests, windowMs, keyPrefix: 'staging' };
    }
    case 'candidate': {
      const maxRequests = Number.parseInt(
        process.env.HIREARCHY_CANDIDATE_RATE_LIMIT_MAX || '60',
        10,
      );
      const windowMs = Number.parseInt(
        process.env.HIREARCHY_CANDIDATE_RATE_LIMIT_WINDOW_MS || '60000',
        10,
      );
      return { maxRequests, windowMs, keyPrefix: 'candidate' };
    }
  }
}

/**
 * Enforce rate limits on a Request. Returns a 429 Response if limit is exceeded,
 * or null if request is allowed.
 */
export function enforceRateLimit(
  request: Request,
  type: 'auth' | 'staging' | 'candidate',
  customOptions?: Partial<RateLimitOptions>,
  limiter: BoundedRateLimiter = globalRateLimiter,
): Response | null {
  const clientIp = extractClientIp(request);
  const baseConfig = getEndpointRateLimitConfig(type);
  const config: RateLimitOptions = {
    ...baseConfig,
    ...customOptions,
  };

  const check = limiter.check(clientIp, config);
  if (!check.allowed) {
    return Response.json(
      {
        error: 'Too many requests. Please try again later.',
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(check.retryAfterSeconds),
          'X-RateLimit-Limit': String(config.maxRequests),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(check.resetAt),
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  return null;
}
