import { randomUUID, sign, type KeyObject } from 'node:crypto';

import {
  assertR23VerifiedIdentity,
  type R23VerifiedIdentity,
} from './identity';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type ProofIssuer = Readonly<{
  issuer: string;
  audience: string;
  keyId: string;
  privateKey: KeyObject;
}>;

// The database verifies these exact bytes; it must also validate the operation's
// complete argument schema and atomically consume the nonce before acting.
function canonical(value: Json): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new TypeError('Invalid proof value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError('Invalid proof value');
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

export function issueStagingProof(
  issuer: ProofIssuer,
  identityInput: R23VerifiedIdentity,
  operation: string,
  args: { [key: string]: Json },
): Readonly<{ payload: Buffer; signature: Buffer }> {
  const identity = assertR23VerifiedIdentity(identityInput);
  const now = Math.floor(Date.now() / 1000);
  if (
    !issuer.issuer ||
    issuer.issuer.length > 256 ||
    !issuer.audience ||
    issuer.audience.length > 256 ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(issuer.keyId) ||
    issuer.privateKey.type !== 'private' ||
    issuer.privateKey.asymmetricKeyType !== 'ed25519' ||
    !/^[a-z][a-z0-9_.-]{0,127}$/.test(operation) ||
    !Number.isSafeInteger(identity.expiresAt) ||
    identity.expiresAt <= now
  )
    throw new TypeError('Invalid staging proof configuration or identity');
  const payload = Buffer.from(
    canonical({
      v: 1,
      iss: issuer.issuer,
      aud: issuer.audience,
      kid: issuer.keyId,
      iat: now,
      exp: Math.min(now + 60, identity.expiresAt),
      auth_exp: identity.expiresAt,
      jti: randomUUID(),
      sub: identity.subjectId,
      sid: identity.sessionId,
      op: operation,
      args,
    }),
    'utf8',
  );
  if (payload.length > 524288) throw new TypeError('Proof exceeds size limit');
  return Object.freeze({
    payload,
    signature: sign(null, payload, issuer.privateKey),
  });
}
