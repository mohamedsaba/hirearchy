import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  R26ConfigurationError,
  r26IsEnabled,
  readR26Config,
} from '../../apps/web/src/r26-candidate/config';

const configure = () => {
  const values = {
    NODE_ENV: 'test',
    HIREARCHY_R23_DISPOSABLE: '1',
    HIREARCHY_R26_DISPOSABLE: '1',
    R23_PUBLIC_ORIGIN: 'https://127.0.0.1:4443',
    R23_AUTH_URL: 'http://127.0.0.1:9999',
    R23_AUTH_ISSUER: 'https://auth.example.test/auth/v1',
    R23_AUTH_AUDIENCE: 'authenticated',
    R23_DATABASE_URL:
      'postgres://r23_gateway:synthetic@127.0.0.1:5432/postgres',
    R23_SESSION_KEY: Buffer.alloc(32, 7).toString('base64'),
    R23_APP_SESSION_TTL_SECONDS: '900',
    R26_DATABASE_URL:
      'postgres://app_candidate_gateway:synthetic@127.0.0.1:5432/postgres',
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
};

afterEach(() => vi.unstubAllEnvs());

describe('isolated PostgreSQL candidate configuration', () => {
  it('stays disabled in production even when both disposable flags are set', () => {
    configure();
    vi.stubEnv('NODE_ENV', 'production');
    expect(r26IsEnabled()).toBe(false);
    expect(readR26Config()).toBeNull();
  });

  it('requires both explicit disposable flags', () => {
    configure();
    vi.stubEnv('HIREARCHY_R26_DISPOSABLE', '');
    expect(readR26Config()).toBeNull();
    vi.stubEnv('HIREARCHY_R26_DISPOSABLE', '1');
    vi.stubEnv('HIREARCHY_R23_DISPOSABLE', '');
    expect(readR26Config()).toBeNull();
  });

  it('accepts only the restricted candidate login on the same loopback database', () => {
    configure();
    expect(readR26Config()?.publicOrigin).toBe('https://127.0.0.1:4443');
    for (const url of [
      'postgres://postgres:synthetic@127.0.0.1:5432/postgres',
      'postgres://hirearchy_migrator:synthetic@127.0.0.1:5432/postgres',
      'postgres://app_candidate_gateway:synthetic@127.0.0.1:5433/postgres',
      'postgres://app_candidate_gateway:synthetic@db.example.test:5432/postgres',
      'postgres://app_candidate_gateway:synthetic@127.0.0.1:5432/postgres?sslmode=disable',
    ]) {
      vi.stubEnv('R26_DATABASE_URL', url);
      expect(() => readR26Config()).toThrow(R26ConfigurationError);
    }
  });

  it('requires the durable candidate login to share an explicit database with staging', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-authenticated');
    vi.stubEnv(
      'STAGING_DATABASE_URL',
      'postgres://r23_gateway:recruiter-only@127.0.0.1:5432/postgres',
    );
    vi.stubEnv(
      'STAGING_CANDIDATE_DATABASE_URL',
      'postgres://app_candidate_gateway:candidate-only@127.0.0.1:5432/postgres',
    );
    vi.stubEnv('STAGING_PUBLIC_ORIGIN', 'http://127.0.0.1:3000');
    vi.stubEnv('HIREARCHY_R26_DISPOSABLE', '1');
    vi.stubEnv(
      'R26_DATABASE_URL',
      'postgres://app_candidate_gateway:ignored@127.0.0.1:5432/other',
    );

    expect(readR26Config()).toMatchObject({
      databaseUrl:
        'postgres://app_candidate_gateway:candidate-only@127.0.0.1:5432/postgres',
      publicOrigin: 'http://127.0.0.1:3000',
      profile: 'durable-staging',
    });

    for (const [recruiterUrl, candidateUrl] of [
      [
        'postgres://r23_gateway:recruiter-only@127.0.0.1:5432/postgres',
        'postgres://app_candidate_gateway:candidate-only@127.0.0.1:5432',
      ],
      [
        'postgres://r23_gateway:recruiter-only@127.0.0.1:5432',
        'postgres://app_candidate_gateway:candidate-only@127.0.0.1:5432',
      ],
      [
        'postgres://r23_gateway:recruiter-only@127.0.0.1:5432/postgres',
        'postgres://app_candidate_gateway:candidate-only@127.0.0.1:5432/other',
      ],
      [
        'postgres://r23_gateway:recruiter-only@127.0.0.1:5432/postgres?sslmode=disable',
        'postgres://app_candidate_gateway:candidate-only@127.0.0.1:5432/postgres',
      ],
    ]) {
      vi.stubEnv('STAGING_DATABASE_URL', recruiterUrl);
      vi.stubEnv('STAGING_CANDIDATE_DATABASE_URL', candidateUrl);
      expect(() => readR26Config()).toThrow(R26ConfigurationError);
    }
  });
});
