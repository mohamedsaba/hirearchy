import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  founderUatInvitationCookie,
  founderUatRecoveryCookie,
  hasFounderUatPendingInvitation,
  readFounderUatPendingInvitation,
  readFounderUatRecovery,
} from '../../apps/web/src/r23-auth/founder-uat-state';
import { verifyR23AccessToken } from '../../apps/web/src/r23-auth/identity';

const subject = '10000000-0000-4000-8000-0000000000a1';
const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const authUrl = new URL('http://127.0.0.1:9998');
const authIssuer = 'http://127.0.0.1:9998/auth/v1';
const audience = 'authenticated';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function configureFounderUat() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const environment = {
    HIREARCHY_RUNTIME_PROFILE: 'founder-uat',
    FOUNDER_UAT_APP_ORIGIN: 'http://127.0.0.1:3000',
    FOUNDER_UAT_MAILPIT_API_URL: 'http://127.0.0.1:8025',
    STAGING_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    STAGING_AUTH_URL: authUrl.origin,
    STAGING_AUTH_ISSUER: authIssuer,
    STAGING_AUTH_AUDIENCE: audience,
    STAGING_DATABASE_URL:
      'postgresql://r23_gateway:local-test@127.0.0.1:5432/postgres',
    STAGING_PROOF_PRIVATE_KEY: privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    STAGING_PROOF_ISSUER: 'hirearchy-staging',
    STAGING_PROOF_AUDIENCE: 'hirearchy-postgres',
    STAGING_PROOF_KEY_ID: 'founder-uat-test',
  };
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function verifiedIdentity() {
  const token = `${encode({ alg: 'HS256' })}.${encode({
    sub: subject,
    session_id: session,
    aal: 'aal1',
    iss: authIssuer,
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 300,
    amr: [{ method: 'password', timestamp: 1 }],
  })}.signature`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        id: subject,
        email: 'founder@local.test',
        email_confirmed_at: '2026-11-10T00:00:00.000Z',
      }),
    ),
  );
  return verifyR23AccessToken(
    { authUrl, authIssuer, authAudience: audience },
    token,
  );
}

describe('Founder UAT purpose-bound cookie state', () => {
  it('seals invitation bearer state and exposes it only to a password-eligible verified identity', async () => {
    configureFounderUat();
    const token = 'a'.repeat(43);
    const cookie = founderUatInvitationCookie(token, 'login');
    expect(cookie).toContain('__Host-founder-uat-invitation=');
    expect(cookie).toContain('Secure; HttpOnly; SameSite=Strict');
    expect(cookie).not.toContain(token);

    const cookieValue = cookie.split(';', 1)[0];
    const request = new Request('http://127.0.0.1:3000/r23/auth/callback', {
      headers: { cookie: cookieValue },
    });
    expect(hasFounderUatPendingInvitation(request)).toBe(true);
    await expect(
      readFounderUatPendingInvitation(request, await verifiedIdentity()),
    ).resolves.toMatchObject({
      token,
      clearCookie: expect.stringContaining('Max-Age=0'),
    });

    const tampered = new Request(request.url, {
      headers: {
        cookie: `${cookieValue.slice(0, -1)}${cookieValue.endsWith('x') ? 'y' : 'x'}`,
      },
    });
    expect(hasFounderUatPendingInvitation(tampered)).toBe(false);
  });

  it('seals recovery bearer state under a separate purpose cookie', async () => {
    configureFounderUat();
    const accessToken = 'opaque-recovery-grant-value';
    const cookie = founderUatRecoveryCookie({
      subjectId: subject,
      email: 'founder@local.test',
      accessToken,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
    expect(cookie).toContain('__Host-founder-uat-recovery=');
    expect(cookie).toContain('Secure; HttpOnly; SameSite=Strict');
    expect(cookie).not.toContain(accessToken);

    const request = new Request('http://127.0.0.1:3000/r23/reset-password', {
      headers: { cookie: cookie.split(';', 1)[0] },
    });
    expect(readFounderUatRecovery(request)).toMatchObject({
      purpose: 'recovery',
      subjectId: subject,
      email: 'founder@local.test',
      accessToken,
    });
    await expect(
      readFounderUatPendingInvitation(request, await verifiedIdentity()),
    ).resolves.toBeNull();
  });
});
