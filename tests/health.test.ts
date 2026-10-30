import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getHealthStatus } from '../apps/web/src/health';

describe('getHealthStatus', () => {
  let originalHops: string | undefined;

  beforeEach(() => {
    originalHops = process.env.HIREARCHY_TRUSTED_PROXY_HOPS;
    delete process.env.HIREARCHY_TRUSTED_PROXY_HOPS;
  });

  afterEach(() => {
    if (originalHops === undefined) {
      delete process.env.HIREARCHY_TRUSTED_PROXY_HOPS;
    } else {
      process.env.HIREARCHY_TRUSTED_PROXY_HOPS = originalHops;
    }
  });

  it('returns a stable diagnostic response', () => {
    expect(getHealthStatus()).toEqual({
      service: 'hirearchy-web',
      status: 'ok',
      readiness: 'not-checked',
      rateLimitIdentity: {
        forwardingHeadersAuthoritative: false,
        clientIdentitySource: 'shared-fallback',
        trustedProxyHopsConfigured: 0,
        trustedProxyHopsEffective: 0,
        boundaryStatus: 'not-configured',
      },
    });
  });

  it('visibly reports a refused trusted-proxy configuration', () => {
    process.env.HIREARCHY_TRUSTED_PROXY_HOPS = '2';

    const status = getHealthStatus();

    // The service is still up; the refusal is reported alongside it.
    expect(status.status).toBe('ok');
    expect(status.rateLimitIdentity).toEqual({
      forwardingHeadersAuthoritative: false,
      clientIdentitySource: 'shared-fallback',
      trustedProxyHopsConfigured: 2,
      trustedProxyHopsEffective: 0,
      boundaryStatus: 'refused-unverified-boundary',
      operatorWarning: expect.stringContaining('REFUSED'),
    });
  });
});
