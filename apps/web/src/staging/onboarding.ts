import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { loadCandidateTokenEncryptionKey } from '../sessions/candidate-token-storage.mjs';

const aadForInvitation = (organizationId: string): Buffer =>
  Buffer.from(`hirearchy:organization-invitation:${organizationId}`);

export interface OnboardingCapabilities {
  readonly selfServiceOnboardingEnabled: boolean;
  readonly emailDeliveryEnabled: boolean;
}

export interface OnboardingStatusResponse {
  readonly status: 'needs_team' | 'has_active_membership';
  readonly email: string;
  readonly capabilities: OnboardingCapabilities;
}

export interface BootstrapOrganizationInput {
  readonly displayName: string;
  readonly idempotencyKey: string;
}

export interface BootstrapOrganizationResponse {
  readonly organizationId: string;
  readonly displayName: string;
  readonly role: 'recruiter';
  readonly isOwner: boolean;
  readonly emailDeliveryEnabled: false;
}

export interface AcceptInvitationResponse {
  readonly organizationId: string;
  readonly role: 'reviewer';
  readonly status: 'accepted';
}

export interface ReviewerInvitationItem {
  readonly id: string;
  readonly targetEmail: string;
  readonly role: 'reviewer';
  readonly status: 'active' | 'expired' | 'revoked' | 'accepted';
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly acceptedAt: string | null;
  readonly tokenCiphertext?: string | null;
}

export interface CreateReviewerInvitationInput {
  readonly organizationId: string;
  readonly targetEmail: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly encryptionKey?: Buffer;
}

export interface CreateReviewerInvitationResponse {
  readonly invitationId: string;
  readonly organizationId: string;
  readonly targetEmail: string;
  readonly role: 'reviewer';
  readonly expiresAt: string;
  readonly emailDeliveryEnabled: false;
  readonly invitationToken: string;
}

export interface OrganizationMemberItem {
  readonly principalId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly role: string;
  readonly status: string;
  readonly joinedAt: string;
  readonly isOwner: boolean;
}

export interface AccountProfile {
  readonly principalId: string;
  readonly displayName: string | null;
  readonly email: string;
}

export function invitationTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function encryptInvitationToken(
  token: string,
  organizationId: string,
  key: Buffer = loadCandidateTokenEncryptionKey(),
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(aadForInvitation(organizationId));
  const ciphertext = Buffer.concat([
    cipher.update(token, 'utf8'),
    cipher.final(),
  ]);
  return `v1.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

export function decryptInvitationToken(
  value: string,
  organizationId: string,
  key: Buffer = loadCandidateTokenEncryptionKey(),
): string {
  const parts = value.split('.');
  if (
    parts.length !== 4 ||
    parts[0] !== 'v1' ||
    !parts.slice(1).every((p) => /^[A-Za-z0-9_-]+$/.test(p))
  ) {
    throw new Error('Invalid invitation ciphertext format');
  }
  const [nonce, ciphertext, tag] = parts
    .slice(1)
    .map((p) => Buffer.from(p, 'base64url'));
  if (nonce.length !== 12 || ciphertext.length === 0 || tag.length !== 16) {
    throw new Error('Invalid invitation ciphertext segments');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
    authTagLength: 16,
  });
  decipher.setAAD(aadForInvitation(organizationId));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}
