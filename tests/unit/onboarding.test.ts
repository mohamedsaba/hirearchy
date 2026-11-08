import { describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  decryptInvitationToken,
  encryptInvitationToken,
  invitationTokenHash,
} from '../../apps/web/src/staging/onboarding';

describe('Reviewer invitation encryption and hashing', () => {
  const encryptionKey = Buffer.from(
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    'base64',
  );

  it('computes deterministic SHA-256 token hash', () => {
    const token = 'sample-invitation-token-12345';
    const hash = invitationTokenHash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(invitationTokenHash(token)).toBe(hash);
    expect(invitationTokenHash('different-token')).not.toBe(hash);
  });

  it('encrypts and decrypts reviewer invitation tokens with organization-bound AAD', () => {
    const orgId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const ciphertext = encryptInvitationToken(token, orgId, encryptionKey);

    expect(ciphertext).toMatch(
      /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );

    const decrypted = decryptInvitationToken(ciphertext, orgId, encryptionKey);
    expect(decrypted).toBe(token);
  });

  it('rejects decryption when bound to a different organization ID', () => {
    const orgId1 = randomUUID();
    const orgId2 = randomUUID();
    const token = 'confidential-token-material';
    const ciphertext = encryptInvitationToken(token, orgId1, encryptionKey);

    expect(() =>
      decryptInvitationToken(ciphertext, orgId2, encryptionKey),
    ).toThrow();
  });

  it('rejects decryption with incorrect key', () => {
    const orgId = randomUUID();
    const wrongKey = Buffer.from(
      'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      'base64',
    );
    const token = 'confidential-token-material';
    const ciphertext = encryptInvitationToken(token, orgId, encryptionKey);

    expect(() => decryptInvitationToken(ciphertext, orgId, wrongKey)).toThrow();
  });

  it('rejects corrupted ciphertext', () => {
    const orgId = randomUUID();
    expect(() =>
      decryptInvitationToken('invalid-format', orgId, encryptionKey),
    ).toThrow('Invalid invitation ciphertext format');
    expect(() =>
      decryptInvitationToken('v1.short.short.short', orgId, encryptionKey),
    ).toThrow('Invalid invitation ciphertext segments');
  });
});
