import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  stagingSignupGet,
  stagingSignupPost,
  stagingRecoverGet,
  stagingResetPasswordGet,
  stagingResetPasswordPost,
  stagingVerifyEmailGet,
  stagingInvitationAcceptGet,
} from '../../apps/web/src/staging/browser';

describe('Self-Service Onboarding Frontend UI & Staging Handlers', () => {
  const originalEnv = process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED;

  beforeEach(() => {
    delete process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED = originalEnv;
    } else {
      delete process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED;
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
        expect(html).toContain('Request Password Recovery');
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
});
