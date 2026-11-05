import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { R23Config } from '../../apps/web/src/r23-auth/config';
import { verifyR23AccessToken } from '../../apps/web/src/r23-auth/identity';
import { issueStagingProof } from '../../apps/web/src/r23-auth/staging-proof';

const subject = '10000000-0000-4000-8000-0000000000a1';
const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config: R23Config = {
  authUrl: new URL('http://127.0.0.1:54321'),
  authIssuer: 'https://auth.example.test',
  authAudience: 'authenticated',
  databaseUrl: 'postgres://r23_gateway:synthetic@127.0.0.1:5432/postgres',
  publicOrigin: 'https://127.0.0.1:3000',
  sessionKey: Buffer.alloc(32),
  appSessionTtlSeconds: 900,
};
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

afterEach(() => vi.unstubAllGlobals());

describe('staging proof issuer', () => {
  it('signs exact bounded claims for a GoTrue-verified identity', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const token = `${encode({ alg: 'HS256' })}.${encode({ sub: subject, session_id: session, aal: 'aal1', iss: config.authIssuer, aud: config.authAudience, exp: expiresAt })}.signature`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id: subject })),
    );
    const identity = await verifyR23AccessToken(config, token);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const issuer = {
      issuer: 'hirearchy',
      audience: 'database',
      keyId: 'key-1',
      privateKey,
    };
    const proof = issueStagingProof(issuer, identity, 'session.mint', {
      handle: 'digest',
    });
    const claims = JSON.parse(proof.payload.toString());
    expect(claims).toMatchObject({
      v: 1,
      iss: 'hirearchy',
      aud: 'database',
      kid: 'key-1',
      auth_exp: expiresAt,
      sub: subject,
      sid: session,
      op: 'session.mint',
      args: { handle: 'digest' },
    });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
    expect(verify(null, proof.payload, publicKey, proof.signature)).toBe(true);
    expect(
      verify(
        null,
        Buffer.from(`${proof.payload} `),
        publicKey,
        proof.signature,
      ),
    ).toBe(false);
    expect(
      issueStagingProof(issuer, identity, 'session.mint', {}).payload.equals(
        proof.payload,
      ),
    ).toBe(false);
    expect(() =>
      issueStagingProof(issuer, { ...identity }, 'session.mint', {}),
    ).toThrow();
    expect(() =>
      issueStagingProof(issuer, identity, 'session.mint', { bad: 1.5 }),
    ).toThrow();
  });
});
