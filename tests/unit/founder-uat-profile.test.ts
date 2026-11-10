import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isAuthenticatedStaging,
  isFounderUatEnabled,
  isFounderUatProfile,
  isStagingLockdown,
} from '../../apps/web/src/runtime/profile';
import { founderUatMailInboxUrl } from '../../apps/web/src/runtime/founder-uat';

afterEach(() => vi.unstubAllEnvs());

function configureFounderUat() {
  const { privateKey } = generateKeyPairSync('ed25519');
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
    STAGING_PROOF_PRIVATE_KEY: privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    STAGING_PROOF_ISSUER: 'hirearchy-staging',
    STAGING_PROOF_AUDIENCE: 'hirearchy-postgres',
    STAGING_PROOF_KEY_ID: 'founder-uat-test',
  };
  for (const [key, value] of Object.entries(environment)) {
    vi.stubEnv(key, value);
  }
}

describe('Founder UAT runtime profile', () => {
  it('enables only with explicit profile and validated loopback app, Auth, database and mail endpoints', () => {
    configureFounderUat();

    expect(isFounderUatProfile()).toBe(true);
    expect(isFounderUatEnabled()).toBe(true);
    expect(isAuthenticatedStaging()).toBe(true);
    expect(isStagingLockdown()).toBe(true);
    expect(founderUatMailInboxUrl('Founder@Local.Test')).toBe(
      '/r23/mail?email=founder%40local.test',
    );
    expect(founderUatMailInboxUrl('not-an-email')).toBeNull();
  });

  it('fails closed on any non-loopback or mismatched configured endpoint', () => {
    configureFounderUat();
    vi.stubEnv('FOUNDER_UAT_MAILPIT_API_URL', 'http://mailpit:8025');

    expect(isFounderUatEnabled()).toBe(false);
    expect(isAuthenticatedStaging()).toBe(false);
    expect(isStagingLockdown()).toBe(true);
    expect(founderUatMailInboxUrl('founder@local.test')).toBeNull();
  });

  it('does not activate Founder UAT under another runtime profile', () => {
    configureFounderUat();
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'public-preview');

    expect(isFounderUatProfile()).toBe(false);
    expect(isFounderUatEnabled()).toBe(false);
    expect(isAuthenticatedStaging()).toBe(false);
    expect(isStagingLockdown()).toBe(true);
  });
});
