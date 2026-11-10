import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../../apps/web/proxy';

afterEach(() => vi.unstubAllEnvs());

function configureValidFounderUat() {
  for (const [name, value] of Object.entries({
    HIREARCHY_RUNTIME_PROFILE: 'founder-uat',
    FOUNDER_UAT_APP_ORIGIN: 'http://127.0.0.1:3000',
    FOUNDER_UAT_MAILPIT_API_URL: 'http://127.0.0.1:8025',
    STAGING_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    STAGING_AUTH_URL: 'http://127.0.0.1:9997',
    STAGING_AUTH_ISSUER: 'http://127.0.0.1:9997',
    STAGING_AUTH_AUDIENCE: 'authenticated',
    STAGING_DATABASE_URL:
      'postgres://r23_gateway:local-test-password@127.0.0.1:5434/postgres',
    STAGING_PROOF_ISSUER: 'hirearchy-founder-uat',
    STAGING_PROOF_AUDIENCE: 'hirearchy-postgres',
    STAGING_PROOF_KEY_ID: '00000000-0000-4000-8000-000000000000',
    STAGING_PROOF_PRIVATE_KEY: 'server-validates-this-key',
  })) {
    vi.stubEnv(name, value);
  }
}

describe('Founder UAT root routing', () => {
  it('allows only a configured Founder UAT root request to reach its redirect', () => {
    configureValidFounderUat();

    const response = proxy(new NextRequest('http://localhost/'));

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('keeps the root blocked when the raw UAT profile has invalid configuration', async () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'founder-uat');

    const response = proxy(new NextRequest('http://localhost/'));

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe(
      'STAGING_CAPABILITY_DISABLED',
    );
  });

  it('does not open the root in authenticated staging', async () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-authenticated');

    const response = proxy(new NextRequest('http://localhost/'));

    expect(response.status).toBe(503);
  });
});
