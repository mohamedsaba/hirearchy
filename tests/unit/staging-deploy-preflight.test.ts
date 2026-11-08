import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { runPreflightChecks } from '../../deploy/staging/preflight.mjs';

const releaseSha = 'a'.repeat(40);
const password = 'b'.repeat(64);
const proofPrivateKey = generateKeyPairSync('ed25519')
  .privateKey.export({ format: 'der', type: 'pkcs8' })
  .toString('base64');

function validEnvironment(): Record<string, string> {
  return {
    HIREARCHY_DEPLOY_MODE: 'supervised-alpha',
    COMPOSE_PROJECT_NAME: 'hirearchy-test-alpha',
    HIREARCHY_RELEASE_SHA: releaseSha,
    HIREARCHY_TRUSTED_PROXY_HOPS: '0',
    PREVIEW_HOSTNAME: 'preview.example.test',
    STAGING_HOSTNAME: 'alpha.example.test',
    CADDY_BIND_ADDRESS: '127.0.0.1',
    STAGING_ALLOWED_CIDRS: '192.0.2.10/32 2001:db8::10/128',
    PG_BIND_ADDRESS: '127.0.0.1',
    PG_PORT: '55432',
    AUTH_BIND_ADDRESS: '127.0.0.1',
    GOTRUE_API_PORT: '59998',
    APP_PORT: '53000',
    PREVIEW_APP_PORT: '53001',
    CADDY_HTTP_PORT: '58080',
    CADDY_HTTPS_PORT: '58443',
    POSTGRES_PASSWORD: password,
    GOTRUE_DB_PASSWORD: password,
    MIGRATOR_DATABASE_PASSWORD: password,
    R23_GATEWAY_PASSWORD: password,
    CANDIDATE_GATEWAY_PASSWORD: password,
    APP_EVALUATOR_PASSWORD: password,
    CONTROL_WORKER_PASSWORD: password,
    GOTRUE_JWT_SECRET: password,
    STAGING_PROOF_PRIVATE_KEY: proofPrivateKey,
    STAGING_PROOF_ISSUER: 'hirearchy-staging',
    STAGING_PROOF_AUDIENCE: 'hirearchy-postgres',
    STAGING_PROOF_KEY_ID: 'staging-key-1',
    HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString(
      'base64',
    ),
    STAGING_ADMIN_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:55432/postgres`,
    STAGING_MIGRATOR_DATABASE_URL: `postgres://hirearchy_migrator:${password}@127.0.0.1:55432/postgres`,
    STAGING_DATABASE_URL: `postgres://r23_gateway:${password}@127.0.0.1:55432/postgres`,
    STAGING_CANDIDATE_DATABASE_URL: `postgres://app_candidate_gateway:${password}@127.0.0.1:55432/postgres`,
    STAGING_AUTH_URL: 'http://127.0.0.1:59998',
    STAGING_AUTH_ISSUER: 'https://alpha.example.test',
    STAGING_AUTH_AUDIENCE: 'authenticated',
    STAGING_PUBLIC_ORIGIN: 'https://alpha.example.test:58443',
  };
}

const testEvidence = {
  dockerComposeVersion: 'Docker Compose version v2.40.3',
  checkoutSha: releaseSha,
  workingTreeClean: true,
};

describe('single-team staging preflight', () => {
  it('accepts a complete clean loopback deployment configuration', () => {
    const checks = runPreflightChecks(validEnvironment(), testEvidence);

    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it('rejects public database URLs, broad access CIDRs, proxy trust, and invalid secrets', () => {
    const environment = validEnvironment();
    environment.STAGING_DATABASE_URL = `postgres://r23_gateway:${password}@db.example.test:55432/postgres`;
    environment.STAGING_ALLOWED_CIDRS = '0.0.0.0/0';
    environment.HIREARCHY_TRUSTED_PROXY_HOPS = '1';
    environment.STAGING_PROOF_PRIVATE_KEY = 'not-a-key';
    environment.HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY = 'not-a-key';
    environment.HIREARCHY_RELEASE_SHA = 'c'.repeat(40);
    environment.STAGING_PUBLIC_ORIGIN = 'https://alpha.example.test';

    const checks = runPreflightChecks(environment, testEvidence);
    const failures = checks.filter((check) => !check.passed).map((c) => c.name);

    expect(failures).toContain('STAGING_DATABASE_URL loopback URL');
    expect(failures).toContain('Staging edge allowlist is restricted');
    expect(failures).toContain('Trusted proxy hops stay disabled');
    expect(failures).toContain(
      'STAGING_PUBLIC_ORIGIN matches the HTTPS proxy origin',
    );
    expect(failures).toContain(
      'STAGING_PROOF_PRIVATE_KEY is canonical Ed25519 PKCS#8',
    );
    expect(failures).toContain(
      'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY is canonical 32-byte base64',
    );
    expect(failures).toContain(
      'Release provenance matches clean checked-out commit',
    );
  });

  it('accepts the standard production HTTPS origin without a port suffix', () => {
    const environment = validEnvironment();
    environment.CADDY_HTTP_PORT = '80';
    environment.CADDY_HTTPS_PORT = '443';
    environment.STAGING_PUBLIC_ORIGIN = 'https://alpha.example.test';

    const checks = runPreflightChecks(environment, testEvidence);

    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it('preflights public preview without PostgreSQL, GoTrue, or proof secrets', () => {
    const previewEnvironment = {
      HIREARCHY_DEPLOY_MODE: 'public-preview',
      COMPOSE_PROJECT_NAME: 'hirearchy-test-preview',
      HIREARCHY_RELEASE_SHA: releaseSha,
      HIREARCHY_TRUSTED_PROXY_HOPS: '0',
      PREVIEW_HOSTNAME: 'preview.example.test',
      PREVIEW_APP_PORT: '53001',
      CADDY_HTTP_PORT: '58080',
      CADDY_HTTPS_PORT: '58443',
      CADDY_BIND_ADDRESS: '127.0.0.1',
    };

    const checks = runPreflightChecks(previewEnvironment, testEvidence);

    expect(checks.every((check) => check.passed)).toBe(true);
  });
});
