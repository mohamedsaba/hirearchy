import { describe, expect, it } from 'vitest';
import { validateFounderUatDatabaseConfiguration } from '../../scripts/founder-uat-install.mjs';

function validConfiguration() {
  const password = 'a'.repeat(64);
  return {
    HIREARCHY_RUNTIME_PROFILE: 'founder-uat',
    PG_PORT: '5434',
    APP_PORT: '3000',
    GOTRUE_API_PORT: '9997',
    MAILPIT_API_PORT: '8025',
    POSTGRES_PASSWORD: password,
    MIGRATOR_DATABASE_PASSWORD: 'b'.repeat(64),
    R23_GATEWAY_PASSWORD: 'c'.repeat(64),
    CANDIDATE_GATEWAY_PASSWORD: 'd'.repeat(64),
    STAGING_ADMIN_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:5434/postgres`,
    STAGING_MIGRATOR_DATABASE_URL: `postgres://hirearchy_migrator:${'b'.repeat(64)}@127.0.0.1:5434/postgres`,
    STAGING_DATABASE_URL: `postgres://r23_gateway:${'c'.repeat(64)}@127.0.0.1:5434/postgres`,
    STAGING_CANDIDATE_DATABASE_URL: `postgres://app_candidate_gateway:${'d'.repeat(64)}@127.0.0.1:5434/postgres`,
    FOUNDER_UAT_APP_ORIGIN: 'http://127.0.0.1:3000',
    STAGING_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    STAGING_AUTH_URL: 'http://127.0.0.1:9997',
    STAGING_AUTH_ISSUER: 'http://127.0.0.1:9997',
    STAGING_AUTH_AUDIENCE: 'authenticated',
    FOUNDER_UAT_MAILPIT_API_URL: 'http://127.0.0.1:8025',
    STAGING_PROOF_AUDIENCE: 'hirearchy-postgres',
    STAGING_PROOF_KEY_ID: '00000000-0000-4000-8000-000000000000',
  };
}

describe('Founder UAT database configuration', () => {
  it('accepts only the expected local roles, database, and port', () => {
    const configuration =
      validateFounderUatDatabaseConfiguration(validConfiguration());

    expect(configuration.adminUrl).toBe(
      validConfiguration().STAGING_ADMIN_DATABASE_URL,
    );
    expect(configuration.migratorUrl).toBe(
      validConfiguration().STAGING_MIGRATOR_DATABASE_URL,
    );
  });

  it('rejects a privileged URL that targets a non-loopback database', () => {
    const configuration = validConfiguration();
    configuration.STAGING_ADMIN_DATABASE_URL =
      'postgres://postgres:' +
      configuration.POSTGRES_PASSWORD +
      '@203.0.113.8:5434/postgres';

    expect(() =>
      validateFounderUatDatabaseConfiguration(configuration),
    ).toThrow('must use the postgres role on local 127.0.0.1');
  });

  it('rejects a local privileged URL with a different port or URL options', () => {
    const wrongPort = validConfiguration();
    wrongPort.STAGING_ADMIN_DATABASE_URL =
      wrongPort.STAGING_ADMIN_DATABASE_URL.replace(':5434/', ':5433/');
    expect(() => validateFounderUatDatabaseConfiguration(wrongPort)).toThrow(
      'local 127.0.0.1 PostgreSQL port 5434',
    );

    const withOptions = validConfiguration();
    withOptions.STAGING_MIGRATOR_DATABASE_URL += '?sslmode=disable';
    expect(() => validateFounderUatDatabaseConfiguration(withOptions)).toThrow(
      'without URL options',
    );
  });

  it('rejects database URLs whose password differs from protected runtime state', () => {
    const configuration = validConfiguration();
    configuration.STAGING_ADMIN_DATABASE_URL =
      configuration.STAGING_ADMIN_DATABASE_URL.replace(
        configuration.POSTGRES_PASSWORD,
        'wrong-password',
      );

    expect(() =>
      validateFounderUatDatabaseConfiguration(configuration),
    ).toThrow('password must match protected runtime state');
  });
});
