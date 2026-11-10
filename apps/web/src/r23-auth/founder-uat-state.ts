import {
  createPrivateKey,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { readFounderUatConfiguration } from '../runtime/founder-uat';
import {
  assertR23StagingEligibleIdentity,
  type R23VerifiedIdentity,
} from './identity';

export const FOUNDER_UAT_INVITATION_COOKIE = '__Host-founder-uat-invitation';
export const FOUNDER_UAT_RECOVERY_COOKIE = '__Host-founder-uat-recovery';

const STATE_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const INVITATION_TTL_SECONDS = 15 * 60;
const RECOVERY_TTL_SECONDS = 10 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,256}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InvitationState = Readonly<{
  v: 1;
  purpose: 'invitation';
  destination: 'login' | 'signup' | 'accept';
  token: string;
  expiresAt: number;
}>;

export type FounderUatRecoveryState = Readonly<{
  v: 1;
  purpose: 'recovery';
  subjectId: string;
  email: string;
  accessToken: string;
  expiresAt: number;
}>;

function stateKey(): Buffer {
  const encoded = process.env.STAGING_PROOF_PRIVATE_KEY;
  if (!encoded || encoded.length > 4096) {
    throw new TypeError('Founder UAT state unavailable');
  }
  let der: Buffer;
  try {
    const encodedBytes = Buffer.from(encoded, 'base64');
    if (encodedBytes.toString('base64') !== encoded) {
      throw new TypeError('Invalid key');
    }
    const privateKey = createPrivateKey({
      key: encodedBytes,
      format: 'der',
      type: 'pkcs8',
    });
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new TypeError('Invalid key');
    }
    der = privateKey.export({ format: 'der', type: 'pkcs8' });
  } catch {
    throw new TypeError('Founder UAT state unavailable');
  }
  return Buffer.from(
    hkdfSync(
      'sha256',
      der,
      Buffer.from('hirearchy-founder-uat-state-salt-v1', 'utf8'),
      Buffer.from('hirearchy-founder-uat-purpose-cookie-v1', 'utf8'),
      32,
    ),
  );
}

function cookieValue(request: Request, name: string): string | null {
  const entries = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (entries.length !== 1) return null;
  const value = entries[0].slice(name.length + 1);
  return value.length <= 16384 && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

function aad(purpose: 'invitation' | 'recovery'): Buffer {
  return Buffer.from(`hirearchy-founder-uat:${purpose}:v1`, 'utf8');
}

function encryptState(
  purpose: 'invitation' | 'recovery',
  value: InvitationState | FounderUatRecoveryState,
): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', stateKey(), nonce);
  cipher.setAAD(aad(purpose));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([STATE_VERSION]),
    nonce,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString('base64url');
}

