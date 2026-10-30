type AttemptRecord = {
  count: number;
  firstAttemptAt: number;
  lastAttemptAt: number;
  blockedUntil?: number;
};

const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX_TRACKED_KEYS = 4096;

/**
 * In-memory rate limiter to protect evaluator authentication from brute-force attempts.
 *
 * NOTE ON PRODUCTION SCALE:
 * This rate limiter maintains state in process memory. In a horizontally scaled
 * or serverless multi-instance production environment, state is not shared across
 * instances. A production deployment with multiple nodes should back this rate limiter
 * with shared distributed storage (such as Redis) or enforce rate limiting at an external
 * reverse proxy / API gateway (e.g., Cloudflare, AWS WAF, Nginx).
 *
 * KEY IDENTITY:
 * Callers must derive `key` from a trustworthy client identity, not from
 * client-supplied headers. See `trusted-proxy-client-identity.ts` for the
 * trusted-proxy policy and its denial-of-service trade-offs.
 */
export class EvaluatorAccessRateLimiter {
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly maxFailedAttempts: number;
  private readonly windowMs: number;
  private readonly blockDurationMs: number;
  private readonly maxTrackedKeys: number;

  constructor(options?: {
    maxFailedAttempts?: number;
    windowMs?: number;
    blockDurationMs?: number;
    maxTrackedKeys?: number;
  }) {
    this.maxFailedAttempts =
      options?.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS;
    this.windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
    this.blockDurationMs =
      options?.blockDurationMs ?? DEFAULT_BLOCK_DURATION_MS;
    this.maxTrackedKeys = options?.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  }

  isBlocked(
    key: string,
    now = Date.now(),
  ): { blocked: boolean; retryAfterSeconds: number } {
    this.cleanup(now);
    const record = this.attempts.get(key);
    if (!record) return { blocked: false, retryAfterSeconds: 0 };

    if (record.blockedUntil && record.blockedUntil > now) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((record.blockedUntil - now) / 1000),
      );
      return { blocked: true, retryAfterSeconds };
    }

    return { blocked: false, retryAfterSeconds: 0 };
  }

  recordFailure(
    key: string,
    now = Date.now(),
  ): { blocked: boolean; retryAfterSeconds: number } {
    this.cleanup(now);
    const record = this.attempts.get(key);
    if (!record) {
      this.attempts.set(key, {
        count: 1,
        firstAttemptAt: now,
        lastAttemptAt: now,
      });
      this.enforceKeyBound();
      return { blocked: false, retryAfterSeconds: 0 };
    }

    if (now - record.firstAttemptAt > this.windowMs) {
      record.count = 1;
      record.firstAttemptAt = now;
      record.lastAttemptAt = now;
      delete record.blockedUntil;
      return { blocked: false, retryAfterSeconds: 0 };
    }

    record.count += 1;
    record.lastAttemptAt = now;

    if (record.count >= this.maxFailedAttempts) {
      record.blockedUntil = now + this.blockDurationMs;
      return {
        blocked: true,
        retryAfterSeconds: Math.ceil(this.blockDurationMs / 1000),
      };
    }

    return { blocked: false, retryAfterSeconds: 0 };
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  reset(): void {
    this.attempts.clear();
  }

  /**
   * Bound the number of tracked identities. Rotating an identity is the
   * attack this limiter defends against, so an unbounded map would let that
   * same attack exhaust process memory. The least recently active records are
   * evicted first; evicting a record only lowers protection for that identity,
   * never raises it.
   */
  private enforceKeyBound(): void {
    if (this.attempts.size <= this.maxTrackedKeys) {
      return;
    }

    const oldestFirst = [...this.attempts.entries()].sort(
      (left, right) => left[1].lastAttemptAt - right[1].lastAttemptAt,
    );
    const excess = this.attempts.size - this.maxTrackedKeys;
    for (let index = 0; index < excess; index += 1) {
      this.attempts.delete(oldestFirst[index][0]);
    }
  }

  private cleanup(now: number): void {
    for (const [key, record] of this.attempts.entries()) {
      const isExpired =
        now - record.lastAttemptAt > this.windowMs &&
        (!record.blockedUntil || record.blockedUntil <= now);
      if (isExpired) {
        this.attempts.delete(key);
      }
    }
  }
}

export const evaluatorAccessRateLimiter = new EvaluatorAccessRateLimiter();
