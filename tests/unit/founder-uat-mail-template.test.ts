import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../../apps/web/app/api/founder-uat/mail/template/[kind]/route';

afterEach(() => vi.unstubAllEnvs());

function configureFounderUat() {
  const environment = {
    HIREARCHY_RUNTIME_PROFILE: 'founder-uat',
    FOUNDER_UAT_APP_ORIGIN: 'http://127.0.0.1:3000',
    FOUNDER_UAT_MAILPIT_API_URL: 'http://127.0.0.1:8025',
    STAGING_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    STAGING_AUTH_URL: 'http://127.0.0.1:9997',
    STAGING_AUTH_ISSUER: 'http://127.0.0.1:9997/auth/v1',
    STAGING_AUTH_AUDIENCE: 'authenticated',
    STAGING_DATABASE_URL:
      'postgresql://r23_gateway:local-test@127.0.0.1:5434/postgres',
    STAGING_PROOF_PRIVATE_KEY: 'local-private-key-placeholder',
    STAGING_PROOF_ISSUER: 'hirearchy-founder-uat',
    STAGING_PROOF_AUDIENCE: 'hirearchy-postgres',
    STAGING_PROOF_KEY_ID: 'founder-uat-test',
  };
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
}

describe('Founder UAT local Auth email templates', () => {
  it('serves a fixed signup OTP template only inside the configured loopback profile', async () => {
    configureFounderUat();

    const response = await GET(new Request('http://127.0.0.1:3000/template'), {
      params: Promise.resolve({ kind: 'confirmation' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.text();
    expect(body).toContain('{{ .Token }}');
    expect(body).not.toContain('ConfirmationURL');
  });

  it('serves a separate recovery OTP template and rejects invalid profiles', async () => {
    configureFounderUat();

    const response = await GET(new Request('http://127.0.0.1:3000/template'), {
      params: Promise.resolve({ kind: 'recovery' }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('password reset');
    expect(body).toContain('{{ .Token }}');

    vi.stubEnv('FOUNDER_UAT_MAILPIT_API_URL', 'http://mailpit:8025');
    const denied = await GET(new Request('http://127.0.0.1:3000/template'), {
      params: Promise.resolve({ kind: 'recovery' }),
    });
    expect(denied.status).toBe(404);
  });
});