function decryptState(
  request: Request,
  name: string,
  purpose: 'invitation' | 'recovery',
): Record<string, unknown> | null {
  if (!readFounderUatConfiguration()) return null;
  const encoded = cookieValue(request, name);
  if (!encoded) return null;
  const raw = Buffer.from(encoded, 'base64url');
  if (
    raw.toString('base64url') !== encoded ||
    raw.length <= 1 + NONCE_BYTES + TAG_BYTES ||
    raw[0] !== STATE_VERSION
  ) {
    return null;
  }
  try {
    const nonce = raw.subarray(1, 1 + NONCE_BYTES);
    const tag = raw.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(1 + NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', stateKey(), nonce);
    decipher.setAAD(aad(purpose));
    decipher.setAuthTag(tag);
    const parsed: unknown = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        'utf8',
      ),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Strict`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

export function founderUatInvitationCookie(
  token: string,
  destination: 'login' | 'signup' | 'accept',
): string {
  if (
    !readFounderUatConfiguration() ||
    !TOKEN_PATTERN.test(token) ||
    !['login', 'signup', 'accept'].includes(destination)
  ) {
    throw new TypeError('Invitation context unavailable');
  }
  const value: InvitationState = Object.freeze({
    v: 1,
    purpose: 'invitation',
    destination,
    token,
    expiresAt: Math.floor(Date.now() / 1000) + INVITATION_TTL_SECONDS,
  });
  return setCookie(
    FOUNDER_UAT_INVITATION_COOKIE,
    encryptState('invitation', value),
    INVITATION_TTL_SECONDS,
  );
}

export function hasFounderUatPendingInvitation(request: Request): boolean {
  const state = decryptState(
    request,
    FOUNDER_UAT_INVITATION_COOKIE,
    'invitation',
  );
  return (
    state?.v === 1 &&
    state.purpose === 'invitation' &&
    (state.destination === 'login' ||
      state.destination === 'signup' ||
      state.destination === 'accept') &&
    typeof state.token === 'string' &&
    TOKEN_PATTERN.test(state.token) &&
    typeof state.expiresAt === 'number' &&
    Number.isSafeInteger(state.expiresAt) &&
    state.expiresAt > Math.floor(Date.now() / 1000)
  );
}

export async function readFounderUatPendingInvitation(
  request: Request,
  value: R23VerifiedIdentity,
): Promise<{ token: string; clearCookie: string } | null> {
  let identity: R23VerifiedIdentity;
  try {
    identity = assertR23StagingEligibleIdentity(value);
  } catch {
    return null;
  }
  if (!identity.emailVerified) return null;
  const state = decryptState(
    request,
    FOUNDER_UAT_INVITATION_COOKIE,
    'invitation',
  );
  if (
    state?.v !== 1 ||
    state.purpose !== 'invitation' ||
    !['login', 'signup', 'accept'].includes(String(state.destination)) ||
    typeof state.token !== 'string' ||
    !TOKEN_PATTERN.test(state.token) ||
    typeof state.expiresAt !== 'number' ||
    !Number.isSafeInteger(state.expiresAt) ||
    state.expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  return {
    token: state.token,
    clearCookie: clearFounderUatPendingInvitation(),
  };
}

export function clearFounderUatPendingInvitation(): string {
  return clearCookie(FOUNDER_UAT_INVITATION_COOKIE);
}

export function founderUatRecoveryCookie(
  value: Omit<FounderUatRecoveryState, 'v' | 'purpose'>,
): string {
  const ttl = Math.min(
    RECOVERY_TTL_SECONDS,
    value.expiresAt - Math.floor(Date.now() / 1000),
  );
  if (
    !readFounderUatConfiguration() ||
    !UUID_PATTERN.test(value.subjectId) ||
    !value.email ||
    !value.accessToken ||
    value.accessToken.length > 16384 ||
    ttl < 1
  ) {
    throw new TypeError('Recovery context unavailable');
  }
  const state: FounderUatRecoveryState = Object.freeze({
    v: 1,
    purpose: 'recovery',
    subjectId: value.subjectId.toLowerCase(),
    email: value.email.trim().toLowerCase(),
    accessToken: value.accessToken,
    expiresAt: Math.floor(Date.now() / 1000) + ttl,
  });
  return setCookie(
    FOUNDER_UAT_RECOVERY_COOKIE,
    encryptState('recovery', state),
    ttl,
  );
}

export function readFounderUatRecovery(
  request: Request,
): FounderUatRecoveryState | null {
  const state = decryptState(request, FOUNDER_UAT_RECOVERY_COOKIE, 'recovery');
  if (
    state?.v !== 1 ||
    state.purpose !== 'recovery' ||
    typeof state.subjectId !== 'string' ||
    !UUID_PATTERN.test(state.subjectId) ||
    typeof state.email !== 'string' ||
    !state.email ||
    typeof state.accessToken !== 'string' ||
    !state.accessToken ||
    state.accessToken.length > 16384 ||
    typeof state.expiresAt !== 'number' ||
    !Number.isSafeInteger(state.expiresAt) ||
    state.expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  return Object.freeze({
    v: 1,
    purpose: 'recovery',
    subjectId: state.subjectId.toLowerCase(),
    email: state.email.trim().toLowerCase(),
    accessToken: state.accessToken,
    expiresAt: state.expiresAt,
  });
}

export function clearFounderUatRecovery(): string {
  return clearCookie(FOUNDER_UAT_RECOVERY_COOKIE);
}
