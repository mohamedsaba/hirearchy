import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { R23AuthenticationDenied, type R23CredentialPair } from './identity';

const VERSION = 1;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

function aad(subjectId: string, sessionId: string): Buffer {
  return Buffer.from(`hirearchy-r23-auth-v1:${subjectId}:${sessionId}`);
}

export function encryptCredentialPair(
  pair: R23CredentialPair,
  sessionKey: Buffer,
  subjectId: string,
  sessionId: string,
): Buffer {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', sessionKey, nonce);
  cipher.setAAD(aad(subjectId, sessionId));
  const ciphertext = Buffer.concat([
    cipher.update(
      JSON.stringify({
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
      }),
      'utf8',
    ),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([VERSION]),
    nonce,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

export function decryptCredentialPair(
  envelope: Buffer,
  sessionKey: Buffer,
  subjectId: string,
  sessionId: string,
): R23CredentialPair {
  if (
    !Buffer.isBuffer(envelope) ||
    envelope.length <= 1 + NONCE_LENGTH + TAG_LENGTH ||
    envelope[0] !== VERSION
  ) {
    throw new R23AuthenticationDenied();
  }
  try {
    const nonce = envelope.subarray(1, 1 + NONCE_LENGTH);
    const tag = envelope.subarray(
      1 + NONCE_LENGTH,
      1 + NONCE_LENGTH + TAG_LENGTH,
    );
    const ciphertext = envelope.subarray(1 + NONCE_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', sessionKey, nonce);
    decipher.setAAD(aad(subjectId, sessionId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    const value: unknown = JSON.parse(plaintext);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof (value as Record<string, unknown>).accessToken !== 'string' ||
      typeof (value as Record<string, unknown>).refreshToken !== 'string' ||
      (value as Record<string, unknown>).accessToken === '' ||
      (value as Record<string, unknown>).refreshToken === ''
    ) {
      throw new R23AuthenticationDenied();
    }
    return Object.freeze({
      accessToken: (value as Record<string, string>).accessToken,
      refreshToken: (value as Record<string, string>).refreshToken,
    });
  } catch {
    throw new R23AuthenticationDenied();
  }
}
