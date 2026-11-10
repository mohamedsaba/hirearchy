import { afterEach, describe, expect, it, vi } from 'vitest';

import { founderUatInvitationCookie } from '../../apps/web/src/r23-auth/founder-uat-state';
import { stagingPost } from '../../apps/web/src/staging/server';

afterEach(() => vi.unstubAllEnvs());

function configureFounderUat(signingKey: string) {
  const environment = {
    HIREARCHY_RUNTIME_PROFILE: 'founder-uat',
    FOUNDER_UAT_APP_ORIGIN: 'http://127.0.0.1:3000',
    FOUNDER_UAT_MAILPIT_API_URL: 'http://127.0.0.1:8025',
    STAGING_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    STAGING_AUTH_URL: 'http://127.0.0.1:9998',
    STAGING_AUTH_ISSUER: 'http://127.0.0.1:9998/auth/v1',
    STAGING_AUTH_AUDIENCE: 'authenticated',
    STAGING_DATABASE_URL:
      'postgresql://r23_gateway:local-test@127.0.0.1:5432/postgres',
    STAGING_PROOF_PRIVATE_KEY: signingKey,
    STAGING_PROOF_ISSUER: 'hirearchy-staging',
    STAGING_PROOF_AUDIENCE: 'hirearchy-postgres',
    STAGING_PROOF_KEY_ID: 'founder-uat-test',
  };
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
}

describe('Founder UAT invalid signing configuration', () => {
  it('does not issue product proofs or purpose-bound state with a malformed signing key', async () => {
    configureFounderUat(Buffer.alloc(48).toString('base64'));

    const response = await stagingPost(
      new Request('http://127.0.0.1:3000/api/staging/v1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'organization.context', args: {} }),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Unavailable' });
    expect(() => founderUatInvitationCookie('a'.repeat(43), 'login')).toThrow(
      'Founder UAT state unavailable',
    );
  });

  it('fails closed when the signing key is missing', async () => {
    configureFounderUat('');

    const response = await stagingPost(
      new Request('http://127.0.0.1:3000/api/staging/v1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'organization.context', args: {} }),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Unavailable' });
    expect(() => founderUatInvitationCookie('a'.repeat(43), 'login')).toThrow(
      'Invitation context unavailable',
    );
  });
});
