import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  OperationalLogger,
  redactSensitiveData,
  sanitizeError,
} from '../../apps/web/src/observability/logger.mjs';
import { checkOperationalReadiness } from '../../apps/web/src/observability/readiness.mjs';

describe('Secret Redaction & Observability Logging', () => {
  it('redacts database credentials in URLs', () => {
    const rawUrl =
      'postgres://r23_gateway:superSecretPassword123@127.0.0.1:5432/staging_db';
    const redacted = redactSensitiveData(rawUrl);
    expect(redacted).not.toContain('superSecretPassword123');
    expect(redacted).not.toContain('r23_gateway');
    expect(redacted).toContain(
      'postgres://[REDACTED_USER]:[REDACTED_SECRET]@127.0.0.1:5432/staging_db',
    );
  });

  it('redacts bearer tokens and long base64 cryptographic keys', () => {
    const bearer =
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeak';
    expect(redactSensitiveData(bearer)).toBe('Bearer [REDACTED_TOKEN]');

    // 44-char base64 AES key or 64-char key
    const base64Key = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkwMSE=';
    expect(redactSensitiveData(base64Key)).toBe('[REDACTED_KEY]');
  });

  it('redacts sensitive fields in nested objects', () => {
    const payload = {
      user: {
        id: '123',
        email: 'alice@example.com',
        password: 'Password123!',
        recoveryToken: 'rec-xyz-987',
      },
      headers: {
        authorization: 'Bearer token123',
        cookie: 'session=abc',
      },
      safeField: 'visible',
    };

    const redacted = redactSensitiveData(payload) as Record<string, unknown>;
    expect(redacted.safeField).toBe('visible');
    expect((redacted.user as Record<string, unknown>).id).toBe('123');
    expect((redacted.user as Record<string, unknown>).password).toBe(
      '[REDACTED]',
    );
    expect((redacted.user as Record<string, unknown>).recoveryToken).toBe(
      '[REDACTED]',
    );
    expect((redacted.headers as Record<string, unknown>).authorization).toBe(
      '[REDACTED]',
    );
    expect((redacted.headers as Record<string, unknown>).cookie).toBe(
      '[REDACTED]',
    );
  });

  it('sanitizes error objects without leaking stack traces or sensitive strings', () => {
    const err = new Error(
      'Connection failed to postgres://user:pass@127.0.0.1:5432/db',
    );
    (err as unknown as { code: string }).code = 'ECONNREFUSED';

    const sanitized = sanitizeError(err);
    expect(sanitized.name).toBe('Error');
    expect(sanitized.code).toBe('ECONNREFUSED');
    expect(sanitized.message).not.toContain('pass');
    expect(sanitized.message).toContain('[REDACTED_SECRET]');
    expect('stack' in sanitized).toBe(false);
  });

  it('structured operational logger redacts context', () => {
    const logger = new OperationalLogger();
    const entry = logger.info('user.login.attempt', {
      email: 'user@example.test',
      password: 'cleartext-password',
      dbUrl: 'postgres://app:dbpass@localhost:5432/db',
    });

    expect(entry.event).toBe('user.login.attempt');
    expect(entry.context?.password).toBe('[REDACTED]');
    expect(entry.context?.dbUrl).not.toContain('dbpass');
  });
});

describe('checkOperationalReadiness', () => {
  beforeEach(() => {
    delete process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED;
    delete process.env.STAGING_DATABASE_URL;
  });

  afterEach(() => {
    delete process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED;
    delete process.env.STAGING_DATABASE_URL;
  });

  it('truthfully reports capability restrictions when database is not configured', async () => {
    const report = await checkOperationalReadiness();
    expect(report.status).toBe('not_ready');
    expect(report.database.connected).toBe(false);
    expect(report.database.targetMigrationVersion).toBe('0017');
    expect(report.capabilities).toEqual({
      liveCodeExecutionEnabled: false,
      liveAiAssistanceEnabled: false,
      emailDeliveryEnabled: false,
      selfServiceOnboardingEnabled: false,
      managedSupabaseSupported: false,
    });
  });

  it('reflects self-service onboarding enabled flag when configured', async () => {
    process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED = 'true';
    const report = await checkOperationalReadiness();
    expect(report.capabilities.selfServiceOnboardingEnabled).toBe(true);
    expect(report.capabilities.liveCodeExecutionEnabled).toBe(false);
    expect(report.capabilities.emailDeliveryEnabled).toBe(false);
    expect(report.capabilities.managedSupabaseSupported).toBe(false);
  });

  it('handles database connection failure cleanly without leaking credentials', async () => {
    const report = await checkOperationalReadiness(
      'postgres://test_user:super_secret@127.0.0.1:1/nonexistent',
    );
    expect(report.status).toBe('not_ready');
    expect(report.database.connected).toBe(false);
    expect(report.database.error).toBeDefined();
    expect(report.database.error).not.toContain('super_secret');
  });
});
