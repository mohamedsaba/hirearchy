import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  stagingSignupGet,
  stagingSignupPost,
  stagingRecoverGet,
  stagingResetPasswordGet,
  stagingResetPasswordPost,
  stagingVerifyEmailPost,
  stagingVerifyEmailGet,
  stagingInvitationAcceptGet,
} from '../../apps/web/src/staging/browser';

describe('Self-Service Onboarding Frontend UI & Staging Handlers', () => {
  const originalEnv = process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED;
  const founderUatEnvKeys = [
    'HIREARCHY_RUNTIME_PROFILE',
    'FOUNDER_UAT_APP_ORIGIN',
    'STAGING_PUBLIC_ORIGIN',
    'STAGING_AUTH_URL',
    'STAGING_AUTH_ISSUER',
    'STAGING_AUTH_AUDIENCE',
    'STAGING_DATABASE_URL',
    'FOUNDER_UAT_MAILPIT_API_URL',
    'STAGING_PROOF_ISSUER',
    'STAGING_PROOF_AUDIENCE',
    'STAGING_PROOF_KEY_ID',
    'STAGING_PROOF_PRIVATE_KEY',
  ];
  const originalFounderUatEnv = new Map(
    founderUatEnvKeys.map((key) => [key, process.env[key]]),
  );

  const enableFounderUat = () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    Object.assign(process.env, {
      HIREARCHY_RUNTIME_PROFILE: 'founder-uat',
      FOUNDER_UAT_APP_ORIGIN: 'http://127.0.0.1:3000',
      STAGING_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
      STAGING_AUTH_URL: 'http://127.0.0.1:9998',
      STAGING_AUTH_ISSUER: 'http://127.0.0.1:9998/auth/v1',
      STAGING_AUTH_AUDIENCE: 'authenticated',
      STAGING_DATABASE_URL:
        'postgresql://r23_gateway:local-test@127.0.0.1:5432/postgres',
      FOUNDER_UAT_MAILPIT_API_URL: 'http://127.0.0.1:8025',
      STAGING_PROOF_ISSUER: 'hirearchy',
      STAGING_PROOF_AUDIENCE: 'database',
      STAGING_PROOF_KEY_ID: 'unit-test-key',
      STAGING_PROOF_PRIVATE_KEY: privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
    });
  };

  beforeEach(() => {
    delete process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED;
    for (const key of founderUatEnvKeys) delete process.env[key];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED = originalEnv;
    } else {
      delete process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED;
    }
    for (const [key, value] of originalFounderUatEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('stagingSignupGet', () => {
    it('returns 403 with gated notice when self-service onboarding is disabled', async () => {
      process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED = 'false';
      const request = new Request('https://hirearchy.test/r23/signup');
      const response = await stagingSignupGet(request);

      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain('Self-service registration disabled');
      expect(html).toContain('emailDeliveryEnabled: false');
      expect(html).toContain('/r23/login');
    });

    it('returns 200 with registration form and truthful non-SMTP notice when enabled', async () => {
      process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED = 'true';
      const request = new Request(
        'https://hirearchy.test/r23/signup?email=user%40example.test',
      );
      const response = await stagingSignupGet(request);

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Create your Hirearchy account');
      expect(html).toContain('emailDeliveryEnabled: false');
      expect(html).toContain('user@example.test');
      expect(html).toContain('name="password"');
      expect(html).toContain('action="/r23/signup"');
    });
  });

  describe('stagingSignupPost validation', () => {
    it('rejects short passwords (< 6 chars) with 400', async () => {
      process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED = 'true';
      const request = new Request('https://hirearchy.test/r23/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://hirearchy.test',
        },
        body: new URLSearchParams({
          email: 'test@example.test',
          password: '123',
        }).toString(),
      });

      const response = await stagingSignupPost(request);
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('password must be at least 6 characters');
    });

    it('denies signup with 403 when gate is disabled', async () => {
      process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED = 'false';
      const request = new Request('https://hirearchy.test/r23/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://hirearchy.test',
        },
        body: new URLSearchParams({
          email: 'test@example.test',
          password: 'validPassword123!',
        }).toString(),
      });

      const response = await stagingSignupPost(request);
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain('Self-service onboarding is disabled');
    });
  });

  describe('stagingRecoverGet', () => {
    it('returns 200 with recovery form and truthful non-SMTP disclosure', () => {
      const response = stagingRecoverGet();
      expect(response.status).toBe(200);
      return response.text().then((html) => {
        expect(html).toContain('Request password recovery');
        expect(html).toContain('emailDeliveryEnabled: false');
        expect(html).toContain('name="email"');
        expect(html).toContain('/r23/login');
      });
    });
  });

  describe('stagingResetPasswordGet & Post validation', () => {
    it('returns 200 with reset password form and recovery quarantine notice', async () => {
      const request = new Request(
        'https://hirearchy.test/r23/reset-password?token=sample-recovery-token',
      );
      const response = stagingResetPasswordGet(request);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Set new password');
      expect(html).toContain('Security notice:');
      expect(html).toContain('sample-recovery-token');
      expect(html).toContain('name="password"');
    });

    it('rejects short passwords (< 6 chars) on reset with 400', async () => {
      const request = new Request('https://hirearchy.test/r23/reset-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://hirearchy.test',
        },
        body: new URLSearchParams({
          token: 'recovery-token-xyz',
          password: 'short',
        }).toString(),
      });

      const response = await stagingResetPasswordPost(request);
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('New password must be at least 6 characters');
    });
  });

  describe('stagingVerifyEmailGet', () => {
    it('returns manual verification token entry form when token not in query', async () => {
      const request = new Request('https://hirearchy.test/r23/verify-email');
      const response = await stagingVerifyEmailGet(request);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Confirm your email address');
      expect(html).toContain('name="token"');
      expect(html).toContain('/r23/login');
    });
  });

  describe('stagingInvitationAcceptGet', () => {
    it('returns 400 when invitation token is missing from query', async () => {
      const request = new Request(
        'https://hirearchy.test/r23/invitations/accept',
      );
      const response = await stagingInvitationAcceptGet(request);
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('An invitation token is required in the link');
    });

    it('renders unauthenticated invitation screen prompting sign-in or registration', async () => {
      const request = new Request(
        'https://hirearchy.test/r23/invitations/accept?token=sample-invite-token-123',
      );
      const response = await stagingInvitationAcceptGet(request);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Join organization as reviewer');
      expect(html).toContain('Sign in with invited account');
      expect(html).toContain('Create new account');
      expect(html).toContain('sample-invite-token-123');
    });
  });

  describe('founder UAT onboarding UI', () => {
    it('shows local confirmation guidance on signup without claiming email is disabled', async () => {
      enableFounderUat();
      process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED = 'true';
      const response = await stagingSignupGet(
        new Request('http://127.0.0.1:3000/r23/signup'),
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(
        'confirmation message will appear in the local inbox',
      );
      expect(html).not.toContain('emailDeliveryEnabled: false');
    });

    it('offers the local inbox instead of a manual verification token field', async () => {
      enableFounderUat();
      const response = await stagingVerifyEmailGet(
        new Request(
          'http://127.0.0.1:3000/r23/verify-email?email=person%40example.test&token=do-not-render',
        ),
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('/r23/mail?email=person%40example.test');
      expect(html).not.toContain('name="token"');
      expect(html).not.toContain('do-not-render');
    });

    it('rejects manual verification-token submission in founder UAT', async () => {
      enableFounderUat();
      const response = await stagingVerifyEmailPost(
        new Request('http://127.0.0.1:3000/r23/verify-email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: 'http://127.0.0.1:3000',
          },
          body: new URLSearchParams({ token: 'secret-token' }),
        }),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('Use the local inbox');
      expect(html).not.toContain('secret-token');
    });

    it('shows captured-mail recovery guidance and keeps the non-UAT disclosure out', async () => {
      enableFounderUat();
      const html = await (await stagingRecoverGet()).text();
      expect(html).toContain('Recovery messages for this local test');
      expect(html).not.toContain('emailDeliveryEnabled: false');
    });

    it('uses password-only reset and renders only safe recovery errors', async () => {
      enableFounderUat();
      const response = stagingResetPasswordGet(
        new Request(
          'http://127.0.0.1:3000/r23/reset-password?token=secret-token&error=expired',
        ),
      );
      const html = await response.text();
      expect(html).toContain('action="/api/founder-uat/auth/reset-password"');
      expect(html).not.toContain('name="token"');
      expect(html).not.toContain('secret-token');
      expect(html).toContain(
        'This recovery message has expired or was already used',
      );
      expect(html).toContain('sign in again');
    });

    it('does not accept the legacy raw-token reset POST', async () => {
      enableFounderUat();
      const response = await stagingResetPasswordPost(
        new Request('http://127.0.0.1:3000/r23/reset-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: 'http://127.0.0.1:3000',
          },
          body: new URLSearchParams({
            token: 'secret-token',
            password: 'NewPassword-123!',
          }),
        }),
      );

      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('secret-token');
    });

    it('preserves reviewer invitation context through explicit login or signup actions', async () => {
      enableFounderUat();
      const response = await stagingInvitationAcceptGet(
        new Request(
          'http://127.0.0.1:3000/r23/invitations/accept?token=invitation-token-123',
        ),
      );
      const html = await response.text();
      expect(html).toContain('action="/api/founder-uat/invitations/context"');
      expect(html).toContain('name="destination" value="login"');
      expect(html).toContain('name="destination" value="signup"');
      expect(html).not.toContain('redirect=');
      expect(html).toContain('Use the email address your inviter specified');
    });
  });
});
