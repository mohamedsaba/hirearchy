import { afterEach, describe, expect, it, vi } from 'vitest';

import type { R23Config } from '../../apps/web/src/r23-auth/config';
import {
  assertR23VerifiedIdentity,
  R23AuthenticationDenied,
  verifyR23AccessToken,
} from '../../apps/web/src/r23-auth/identity';

const subjectA = '10000000-0000-4000-8000-0000000000a1';
const subjectB = '20000000-0000-4000-8000-0000000000b1';
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const config: R23Config = {
  authUrl: new URL('http://127.0.0.1:54321'),
  authIssuer: 'https://auth.hirearchy.test/auth/v1',
  authAudience: 'authenticated',
  databaseUrl: 'postgres://r23_gateway:synthetic@127.0.0.1:5432/postgres',
  publicOrigin: 'https://127.0.0.1:3000',
  sessionKey: Buffer.alloc(32),
  appSessionTtlSeconds: 900,
};

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function accessToken(
  overrides: Record<string, unknown> = {},
  expiresAt = Math.floor(Date.now() / 1000) + 300,
): string {
  const header = segment({ alg: 'HS256', typ: 'JWT' });
  const claims = segment({
    sub: subjectA,
    session_id: sessionId,
    aal: 'aal1',
    iss: config.authIssuer,
    aud: config.authAudience,
    exp: expiresAt,
    ...overrides,
  });
  return `${header}.${claims}.synthetic-signature`;
}

afterEach(() => vi.unstubAllGlobals());

describe('R23 Auth identity verification', () => {
  it('requires GoTrue to accept the bearer before branding its identity', async () => {
    const token = accessToken();
    const authFetch = vi.fn<typeof fetch>(
      async () => new Response('{}', { status: 401 }),
    );
    vi.stubGlobal('fetch', authFetch);

    await expect(verifyR23AccessToken(config, token)).rejects.toBeInstanceOf(
      R23AuthenticationDenied,
    );
    expect(authFetch).toHaveBeenCalledOnce();

    expect(() =>
      assertR23VerifiedIdentity({
        subjectId: subjectA,
        sessionId,
        assurance: 'aal1',
        email: null,
        emailVerified: false,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toThrow(R23AuthenticationDenied);
  });

  it('rejects an expired access token without asking GoTrue to verify it', async () => {
    const authFetch = vi.fn();
    vi.stubGlobal('fetch', authFetch);

    await expect(
      verifyR23AccessToken(config, accessToken({}, 1)),
    ).rejects.toBeInstanceOf(R23AuthenticationDenied);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('checks that the GoTrue user matches the token subject before branding', async () => {
    const token = accessToken();
    const authFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ id: subjectB, email: 'other@example.test' }),
    );
    vi.stubGlobal('fetch', authFetch);

    await expect(verifyR23AccessToken(config, token)).rejects.toBeInstanceOf(
      R23AuthenticationDenied,
    );
    expect(authFetch).toHaveBeenCalledOnce();
  });

  it('brands only the identity returned after GoTrue accepts the bearer', async () => {
    const token = accessToken();
    const authFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: subjectA,
        email: 'evaluator@example.test',
        email_confirmed_at: '2026-10-30T00:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', authFetch);

    const identity = await verifyR23AccessToken(config, token);
    expect(identity).toMatchObject({
      subjectId: subjectA,
      sessionId,
      assurance: 'aal1',
      email: 'evaluator@example.test',
      emailVerified: true,
    });
    expect(assertR23VerifiedIdentity(identity)).toBe(identity);
    expect(authFetch).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = authFetch.mock.calls[0];
    expect(String(requestUrl)).toBe('http://127.0.0.1:54321/user');
    expect(requestInit?.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
    });

    expect(() => assertR23VerifiedIdentity({ ...identity })).toThrow(
      R23AuthenticationDenied,
    );
  });
});
