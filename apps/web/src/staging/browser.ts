import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { isIP } from 'node:net';

import {
  invitationTokenHash,
  encryptInvitationToken,
  decryptInvitationToken,
  type OnboardingStatusResponse,
  type OrganizationMemberItem,
  type ReviewerInvitationItem,
  type AccountProfile,
  type BootstrapOrganizationResponse,
  type AcceptInvitationResponse,
} from './onboarding';

import type {
  R23Membership,
  R23Session,
} from '../../../../database/postgres/r23/adapter.mjs';
import type {
  R23CandidateInvitationResponse,
  R23CandidateInvitationRevocationResponse,
} from '../r23-auth/contract';
import {
  decryptCandidateToken,
  encryptCandidateToken,
  loadCandidateTokenEncryptionKey,
} from '../sessions/candidate-token-storage.mjs';
import type {
  R27Evidence,
  R27EvidenceQuery,
} from '../../../../database/postgres/r27/contract.mjs';
import type { R28CandidateRevision } from '../../../../database/postgres/r28/contract.mjs';
import {
  buildScenarioSnapshotEnvelope,
  buildTaskRubricSnapshot,
  computeCanonicalContentDigest,
} from '../r211-builder/validation';
import {
  normalizeAssessmentTemplate,
  reservationMovesBinding,
} from '../../../../database/postgres/r211/template.mjs';
import {
  R23_CALLBACK_COOKIE,
  R23_CSRF_COOKIE,
  R23_SESSION_COOKIE,
  readR23Config,
} from '../r23-auth/config';
import {
  assertR23StagingEligibleIdentity,
  assertR23VerifiedIdentity,
  passwordGrant,
  readR23Claims,
  refreshGrant,
  revokeAuthSession,
  R23AuthenticationDenied,
  R23AuthUnavailable,
  verifyR23AccessToken,
  type R23CredentialPair,
  type R23TokenGrant,
  type R23VerifiedIdentity,
} from '../r23-auth/identity';
import {
  resolveOrgDisplay,
  type AuthenticatedSessionListContext,
  type AuthenticatedSessionSummaryContext,
  type R24OrganizationSessionListResult,
  type R24OrganizationSessionSummaryResult,
  type R24SessionSummaryRecord,
} from '../r23-auth/server';
import type {
  R210ReferencedEvidence,
  R210ReviewPacket,
  R210ReviewPacketHistoryEntry,
} from '../r210-review-packets/presentation';
import type {
  R211AssessmentDraft,
  R211AssessmentDraftInput,
  R211RubricCriterion,
  R211StarterFile,
  R211ValidatedVersion,
} from '../r211-builder/contract';
import { validateAssessmentDraft } from '../r211-builder/validation';
import type {
  R29EvidenceSourceType,
  R29EvaluatorObservation,
  R29ObservationHistoryEntry,
} from '../r29-observations/presentation';
import {
  validateCreateObservationInput,
  validateUpdateObservationInput,
} from '../r29-observations/presentation';
import {
  validateFinalizePacketInput,
  validateSaveDraftInput,
} from '../r210-review-packets/presentation';
import { isAuthenticatedStaging } from '../runtime/profile';
import {
  dispatchVerifiedStagingOperation,
  loadStagingConfiguration,
  type StagingConfiguration,
  type StagingProofArgs,
} from './server';

const ENVELOPE_VERSION = 1;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const APP_SESSION_TTL_SECONDS = 3600;
const REFRESH_AHEAD_SECONDS = 30;
const MAX_BODY_BYTES = 4096;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const R27_MAX_SEQUENCE = 9223372036854775807n;

class StagingBadRequest extends Error {
  readonly code = 'INVALID_REQUEST';
}
class StagingPayloadTooLarge extends Error {
  readonly code = 'REQUEST_TOO_LARGE';
}
class StagingForbidden extends Error {
  readonly code = 'ACCESS_DENIED';
}
class StagingNotFound extends Error {
  readonly code = 'NOT_FOUND';
}
class StagingUnavailable extends Error {
  readonly code = 'AUTH_UNAVAILABLE';
}
class StagingInvitationConflict extends Error {
  readonly code = 'INVITATION_CONFLICT';
}

type StagingBrowserSessionPayload = Readonly<{
  v: 1;
  sub: string;
  sid: string;
  aal: 'aal1' | 'aal2';
  accessToken: string;
  refreshToken: string;
  csrfHash: string;
  callbackHash: string | null;
  selectedOrganizationId: string | null;
  expiresAt: number;
}>;

type StagingMembershipItem = Readonly<{
  organizationId: string;
  role: 'recruiter' | 'reviewer';
  version: number;
}>;

type StagingReviewerItem = Readonly<{
  principalId: string;
  role: string;
  joinedAt: string;
}>;

type StagingSessionAssignmentItem = Readonly<{
  assignmentId: string;
  sessionId: string;
  organizationId: string;
  reviewerPrincipalId: string;
  assignedByPrincipalId: string;
  assignedAt: string;
  revokedAt: string | null;
  version: number;
  isActive: boolean;
}>;

type StagingSessionRecord = Readonly<{
  sessionId: string;
  organizationId: string;
  issuerPrincipalId: string;
  scenarioId: string;
  scenarioVersion: string;
  scenarioTitle: string;
  status: 'CREATED' | 'ACTIVE' | 'SUBMITTED';
  createdAt: string;
  activatedAt: string | null;
  submittedAt: string | null;
  durationSeconds: number | null;
  closureReason: 'candidate_submission' | 'timeout' | null;
  reviewProcessStatus:
    'not_started' | 'waiting_for_response' | 'next_step_recorded' | null;
  terminalEnabled: boolean;
  visibilityScope: 'issued_by_recruiter' | 'assigned_to_reviewer';
  assignments: StagingSessionAssignmentItem[];
}>;

export type StagingTemplateSummary = Readonly<{
  templateId: 'custom' | 'reservation-moves-v3';
  title: string;
  description: string;
  scenarioId?: string;
  scenarioVersion?: string;
}>;

type StagingOrganizationContextResponse = Readonly<{
  organizationId: string;
  principalId: string;
  role: 'recruiter' | 'reviewer';
  reviewers: StagingReviewerItem[];
  draft: R211AssessmentDraft | null;
  validatedVersions: R211ValidatedVersion[];
  sessions: StagingSessionRecord[];
  availableTemplates?: StagingTemplateSummary[];
}>;

export type StagingR27EvidencePageState =
  | Readonly<{
      kind: 'submitted';
      evidence: R27Evidence;
      csrfToken: string;
    }>
  | Readonly<{
      kind: 'unsubmitted';
      organizationId: string;
      session: StagingSessionRecord;
      csrfToken: string;
    }>
  | Readonly<{
      kind: 'unavailable';
    }>;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomOpaqueValue(): string {
  return randomBytes(32).toString('base64url');
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function isLoopbackHost(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  if (host === '::1' || host === 'localhost') return true;
  if (isIP(host) !== 4) return false;
  return Number(host.split('.')[0]) === 127;
}

function resolvePublicOrigin(request: Request): string {
  const configured = process.env.STAGING_PUBLIC_ORIGIN?.trim();
  if (configured) {
    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch {
      throw new StagingUnavailable();
    }
    if (
      (parsed.protocol !== 'https:' &&
        !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      throw new StagingUnavailable();
    }
    return parsed.origin;
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new StagingBadRequest();
  }
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) ||
    url.username ||
    url.password
  ) {
    throw new StagingForbidden();
  }
  return url.origin;
}

function requireSameOrigin(request: Request): string {
  const originHeader = request.headers.get('origin');
  if (!originHeader) {
    throw new StagingForbidden();
  }
  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    throw new StagingForbidden();
  }
  if (
    (originUrl.protocol !== 'https:' &&
      !(
        originUrl.protocol === 'http:' && isLoopbackHost(originUrl.hostname)
      )) ||
    originUrl.username ||
    originUrl.password
  ) {
    throw new StagingForbidden();
  }

  const expectedOrigin = resolvePublicOrigin(request);
  if (originHeader === expectedOrigin) {
    return expectedOrigin;
  }

  let expectedUrl: URL;
  try {
    expectedUrl = new URL(expectedOrigin);
  } catch {
    throw new StagingForbidden();
  }

  if (
    originUrl.protocol === expectedUrl.protocol &&
    originUrl.port === expectedUrl.port &&
    isLoopbackHost(originUrl.hostname) &&
    isLoopbackHost(expectedUrl.hostname)
  ) {
    return originUrl.origin;
  }

  throw new StagingForbidden();
}

function deriveSessionKey(config: StagingConfiguration): Buffer {
  const der = config.proof.privateKey.export({
    format: 'der',
    type: 'pkcs8',
  });
  return Buffer.from(
    hkdfSync(
      'sha256',
      der,
      Buffer.from('hirearchy-r215-staging-cookie-salt-v1', 'utf8'),
      Buffer.from('hirearchy-r215-staging-session-envelope-v1', 'utf8'),
      32,
    ),
  );
}

function sessionAad(): Buffer {
  return Buffer.from('hirearchy-r215-staging-browser-session-v1', 'utf8');
}

function encryptSessionPayload(
  payload: StagingBrowserSessionPayload,
  key: Buffer,
): string {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(sessionAad());
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from([ENVELOPE_VERSION]),
    nonce,
    tag,
    ciphertext,
  ]).toString('base64url');
}

function decryptSessionPayload(
  encoded: string,
  key: Buffer,
): StagingBrowserSessionPayload {
  if (!encoded || encoded.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new R23AuthenticationDenied();
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(encoded, 'base64url');
  } catch {
    throw new R23AuthenticationDenied();
  }
  if (
    raw.length <= 1 + NONCE_LENGTH + TAG_LENGTH ||
    raw[0] !== ENVELOPE_VERSION
  ) {
    throw new R23AuthenticationDenied();
  }
  try {
    const nonce = raw.subarray(1, 1 + NONCE_LENGTH);
    const tag = raw.subarray(1 + NONCE_LENGTH, 1 + NONCE_LENGTH + TAG_LENGTH);
    const ciphertext = raw.subarray(1 + NONCE_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(sessionAad());
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    const parsed: unknown = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new R23AuthenticationDenied();
    }
    const obj = parsed as Record<string, unknown>;
    if (
      obj.v !== 1 ||
      typeof obj.sub !== 'string' ||
      !UUID.test(obj.sub) ||
      typeof obj.sid !== 'string' ||
      !UUID.test(obj.sid) ||
      (obj.aal !== 'aal1' && obj.aal !== 'aal2') ||
      typeof obj.accessToken !== 'string' ||
      !obj.accessToken ||
      typeof obj.refreshToken !== 'string' ||
      !obj.refreshToken ||
      typeof obj.csrfHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(obj.csrfHash) ||
      (obj.callbackHash !== null &&
        (typeof obj.callbackHash !== 'string' ||
          !/^[0-9a-f]{64}$/.test(obj.callbackHash))) ||
      (obj.selectedOrganizationId !== null &&
        (typeof obj.selectedOrganizationId !== 'string' ||
          !UUID.test(obj.selectedOrganizationId))) ||
      typeof obj.expiresAt !== 'number' ||
      !Number.isSafeInteger(obj.expiresAt)
    ) {
      throw new R23AuthenticationDenied();
    }
    return Object.freeze({
      v: 1,
      sub: obj.sub.toLowerCase(),
      sid: obj.sid.toLowerCase(),
      aal: obj.aal,
      accessToken: obj.accessToken,
      refreshToken: obj.refreshToken,
      csrfHash: obj.csrfHash,
      callbackHash: obj.callbackHash,
      selectedOrganizationId: obj.selectedOrganizationId
        ? obj.selectedOrganizationId.toLowerCase()
        : null,
      expiresAt: obj.expiresAt,
    });
  } catch {
    throw new R23AuthenticationDenied();
  }
}

function cookieValue(request: Request, name: string): string | null {
  const entries = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (entries.length !== 1) return null;
  return entries[0].slice(name.length + 1);
}

function requiredOpaqueCookie(request: Request, name: string): string {
  const value = cookieValue(request, name);
  if (!value || !RANDOM_VALUE.test(value)) throw new R23AuthenticationDenied();
  return value;
}

function requiredEnvelopeCookie(request: Request, name: string): string {
  const value = cookieValue(request, name);
  if (!value || value.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new R23AuthenticationDenied();
  }
  return value;
}

function cookieHeader(name: string, value: string, httpOnly: boolean): string {
  return `${name}=${value}; Path=/; Secure; SameSite=Strict${httpOnly ? '; HttpOnly' : ''}`;
}

function clearCookieHeader(name: string, httpOnly: boolean): string {
  return `${name}=; Path=/; Secure; SameSite=Strict; Max-Age=0${httpOnly ? '; HttpOnly' : ''}`;
}

function safeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function securityHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy':
      "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });
}

function htmlResponse(
  title: string,
  content: string,
  status = 200,
  headers = securityHeaders(),
): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safeHtml(title)}</title></head><body><main><h1>${safeHtml(title)}</h1>${content}</main></body></html>`,
    { status, headers },
  );
}

function loginForm(message = ''): string {
  return `${message ? `<p role="alert">${safeHtml(message)}</p>` : ''}<form action="/r23/auth/login" method="post"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="320"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button type="submit">Sign in</button></form><nav aria-label="Account access options"><p><a href="/r23/signup">Create an account (Sign up)</a></p><p><a href="/r23/recover">Forgot password?</a></p><p><a href="/r23/verify-email">Verify email address</a></p></nav>`;
}

function redirect(
  origin: string,
  path: string,
  cookies: string[] = [],
): Response {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    Location: new URL(path, origin).toString(),
    'Referrer-Policy': 'same-origin',
  });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function isJsonRequest(request: Request): boolean {
  return (
    request.headers.get('content-type')?.split(';')[0].trim() ===
      'application/json' ||
    request.headers.get('accept')?.includes('application/json') === true
  );
}

function getSqlErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as Record<string, unknown>).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function getSqlErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as Record<string, unknown>).message;
    return typeof message === 'string' ? message : '';
  }
  return '';
}

function errorDetails(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  const code = getSqlErrorCode(error);
  const sqlMessage = getSqlErrorMessage(error);
  if (code === 'R2901' || code === 'R2101') {
    return {
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'Check the request and try again.',
    };
  }
  if (code === 'R2902' || code === 'R2102') {
    return {
      status: 400,
      code: 'EVIDENCE_MISMATCH',
      message: 'The referenced evidence does not exist in this session.',
    };
  }
  if (code === 'R2904' || code === 'R2104') {
    return {
      status: 409,
      code: 'CONCURRENCY_CONFLICT',
      message: 'This item changed concurrently. Refresh and try again.',
    };
  }
  if (code === 'R2103') {
    return {
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'The review packet needs a summary and a grounded citation.',
    };
  }
  if (code === 'R2105') {
    return {
      status: 409,
      code: 'FINALIZED_PACKET_IMMUTABLE',
      message: 'This review packet is finalized and immutable.',
    };
  }
  if (error instanceof StagingBadRequest || code === '22023') {
    if (
      sqlMessage.includes(
        'Idempotency key already exists with different request parameters',
      )
    ) {
      return {
        status: 400,
        code: 'IDEMPOTENCY_CONFLICT',
        message:
          'Idempotency key already exists with different request parameters.',
      };
    }
    return {
      status: 400,
      code: 'INVALID_REQUEST',
      message:
        error instanceof StagingBadRequest && error.message
          ? error.message
          : 'Check the request and try again.',
    };
  }
  if (error instanceof StagingPayloadTooLarge) {
    return {
      status: 413,
      code: 'REQUEST_TOO_LARGE',
      message: 'The request is too large.',
    };
  }
  if (error instanceof StagingNotFound || code === 'P0002') {
    return {
      status: 404,
      code: 'NOT_FOUND',
      message: 'Resource not found.',
    };
  }
  if (error instanceof StagingForbidden || code === '42501') {
    if (sqlMessage.includes('Email confirmation is required')) {
      return {
        status: 403,
        code: 'EMAIL_CONFIRMATION_REQUIRED',
        message: 'Email confirmation is required before proceeding.',
      };
    }
    if (
      sqlMessage.includes('User already has an active organization membership')
    ) {
      return {
        status: 403,
        code: 'MEMBERSHIP_CONFLICT',
        message: 'User already has an active organization membership.',
      };
    }
    if (
      sqlMessage.includes('Invitation is bound to a different email address')
    ) {
      return {
        status: 403,
        code: 'INVITATION_EMAIL_MISMATCH',
        message: 'This invitation was issued to a different email address.',
      };
    }
    if (sqlMessage.includes('Invitation has been revoked')) {
      return {
        status: 403,
        code: 'INVITATION_REVOKED',
        message: 'This invitation has been revoked by the organization owner.',
      };
    }
    if (sqlMessage.includes('Invitation has expired')) {
      return {
        status: 403,
        code: 'INVITATION_EXPIRED',
        message: 'This invitation has expired.',
      };
    }
    if (sqlMessage.includes('Sole organization owner cannot be removed')) {
      return {
        status: 403,
        code: 'OWNER_REMOVAL_FORBIDDEN',
        message: 'The sole organization owner cannot be removed.',
      };
    }
    if (sqlMessage.includes('Self-service onboarding is disabled')) {
      return {
        status: 403,
        code: 'SELF_SERVICE_DISABLED',
        message: 'Self-service onboarding is disabled in this environment.',
      };
    }
    return {
      status: 403,
      code: 'ACCESS_DENIED',
      message: 'Access was denied.',
    };
  }
  if (error instanceof StagingInvitationConflict) {
    return {
      status: 409,
      code: 'INVITATION_CONFLICT',
      message: 'This invitation cannot be changed or reused.',
    };
  }
  if (code === '23505') {
    return {
      status: 409,
      code: 'DRAFT_CONCURRENCY_CONFLICT',
      message: 'Edit conflict: this assessment draft was updated concurrently.',
    };
  }
  if (error instanceof R23AuthenticationDenied || code === '28000') {
    return {
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Sign in to continue.',
    };
  }
  if (
    error instanceof R23AuthUnavailable ||
    error instanceof StagingUnavailable
  ) {
    return {
      status: 503,
      code: 'AUTH_UNAVAILABLE',
      message: 'The sign-in service is temporarily unavailable.',
    };
  }
  return {
    status: 500,
    code: 'REQUEST_FAILED',
    message: 'The request could not be completed.',
  };
}

function failureResponse(request: Request, error: unknown): Response {
  const details = errorDetails(error);
  if (isJsonRequest(request)) {
    return Response.json(
      { error: { code: details.code, message: details.message } },
      {
        status: details.status,
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
    );
  }
  const content =
    details.status === 401
      ? `<p role="alert">${safeHtml(details.message)}</p><p><a href="/r23/login">Sign in</a></p>`
      : `<p role="alert">${safeHtml(details.message)}</p>`;
  return htmlResponse('Request denied', content, details.status);
}

export function stagingCapabilityDisabledJsonResponse(
  message = 'This capability is unavailable in the authenticated staging slice.',
): Response {
  return Response.json(
    {
      error: {
        code: 'STAGING_CAPABILITY_DISABLED',
        message,
      },
    },
    {
      status: 503,
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Type': 'application/json; charset=utf-8',
      },
    },
  );
}

async function parseBody(
  request: Request,
  optional: boolean,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader !== null && !/^\d+$/.test(lengthHeader)) {
    throw new StagingBadRequest();
  }
  if (lengthHeader !== null && Number(lengthHeader) > maxBytes) {
    throw new StagingPayloadTooLarge();
  }

  if (!request.body) {
    if (optional && (lengthHeader === null || lengthHeader === '0')) {
      return Object.create(null);
    }
    throw new StagingBadRequest();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          throw new StagingPayloadTooLarge();
        }
        throw new StagingPayloadTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (size === 0) {
    if (optional && (lengthHeader === null || lengthHeader === '0')) {
      return Object.create(null);
    }
    throw new StagingBadRequest();
  }

  const contentType = request.headers.get('content-type')?.split(';')[0].trim();
  if (
    contentType !== 'application/json' &&
    contentType !== 'application/x-www-form-urlencoded'
  ) {
    throw new StagingBadRequest();
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new StagingBadRequest();
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    const fields = new URLSearchParams(text);
    const body: Record<string, unknown> = Object.create(null);
    for (const key of new Set(fields.keys())) {
      const values = fields.getAll(key);
      if (values.length !== 1) throw new StagingBadRequest();
      body[key] = values[0];
    }
    return body;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StagingBadRequest();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StagingBadRequest();
  }
  return value as Record<string, unknown>;
}

function allowedFields(body: Record<string, unknown>, names: string[]): void {
  if (Object.keys(body).some((key) => !names.includes(key))) {
    throw new StagingBadRequest();
  }
}

function requiredText(
  body: Record<string, unknown>,
  name: string,
  maximum: number,
): string {
  const value = body[name];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new StagingBadRequest();
  }
  return value;
}

function requireOriginAndCsrf(
  request: Request,
  body: Record<string, unknown>,
): { csrf: string; csrfHash: string; origin: string } {
  const origin = requireSameOrigin(request);
  const header = request.headers.get('x-csrf-token');
  const form = body.csrf;
  const csrf = cookieValue(request, R23_CSRF_COOKIE);
  if (
    !csrf ||
    !RANDOM_VALUE.test(csrf) ||
    (header === null && typeof form !== 'string') ||
    (header !== null && !equalSecret(header, csrf)) ||
    (form !== undefined && typeof form !== 'string') ||
    (typeof form === 'string' && !equalSecret(form, csrf))
  ) {
    throw new StagingForbidden();
  }
  return { csrf, csrfHash: digest(csrf), origin };
}

function sameIdentity(
  identity: R23VerifiedIdentity,
  session: StagingBrowserSessionPayload,
): void {
  if (
    identity.subjectId !== session.sub ||
    identity.sessionId !== session.sid ||
    identity.assurance !== session.aal
  ) {
    throw new R23AuthenticationDenied();
  }
}

async function withStagingBrowserSession<T>(
  request: Request,
  expectedCsrfHash: string,
  operation: (context: {
    config: StagingConfiguration;
    sessionKey: Buffer;
    session: StagingBrowserSessionPayload;
    identity: R23VerifiedIdentity;
    csrfToken: string;
    refreshedSessionCookie: string | null;
  }) => Promise<T>,
  forceRefresh = false,
): Promise<T> {
  if (!isAuthenticatedStaging()) throw new StagingUnavailable();
  let config: StagingConfiguration;
  try {
    config = loadStagingConfiguration();
  } catch {
    throw new StagingUnavailable();
  }
  const sessionKey = deriveSessionKey(config);
  const encodedSession = requiredEnvelopeCookie(request, R23_SESSION_COOKIE);
  const csrfToken = requiredOpaqueCookie(request, R23_CSRF_COOKIE);
  const session = decryptSessionPayload(encodedSession, sessionKey);

  const now = Math.floor(Date.now() / 1000);
  if (
    session.callbackHash !== null ||
    session.expiresAt <= now ||
    !equalSecret(session.csrfHash, expectedCsrfHash)
  ) {
    throw new R23AuthenticationDenied();
  }

  const storedClaims = readR23Claims(session.accessToken, config.auth);
  const needsRefresh =
    forceRefresh ||
    storedClaims.exp <= Date.now() / 1000 + REFRESH_AHEAD_SECONDS;
  const grant: R23TokenGrant | undefined = needsRefresh
    ? await refreshGrant(config.auth, session.refreshToken)
    : undefined;
  const pair: R23CredentialPair = grant ?? {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
  };
  const identity = assertR23VerifiedIdentity(
    await verifyR23AccessToken(config.auth, pair.accessToken, grant),
  );
  sameIdentity(identity, session);

  const updatedSession: StagingBrowserSessionPayload = needsRefresh
    ? Object.freeze({
        ...session,
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
      })
    : session;
  const refreshedSessionCookie = needsRefresh
    ? cookieHeader(
        R23_SESSION_COOKIE,
        encryptSessionPayload(updatedSession, sessionKey),
        true,
      )
    : null;

  return operation({
    config,
    sessionKey,
    session: updatedSession,
    identity,
    csrfToken,
    refreshedSessionCookie,
  });
}

function attachRefreshedCookie(
  response: Response,
  refreshedSessionCookie: string | null,
): Response {
  if (refreshedSessionCookie) {
    response.headers.append('Set-Cookie', refreshedSessionCookie);
  }
  return response;
}

async function fetchOrganizationContext(
  config: StagingConfiguration,
  identity: R23VerifiedIdentity,
  organizationId: string,
): Promise<StagingOrganizationContextResponse> {
  const raw = await dispatchVerifiedStagingOperation(
    config,
    identity,
    'organization.context',
    { organizationId },
  );
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StagingUnavailable();
  }
  return raw as unknown as StagingOrganizationContextResponse;
}

function filterStagingSessions(
  sessions: StagingSessionRecord[],
  queryParams?: {
    lifecycleFilter?: string;
    reviewStatusFilter?: string;
    search?: string;
    cursor?: string | null;
    limit?: number;
  },
): {
  filtered: R24SessionSummaryRecord[];
  totalAuthorizedCount: number;
  filteredAuthorizedCount: number;
} {
  const mapped: R24SessionSummaryRecord[] = sessions.map((s) => ({
    sessionId: s.sessionId,
    organizationId: s.organizationId,
    issuerPrincipalId: s.issuerPrincipalId,
    scenarioId: s.scenarioId,
    scenarioVersion: s.scenarioVersion,
    scenarioTitle: s.scenarioTitle,
    status: s.status,
    createdAt: s.createdAt,
    activatedAt: s.activatedAt,
    submittedAt: s.submittedAt,
    durationSeconds: s.durationSeconds,
    closureReason: s.closureReason,
    reviewProcessStatus: s.reviewProcessStatus,
    visibilityScope: s.visibilityScope,
  }));

  const lifecycle = queryParams?.lifecycleFilter;
  const reviewStatus = queryParams?.reviewStatusFilter;
  const search = queryParams?.search?.trim().toLowerCase();

  const filtered = mapped.filter((item) => {
    if (lifecycle && lifecycle !== 'all') {
      if (lifecycle === 'issued' && item.status !== 'CREATED') return false;
      if (lifecycle === 'active' && item.status !== 'ACTIVE') return false;
      if (lifecycle === 'submitted' && item.status !== 'SUBMITTED')
        return false;
      if (
        lifecycle === 'timed_out' &&
        !(item.status === 'SUBMITTED' && item.closureReason === 'timeout')
      ) {
        return false;
      }
    }
    if (reviewStatus && reviewStatus !== 'all') {
      if (item.status !== 'SUBMITTED') return false;
      if (item.reviewProcessStatus !== reviewStatus) return false;
    }
    if (search) {
      const hay =
        `${item.scenarioTitle} ${item.sessionId} ${item.scenarioId}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const limit = queryParams?.limit ?? 50;
  return {
    filtered: filtered.slice(0, limit),
    totalAuthorizedCount: mapped.length,
    filteredAuthorizedCount: filtered.length,
  };
}

function toR23SessionShim(
  session: StagingBrowserSessionPayload,
  principalId?: string,
): R23Session {
  const expiresAt = new Date(session.expiresAt * 1000);
  return {
    handleHash: '',
    subjectId: session.sub,
    authSessionId: session.sid,
    principalId: principalId ?? session.sub,
    assurance: session.aal,
    selectedOrganizationId: session.selectedOrganizationId,
    callbackPending: session.callbackHash !== null,
    credentialEnvelope: Buffer.alloc(0),
    expiresAt,
    accessExpiresAt: expiresAt,
  };
}

export function stagingLoginGet(): Response {
  if (!isAuthenticatedStaging()) {
    return htmlResponse('Not found', '<p>Not found.</p>', 404);
  }
  try {
    loadStagingConfiguration();
    return htmlResponse('Evaluator sign in', loginForm());
  } catch {
    return htmlResponse(
      'Sign in unavailable',
      '<p role="alert">The sign-in service is temporarily unavailable.</p>',
      503,
    );
  }
}

export async function stagingLoginPost(request: Request): Promise<Response> {
  if (!isAuthenticatedStaging()) {
    return htmlResponse('Not found', '<p>Not found.</p>', 404);
  }
  try {
    const config = loadStagingConfiguration();
    const origin = requireSameOrigin(request);
    const body = await parseBody(request, false);
    allowedFields(body, ['email', 'password']);
    const email = requiredText(body, 'email', 320);
    const password = requiredText(body, 'password', 1024);

    const pair = await passwordGrant(config.auth, email, password);
    const identity = assertR23StagingEligibleIdentity(
      await verifyR23AccessToken(config.auth, pair.accessToken, pair),
    );
    const csrf = randomOpaqueValue();
    const callback = randomOpaqueValue();
    const sessionKey = deriveSessionKey(config);
    const now = Math.floor(Date.now() / 1000);
    const payload: StagingBrowserSessionPayload = Object.freeze({
      v: 1,
      sub: identity.subjectId,
      sid: identity.sessionId,
      aal: identity.assurance,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      csrfHash: digest(csrf),
      callbackHash: digest(callback),
      selectedOrganizationId: null,
      expiresAt: now + APP_SESSION_TTL_SECONDS,
    });
    const encodedSession = encryptSessionPayload(payload, sessionKey);

    return redirect(origin, '/r23/auth/callback', [
      cookieHeader(R23_SESSION_COOKIE, encodedSession, true),
      cookieHeader(R23_CSRF_COOKIE, csrf, false),
      cookieHeader(R23_CALLBACK_COOKIE, callback, true),
    ]);
  } catch (error) {
    if (error instanceof R23AuthenticationDenied) {
      if (isJsonRequest(request)) {
        return Response.json(
          {
            error: {
              code: 'AUTHENTICATION_REQUIRED',
              message: 'Invalid email or password.',
            },
          },
          { status: 401, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      return htmlResponse(
        'Evaluator sign in',
        loginForm(
          'Invalid email or password. Check credentials and try again.',
        ),
        401,
      );
    }
    return failureResponse(request, error);
  }
}

export async function stagingCallbackGet(request: Request): Promise<Response> {
  if (!isAuthenticatedStaging()) {
    return htmlResponse('Not found', '<p>Not found.</p>', 404);
  }
  let sessionPending = false;
  try {
    const config = loadStagingConfiguration();
    const origin = resolvePublicOrigin(request);
    if (new URL(request.url).search) throw new R23AuthenticationDenied();

    const encodedSession = requiredEnvelopeCookie(request, R23_SESSION_COOKIE);
    const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);
    const callback = requiredOpaqueCookie(request, R23_CALLBACK_COOKIE);
    const sessionKey = deriveSessionKey(config);
    const session = decryptSessionPayload(encodedSession, sessionKey);

    if (
      session.callbackHash === null ||
      session.expiresAt <= Math.floor(Date.now() / 1000) ||
      !equalSecret(session.csrfHash, digest(csrf))
    ) {
      throw new R23AuthenticationDenied();
    }
    sessionPending = true;
    if (!equalSecret(session.callbackHash, digest(callback))) {
      throw new R23AuthenticationDenied();
    }

    const identity = assertR23VerifiedIdentity(
      await verifyR23AccessToken(config.auth, session.accessToken),
    );
    sameIdentity(identity, session);

    const updatedSession: StagingBrowserSessionPayload = Object.freeze({
      ...session,
      callbackHash: null,
    });

    return redirect(origin, '/r23/organizations', [
      cookieHeader(
        R23_SESSION_COOKIE,
        encryptSessionPayload(updatedSession, sessionKey),
        true,
      ),
      clearCookieHeader(R23_CALLBACK_COOKIE, true),
    ]);
  } catch (error) {
    const response = failureResponse(request, error);
    if (sessionPending && errorDetails(error).status !== 503) {
      response.headers.append(
        'Set-Cookie',
        clearCookieHeader(R23_CALLBACK_COOKIE, true),
      );
    }
    return response;
  }
}

export async function stagingOrganizationsGet(
  request: Request,
): Promise<Response> {
  try {
    const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);
    return await withStagingBrowserSession(
      request,
      digest(csrf),
      async ({ config, identity, csrfToken, refreshedSessionCookie }) => {
        let memberships: StagingMembershipItem[] = [];
        try {
          const result = (await dispatchVerifiedStagingOperation(
            config,
            identity,
            'membership.list',
            {},
          )) as { memberships?: StagingMembershipItem[] } | null;
          if (Array.isArray(result?.memberships)) {
            memberships = result.memberships;
          }
        } catch {
          // Pre-principal identity without an active principal or zero memberships
          memberships = [];
        }
        const items = memberships
          .map((membership) => {
            if (!UUID.test(membership.organizationId)) {
              throw new StagingUnavailable();
            }
            const id = safeHtml(membership.organizationId.toLowerCase());
            const roleLabel = safeHtml(membership.role);
            return `<li><form action="/r23/organization" method="post"><input type="hidden" name="csrf" value="${safeHtml(csrfToken)}"><input type="hidden" name="organizationId" value="${id}"><button type="submit">Select organization ${id} (${roleLabel})</button></form></li>`;
          })
          .join('');
        let content = '';
        if (memberships.length > 0) {
          content = `<p>Select one organization for this session.</p><ul>${items}</ul>`;
        } else {
          let onboardingStatus: OnboardingStatusResponse | null = null;
          try {
            onboardingStatus = (await dispatchVerifiedStagingOperation(
              config,
              identity,
              'onboarding.status',
              {},
            )) as OnboardingStatusResponse;
          } catch {
            // Pre-principal or unconfirmed identity
          }

          if (
            onboardingStatus?.status === 'needs_team' &&
            onboardingStatus.capabilities.selfServiceOnboardingEnabled
          ) {
            content = `
              <section aria-labelledby="create-org-title">
                <h2 id="create-org-title">Create your first organization</h2>
                <p>You do not have an active organization membership yet. As the founding owner, create your first organization to begin issuing assessments.</p>
                <div role="note" aria-label="Governance notice">
                  <p><strong>Governance:</strong> You will be provisioned as the immutable <strong>owner</strong> and <strong>recruiter</strong> for this organization. <em>Reservation Moves v3</em> will be immediately available in your workspace.</p>
                </div>
                <form action="/r23/organization/bootstrap" method="post">
                  <input type="hidden" name="csrf" value="${safeHtml(csrfToken)}">
                  <input type="hidden" name="idempotencyKey" value="${safeHtml(randomUUID())}">
                  <label for="displayName">Organization display name</label>
                  <input id="displayName" name="displayName" type="text" required maxlength="100" placeholder="e.g. Acme Space Systems">
                  <button type="submit">Create organization and continue</button>
                </form>
              </section>
            `;
          } else {
            content =
              '<p>No active organization membership is available for this account.</p>';
          }
        }
        const response = htmlResponse(
          'Choose an organization',
          `${content}<form action="/r23/auth/logout" method="post"><input type="hidden" name="csrf" value="${safeHtml(csrfToken)}"><button type="submit">Sign out</button></form>`,
        );
        return attachRefreshedCookie(response, refreshedSessionCookie);
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingOrganizationPost(
  request: Request,
): Promise<Response> {
  try {
    const body = await parseBody(request, false);
    allowedFields(body, ['organizationId', 'csrf']);
    const organizationId = requiredText(
      body,
      'organizationId',
      64,
    ).toLowerCase();
    if (!UUID.test(organizationId)) throw new StagingBadRequest();
    const { csrfHash, origin } = requireOriginAndCsrf(request, body);

    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, sessionKey, session, identity }) => {
        await dispatchVerifiedStagingOperation(
          config,
          identity,
          'session.open',
          {
            organizationId,
          },
        );
        const updatedSession: StagingBrowserSessionPayload = Object.freeze({
          ...session,
          selectedOrganizationId: organizationId,
        });
        return redirect(origin, `/r23/organizations/${organizationId}`, [
          cookieHeader(
            R23_SESSION_COOKIE,
            encryptSessionPayload(updatedSession, sessionKey),
            true,
          ),
        ]);
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingLoadOrganizationSessionList(
  request: Request,
  targetOrganizationId: string,
  queryParams?: {
    lifecycleFilter?: string;
    reviewStatusFilter?: string;
    search?: string;
    cursor?: string | null;
    limit?: number;
  },
): Promise<
  AuthenticatedSessionListContext & {
    reviewers: StagingReviewerItem[];
    draft: R211AssessmentDraft | null;
    validatedVersions: R211ValidatedVersion[];
    availableTemplates?: StagingTemplateSummary[];
    refreshedSessionCookie: string | null;
  }
> {
  if (!UUID.test(targetOrganizationId)) throw new StagingBadRequest();
  const orgIdLower = targetOrganizationId.toLowerCase();
  const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);

  return withStagingBrowserSession(
    request,
    digest(csrf),
    async ({
      session,
      identity,
      config,
      csrfToken,
      refreshedSessionCookie,
    }) => {
      if (session.selectedOrganizationId !== orgIdLower) {
        throw new StagingForbidden();
      }
      const orgContext = await fetchOrganizationContext(
        config,
        identity,
        orgIdLower,
      );
      const { filtered, totalAuthorizedCount, filteredAuthorizedCount } =
        filterStagingSessions(orgContext.sessions ?? [], queryParams);

      const membership: R23Membership = {
        organizationId: orgIdLower,
        role: orgContext.role,
        membershipVersion: '1',
      };
      const orgDisplay = resolveOrgDisplay(
        orgIdLower,
        membership,
        identity.email,
      );
      const result: R24OrganizationSessionListResult = {
        organizationId: orgIdLower,
        role: orgContext.role,
        membershipVersion: 1,
        visibilityScope:
          orgContext.role === 'recruiter'
            ? 'issued_by_recruiter'
            : 'assigned_to_reviewer',
        sessions: filtered,
        totalAuthorizedCount,
        filteredAuthorizedCount,
        nextCursor: null,
      };

      return {
        identity,
        membership,
        session: toR23SessionShim(session, orgContext.principalId),
        csrfToken,
        result,
        organization: {
          id: orgIdLower,
          name: orgDisplay.name,
          slug: orgDisplay.slug,
          role: orgContext.role,
        },
        reviewers: orgContext.reviewers ?? [],
        draft: orgContext.draft ?? null,
        validatedVersions: orgContext.validatedVersions ?? [],
        availableTemplates: orgContext.availableTemplates ?? [],
        refreshedSessionCookie,
      };
    },
  );
}

export async function stagingLoadOrganizationSessionSummary(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<
  AuthenticatedSessionSummaryContext & {
    refreshedSessionCookie: string | null;
  }
> {
  if (!UUID.test(targetOrganizationId)) throw new StagingBadRequest();
  if (!sessionId || sessionId.length > 256) throw new StagingBadRequest();
  const orgIdLower = targetOrganizationId.toLowerCase();
  const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);

  return withStagingBrowserSession(
    request,
    digest(csrf),
    async ({
      session,
      identity,
      config,
      csrfToken,
      refreshedSessionCookie,
    }) => {
      if (session.selectedOrganizationId !== orgIdLower) {
        throw new StagingForbidden();
      }
      const orgContext = await fetchOrganizationContext(
        config,
        identity,
        orgIdLower,
      );
      const match = (orgContext.sessions ?? []).find(
        (s) => s.sessionId === sessionId,
      );

      const membership: R23Membership = {
        organizationId: orgIdLower,
        role: orgContext.role,
        membershipVersion: '1',
      };
      const orgDisplay = resolveOrgDisplay(
        orgIdLower,
        membership,
        identity.email,
      );
      const result: R24OrganizationSessionSummaryResult = {
        organizationId: orgIdLower,
        role: orgContext.role,
        membershipVersion: 1,
        visibilityScope:
          orgContext.role === 'recruiter'
            ? 'issued_by_recruiter'
            : 'assigned_to_reviewer',
        session: match
          ? {
              sessionId: match.sessionId,
              organizationId: match.organizationId,
              issuerPrincipalId: match.issuerPrincipalId,
              scenarioId: match.scenarioId,
              scenarioVersion: match.scenarioVersion,
              scenarioTitle: match.scenarioTitle,
              status: match.status,
              createdAt: match.createdAt,
              activatedAt: match.activatedAt,
              submittedAt: match.submittedAt,
              durationSeconds: match.durationSeconds,
              closureReason: match.closureReason,
              reviewProcessStatus: match.reviewProcessStatus,
              visibilityScope: match.visibilityScope,
            }
          : null,
      };

      return {
        identity,
        membership,
        session: toR23SessionShim(session, orgContext.principalId),
        csrfToken,
        result,
        organization: {
          id: orgIdLower,
          name: orgDisplay.name,
          slug: orgDisplay.slug,
          role: orgContext.role,
        },
        reviewers: orgContext.reviewers ?? [],
        assignments: match?.assignments ?? [],
        refreshedSessionCookie,
      };
    },
  );
}

export async function stagingOrganizationGet(
  request: Request,
  organizationId: string,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const lifecycleFilter = url.searchParams.get('lifecycle') ?? undefined;
    const reviewStatusFilter =
      url.searchParams.get('reviewStatus') ?? undefined;
    const search = url.searchParams.get('search') ?? undefined;
    const cursor = url.searchParams.get('cursor') ?? null;
    const limitParam = url.searchParams.get('limit');
    const limit =
      limitParam && /^\d+$/.test(limitParam)
        ? Math.min(Math.max(1, parseInt(limitParam, 10)), 100)
        : undefined;

    const context = await stagingLoadOrganizationSessionList(
      request,
      organizationId,
      { lifecycleFilter, reviewStatusFilter, search, cursor, limit },
    );

    const { organization, membership, identity, csrfToken, result } = context;
    const safeOrgId = safeHtml(organizationId.toLowerCase());
    const safeOrgName = safeHtml(organization.name);
    const safeOrgSlug = safeHtml(organization.slug);
    const safeRole = safeHtml(membership.role);
    const safeEmail = safeHtml(identity.email ?? 'evaluator');
    const safeCsrf = safeHtml(csrfToken);

    const roleScopeText =
      membership.role === 'recruiter'
        ? 'Recruiter scope: sessions issued by your account'
        : 'Reviewer scope: sessions actively assigned to your evaluator account';

    let sessionsHtml = '';
    if (result.sessions.length === 0) {
      const emptyExplanation =
        membership.role === 'recruiter'
          ? 'No assessment sessions issued by your recruiter account were found in this organization.'
          : 'No assessment sessions are currently assigned to your reviewer account in this organization.';

      sessionsHtml = `
        <section aria-labelledby="empty-sessions-title">
          <h3 id="empty-sessions-title">No authorized sessions in this organization</h3>
          <p>${safeHtml(emptyExplanation)}</p>
        </section>
      `;
    } else {
      const rows = result.sessions
        .map((s) => {
          const isTimedOut =
            s.status === 'SUBMITTED' && s.closureReason === 'timeout';
          const lifecycleLabel =
            s.status === 'CREATED'
              ? 'Issued'
              : s.status === 'ACTIVE'
                ? 'Active'
                : 'Submitted';
          const reviewLabel =
            s.status !== 'SUBMITTED'
              ? 'Available after submission'
              : s.reviewProcessStatus === 'not_started'
                ? 'Not started'
                : s.reviewProcessStatus === 'waiting_for_response'
                  ? 'Waiting for response'
                  : s.reviewProcessStatus === 'next_step_recorded'
                    ? 'Next step recorded'
                    : 'Not recorded';

          const budgetStr =
            s.durationSeconds === null
              ? 'Untimed (legacy)'
              : `${Math.round(s.durationSeconds / 60)} min`;
          const currentTimestampLabel =
            s.status === 'CREATED'
              ? 'Issued'
              : s.status === 'ACTIVE'
                ? 'Started'
                : 'Submitted';
          const currentTimestamp =
            s.status === 'CREATED'
              ? s.createdAt
              : s.status === 'ACTIVE'
                ? s.activatedAt
                : s.submittedAt;
          const inspectUrl = `/r23/organizations/${encodeURIComponent(organizationId.toLowerCase())}/sessions/${encodeURIComponent(s.sessionId)}`;

          return `
            <li data-session-id="${safeHtml(s.sessionId)}">
              <div>
                <h3>${safeHtml(s.scenarioTitle)}</h3>
                <p>Session <code>${safeHtml(s.sessionId.slice(0, 8))}</code></p>
              </div>
              <div>
                <span>Lifecycle: </span>
                <span>${safeHtml(lifecycleLabel)}</span>
                ${isTimedOut ? '<span>(Timed out)</span>' : ''}
                <p>
                  <span>${safeHtml(currentTimestampLabel)}: </span>
                  ${currentTimestamp ? `<time datetime="${safeHtml(currentTimestamp)}">${safeHtml(currentTimestamp)}</time>` : '<span>Not recorded</span>'}
                </p>
              </div>
              <div>
                <span>Time budget: </span>
                <strong>${safeHtml(budgetStr)}</strong>
              </div>
              <div>
                <span>Review progress: </span>
                <span>${safeHtml(reviewLabel)}</span>
              </div>
              <div>
                <p><a href="${safeHtml(inspectUrl)}">Inspect session</a></p>
                <details>
                  <summary aria-label="Session details for ${safeHtml(s.scenarioTitle)}">Details</summary>
                  <div>
                    <dl>
                      <dt>Full session reference</dt><dd><code>${safeHtml(s.sessionId)}</code></dd>
                      <dt>Scenario</dt><dd><code>${safeHtml(s.scenarioId)}</code> (v${safeHtml(s.scenarioVersion)})</dd>
                      <dt>Issued</dt><dd><time datetime="${safeHtml(s.createdAt)}">${safeHtml(s.createdAt)}</time></dd>
                    </dl>
                    <p><a href="${safeHtml(inspectUrl)}">Inspect authorized session summary</a></p>
                  </div>
                </details>
              </div>
            </li>
          `;
        })
        .join('');

      sessionsHtml = `
        <div>
          <span>Assessment</span> | <span>Lifecycle</span> | <span>Time budget</span> | <span>Review progress</span> | <span>Action</span>
        </div>
        <ul>${rows}</ul>
      `;
    }

    const content = `
      <p>Current organization: <code>${safeOrgId}</code></p>
      <p>Organization membership was checked for this request.</p>
      <p><a href="/r23/organizations">Choose another organization</a></p>
      <header>
        <p>
          <strong>Active organization:</strong>
          <span>${safeOrgName}</span>
          <span>(${safeOrgSlug})</span>
          <span>Role: ${safeRole}</span>
          <span>${safeEmail}</span>
        </p>
        <nav aria-label="Evaluator workspace">
          <a href="/r23/organizations">Switch organization</a>
          <a href="/r23/organizations/${safeOrgId}/settings" data-testid="org-settings-link">Team &amp; Settings</a>
        </nav>
      </header>

      <form action="/r23/auth/logout" method="post">
        <input type="hidden" name="csrf" value="${safeCsrf}">
        <button type="submit">Sign out</button>
      </form>

      <section aria-labelledby="staging-boundaries-title" data-testid="staging-workspace-capability-notice">
        <h2 id="staging-boundaries-title">Authenticated Staging Boundaries (R2.15)</h2>
        <p><strong>Supported in this slice:</strong> Named GoTrue authentication, organization membership verification, assessment authoring, static validation, internal session issuance with evaluator assignment, and read-only inspection of submitted evidence and private review data.</p>
        <p><strong>Unavailable in this slice:</strong> Candidate invitation tokens/links, candidate workspace execution, live AI-provider task generation or assistance, unsubmitted session evidence, and review observation/packet writes.</p>
      </section>

      <section aria-labelledby="lifecycle-list-title">
        <h2 id="lifecycle-list-title">Session lifecycle</h2>
        <div role="region" aria-label="Authorized visibility scope">
          <p>${safeHtml(roleScopeText)}</p>
        </div>

        ${
          membership.role === 'recruiter'
            ? `
        <section aria-labelledby="issue-assessment-title">
          <h3 id="issue-assessment-title">Author & Issue Assessment</h3>
          <p>Create, statically validate, and issue assessments with an assigned organization reviewer in the Assessment Builder.</p>
          <p><a href="/r23/organizations/${safeOrgId}/builder" data-testid="open-assessment-builder-link">Open Assessment Builder</a></p>
        </section>
        `
            : ''
        }

        <form method="get" action="/r23/organizations/${safeOrgId}">
          <label>
            <span>Search assessment title or session reference</span>
            <input type="search" name="search" value="${safeHtml(search ?? '')}" placeholder="Assessment title or session reference" aria-label="Search by assessment title or session reference">
          </label>
          <label>
            <span>Session lifecycle</span>
            <select name="lifecycle">
              <option value="all" ${lifecycleFilter === 'all' || !lifecycleFilter ? 'selected' : ''}>All sessions</option>
              <option value="issued" ${lifecycleFilter === 'issued' ? 'selected' : ''}>Issued</option>
              <option value="active" ${lifecycleFilter === 'active' ? 'selected' : ''}>Active</option>
              <option value="submitted" ${lifecycleFilter === 'submitted' ? 'selected' : ''}>Submitted</option>
              <option value="timed_out" ${lifecycleFilter === 'timed_out' ? 'selected' : ''}>Timed out submissions</option>
            </select>
          </label>
          <label>
            <span>Review progress</span>
            <select name="reviewStatus">
              <option value="all" ${reviewStatusFilter === 'all' || !reviewStatusFilter ? 'selected' : ''}>All review progress</option>
              <option value="not_started" ${reviewStatusFilter === 'not_started' ? 'selected' : ''}>Not started</option>
              <option value="waiting_for_response" ${reviewStatusFilter === 'waiting_for_response' ? 'selected' : ''}>Waiting for response</option>
              <option value="next_step_recorded" ${reviewStatusFilter === 'next_step_recorded' ? 'selected' : ''}>Next step recorded</option>
            </select>
          </label>
          <button type="submit">Apply filters</button>
        </form>

        <p role="status">Showing ${result.sessions.length} of ${result.totalAuthorizedCount} sessions</p>

        ${sessionsHtml}
      </section>
    `;

    const response = htmlResponse(
      'Organization workspace',
      content,
      200,
      securityHeaders(),
    );
    return attachRefreshedCookie(response, context.refreshedSessionCookie);
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingOrganizationSessionsApiGet(
  request: Request,
  organizationId: string,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const lifecycleFilter =
      url.searchParams.get('lifecycle') ??
      url.searchParams.get('lifecycleFilter') ??
      undefined;
    const reviewStatusFilter =
      url.searchParams.get('reviewStatus') ??
      url.searchParams.get('reviewStatusFilter') ??
      undefined;
    const search = url.searchParams.get('search') ?? undefined;
    const cursor = url.searchParams.get('cursor') ?? null;
    const limitParam = url.searchParams.get('limit');
    const limit =
      limitParam && /^\d+$/.test(limitParam)
        ? Math.min(Math.max(1, parseInt(limitParam, 10)), 100)
        : undefined;

    const context = await stagingLoadOrganizationSessionList(
      request,
      organizationId,
      { lifecycleFilter, reviewStatusFilter, search, cursor, limit },
    );

    const safeAssessments = context.result.sessions.map((s) => ({
      sessionId: s.sessionId,
      candidatePath: null,
      scenarioTitle: s.scenarioTitle,
      scenarioId: s.scenarioId,
      scenarioVersion: s.scenarioVersion,
      status: s.status,
      createdAt: s.createdAt,
      activatedAt: s.activatedAt,
      submittedAt: s.submittedAt,
      durationSeconds: s.durationSeconds,
      closureReason: s.closureReason,
      reviewProcessStatus: s.reviewProcessStatus,
      visibilityScope: s.visibilityScope,
    }));

    const response = Response.json(
      {
        organization: context.organization,
        visibilityScope: context.result.visibilityScope,
        totalAuthorizedCount: context.result.totalAuthorizedCount,
        filteredAuthorizedCount: context.result.filteredAuthorizedCount,
        nextCursor: context.result.nextCursor,
        assessments: safeAssessments,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'private, no-store, max-age=0',
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
    );
    return attachRefreshedCookie(response, context.refreshedSessionCookie);
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingOrganizationSessionSummaryApiGet(
  request: Request,
  organizationId: string,
  sessionId: string,
): Promise<Response> {
  try {
    const context = await stagingLoadOrganizationSessionSummary(
      request,
      organizationId,
      sessionId,
    );
    const s = context.result.session;
    if (!s) {
      return attachRefreshedCookie(
        Response.json(
          {
            error: {
              code: 'NOT_FOUND',
              message: 'Session not found in authorized organization scope.',
            },
          },
          {
            status: 404,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        ),
        context.refreshedSessionCookie,
      );
    }

    return attachRefreshedCookie(
      Response.json(
        {
          organization: context.organization,
          session: {
            sessionId: s.sessionId,
            candidatePath: null,
            scenarioTitle: s.scenarioTitle,
            scenarioId: s.scenarioId,
            scenarioVersion: s.scenarioVersion,
            status: s.status,
            createdAt: s.createdAt,
            activatedAt: s.activatedAt,
            submittedAt: s.submittedAt,
            durationSeconds: s.durationSeconds,
            closureReason: s.closureReason,
            reviewProcessStatus: s.reviewProcessStatus,
            visibilityScope: s.visibilityScope,
          },
        },
        {
          status: 200,
          headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'Content-Type': 'application/json; charset=utf-8',
          },
        },
      ),
      context.refreshedSessionCookie,
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingOrganizationSessionPageGet(
  request: Request,
  organizationId: string,
  sessionId: string,
): Promise<Response> {
  try {
    const context = await stagingLoadOrganizationSessionSummary(
      request,
      organizationId,
      sessionId,
    );
    const sessionRecord = context.result.session;
    if (!sessionRecord) {
      return attachRefreshedCookie(
        htmlResponse(
          'Session not found',
          `<p role="alert">Session not available in your authorized organization scope.</p><p><a href="/r23/organizations/${safeHtml(organizationId.toLowerCase())}">Back to organization sessions</a></p>`,
          404,
        ),
        context.refreshedSessionCookie,
      );
    }

    const { organization, membership, identity, csrfToken } = context;
    const s = sessionRecord;
    const safeOrgId = safeHtml(organizationId.toLowerCase());
    const safeOrgName = safeHtml(organization.name);
    const safeOrgSlug = safeHtml(organization.slug);
    const safeRole = safeHtml(membership.role);
    const safeEmail = safeHtml(identity.email ?? 'evaluator');
    const safeCsrf = safeHtml(csrfToken);

    const isTimedOut =
      s.status === 'SUBMITTED' && s.closureReason === 'timeout';
    const lifecycleLabel =
      s.status === 'CREATED'
        ? 'Issued'
        : s.status === 'ACTIVE'
          ? 'Active'
          : 'Submitted';
    const reviewLabel =
      s.status !== 'SUBMITTED'
        ? 'Available after submission'
        : s.reviewProcessStatus === 'not_started'
          ? 'Not started'
          : s.reviewProcessStatus === 'waiting_for_response'
            ? 'Waiting for response'
            : s.reviewProcessStatus === 'next_step_recorded'
              ? 'Next step recorded'
              : 'Not recorded';

    const budgetStr =
      s.durationSeconds === null
        ? 'Untimed (legacy)'
        : `${Math.round(s.durationSeconds / 60)} min`;
    const isSubmittedReviewerSession =
      membership.role === 'reviewer' &&
      s.status === 'SUBMITTED' &&
      s.visibilityScope === 'assigned_to_reviewer';
    const isSubmittedSession = s.status === 'SUBMITTED';
    const isRecruiterIssuedSession =
      membership.role === 'recruiter' &&
      s.visibilityScope === 'issued_by_recruiter';
    const invitationManagementUrl = `/r23/organizations/${safeOrgId}/builder?issuedSession=${encodeURIComponent(s.sessionId)}`;

    const content = `
      <header>
        <p>
          <strong>Active organization:</strong>
          <span>${safeOrgName}</span>
          <span>(${safeOrgSlug})</span>
          <span>Role: ${safeRole}</span>
          <span>${safeEmail}</span>
        </p>
        <nav aria-label="Evaluator workspace">
          <p><a href="/r23/organizations/${safeOrgId}">Back to organization sessions</a></p>
          <p><a href="/r23/organizations">Switch organization</a></p>
        </nav>
      </header>

      <form action="/r23/auth/logout" method="post">
        <input type="hidden" name="csrf" value="${safeCsrf}">
        <button type="submit">Sign out</button>
      </form>

      <section aria-labelledby="session-summary-title">
        <h2 id="session-summary-title">${safeHtml(s.scenarioTitle)}</h2>
        <p>Session ID: <code>${safeHtml(s.sessionId)}</code></p>
        <dl>
          <dt><strong>Scenario ID:</strong></dt><dd><code>${safeHtml(s.scenarioId)}</code> (v${safeHtml(s.scenarioVersion)})</dd>
          <dt><strong>Lifecycle status:</strong></dt><dd><span data-testid="session-lifecycle-status">${safeHtml(lifecycleLabel)} (${safeHtml(s.status)})</span> ${isTimedOut ? '<span>(Timed out)</span>' : ''}</dd>
          <dt><strong>Review progress:</strong></dt><dd>${safeHtml(reviewLabel)}</dd>
          <dt><strong>Time budget:</strong></dt><dd>${safeHtml(budgetStr)}</dd>
          <dt><strong>Issued:</strong></dt><dd><time datetime="${safeHtml(s.createdAt)}">${safeHtml(s.createdAt)}</time></dd>
          <dt><strong>Started:</strong></dt><dd>${s.activatedAt ? `<time datetime="${safeHtml(s.activatedAt)}">${safeHtml(s.activatedAt)}</time>` : 'Not recorded'}</dd>
          <dt><strong>Submitted:</strong></dt><dd>${s.submittedAt ? `<time datetime="${safeHtml(s.submittedAt)}">${safeHtml(s.submittedAt)}</time>` : 'Not submitted'}</dd>
          <dt><strong>Visibility scope:</strong></dt><dd>${safeHtml(s.visibilityScope ?? 'authorized_scope')}</dd>
        </dl>

        ${
          isSubmittedReviewerSession
            ? `<p><a href="/r27/organizations/${safeOrgId}/sessions/${safeHtml(s.sessionId)}" data-testid="open-submitted-evidence-workbench-link">Open submitted evidence and review workbench</a></p>`
            : isSubmittedSession
              ? `<section aria-labelledby="assigned-reviewer-scope-title" data-testid="staging-assigned-reviewer-scope">
                  <h3 id="assigned-reviewer-scope-title">Evidence access scope</h3>
                  <p role="status">This session has been submitted. Submitted evidence and reviewer notes are available only to the reviewer assigned to this session.</p>
                </section>`
              : `<section aria-labelledby="unsubmitted-evidence-notice-title" data-testid="staging-unsubmitted-evidence-unavailable">
                <h3 id="unsubmitted-evidence-notice-title">Candidate evidence &amp; review workbench status</h3>
                <p role="status">Unsubmitted evidence is unavailable. Candidate execution and live AI-provider operations are disabled in the R2.15 staging slice; evidence reconstruction opens only after a session is in <code>SUBMITTED</code> status.</p>
                ${
                  membership.role === 'reviewer'
                    ? `<p><a href="/r27/organizations/${safeOrgId}/sessions/${safeHtml(s.sessionId)}">View evidence workbench availability status</a></p>`
                    : ''
                }
              </section>`
        }

        <section aria-labelledby="reviewer-assignments-title">
          <h3 id="reviewer-assignments-title">Reviewer assignments</h3>
          <p>Reviewer assignment is bound during internal assessment issuance in the authenticated staging slice.</p>
          <h4>Assigned reviewers</h4>
          ${
            context.assignments && context.assignments.length > 0
              ? `<ul data-testid="assigned-reviewers-list">${context.assignments
                  .map(
                    (a) => `
                <li>
                  <span>Reviewer: <code>${safeHtml(a.reviewerPrincipalId)}</code></span>
                  <span>Status: ${a.revokedAt ? 'Revoked' : 'Active'}</span>
                </li>`,
                  )
                  .join('')}</ul>`
              : '<p>No reviewers currently assigned.</p>'
          }
        </section>

        <section aria-labelledby="candidate-token-recovery-title" data-testid="staging-candidate-invitation-management">
          <h3 id="candidate-token-recovery-title">Candidate invitation</h3>
          ${
            isRecruiterIssuedSession
              ? `<p role="status">The issuing recruiter manages this candidate invitation, including recovery and revocation.</p>
                 <p><a href="${safeHtml(invitationManagementUrl)}" data-testid="manage-candidate-invitation-link">Manage candidate invitation</a></p>`
              : `<p role="status">Candidate invitation links are managed by the issuing recruiter. Contact them for access or a replacement link.</p>`
          }
        </section>
        <p><a href="/r23/organizations/${safeOrgId}">Back to organization sessions</a></p>
      </section>
    `;

    return attachRefreshedCookie(
      htmlResponse(
        `Session ${s.sessionId.slice(0, 8)} summary`,
        content,
        200,
        securityHeaders(),
      ),
      context.refreshedSessionCookie,
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingRefreshPost(request: Request): Promise<Response> {
  try {
    const body = await parseBody(request, true);
    allowedFields(body, ['csrf']);
    const { csrfHash } = requireOriginAndCsrf(request, body);

    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, session, identity, refreshedSessionCookie }) => {
        if (session.selectedOrganizationId) {
          await dispatchVerifiedStagingOperation(
            config,
            identity,
            'organization.context',
            { organizationId: session.selectedOrganizationId },
          );
        } else {
          await dispatchVerifiedStagingOperation(
            config,
            identity,
            'membership.list',
            {},
          );
        }
        const response = new Response(null, {
          status: 204,
          headers: { 'Cache-Control': 'private, no-store' },
        });
        return attachRefreshedCookie(response, refreshedSessionCookie);
      },
      true,
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingLogoutPost(request: Request): Promise<Response> {
  let localClosed = false;
  try {
    const body = await parseBody(request, true);
    allowedFields(body, ['csrf']);
    const { csrfHash, origin } = requireOriginAndCsrf(request, body);

    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, session, identity }) => {
        if (session.selectedOrganizationId) {
          try {
            await dispatchVerifiedStagingOperation(
              config,
              identity,
              'session.revoke',
              { organizationId: session.selectedOrganizationId },
            );
          } catch {
            // Proceed to revoke live GoTrue session and clear browser cookies.
          }
        }
        localClosed = true;
        await revokeAuthSession(config.auth, session.accessToken);
        const response = new Response(null, {
          status: isJsonRequest(request) ? 204 : 303,
          headers: new Headers({
            'Cache-Control': 'private, no-store',
            ...(!isJsonRequest(request)
              ? { Location: new URL('/r23/login', origin).toString() }
              : {}),
          }),
        });
        response.headers.append(
          'Set-Cookie',
          clearCookieHeader(R23_SESSION_COOKIE, true),
        );
        response.headers.append(
          'Set-Cookie',
          clearCookieHeader(R23_CSRF_COOKIE, false),
        );
        response.headers.append(
          'Set-Cookie',
          clearCookieHeader(R23_CALLBACK_COOKIE, true),
        );
        return response;
      },
    );
  } catch (error) {
    const response = failureResponse(request, error);
    if (localClosed) {
      response.headers.append(
        'Set-Cookie',
        clearCookieHeader(R23_SESSION_COOKIE, true),
      );
      response.headers.append(
        'Set-Cookie',
        clearCookieHeader(R23_CSRF_COOKIE, false),
      );
      response.headers.append(
        'Set-Cookie',
        clearCookieHeader(R23_CALLBACK_COOKIE, true),
      );
    }
    return response;
  }
}

export async function stagingOrganizationReviewersApiGet(
  request: Request,
  organizationId: string,
): Promise<Response> {
  try {
    const context = await stagingLoadOrganizationSessionList(
      request,
      organizationId,
    );
    return attachRefreshedCookie(
      Response.json(
        {
          organizationId: organizationId.toLowerCase(),
          reviewers: context.reviewers,
        },
        {
          status: 200,
          headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'Content-Type': 'application/json; charset=utf-8',
          },
        },
      ),
      context.refreshedSessionCookie,
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingSessionAssignmentsApiGet(
  request: Request,
  organizationId: string,
  sessionId: string,
): Promise<Response> {
  try {
    const context = await stagingLoadOrganizationSessionSummary(
      request,
      organizationId,
      sessionId,
    );
    if (context.membership.role !== 'recruiter') {
      throw new StagingForbidden();
    }
    return attachRefreshedCookie(
      Response.json(
        {
          organizationId: organizationId.toLowerCase(),
          sessionId,
          assignments: context.assignments ?? [],
        },
        {
          status: 200,
          headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'Content-Type': 'application/json; charset=utf-8',
          },
        },
      ),
      context.refreshedSessionCookie,
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

function buildStagingDraftContent(
  input: Record<string, unknown>,
  existingDraft: R211AssessmentDraft | null,
): {
  assessmentId?: string;
  content: Record<string, unknown>;
} {
  const templateId =
    input.templateId === 'reservation-moves-v3'
      ? 'reservation-moves-v3'
      : input.templateId === undefined || input.templateId === 'custom'
        ? 'custom'
        : null;
  if (!templateId) {
    throw new StagingBadRequest('Unsupported assessment template.');
  }

  const rawDraft: R211AssessmentDraftInput = {
    templateId,
    title: typeof input.title === 'string' ? input.title : '',
    brief: typeof input.brief === 'string' ? input.brief : '',
    expectedBehavior: Array.isArray(input.expectedBehavior)
      ? (input.expectedBehavior.filter(
          (item): item is string => typeof item === 'string',
        ) as string[])
      : [],
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria)
      ? (input.acceptanceCriteria.filter(
          (item): item is string => typeof item === 'string',
        ) as string[])
      : [],
    primaryFilePath:
      typeof input.primaryFilePath === 'string' ? input.primaryFilePath : '',
    starterFiles: Array.isArray(input.starterFiles)
      ? (input.starterFiles
          .filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === 'object' && !Array.isArray(item),
          )
          .map((item) => ({
            path: typeof item.path === 'string' ? item.path : '',
            content: typeof item.content === 'string' ? item.content : '',
          })) as R211StarterFile[])
      : [],
    durationMinutes:
      typeof input.durationMinutes === 'number' &&
      Number.isInteger(input.durationMinutes)
        ? input.durationMinutes
        : 45,
    terminalEnabled:
      typeof input.terminalEnabled === 'boolean' ? input.terminalEnabled : true,
    integratedAi:
      typeof input.integratedAi === 'boolean' ? input.integratedAi : false,
    rubric: Array.isArray(input.rubric)
      ? (input.rubric
          .filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === 'object' && !Array.isArray(item),
          )
          .map((item) => {
            const app =
              item.applicability &&
              typeof item.applicability === 'object' &&
              !Array.isArray(item.applicability)
                ? (item.applicability as Record<string, unknown>)
                : {};
            return {
              id: typeof item.id === 'string' ? item.id : '',
              label: typeof item.label === 'string' ? item.label : '',
              description:
                typeof item.description === 'string' ? item.description : '',
              weight:
                typeof item.weight === 'number' && Number.isInteger(item.weight)
                  ? item.weight
                  : 0,
              applicability: {
                kind:
                  app.kind === 'conditional'
                    ? ('conditional' as const)
                    : ('always' as const),
                rule: typeof app.rule === 'string' ? app.rule : 'always',
              },
            };
          }) as R211RubricCriterion[])
      : [],
  };

  const normalized = normalizeAssessmentTemplate(rawDraft);
  const requestedDefinitionId =
    typeof input.definitionId === 'string' && UUID.test(input.definitionId)
      ? input.definitionId.toLowerCase()
      : undefined;
  const requestedExpectedVersion =
    typeof input.expectedVersion === 'number' &&
    Number.isInteger(input.expectedVersion)
      ? input.expectedVersion
      : undefined;

  const content: Record<string, unknown> = {
    templateId: normalized.templateId ?? templateId,
    title: normalized.title,
    brief: normalized.brief,
    expectedBehavior: [...normalized.expectedBehavior],
    acceptanceCriteria: [...normalized.acceptanceCriteria],
    primaryFilePath: normalized.primaryFilePath,
    starterFiles: normalized.starterFiles.map((f) => ({
      path: f.path,
      content: f.content,
    })),
    durationMinutes: normalized.durationMinutes,
    terminalEnabled: normalized.terminalEnabled,
    integratedAi: normalized.integratedAi,
    rubric: normalized.rubric.map((r) => ({
      id: r.id,
      label: r.label,
      description: r.description,
      weight: r.weight,
      applicability: {
        kind: r.applicability.kind,
        rule: r.applicability.rule,
      },
    })),
  };

  if (existingDraft) {
    const targetId = requestedDefinitionId ?? existingDraft.definitionId;
    const expectedVersion = requestedExpectedVersion ?? existingDraft.version;
    content.definitionId = targetId;
    content.expectedVersion = expectedVersion;
    return { assessmentId: targetId, content };
  }

  if (
    requestedExpectedVersion !== undefined &&
    requestedExpectedVersion !== 1
  ) {
    const conflict = new Error(
      'Assessment draft changed concurrently',
    ) as Error & {
      code: string;
    };
    conflict.code = '23505';
    throw conflict;
  }

  if (requestedDefinitionId) {
    content.definitionId = requestedDefinitionId;
    return { assessmentId: requestedDefinitionId, content };
  }

  return { content };
}

export async function stagingAssessmentDraftApiGet(
  request: Request,
  targetOrganizationId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'GET',
    headers: jsonHeaders,
  });

  try {
    const context = await stagingLoadOrganizationSessionList(
      request,
      targetOrganizationId,
    );
    if (context.membership.role !== 'recruiter') {
      throw new StagingForbidden();
    }
    return attachRefreshedCookie(
      Response.json(
        { draft: context.draft ?? null },
        {
          status: 200,
          headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'Content-Type': 'application/json; charset=utf-8',
          },
        },
      ),
      context.refreshedSessionCookie,
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function stagingAssessmentDraftApiPut(
  request: Request,
  targetOrganizationId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'PUT',
    headers: jsonHeaders,
  });

  try {
    if (!UUID.test(targetOrganizationId)) throw new StagingBadRequest();
    const organizationId = targetOrganizationId.toLowerCase();
    const body = await parseBody(request, false, 262144);
    const { csrfHash } = requireOriginAndCsrf(request, body);

    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, session, identity, refreshedSessionCookie }) => {
        if (session.selectedOrganizationId !== organizationId) {
          throw new StagingForbidden();
        }
        const beforeContext = await fetchOrganizationContext(
          config,
          identity,
          organizationId,
        );
        if (beforeContext.role !== 'recruiter') {
          throw new StagingForbidden();
        }

        const { assessmentId, content } = buildStagingDraftContent(
          body,
          beforeContext.draft,
        );
        await dispatchVerifiedStagingOperation(
          config,
          identity,
          'assessment.create',
          {
            organizationId,
            ...(assessmentId ? { assessmentId } : {}),
            content: content as unknown as StagingProofArgs,
          },
        );

        const afterContext = await fetchOrganizationContext(
          config,
          identity,
          organizationId,
        );
        return attachRefreshedCookie(
          Response.json(
            { draft: afterContext.draft },
            {
              status: 200,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          ),
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function stagingAssessmentValidateApiPost(
  request: Request,
  targetOrganizationId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'POST',
    headers: jsonHeaders,
  });

  try {
    if (!UUID.test(targetOrganizationId)) throw new StagingBadRequest();
    const organizationId = targetOrganizationId.toLowerCase();
    const body = await parseBody(request, false, 262144);
    const { csrfHash } = requireOriginAndCsrf(request, body);

    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, session, identity, refreshedSessionCookie }) => {
        if (session.selectedOrganizationId !== organizationId) {
          throw new StagingForbidden();
        }
        const beforeContext = await fetchOrganizationContext(
          config,
          identity,
          organizationId,
        );
        if (beforeContext.role !== 'recruiter') {
          throw new StagingForbidden();
        }

        const { assessmentId: existingOrRequestedId, content } =
          buildStagingDraftContent(body, beforeContext.draft);

        if (content.integratedAi === true) {
          return attachRefreshedCookie(
            Response.json(
              {
                valid: false,
                issues: [
                  {
                    path: 'integratedAi',
                    code: 'AI_UNAVAILABLE_IN_STAGING',
                    message:
                      'Live AI-provider operations are disabled in the authenticated staging slice. Disable Integrated AI before validating.',
                  },
                ],
                executionValidationAvailable: false,
                executionValidationNotice:
                  'Static scenario structure validation only. Live code execution and AI capability are disabled in staging.',
              },
              {
                status: 422,
                headers: {
                  'Cache-Control': 'private, no-store, max-age=0',
                  'Content-Type': 'application/json; charset=utf-8',
                },
              },
            ),
            refreshedSessionCookie,
          );
        }

        const approved = normalizeAssessmentTemplate(
          content as unknown as R211AssessmentDraftInput,
        );
        const validation = validateAssessmentDraft(approved);
        if (!validation.valid) {
          return attachRefreshedCookie(
            Response.json(
              {
                valid: false,
                issues: validation.issues,
                executionValidationAvailable: false,
                executionValidationNotice: validation.executionValidationNotice,
              },
              {
                status: 422,
                headers: {
                  'Cache-Control': 'private, no-store, max-age=0',
                  'Content-Type': 'application/json; charset=utf-8',
                },
              },
            ),
            refreshedSessionCookie,
          );
        }

        const created = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'assessment.create',
          {
            organizationId,
            ...(existingOrRequestedId
              ? { assessmentId: existingOrRequestedId }
              : {}),
            content: content as unknown as StagingProofArgs,
          },
        )) as { assessmentId: string };

        const assessmentId = created.assessmentId;
        const storedDraft = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'assessment.get',
          { organizationId, assessmentId },
        )) as { content: StagingProofArgs };

        const reservation = approved.templateId === 'reservation-moves-v3';
        const binding = reservation ? reservationMovesBinding() : undefined;
        const scenarioId = reservation
          ? 'reservation-moves'
          : 'authored-assessment';
        const scenarioVersion = reservation ? 'v3' : '1.0.0';
        const scenarioSnapshot = buildScenarioSnapshotEnvelope(
          scenarioId,
          scenarioVersion,
          approved,
        );
        if (binding) Object.assign(scenarioSnapshot.scenario, binding);

        const validatedVersionPayload = {
          contentDigest: computeCanonicalContentDigest(approved, binding),
          scenarioId,
          scenarioVersion,
          scenarioTitle: approved.title.trim(),
          scenarioSnapshot,
          taskRubricSnapshot: buildTaskRubricSnapshot(approved),
          durationSeconds: approved.durationMinutes * 60,
          terminalEnabled: approved.terminalEnabled,
          integratedAi: approved.integratedAi,
          validationReceipt: {
            validatedAt: new Date().toISOString(),
            checks: [
              'structural_schema',
              'file_boundaries',
              'rubric_weights',
              'duration_limits',
            ],
            executionValidationAvailable: false,
          },
        };

        const validatedResult = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'assessment.validate',
          {
            organizationId,
            assessmentId,
            content: storedDraft.content,
            validatedVersion:
              validatedVersionPayload as unknown as StagingProofArgs,
          },
        )) as { validatedVersionId: string };

        const afterContext = await fetchOrganizationContext(
          config,
          identity,
          organizationId,
        );
        const createdVersion =
          afterContext.validatedVersions.find(
            (v) => v.id === validatedResult.validatedVersionId,
          ) ?? afterContext.validatedVersions[0];

        return attachRefreshedCookie(
          Response.json(
            {
              valid: true,
              version: createdVersion,
              draft: afterContext.draft,
            },
            {
              status: 200,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          ),
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function stagingAssessmentVersionApiGet(
  request: Request,
  targetOrganizationId: string,
  versionId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'GET',
    headers: jsonHeaders,
  });

  try {
    if (!UUID.test(targetOrganizationId) || !UUID.test(versionId)) {
      throw new StagingBadRequest();
    }
    const context = await stagingLoadOrganizationSessionList(
      request,
      targetOrganizationId,
    );
    if (context.membership.role !== 'recruiter') {
      throw new StagingForbidden();
    }
    const version = context.validatedVersions.find(
      (v) => v.id.toLowerCase() === versionId.toLowerCase(),
    );
    if (!version) {
      return attachRefreshedCookie(
        Response.json(
          {
            error: {
              code: 'NOT_FOUND',
              message: 'Validated version not found.',
            },
          },
          {
            status: 404,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        ),
        context.refreshedSessionCookie,
      );
    }

    return attachRefreshedCookie(
      Response.json(
        { version },
        {
          status: 200,
          headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'Content-Type': 'application/json; charset=utf-8',
          },
        },
      ),
      context.refreshedSessionCookie,
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function stagingAssessmentIssuanceApiPost(
  request: Request,
  targetOrganizationId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'POST',
    headers: jsonHeaders,
  });

  try {
    if (!UUID.test(targetOrganizationId)) throw new StagingBadRequest();
    const organizationId = targetOrganizationId.toLowerCase();
    const body = await parseBody(request, false, 65536);
    const { csrfHash } = requireOriginAndCsrf(request, body);

    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, session, identity, refreshedSessionCookie }) => {
        if (session.selectedOrganizationId !== organizationId) {
          throw new StagingForbidden();
        }
        const orgContext = await fetchOrganizationContext(
          config,
          identity,
          organizationId,
        );
        if (orgContext.role !== 'recruiter') {
          throw new StagingForbidden();
        }

        const rawValidatedVersionId =
          body.validatedVersionId ?? body.validated_version_id;
        if (
          typeof rawValidatedVersionId !== 'string' ||
          !UUID.test(rawValidatedVersionId)
        ) {
          throw new StagingBadRequest(
            'Validate an assessment version in the Assessment Builder before issuing.',
          );
        }

        const rawReviewerId = body.reviewerPrincipalId;
        if (typeof rawReviewerId !== 'string' || !UUID.test(rawReviewerId)) {
          return attachRefreshedCookie(
            Response.json(
              {
                error: {
                  code: 'INVALID_REVIEWER',
                  message:
                    'Select an active organization reviewer to assign before issuing the assessment.',
                },
              },
              {
                status: 400,
                headers: {
                  'Cache-Control': 'private, no-store, max-age=0',
                  'Content-Type': 'application/json; charset=utf-8',
                },
              },
            ),
            refreshedSessionCookie,
          );
        }

        const validatedVersion = orgContext.validatedVersions.find(
          (v) => v.id.toLowerCase() === rawValidatedVersionId.toLowerCase(),
        );
        if (!validatedVersion) {
          throw new StagingBadRequest(
            'Validated assessment version not found.',
          );
        }

        const issued = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'assessment.issue',
          {
            organizationId,
            assessmentId: validatedVersion.definitionId,
            reviewerPrincipalId: rawReviewerId.toLowerCase(),
          },
        )) as {
          sessionId: string;
          organizationId: string;
          assessmentId: string;
          reviewerPrincipalId: string;
          status: string;
          terminalEnabled: boolean;
          integratedAi: boolean;
          candidateTokenIssued: boolean;
        };

        return attachRefreshedCookie(
          Response.json(
            {
              sessionId: issued.sessionId,
              organizationId: issued.organizationId,
              assessmentId: issued.assessmentId,
              validatedVersionId: validatedVersion.id,
              reviewerPrincipalId: issued.reviewerPrincipalId,
              scenarioId: validatedVersion.scenarioId,
              scenarioVersion: validatedVersion.scenarioVersion,
              scenarioTitle: validatedVersion.scenarioTitle,
              status: issued.status,
              createdAt: new Date().toISOString(),
              durationSeconds: validatedVersion.durationSeconds,
              isReplay: false,
              terminalEnabled: issued.terminalEnabled,
              integratedAi: issued.integratedAi,
              executionEnabled: false,
              aiEnabled: false,
              candidateTokenIssued: issued.candidateTokenIssued,
              candidateBearerAvailabilityStatus: 'not_issued_in_staging',
              candidatePath: null,
            },
            {
              status: 201,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          ),
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

function requiredInvitationExpiry(value: unknown): string {
  if (typeof value !== 'string') throw new StagingBadRequest();
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new StagingBadRequest();
  }
  return value;
}

function invitationResponse(
  raw: unknown,
  sessionId: string,
  encryptionKey: Buffer,
): R23CandidateInvitationResponse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StagingUnavailable();
  }
  const value = raw as Record<string, unknown>;
  if (
    value.sessionId !== sessionId ||
    !['not_created', 'active', 'expired', 'revoked', 'unmanaged'].includes(
      String(value.status),
    ) ||
    (value.expiresAt !== null && typeof value.expiresAt !== 'string')
  ) {
    throw new StagingUnavailable();
  }
  const status = value.status as R23CandidateInvitationResponse['status'];
  const expiresAt = value.expiresAt as string | null;
  if (status !== 'active') {
    return { sessionId, status, expiresAt, candidatePath: null };
  }
  if (
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now() ||
    typeof value.candidateTokenCiphertext !== 'string'
  ) {
    return {
      sessionId,
      status: 'expired',
      expiresAt,
      candidatePath: null,
    };
  }
  const candidateToken = decryptCandidateToken(
    value.candidateTokenCiphertext,
    sessionId,
    encryptionKey,
  );
  return {
    sessionId,
    status,
    expiresAt,
    candidatePath: `/r26/candidate/${encodeURIComponent(sessionId)}#${candidateToken}`,
  };
}

function candidateInvitationJson(
  value: unknown,
  status: number,
  refreshedSessionCookie: string | null,
): Response {
  return attachRefreshedCookie(
    Response.json(value, {
      status,
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Type': 'application/json; charset=utf-8',
        'Referrer-Policy': 'no-referrer',
      },
    }),
    refreshedSessionCookie,
  );
}

async function requireInvitationRecruiter(
  config: StagingConfiguration,
  identity: R23VerifiedIdentity,
  session: StagingBrowserSessionPayload,
  organizationId: string,
): Promise<void> {
  if (session.selectedOrganizationId !== organizationId) {
    throw new StagingForbidden();
  }
  const context = await fetchOrganizationContext(
    config,
    identity,
    organizationId,
  );
  if (context.role !== 'recruiter') throw new StagingForbidden();
}

export async function stagingCandidateInvitationApiPost(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'POST',
    headers: jsonHeaders,
  });
  try {
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ) {
      throw new StagingBadRequest();
    }
    const organizationId = targetOrganizationId.toLowerCase();
    const body = await parseBody(request, false);
    allowedFields(body, ['expiresAt', 'csrf']);
    const { csrfHash } = requireOriginAndCsrf(request, body);
    const idempotencyKey = request.headers.get('Idempotency-Key');
    if (
      !idempotencyKey ||
      idempotencyKey.length > 128 ||
      !/^[A-Za-z0-9._~-]{1,128}$/.test(idempotencyKey)
    ) {
      throw new StagingBadRequest();
    }
    const expiresAt = requiredInvitationExpiry(body.expiresAt);
    const encryptionKey = loadCandidateTokenEncryptionKey();

    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, session, identity, refreshedSessionCookie }) => {
        await requireInvitationRecruiter(
          config,
          identity,
          session,
          organizationId,
        );
        const candidateToken = randomBytes(32).toString('base64url');
        const raw = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'candidate.invitation.create',
          {
            organizationId,
            sessionId,
            expiresAt,
            idempotencyKey,
            candidateTokenHash: digest(candidateToken),
            candidateTokenCiphertext: encryptCandidateToken(
              candidateToken,
              sessionId,
              encryptionKey,
            ),
          },
        )) as Record<string, unknown> | null;
        if (raw?.conflict === 'IDEMPOTENCY_CONFLICT') {
          return candidateInvitationJson(
            {
              error: {
                code: 'IDEMPOTENCY_CONFLICT',
                message:
                  'This idempotency key was used for another invitation request.',
              },
            },
            409,
            refreshedSessionCookie,
          );
        }
        if (raw?.conflict === 'INVITATION_ALREADY_EXISTS') {
          return candidateInvitationJson(
            {
              error: {
                code: 'INVITATION_ALREADY_EXISTS',
                message:
                  'Recover or revoke the current invitation before creating another.',
              },
            },
            409,
            refreshedSessionCookie,
          );
        }
        const result = invitationResponse(raw, sessionId, encryptionKey);
        return candidateInvitationJson(
          result,
          raw?.replayed === true ? 200 : 201,
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function stagingCandidateInvitationApiGet(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'GET',
    headers: jsonHeaders,
  });
  try {
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      new URL(request.url).search
    ) {
      throw new StagingBadRequest();
    }
    const organizationId = targetOrganizationId.toLowerCase();
    const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);
    const encryptionKey = loadCandidateTokenEncryptionKey();
    return await withStagingBrowserSession(
      request,
      digest(csrf),
      async ({ config, session, identity, refreshedSessionCookie }) => {
        await requireInvitationRecruiter(
          config,
          identity,
          session,
          organizationId,
        );
        const raw = await dispatchVerifiedStagingOperation(
          config,
          identity,
          'candidate.invitation.get',
          { organizationId, sessionId },
        );
        return candidateInvitationJson(
          invitationResponse(raw, sessionId, encryptionKey),
          200,
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function stagingCandidateInvitationApiDelete(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'DELETE',
    headers: jsonHeaders,
  });
  try {
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ) {
      throw new StagingBadRequest();
    }
    const organizationId = targetOrganizationId.toLowerCase();
    const body = await parseBody(request, true);
    allowedFields(body, ['csrf']);
    const { csrfHash } = requireOriginAndCsrf(request, body);
    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, session, identity, refreshedSessionCookie }) => {
        await requireInvitationRecruiter(
          config,
          identity,
          session,
          organizationId,
        );
        const raw = await dispatchVerifiedStagingOperation(
          config,
          identity,
          'candidate.invitation.revoke',
          { organizationId, sessionId },
        );
        if (
          !raw ||
          typeof raw !== 'object' ||
          Array.isArray(raw) ||
          (raw as Record<string, unknown>).sessionId !== sessionId ||
          !['revoked', 'not_created', 'unmanaged'].includes(
            String((raw as Record<string, unknown>).status),
          )
        ) {
          throw new StagingUnavailable();
        }
        const result = raw as R23CandidateInvitationRevocationResponse;
        return candidateInvitationJson(result, 200, refreshedSessionCookie);
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

function readR27EvidenceQuery(request: Request): R27EvidenceQuery {
  const params = new URL(request.url).searchParams;
  if (
    [...params.keys()].some((key) => !['afterSequence', 'limit'].includes(key))
  ) {
    throw new StagingBadRequest();
  }
  const afterValues = params.getAll('afterSequence');
  const limitValues = params.getAll('limit');
  if (afterValues.length > 1 || limitValues.length > 1) {
    throw new StagingBadRequest();
  }
  let afterSequence: string | undefined;
  if (afterValues.length) {
    const value = afterValues[0];
    if (
      !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
      BigInt(value) > R27_MAX_SEQUENCE
    ) {
      throw new StagingBadRequest();
    }
    afterSequence = value;
  }
  const limitValue = limitValues[0];
  const limit = limitValue === undefined ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new StagingBadRequest();
  }
  return {
    ...(afterSequence === undefined ? {} : { afterSequence }),
    limit,
  };
}

type RawStagingEvidencePayload = {
  session: {
    id: string;
    organizationId: string;
    status: string;
    scenarioId: string;
    scenarioVersion: string;
    scenarioTitle: string;
    durationSeconds?: number | null;
    createdAt?: string;
    activatedAt?: string | null;
    submittedAt?: string | null;
    closureReason?: 'candidate_submission' | 'timeout' | null;
    reviewProcessStatus?:
      'not_started' | 'waiting_for_response' | 'next_step_recorded' | null;
    terminalEnabled: boolean;
    aiCapabilitySnapshot: Record<string, unknown>;
    scenarioSnapshot?: unknown;
    taskRubricSnapshot?: unknown;
  };
  events: Array<{
    sequence: number;
    eventType?: string;
    type?: string;
    happenedAt?: string;
    occurredAt?: string;
    payload: Record<string, unknown>;
  }>;
  fileRevisions?: Array<{
    path: string;
    version: number;
    content: string | null;
    contentDigest: string;
    acceptedAt: string;
    eventSequence: number;
  }>;
  submissions?: Array<{
    submittedAt: string;
    closureReason: 'candidate_submission' | 'timeout';
    workspaceDigest: string;
    manifestDigest: string;
    manifest: unknown;
  }>;
  observations: Array<{
    id: string;
    evidenceSourceType?: string;
    sourceType?: string;
    eventSequence: number;
    filePath: string | null;
    fileVersion: number | null;
    evidenceDigest: string;
    body: string;
    version: number;
    createdAt: string;
    updatedAt: string;
  }>;
  observationHistory: Array<{
    historyId: string;
    observationId: string;
    version: number;
    body: string;
    validFrom: string;
    validUntil: string;
    recordedAt: string;
  }>;
  captureLimitation?: string;
};

type RawStagingObservation = {
  id: string;
  evidenceSourceType?: string;
  sourceType?: string;
  eventSequence: string | number;
  filePath: string | null;
  fileVersion: string | number | null;
  evidenceDigest: string;
  body: string;
  version: string | number;
  createdAt: string;
  updatedAt: string;
};

type RawStagingObservationHistory = {
  historyId: string;
  observationId: string;
  version: string | number;
  body: string;
  validFrom: string;
  validUntil: string;
  recordedAt: string;
};

function extractStarterFilesFromSnapshot(
  rawSnapshot: unknown,
): Record<string, string> | null {
  let parsed = rawSnapshot;
  if (typeof rawSnapshot === 'string') {
    try {
      parsed = JSON.parse(rawSnapshot);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    obj.workspaceFiles &&
    typeof obj.workspaceFiles === 'object' &&
    !Array.isArray(obj.workspaceFiles)
  ) {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      obj.workspaceFiles as Record<string, unknown>,
    )) {
      if (typeof v === 'string') {
        result[k] = v;
      }
    }
    return result;
  }
  return null;
}

function mapStagingEvidenceToR27(
  raw: RawStagingEvidencePayload,
  subjectId: string,
  principalId: string,
  matchingSession: StagingSessionRecord | undefined,
  query: R27EvidenceQuery = {},
): R27Evidence {
  const afterSeq =
    query.afterSequence !== undefined ? BigInt(query.afterSequence) : null;
  const limit = query.limit ?? 50;

  const allEvents = (raw.events ?? []).filter((e) =>
    afterSeq === null ? true : BigInt(e.sequence) > afterSeq,
  );
  const slicedEvents = allEvents.slice(0, limit);
  const hasMore = allEvents.length > limit;
  const nextAfterSequence =
    hasMore && slicedEvents.length > 0
      ? String(slicedEvents[slicedEvents.length - 1]!.sequence)
      : null;

  const s = raw.session;
  const createdAt = s.createdAt ?? new Date(0).toISOString();
  const activatedAt = s.activatedAt ?? createdAt;
  const sub = raw.submissions?.[0] ?? null;
  const submittedAt = sub?.submittedAt ?? s.submittedAt ?? createdAt;
  const closureReason =
    sub?.closureReason ?? s.closureReason ?? 'candidate_submission';

  const snapshotText =
    typeof s.scenarioSnapshot === 'string'
      ? s.scenarioSnapshot
      : JSON.stringify(s.scenarioSnapshot ?? {});
  const snapshotDigest = digest(snapshotText);
  const starterFiles = extractStarterFilesFromSnapshot(s.scenarioSnapshot);

  const submittedFiles: Array<{
    path: string;
    content: string;
    version: string;
    digest: string;
  }> = Array.isArray(sub?.manifest)
    ? (sub.manifest as Array<Record<string, unknown>>)
        .filter((item) => item && typeof item.path === 'string')
        .map((item) => {
          const content = typeof item.content === 'string' ? item.content : '';
          return {
            path: String(item.path),
            content,
            version: String(item.version ?? '1'),
            digest:
              typeof item.digest === 'string' ? item.digest : digest(content),
          };
        })
    : [];

  const revisions: Array<R27Evidence['revisions'][number]> = [];
  if (starterFiles) {
    for (const path of Object.keys(starterFiles).sort()) {
      const content = starterFiles[path]!;
      revisions.push({
        path,
        version: '0',
        digest: digest(content),
        content,
        source: 'starter',
      });
    }
  }
  for (const rev of raw.fileRevisions ?? []) {
    revisions.push({
      path: rev.path,
      version: String(rev.version),
      digest: rev.contentDigest,
      content: rev.content ?? null,
      source: 'event_metadata',
    });
  }
  for (const file of submittedFiles) {
    revisions.push({
      path: file.path,
      version: file.version,
      digest: file.digest,
      content: file.content,
      source: 'submitted',
    });
  }

  const activeAssignment = (matchingSession?.assignments ?? []).find(
    (a: StagingSessionAssignmentItem) =>
      a.reviewerPrincipalId.toLowerCase() === principalId.toLowerCase() &&
      a.isActive,
  );

  return {
    permission: 'assigned_reviewer',
    reviewer: {
      subjectId,
      principalId,
    },
    organizationId: s.organizationId,
    sessionId: s.id,
    assignment: {
      id: activeAssignment?.assignmentId ?? 'rva_staging',
      version: String(activeAssignment?.version ?? 1),
      assignedAt: activeAssignment?.assignedAt ?? createdAt,
    },
    scenario: {
      id: s.scenarioId,
      version: s.scenarioVersion,
      title: s.scenarioTitle,
      snapshotText,
      snapshotDigest,
      starterFiles,
    },
    status: 'SUBMITTED',
    createdAt,
    activatedAt,
    submittedAt,
    closureReason,
    submission: {
      submittedAt,
      closureReason,
      workspaceDigest: sub?.workspaceDigest ?? digest('[]'),
      manifestDigest: sub?.manifestDigest ?? digest('[]'),
      files: submittedFiles,
    },
    revisions,
    events: slicedEvents.map((ev) => ({
      sequence: String(ev.sequence),
      type: (ev.eventType ??
        ev.type ??
        'SESSION_SUBMITTED') as R27Evidence['events'][number]['type'],
      timestamp: ev.happenedAt ?? ev.occurredAt ?? submittedAt,
      payload: ev.payload ?? {},
      provenance: 'hirearchy.candidate_session_events',
    })),
    aiInteractions: [],
    executions: [],
    pagination: {
      limit,
      nextAfterSequence,
    },
    availability: {
      terminal: 'unavailable',
      ai: 'unavailable',
      verification: 'unavailable',
      history: 'metadata_only',
      limitations: [
        raw.captureLimitation ??
          'Candidate execution is disabled in this staging lane; no new candidate work is being captured.',
      ],
    },
  };
}

export async function stagingLoadR27EvidencePage(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
  query: R27EvidenceQuery = {},
): Promise<StagingR27EvidencePageState> {
  if (
    !UUID.test(targetOrganizationId) ||
    !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
  ) {
    throw new StagingBadRequest();
  }
  const organizationId = targetOrganizationId.toLowerCase();
  const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);

  return withStagingBrowserSession(
    request,
    digest(csrf),
    async ({ config, session, identity, csrfToken }) => {
      if (session.selectedOrganizationId !== organizationId) {
        throw new StagingForbidden();
      }
      const orgContext = await fetchOrganizationContext(
        config,
        identity,
        organizationId,
      );
      const matchingSession = (orgContext.sessions ?? []).find(
        (s) => s.sessionId === sessionId,
      );
      try {
        const raw = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'evidence.read',
          { organizationId, sessionId },
        )) as unknown as RawStagingEvidencePayload;
        if (raw.session.status !== 'SUBMITTED') {
          const fallbackSession: StagingSessionRecord = matchingSession ?? {
            sessionId: raw.session.id,
            organizationId,
            issuerPrincipalId: '',
            scenarioId: raw.session.scenarioId,
            scenarioVersion: raw.session.scenarioVersion,
            scenarioTitle: raw.session.scenarioTitle,
            status: raw.session.status as StagingSessionRecord['status'],
            durationSeconds: raw.session.durationSeconds ?? 3600,
            createdAt: raw.session.createdAt ?? new Date(0).toISOString(),
            activatedAt: raw.session.activatedAt ?? null,
            submittedAt: raw.session.submittedAt ?? null,
            closureReason: raw.session.closureReason ?? null,
            reviewProcessStatus:
              raw.session.reviewProcessStatus ?? 'not_started',
            terminalEnabled: raw.session.terminalEnabled,
            visibilityScope: 'assigned_to_reviewer',
            assignments: [],
          };
          return {
            kind: 'unsubmitted',
            organizationId,
            session: fallbackSession,
            csrfToken,
          };
        }
        return {
          kind: 'submitted',
          evidence: mapStagingEvidenceToR27(
            raw,
            identity.subjectId,
            orgContext.principalId,
            matchingSession,
            query,
          ),
          csrfToken,
        };
      } catch (error) {
        const code = getSqlErrorCode(error);
        if (code === 'P0002' || code === '42501') {
          return { kind: 'unavailable' };
        }
        throw error;
      }
    },
  );
}

export async function stagingLoadR27Evidence(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
  query: R27EvidenceQuery = {},
): Promise<R27Evidence | null> {
  const pageState = await stagingLoadR27EvidencePage(
    request,
    targetOrganizationId,
    sessionId,
    query,
  );
  return pageState.kind === 'submitted' ? pageState.evidence : null;
}

export async function stagingEvidenceApiGet(
  request: Request,
  organizationId: string,
  sessionId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'GET',
    headers: jsonHeaders,
  });

  try {
    const query = readR27EvidenceQuery(request);
    const evidence = await stagingLoadR27Evidence(
      request,
      organizationId,
      sessionId,
      query,
    );
    if (!evidence) {
      return Response.json(
        { error: { code: 'NOT_FOUND', message: 'Not found.' } },
        {
          status: 404,
          headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'Content-Type': 'application/json; charset=utf-8',
          },
        },
      );
    }
    return Response.json(evidence, {
      status: 200,
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function stagingLoadR28Revision(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
  sequence: string,
): Promise<R28CandidateRevision | null> {
  if (
    !UUID.test(targetOrganizationId) ||
    !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
    !/^(0|[1-9][0-9]{0,18})$/.test(sequence)
  ) {
    throw new StagingBadRequest();
  }
  const organizationId = targetOrganizationId.toLowerCase();
  const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);

  return withStagingBrowserSession(
    request,
    digest(csrf),
    async ({ config, session, identity }) => {
      if (session.selectedOrganizationId !== organizationId) {
        throw new StagingForbidden();
      }
      try {
        const raw = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'evidence.read',
          { organizationId, sessionId },
        )) as unknown as RawStagingEvidencePayload;
        if (raw.session.status !== 'SUBMITTED') return null;
        const revisions = raw.fileRevisions ?? [];
        const rev = revisions.find(
          (item) => String(item.eventSequence) === sequence,
        );
        if (!rev) return null;
        const starterFiles = extractStarterFilesFromSnapshot(
          raw.session.scenarioSnapshot,
        );
        const starterContent = starterFiles?.[rev.path] ?? null;
        const prevRev = revisions
          .filter(
            (item) =>
              item.path === rev.path &&
              Number(item.version) < Number(rev.version),
          )
          .sort((a, b) => Number(b.version) - Number(a.version))[0];
        const sub = raw.submissions?.[0] ?? null;
        const submittedFile = Array.isArray(sub?.manifest)
          ? (sub.manifest as Array<Record<string, unknown>>).find(
              (item) => item && item.path === rev.path,
            )
          : undefined;
        const submittedContent =
          typeof submittedFile?.content === 'string'
            ? submittedFile.content
            : null;
        const matchingEvent = (raw.events ?? []).find(
          (e) => String(e.sequence) === sequence,
        );
        return {
          organizationId,
          sessionId,
          filePath: rev.path,
          version: String(rev.version),
          requestId: String(
            (matchingEvent?.payload as Record<string, unknown> | undefined)
              ?.requestId ?? `req_${rev.eventSequence}`,
          ),
          eventSequence: String(rev.eventSequence),
          acceptedAt: rev.acceptedAt,
          contentEncoding: 'utf-8',
          content: rev.content,
          contentLength: Buffer.byteLength(rev.content ?? '', 'utf8'),
          contentDigest: rev.contentDigest,
          previousVersion: prevRev ? String(prevRev.version) : '0',
          previousDigest: prevRev
            ? prevRev.contentDigest
            : starterContent !== null
              ? digest(starterContent)
              : '',
          previousContent: prevRev ? prevRev.content : starterContent,
          starterContent,
          submittedContent,
          isSubmitted: submittedFile
            ? String(submittedFile.version ?? '') === String(rev.version) &&
              submittedFile.digest === rev.contentDigest
            : false,
          availability:
            typeof rev.content === 'string' ? 'available' : 'unavailable',
          provenance: 'hirearchy.candidate_file_revisions',
        };
      } catch (error) {
        const code = getSqlErrorCode(error);
        if (code === 'P0002' || code === '42501') return null;
        throw error;
      }
    },
  );
}

export async function stagingRevisionApiGet(
  request: Request,
  organizationId: string,
  sessionId: string,
  sequence: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'GET',
    headers: jsonHeaders,
  });

  try {
    const revision = await stagingLoadR28Revision(
      request,
      organizationId,
      sessionId,
      sequence,
    );
    if (!revision) {
      return Response.json(
        { error: { code: 'NOT_FOUND', message: 'Revision not found.' } },
        {
          status: 404,
          headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'Content-Type': 'application/json; charset=utf-8',
          },
        },
      );
    }
    return Response.json(revision, {
      status: 200,
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

function mapStagingObservations(
  raw: RawStagingEvidencePayload,
  organizationId: string,
  sessionId: string,
  authorPrincipalId: string,
): R29EvaluatorObservation[] {
  const historyList = raw.observationHistory ?? [];
  return (raw.observations ?? []).map((obs) =>
    mapStagingObservation(
      obs,
      historyList,
      organizationId,
      sessionId,
      authorPrincipalId,
    ),
  );
}

function mapStagingObservation(
  obs: RawStagingObservation,
  historyList: readonly RawStagingObservationHistory[],
  organizationId: string,
  sessionId: string,
  authorPrincipalId: string,
): R29EvaluatorObservation {
  const sourceType = (obs.sourceType ??
    obs.evidenceSourceType ??
    'timeline_event') as R29EvidenceSourceType;
  const matchingHistory: R29ObservationHistoryEntry[] = historyList
    .filter((h) => h.observationId === obs.id)
    .map((h) => ({
      historyId: h.historyId,
      observationId: h.observationId,
      version: Number(h.version),
      body: h.body,
      evidenceSourceType: sourceType,
      eventSequence: String(obs.eventSequence),
      filePath: obs.filePath ?? null,
      fileVersion: obs.fileVersion != null ? String(obs.fileVersion) : null,
      evidenceDigest: obs.evidenceDigest,
      visibility: 'private' as const,
      validFrom: h.validFrom,
      validUntil: h.validUntil,
      recordedAt: h.recordedAt,
    }));
  return {
    id: obs.id,
    organizationId,
    sessionId,
    authorPrincipalId,
    evidenceSourceType: sourceType,
    eventSequence: String(obs.eventSequence),
    filePath: obs.filePath ?? null,
    fileVersion: obs.fileVersion != null ? String(obs.fileVersion) : null,
    evidenceDigest: obs.evidenceDigest,
    body: obs.body,
    version: Number(obs.version),
    visibility: 'private',
    createdAt: obs.createdAt,
    updatedAt: obs.updatedAt,
    history: matchingHistory,
  };
}

export async function stagingObservationsApiGet(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'GET',
    headers: jsonHeaders,
  });

  try {
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ) {
      throw new StagingBadRequest();
    }
    const organizationId = targetOrganizationId.toLowerCase();
    const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);

    return await withStagingBrowserSession(
      request,
      digest(csrf),
      async ({ config, session, identity, refreshedSessionCookie }) => {
        if (session.selectedOrganizationId !== organizationId) {
          throw new StagingForbidden();
        }
        const orgContext = await fetchOrganizationContext(
          config,
          identity,
          organizationId,
        );
        const raw = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'evidence.read',
          { organizationId, sessionId },
        )) as unknown as RawStagingEvidencePayload;
        const observations = mapStagingObservations(
          raw,
          organizationId,
          sessionId,
          orgContext.principalId,
        );
        const writable = raw.session.status === 'SUBMITTED';
        return attachRefreshedCookie(
          Response.json(
            {
              observations,
              writesEnabled: writable,
              ...(writable
                ? {}
                : {
                    writesUnavailableReason:
                      'Private observations are available after the candidate session is submitted.',
                  }),
            },
            {
              status: 200,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          ),
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function stagingObservationsApiPost(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'POST',
    headers: jsonHeaders,
  });
  try {
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ) {
      throw new StagingBadRequest();
    }
    const organizationId = targetOrganizationId.toLowerCase();
    const body = await parseBody(request, false, 65536);
    allowedFields(body, [
      'csrf',
      'evidenceSourceType',
      'eventSequence',
      'filePath',
      'fileVersion',
      'evidenceDigest',
      'body',
    ]);
    const { csrfHash } = requireOriginAndCsrf(request, body);
    const validation = validateCreateObservationInput(body);
    const validatedInput = validation.value;
    if (!validation.valid || !validatedInput) {
      return Response.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message:
              validation.errors?.join(' ') ?? 'Invalid observation input.',
          },
        },
        {
          status: 400,
          headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'Content-Type': 'application/json; charset=utf-8',
          },
        },
      );
    }

    const proofArgs = JSON.parse(
      JSON.stringify({ organizationId, sessionId, input: validatedInput }),
    ) as StagingProofArgs;
    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, session, identity, refreshedSessionCookie }) => {
        if (session.selectedOrganizationId !== organizationId) {
          throw new StagingForbidden();
        }
        const orgContext = await fetchOrganizationContext(
          config,
          identity,
          organizationId,
        );
        if (orgContext.role !== 'reviewer') throw new StagingForbidden();
        const raw = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'evidence.observation.create',
          proofArgs,
        )) as RawStagingObservation;
        const observation = mapStagingObservation(
          raw,
          [],
          organizationId,
          sessionId,
          orgContext.principalId,
        );
        return attachRefreshedCookie(
          Response.json(
            { observation },
            {
              status: 201,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          ),
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function stagingObservationApiGet(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
  observationId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'GET',
    headers: jsonHeaders,
  });

  try {
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      !UUID.test(observationId)
    ) {
      throw new StagingBadRequest();
    }
    const organizationId = targetOrganizationId.toLowerCase();
    const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);

    return await withStagingBrowserSession(
      request,
      digest(csrf),
      async ({ config, session, identity, refreshedSessionCookie }) => {
        if (session.selectedOrganizationId !== organizationId) {
          throw new StagingForbidden();
        }
        const orgContext = await fetchOrganizationContext(
          config,
          identity,
          organizationId,
        );
        const raw = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'evidence.read',
          { organizationId, sessionId },
        )) as unknown as RawStagingEvidencePayload;
        const observations = mapStagingObservations(
          raw,
          organizationId,
          sessionId,
          orgContext.principalId,
        );
        const match = observations.find(
          (o) => o.id.toLowerCase() === observationId.toLowerCase(),
        );
        if (!match) {
          return attachRefreshedCookie(
            Response.json(
              {
                error: { code: 'NOT_FOUND', message: 'Observation not found.' },
              },
              {
                status: 404,
                headers: {
                  'Cache-Control': 'private, no-store, max-age=0',
                  'Content-Type': 'application/json; charset=utf-8',
                },
              },
            ),
            refreshedSessionCookie,
          );
        }
        return attachRefreshedCookie(
          Response.json(
            {
              observation: match,
              writesEnabled: raw.session.status === 'SUBMITTED',
            },
            {
              status: 200,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          ),
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function stagingObservationApiPatch(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
  observationId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'PATCH',
    headers: jsonHeaders,
  });
  try {
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      !UUID.test(observationId)
    ) {
      throw new StagingBadRequest();
    }
    const organizationId = targetOrganizationId.toLowerCase();
    const body = await parseBody(request, false, 65536);
    allowedFields(body, ['csrf', 'expectedVersion', 'body']);
    const { csrfHash } = requireOriginAndCsrf(request, body);
    const validation = validateUpdateObservationInput(body);
    const validatedInput = validation.value;
    if (!validation.valid || !validatedInput) {
      return Response.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message:
              validation.errors?.join(' ') ?? 'Invalid observation update.',
          },
        },
        {
          status: 400,
          headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'Content-Type': 'application/json; charset=utf-8',
          },
        },
      );
    }

    const proofArgs = JSON.parse(
      JSON.stringify({
        organizationId,
        sessionId,
        observationId,
        input: validatedInput,
      }),
    ) as StagingProofArgs;
    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, session, identity, refreshedSessionCookie }) => {
        if (session.selectedOrganizationId !== organizationId) {
          throw new StagingForbidden();
        }
        const orgContext = await fetchOrganizationContext(
          config,
          identity,
          organizationId,
        );
        if (orgContext.role !== 'reviewer') throw new StagingForbidden();
        const raw = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'evidence.observation.update',
          proofArgs,
        )) as RawStagingObservation;
        const observation = mapStagingObservation(
          raw,
          [],
          organizationId,
          sessionId,
          orgContext.principalId,
        );
        return attachRefreshedCookie(
          Response.json(
            { observation },
            {
              status: 200,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          ),
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function stagingReviewPacketApiGet(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: 'GET',
    headers: jsonHeaders,
  });

  try {
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ) {
      throw new StagingBadRequest();
    }
    const organizationId = targetOrganizationId.toLowerCase();
    const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);

    return await withStagingBrowserSession(
      request,
      digest(csrf),
      async ({ config, session, identity, refreshedSessionCookie }) => {
        if (session.selectedOrganizationId !== organizationId) {
          throw new StagingForbidden();
        }
        const orgContext = await fetchOrganizationContext(
          config,
          identity,
          organizationId,
        );
        const raw = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'review.read',
          { organizationId, sessionId },
        )) as {
          status?: string;
          packets?: Array<{
            id: string;
            status: 'DRAFT' | 'FINALIZED';
            summary: string;
            strengths: string[];
            concerns: string[];
            unresolvedQuestions: string[];
            referencedObservationIds: string[];
            referencedEvidence: R210ReferencedEvidence[];
            version: number;
            finalizedAt: string | null;
            finalDigest: string | null;
            createdAt: string;
            updatedAt: string;
          }>;
          history?: Array<{
            historyId: string;
            packetId: string;
            status: 'DRAFT' | 'FINALIZED';
            version: number;
            summary: string;
            strengths: string[];
            concerns: string[];
            unresolvedQuestions: string[];
            referencedObservationIds: string[];
            referencedEvidence: R210ReferencedEvidence[];
            finalizedAt: string | null;
            finalDigest: string | null;
            validFrom: string;
            validUntil: string;
            recordedAt: string;
          }>;
        };

        const rawPacket = raw.packets?.[0] ?? null;
        const historyEntries: R210ReviewPacketHistoryEntry[] = rawPacket
          ? (raw.history ?? [])
              .filter((h) => h.packetId === rawPacket.id)
              .map((h) => ({
                historyId: h.historyId,
                packetId: h.packetId,
                organizationId,
                sessionId,
                authorPrincipalId: orgContext.principalId,
                status: h.status,
                version: Number(h.version),
                summary: h.summary,
                strengths: h.strengths ?? [],
                concerns: h.concerns ?? [],
                unresolvedQuestions: h.unresolvedQuestions ?? [],
                referencedObservationIds: h.referencedObservationIds ?? [],
                referencedEvidence: h.referencedEvidence ?? [],
                finalizedAt: h.finalizedAt ?? null,
                finalDigest: h.finalDigest ?? null,
                validFrom: h.validFrom,
                validUntil: h.validUntil,
                recordedAt: h.recordedAt,
              }))
          : [];

        const reviewPacket: R210ReviewPacket | null = rawPacket
          ? {
              id: rawPacket.id,
              organizationId,
              sessionId,
              authorPrincipalId: orgContext.principalId,
              status: rawPacket.status,
              summary: rawPacket.summary,
              strengths: rawPacket.strengths ?? [],
              concerns: rawPacket.concerns ?? [],
              unresolvedQuestions: rawPacket.unresolvedQuestions ?? [],
              referencedObservationIds:
                rawPacket.referencedObservationIds ?? [],
              referencedEvidence: rawPacket.referencedEvidence ?? [],
              version: Number(rawPacket.version),
              finalizedAt: rawPacket.finalizedAt ?? null,
              finalDigest: rawPacket.finalDigest ?? null,
              createdAt: rawPacket.createdAt,
              updatedAt: rawPacket.updatedAt,
              history: historyEntries,
            }
          : null;

        return attachRefreshedCookie(
          Response.json(
            {
              reviewPacket,
              writesEnabled: raw.status === 'SUBMITTED',
              ...(raw.status === 'SUBMITTED'
                ? {}
                : {
                    writesUnavailableReason:
                      'Review packets are available after the candidate session is submitted.',
                  }),
            },
            {
              status: 200,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          ),
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

async function stagingReviewPacketMutation(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
  method: 'PUT' | 'POST',
  operation: 'review.packet.save' | 'review.packet.finalize',
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method,
    headers: jsonHeaders,
  });
  try {
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ) {
      throw new StagingBadRequest();
    }
    const organizationId = targetOrganizationId.toLowerCase();
    const body = await parseBody(request, false, 131072);
    allowedFields(
      body,
      operation === 'review.packet.save'
        ? [
            'csrf',
            'summary',
            'strengths',
            'concerns',
            'unresolvedQuestions',
            'referencedObservationIds',
            'referencedEvidence',
            'expectedVersion',
          ]
        : ['csrf', 'expectedVersion'],
    );
    const { csrfHash } = requireOriginAndCsrf(request, body);
    const validation =
      operation === 'review.packet.save'
        ? validateSaveDraftInput(body)
        : validateFinalizePacketInput(body);
    const validatedInput = validation.value;
    if (!validation.valid || !validatedInput) {
      return Response.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message:
              validation.errors?.join(' ') ?? 'Invalid review packet input.',
          },
        },
        {
          status: 400,
          headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'Content-Type': 'application/json; charset=utf-8',
          },
        },
      );
    }

    const proofArgs = JSON.parse(
      JSON.stringify({ organizationId, sessionId, input: validatedInput }),
    ) as StagingProofArgs;
    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, session, identity, refreshedSessionCookie }) => {
        if (session.selectedOrganizationId !== organizationId) {
          throw new StagingForbidden();
        }
        const orgContext = await fetchOrganizationContext(
          config,
          identity,
          organizationId,
        );
        if (orgContext.role !== 'reviewer') throw new StagingForbidden();
        const raw = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          operation,
          proofArgs,
        )) as { reviewPacket?: R210ReviewPacket } | null;
        if (!raw?.reviewPacket) throw new StagingUnavailable();
        return attachRefreshedCookie(
          Response.json(
            { reviewPacket: raw.reviewPacket },
            {
              status: 200,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          ),
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export function stagingReviewPacketApiPut(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<Response> {
  return stagingReviewPacketMutation(
    request,
    targetOrganizationId,
    sessionId,
    'PUT',
    'review.packet.save',
  );
}

export function stagingReviewPacketFinalizeApiPost(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<Response> {
  return stagingReviewPacketMutation(
    request,
    targetOrganizationId,
    sessionId,
    'POST',
    'review.packet.finalize',
  );
}

function resolveAuthAuthConfig(): {
  authUrl: URL;
  authIssuer: string;
  authAudience: string;
} {
  try {
    const config = loadStagingConfiguration();
    if (config?.auth?.authUrl) return config.auth;
  } catch {
    // ignore
  }
  const r23 = readR23Config();
  if (r23) {
    return {
      authUrl: r23.authUrl,
      authIssuer: r23.authIssuer,
      authAudience: r23.authAudience,
    };
  }
  const envUrl = process.env.STAGING_AUTH_URL || process.env.R23_AUTH_URL;
  if (envUrl) {
    return {
      authUrl: new URL(envUrl),
      authIssuer:
        process.env.STAGING_AUTH_ISSUER ||
        process.env.R23_AUTH_ISSUER ||
        'https://auth.hirearchy.test/auth/v1',
      authAudience:
        process.env.STAGING_AUTH_AUDIENCE ||
        process.env.R23_AUTH_AUDIENCE ||
        'authenticated',
    };
  }
  throw new Error('Auth configuration unavailable');
}

export async function stagingSignupGet(request: Request): Promise<Response> {
  const enabled =
    process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED === 'true';

  if (!enabled) {
    return htmlResponse(
      'Self-service registration disabled',
      `
        <section aria-labelledby="gated-signup-heading">
          <h2 id="gated-signup-heading">Self-service registration disabled</h2>
          <p>Public self-service signup is gated off in this environment. Registration will open when self-service release gates are met.</p>
          <div role="note" aria-label="Environment restrictions">
            <p><strong>Environment notice:</strong> Automated email delivery is disabled in this environment (<code>emailDeliveryEnabled: false</code>).</p>
          </div>
          <p><a href="/r23/login">Return to sign in</a></p>
        </section>
      `,
      403,
    );
  }

  const url = new URL(request.url);
  const emailParam = url.searchParams.get('email') ?? '';

  return htmlResponse(
    'Create your account',
    `
      <section aria-labelledby="signup-heading">
        <h2 id="signup-heading">Create your Hirearchy account</h2>
        <div role="note" aria-label="Environment notice">
          <p><strong>Environment notice:</strong> Automated email delivery is disabled in this environment (<code>emailDeliveryEnabled: false</code>). After registration, verify your email to activate your account.</p>
        </div>
        <form action="/r23/signup" method="post">
          <label for="email">Work email</label>
          <input id="email" name="email" type="email" autocomplete="email" required maxlength="320" value="${safeHtml(emailParam)}" placeholder="you@company.com">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="new-password" required minlength="6" maxlength="1024">
          <button type="submit">Create account</button>
        </form>
        <nav aria-label="Sign in navigation">
          <p><a href="/r23/login">Already have an account? Sign in</a></p>
        </nav>
      </section>
    `,
  );
}

export async function stagingSignupPost(request: Request): Promise<Response> {
  const enabled =
    process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED === 'true';

  if (!enabled) {
    return htmlResponse(
      'Self-service registration disabled',
      '<p role="alert">Self-service onboarding is disabled in this environment.</p><p><a href="/r23/login">Return to sign in</a></p>',
      403,
    );
  }

  try {
    const body = await parseBody(request, false);
    allowedFields(body, ['email', 'password']);
    const email = requiredText(body, 'email', 320);
    const password = requiredText(body, 'password', 1024);

    if (!email.includes('@') || password.length < 6) {
      return htmlResponse(
        'Create your account',
        '<p role="alert">Invalid email or password (password must be at least 6 characters).</p><p><a href="/r23/signup">Try again</a></p>',
        400,
      );
    }

    const authConfig = resolveAuthAuthConfig();

    const authResponse = await fetch(
      new URL('/signup', authConfig.authUrl).toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
        }),
        signal: AbortSignal.timeout(5000),
      },
    );

    const data = (await authResponse.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    if (!authResponse.ok) {
      return htmlResponse(
        'Create your account',
        `<p role="alert">${safeHtml(String(data?.msg ?? data?.error_description ?? 'Signup failed'))}</p><p><a href="/r23/signup">Try again</a></p>`,
        authResponse.status,
      );
    }

    return htmlResponse(
      'Account registered',
      `
        <section aria-labelledby="registered-heading">
          <h2 id="registered-heading">Account registration initiated</h2>
          <p>An account for <strong>${safeHtml(email)}</strong> was successfully registered.</p>
          <section aria-labelledby="verification-instructions-heading">
            <h3 id="verification-instructions-heading">Identity Verification Required</h3>
            <div role="note" aria-label="Email delivery notice">
              <p><strong>Automated email delivery is disabled:</strong> We did not send an email because SMTP is disabled in this environment (<code>emailDeliveryEnabled: false</code>). Do not wait for an inbox message.</p>
            </div>
            <p>Please proceed to verify your email address before signing in.</p>
            <p><a href="/r23/verify-email?email=${encodeURIComponent(email)}">Verify email address now</a></p>
            <p><a href="/r23/login">Sign in</a></p>
          </section>
        </section>
      `,
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingVerifyEmailGet(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') || 'signup';

  if (token || tokenHash) {
    try {
      const authConfig = resolveAuthAuthConfig();
      const verifyUrl = new URL('/verify', authConfig.authUrl);
      if (tokenHash) {
        verifyUrl.searchParams.set('token_hash', tokenHash);
      } else if (token) {
        verifyUrl.searchParams.set('token', token);
      }
      verifyUrl.searchParams.set('type', type);

      const authResponse = await fetch(verifyUrl.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });

      if (
        authResponse.status === 200 ||
        authResponse.status === 302 ||
        authResponse.status === 303
      ) {
        return htmlResponse(
          'Email confirmed',
          `
            <section aria-labelledby="confirmed-heading">
              <h2 id="confirmed-heading">Email verified successfully</h2>
              <p>Your identity has been confirmed. You may now sign in and set up your organization.</p>
              <p><a href="/r23/login">Proceed to sign in</a></p>
            </section>
          `,
        );
      }
    } catch {
      // fallback to manual form
    }
  }

  return htmlResponse(
    'Verify your email address',
    `
      <section aria-labelledby="verify-heading">
        <h2 id="verify-heading">Confirm your email address</h2>
        <div role="note" aria-label="Verification instructions">
          <p>Enter the verification token provided for your account to confirm your email.</p>
        </div>
        <form action="/r23/verify-email" method="post">
          <label for="token">Verification token</label>
          <input id="token" name="token" type="text" required placeholder="Verification token" value="${safeHtml(token ?? '')}">
          <input type="hidden" name="type" value="${safeHtml(type)}">
          <button type="submit">Confirm email</button>
        </form>
        <p><a href="/r23/login">Return to sign in</a></p>
      </section>
    `,
  );
}

export async function stagingVerifyEmailPost(
  request: Request,
): Promise<Response> {
  try {
    const authConfig = resolveAuthAuthConfig();
    const body = await parseBody(request, false);
    allowedFields(body, ['token', 'tokenHash', 'type']);
    const token = body.token;
    const tokenHash = body.tokenHash;
    const type = String(body.type || 'signup');

    const verifyUrl = new URL('/verify', authConfig.authUrl);
    if (tokenHash && typeof tokenHash === 'string') {
      verifyUrl.searchParams.set('token_hash', tokenHash);
    } else if (token && typeof token === 'string') {
      verifyUrl.searchParams.set('token', token);
    } else {
      return htmlResponse(
        'Verify your email address',
        '<p role="alert">Verification token is required.</p><p><a href="/r23/verify-email">Try again</a></p>',
        400,
      );
    }
    verifyUrl.searchParams.set('type', type);

    const authResponse = await fetch(verifyUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });

    if (
      authResponse.status === 200 ||
      authResponse.status === 302 ||
      authResponse.status === 303
    ) {
      return htmlResponse(
        'Email confirmed',
        `
          <section aria-labelledby="confirmed-heading">
            <h2 id="confirmed-heading">Email verified successfully</h2>
            <p>Your identity has been confirmed. You may now sign in and set up your organization.</p>
            <p><a href="/r23/login">Sign in</a></p>
          </section>
        `,
      );
    }

    return htmlResponse(
      'Verify your email address',
      '<p role="alert">Email verification failed. Check the token and try again.</p><p><a href="/r23/verify-email">Try again</a></p>',
      400,
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export function stagingRecoverGet(): Response {
  return htmlResponse(
    'Reset your password',
    `
      <section aria-labelledby="recover-heading">
        <h2 id="recover-heading">Request Password Recovery</h2>
        <div role="note" aria-label="Environment notice">
          <p><strong>Notice:</strong> Automated email delivery is disabled in this environment (<code>emailDeliveryEnabled: false</code>). Recovery tokens are generated by the identity provider.</p>
        </div>
        <form action="/r23/recover" method="post">
          <label for="email">Account email</label>
          <input id="email" name="email" type="email" autocomplete="email" required maxlength="320">
          <button type="submit">Request password recovery</button>
        </form>
        <p><a href="/r23/login">Return to sign in</a></p>
      </section>
    `,
  );
}

export async function stagingRecoverPost(request: Request): Promise<Response> {
  try {
    const authConfig = resolveAuthAuthConfig();
    const body = await parseBody(request, false);
    allowedFields(body, ['email']);
    const email = requiredText(body, 'email', 320);

    const authResponse = await fetch(
      new URL('/recover', authConfig.authUrl).toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!authResponse.ok) {
      const data = (await authResponse.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      return htmlResponse(
        'Reset your password',
        `<p role="alert">${safeHtml(String(data?.msg ?? data?.error_description ?? 'Password recovery request failed'))}</p><p><a href="/r23/recover">Try again</a></p>`,
        authResponse.status,
      );
    }

    return htmlResponse(
      'Password recovery initiated',
      `
        <section aria-labelledby="recovery-receipt-title">
          <h2 id="recovery-receipt-title">Password Recovery Initiated</h2>
          <p>A password recovery request has been processed for <strong>${safeHtml(email)}</strong>.</p>
          <div role="note" aria-label="Email delivery notice">
            <p><strong>Automated email delivery is disabled:</strong> Automated recovery emails are not sent in this environment (<code>emailDeliveryEnabled: false</code>).</p>
          </div>
          <p>If you have received a recovery token, you can set your new password below:</p>
          <p><a href="/r23/reset-password">Enter recovery token and set new password</a></p>
          <p><a href="/r23/login">Return to sign in</a></p>
        </section>
      `,
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export function stagingResetPasswordGet(request: Request): Response {
  const url = new URL(request.url);
  const token =
    url.searchParams.get('token') ?? url.searchParams.get('access_token') ?? '';

  return htmlResponse(
    'Set new password',
    `
      <section aria-labelledby="reset-password-heading">
        <h2 id="reset-password-heading">Set new password</h2>
        <div role="note" aria-label="Quarantine notice">
          <p><strong>Security notice:</strong> Password reset uses a dedicated recovery credential. After resetting your password, you will be directed to sign in with your standard credentials.</p>
        </div>
        <form action="/r23/reset-password" method="post">
          <label for="token">Recovery token / access token</label>
          <input id="token" name="token" type="password" required value="${safeHtml(token)}">
          <label for="password">New password</label>
          <input id="password" name="password" type="password" autocomplete="new-password" required minlength="6" maxlength="1024">
          <button type="submit">Update password</button>
        </form>
        <p><a href="/r23/login">Cancel and return to sign in</a></p>
      </section>
    `,
  );
}

export async function stagingResetPasswordPost(
  request: Request,
): Promise<Response> {
  try {
    const body = await parseBody(request, false);
    allowedFields(body, ['token', 'password']);
    const token = requiredText(body, 'token', 16384);
    const password = requiredText(body, 'password', 1024);

    if (password.length < 6) {
      return htmlResponse(
        'Set new password',
        '<p role="alert">New password must be at least 6 characters.</p><p><a href="/r23/reset-password">Try again</a></p>',
        400,
      );
    }

    const authConfig = resolveAuthAuthConfig();

    const identity = await verifyR23AccessToken(authConfig, token);
    if (identity.isRecovery !== true) {
      return htmlResponse(
        'Recovery credential required',
        '<p role="alert">A valid recovery credential is required for password reset.</p><p><a href="/r23/recover">Request recovery</a></p>',
        403,
      );
    }

    const updateResponse = await fetch(
      new URL('/user', authConfig.authUrl).toString(),
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!updateResponse.ok) {
      const data = (await updateResponse.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      return htmlResponse(
        'Set new password',
        `<p role="alert">${safeHtml(String(data?.msg ?? data?.error_description ?? 'Password update failed'))}</p><p><a href="/r23/reset-password">Try again</a></p>`,
        updateResponse.status,
      );
    }

    return htmlResponse(
      'Password updated successfully',
      `
        <section aria-labelledby="reset-complete-heading">
          <h2 id="reset-complete-heading">Password Updated Successfully</h2>
          <p>Your password has been changed. Please sign in with your new credentials.</p>
          <p><a href="/r23/login">Sign in now</a></p>
        </section>
      `,
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingOrganizationBootstrapPost(
  request: Request,
): Promise<Response> {
  try {
    const origin = requireSameOrigin(request);
    const body = await parseBody(request, false);
    allowedFields(body, ['displayName', 'idempotencyKey', 'csrf']);
    const displayName = requiredText(body, 'displayName', 100);
    const idempotencyKey = requiredText(body, 'idempotencyKey', 128);
    const csrf = requiredText(body, 'csrf', 100);
    const csrfHash = digest(csrf);

    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, sessionKey, session, identity }) => {
        const result = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'organization.bootstrap',
          { displayName, idempotencyKey },
        )) as BootstrapOrganizationResponse;

        const organizationId = result.organizationId.toLowerCase();
        await dispatchVerifiedStagingOperation(
          config,
          identity,
          'session.open',
          { organizationId },
        );

        const updatedSession: StagingBrowserSessionPayload = Object.freeze({
          ...session,
          selectedOrganizationId: organizationId,
        });

        return redirect(origin, `/r23/organizations/${organizationId}`, [
          cookieHeader(
            R23_SESSION_COOKIE,
            encryptSessionPayload(updatedSession, sessionKey),
            true,
          ),
        ]);
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingOrganizationSettingsGet(
  request: Request,
  targetOrganizationId: string,
): Promise<Response> {
  if (!UUID.test(targetOrganizationId)) throw new StagingBadRequest();
  const orgIdLower = targetOrganizationId.toLowerCase();
  const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);

  return withStagingBrowserSession(
    request,
    digest(csrf),
    async ({
      session,
      identity,
      config,
      csrfToken,
      refreshedSessionCookie,
    }) => {
      if (session.selectedOrganizationId !== orgIdLower) {
        throw new StagingForbidden();
      }
      const orgContext = await fetchOrganizationContext(
        config,
        identity,
        orgIdLower,
      );

      const profile = (await dispatchVerifiedStagingOperation(
        config,
        identity,
        'account.profile.get',
        {},
      )) as AccountProfile;

      const membersResult = (await dispatchVerifiedStagingOperation(
        config,
        identity,
        'organization.members.list',
        { organizationId: orgIdLower },
      )) as { members?: OrganizationMemberItem[] };
      const members = membersResult?.members ?? [];

      const invitationsResult = (await dispatchVerifiedStagingOperation(
        config,
        identity,
        'organization.invitation.list',
        { organizationId: orgIdLower },
      )) as { invitations?: ReviewerInvitationItem[] };
      const invitations = invitationsResult?.invitations ?? [];

      const membership: R23Membership = {
        organizationId: orgIdLower,
        role: orgContext.role,
        membershipVersion: '1',
      };
      const orgDisplay = resolveOrgDisplay(
        orgIdLower,
        membership,
        identity.email,
      );

      const safeOrgId = safeHtml(orgIdLower);
      const safeOrgName = safeHtml(orgDisplay.name);
      const safeOrgSlug = safeHtml(orgDisplay.slug);
      const safeRole = safeHtml(orgContext.role);
      const safeCsrf = safeHtml(csrfToken);
      const safeEmail = safeHtml(profile.email || identity.email || '');
      const safeDisplayName = safeHtml(profile.displayName || '');

      const membersRows = members
        .map((m) => {
          const ownerLabel = m.isOwner ? '<strong>(Sole Owner)</strong>' : '';
          const removeButton =
            !m.isOwner &&
            (orgContext.role === 'recruiter' ||
              m.principalId === profile.principalId)
              ? `<form action="/r23/organizations/${safeOrgId}/settings" method="post">
                  <input type="hidden" name="csrf" value="${safeCsrf}">
                  <input type="hidden" name="action" value="remove_member">
                  <input type="hidden" name="principalId" value="${safeHtml(m.principalId)}">
                  <button type="submit" aria-label="Remove member ${safeHtml(m.email || m.principalId)}">Remove member</button>
                </form>`
              : m.isOwner
                ? '<span>Sole owner (protected)</span>'
                : '';

          return `
            <tr>
              <td>${safeHtml(m.displayName || 'No display name')}</td>
              <td><code>${safeHtml(m.email || m.principalId)}</code></td>
              <td>${safeHtml(m.role)}</td>
              <td>${safeHtml(m.status)} ${ownerLabel}</td>
              <td><time datetime="${safeHtml(m.joinedAt)}">${safeHtml(m.joinedAt)}</time></td>
              <td>${removeButton}</td>
            </tr>
          `;
        })
        .join('');

      const candidateEncryptionKey = loadCandidateTokenEncryptionKey();
      const invitationsList = invitations
        .map((inv) => {
          let linkHtml = '';
          if (inv.status === 'active' && inv.tokenCiphertext) {
            try {
              const rawToken = decryptInvitationToken(
                inv.tokenCiphertext,
                orgIdLower,
                candidateEncryptionKey,
              );
              const acceptUrl = `/r23/invitations/accept?token=${encodeURIComponent(rawToken)}`;
              linkHtml = `<p><strong>Acceptance Link:</strong> <input type="text" readonly value="${safeHtml(acceptUrl)}" aria-label="Invitation link for ${safeHtml(inv.targetEmail)}" style="width:100%;max-width:100%;box-sizing:border-box;"></p>`;
            } catch {
              // decryption fallback
            }
          }

          const revokeButton =
            inv.status === 'active'
              ? `<form action="/r23/organizations/${safeOrgId}/settings" method="post">
                  <input type="hidden" name="csrf" value="${safeCsrf}">
                  <input type="hidden" name="action" value="revoke_invitation">
                  <input type="hidden" name="invitationId" value="${safeHtml(inv.id)}">
                  <button type="submit" aria-label="Revoke invitation for ${safeHtml(inv.targetEmail)}">Revoke invitation</button>
                </form>`
              : '';

          return `
            <li>
              <div>
                <strong>Target email:</strong> <code>${safeHtml(inv.targetEmail)}</code> |
                <strong>Role:</strong> ${safeHtml(inv.role)} |
                <strong>Status:</strong> <span>${safeHtml(inv.status)}</span>
              </div>
              <div>
                <span>Expires: <time datetime="${safeHtml(inv.expiresAt)}">${safeHtml(inv.expiresAt)}</time></span>
                ${inv.acceptedAt ? ` | <span>Accepted: <time datetime="${safeHtml(inv.acceptedAt)}">${safeHtml(inv.acceptedAt)}</time></span>` : ''}
              </div>
              ${linkHtml}
              ${revokeButton}
            </li>
          `;
        })
        .join('');

      const content = `
        <header>
          <p>
            <strong>Active organization:</strong>
            <span>${safeOrgName}</span>
            <span>(${safeOrgId})</span>
            <span>Role: ${safeRole}</span>
            <span>${safeEmail}</span>
          </p>
          <nav aria-label="Settings navigation">
            <a href="/r23/organizations/${safeOrgId}">Back to organization sessions</a>
            <a href="/r23/organizations">Switch organization</a>
          </nav>
        </header>

        <form action="/r23/auth/logout" method="post">
          <input type="hidden" name="csrf" value="${safeCsrf}">
          <button type="submit">Sign out</button>
        </form>

        <section aria-labelledby="account-profile-heading">
          <h2 id="account-profile-heading">Account Profile</h2>
          <p>Email: <code>${safeEmail}</code> | Principal ID: <code>${safeHtml(profile.principalId)}</code></p>
          <form action="/r23/organizations/${safeOrgId}/settings" method="post">
            <input type="hidden" name="csrf" value="${safeCsrf}">
            <input type="hidden" name="action" value="update_account_profile">
            <label for="accountDisplayName">Display name</label>
            <input id="accountDisplayName" name="displayName" type="text" maxlength="100" value="${safeDisplayName}" placeholder="Your full name">
            <button type="submit">Update profile</button>
          </form>
        </section>

        <section aria-labelledby="org-profile-heading">
          <h2 id="org-profile-heading">Organization Details</h2>
          <p>Organization ID: <code>${safeOrgId}</code> | Slug: <code>${safeOrgSlug}</code></p>
          ${
            orgContext.role === 'recruiter'
              ? `
            <form action="/r23/organizations/${safeOrgId}/settings" method="post">
              <input type="hidden" name="csrf" value="${safeCsrf}">
              <input type="hidden" name="action" value="update_organization_profile">
              <label for="orgDisplayName">Organization display name</label>
              <input id="orgDisplayName" name="organizationDisplayName" type="text" required maxlength="100" value="${safeOrgName}">
              <button type="submit">Update organization name</button>
            </form>
            `
              : ''
          }
        </section>

        <section aria-labelledby="team-members-heading">
          <h2 id="team-members-heading">Organization Members</h2>
          <p>Members with active governance or evaluation roles in this organization.</p>
          <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;width:100%;max-width:100%;">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email / Principal</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Joined</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${membersRows}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="invitations-heading">
          <h2 id="invitations-heading">Reviewer Invitations</h2>
          ${
            orgContext.role === 'recruiter'
              ? `
            <section aria-labelledby="issue-invitation-heading">
              <h3 id="issue-invitation-heading">Issue Reviewer Invitation</h3>
              <div role="note" aria-label="Invitation delivery notice">
                <p><strong>Notice:</strong> Automated email delivery is disabled in this environment (<code>emailDeliveryEnabled: false</code>). A copyable invitation link and bearer token will be generated for manual sharing with the reviewer.</p>
              </div>
              <form action="/r23/organizations/${safeOrgId}/settings" method="post">
                <input type="hidden" name="csrf" value="${safeCsrf}">
                <input type="hidden" name="action" value="create_invitation">
                <input type="hidden" name="idempotencyKey" value="${safeHtml(randomUUID())}">
                <label for="targetEmail">Reviewer email</label>
                <input id="targetEmail" name="targetEmail" type="email" required maxlength="320" placeholder="reviewer@example.com">
                <button type="submit">Create reviewer invitation</button>
              </form>
            </section>
            `
              : ''
          }
          <section aria-labelledby="invitation-history-heading">
            <h3 id="invitation-history-heading">Pending &amp; Past Invitations</h3>
            ${
              invitations.length === 0
                ? '<p>No invitations have been issued for this organization.</p>'
                : `<ul>${invitationsList}</ul>`
            }
          </section>
        </section>
      `;

      const response = htmlResponse('Team & Settings', content);
      return attachRefreshedCookie(response, refreshedSessionCookie);
    },
  );
}

export async function stagingOrganizationSettingsPost(
  request: Request,
  targetOrganizationId: string,
): Promise<Response> {
  if (!UUID.test(targetOrganizationId)) throw new StagingBadRequest();
  const orgIdLower = targetOrganizationId.toLowerCase();
  const origin = requireSameOrigin(request);
  const body = await parseBody(request, false);
  const action = String(body.action ?? '');
  const csrf = requiredText(body, 'csrf', 100);
  const csrfHash = digest(csrf);

  return withStagingBrowserSession(
    request,
    csrfHash,
    async ({ session, identity, config }) => {
      if (session.selectedOrganizationId !== orgIdLower) {
        throw new StagingForbidden();
      }

      if (action === 'update_account_profile') {
        const displayName = requiredText(body, 'displayName', 100);
        await dispatchVerifiedStagingOperation(
          config,
          identity,
          'account.profile.update',
          { displayName },
        );
      } else if (action === 'update_organization_profile') {
        const displayName = requiredText(body, 'organizationDisplayName', 100);
        await dispatchVerifiedStagingOperation(
          config,
          identity,
          'organization.update',
          { organizationId: orgIdLower, displayName },
        );
      } else if (action === 'create_invitation') {
        const targetEmail = requiredText(body, 'targetEmail', 320)
          .trim()
          .toLowerCase();
        const idempotencyKey = requiredText(body, 'idempotencyKey', 128);
        const rawToken = randomBytes(32).toString('base64url');
        const tokenHash = invitationTokenHash(rawToken);
        const ciphertext = encryptInvitationToken(
          rawToken,
          orgIdLower,
          loadCandidateTokenEncryptionKey(),
        );
        const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
        await dispatchVerifiedStagingOperation(
          config,
          identity,
          'organization.invitation.create',
          {
            organizationId: orgIdLower,
            targetEmail,
            expiresAt,
            idempotencyKey,
            invitationTokenHash: tokenHash,
            invitationTokenCiphertext: ciphertext,
          },
        );
      } else if (action === 'revoke_invitation') {
        const invitationId = requiredText(body, 'invitationId', 128);
        await dispatchVerifiedStagingOperation(
          config,
          identity,
          'organization.invitation.revoke',
          { organizationId: orgIdLower, invitationId },
        );
      } else if (action === 'remove_member') {
        const principalId = requiredText(body, 'principalId', 128);
        await dispatchVerifiedStagingOperation(
          config,
          identity,
          'organization.member.remove',
          { organizationId: orgIdLower, principalId },
        );
      } else {
        throw new StagingBadRequest();
      }

      return redirect(origin, `/r23/organizations/${orgIdLower}/settings`);
    },
  );
}

export async function stagingInvitationAcceptGet(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token || token.length > 256) {
    return htmlResponse(
      'Invitation link required',
      '<p role="alert">An invitation token is required in the link.</p><p><a href="/r23/login">Sign in</a></p>',
      400,
    );
  }

  const encodedSession = cookieValue(request, R23_SESSION_COOKIE);
  const csrf = cookieValue(request, R23_CSRF_COOKIE);

  if (!encodedSession || !csrf) {
    return htmlResponse(
      'Reviewer Invitation',
      `
        <section aria-labelledby="invitation-intro-title">
          <h2 id="invitation-intro-title">Join organization as reviewer</h2>
          <p>You have been invited to join an engineering organization on Hirearchy as an active reviewer.</p>
          <div role="note" aria-label="Invitation instructions">
            <p>Please sign in or create an account using the email address the invitation was issued to.</p>
          </div>
          <p><a href="/r23/login?redirect=${encodeURIComponent(`/r23/invitations/accept?token=${token}`)}">Sign in with invited account</a></p>
          <p><a href="/r23/signup">Create new account</a></p>
        </section>
      `,
    );
  }

  try {
    return await withStagingBrowserSession(
      request,
      digest(csrf),
      async ({ identity, csrfToken }) => {
        const safeToken = safeHtml(token);
        const safeEmail = safeHtml(identity.email ?? '');
        const safeCsrf = safeHtml(csrfToken);

        return htmlResponse(
          'Accept Reviewer Invitation',
          `
            <section aria-labelledby="accept-invitation-title">
              <h2 id="accept-invitation-title">Accept Reviewer Invitation</h2>
              <p>You are signed in as <strong>${safeEmail}</strong>.</p>
              <form action="/r23/invitations/accept" method="post">
                <input type="hidden" name="csrf" value="${safeCsrf}">
                <input type="hidden" name="token" value="${safeToken}">
                <button type="submit">Accept invitation and join organization</button>
              </form>
              <p><a href="/r23/organizations">Cancel</a></p>
            </section>
          `,
        );
      },
    );
  } catch {
    return htmlResponse(
      'Reviewer Invitation',
      `
        <p>Your session has expired or is invalid. Please sign in to accept the invitation.</p>
        <p><a href="/r23/login?redirect=${encodeURIComponent(`/r23/invitations/accept?token=${token}`)}">Sign in</a></p>
      `,
      401,
    );
  }
}

export async function stagingInvitationAcceptPost(
  request: Request,
): Promise<Response> {
  try {
    const origin = requireSameOrigin(request);
    const body = await parseBody(request, false);
    allowedFields(body, ['token', 'csrf']);
    const token = requiredText(body, 'token', 256);
    const csrf = requiredText(body, 'csrf', 100);
    const csrfHash = digest(csrf);

    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, sessionKey, session, identity }) => {
        const tokenHash = invitationTokenHash(token);
        const result = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'organization.invitation.accept',
          { invitationTokenHash: tokenHash },
        )) as AcceptInvitationResponse;

        const organizationId = result.organizationId.toLowerCase();
        await dispatchVerifiedStagingOperation(
          config,
          identity,
          'session.open',
          { organizationId },
        );

        const updatedSession: StagingBrowserSessionPayload = Object.freeze({
          ...session,
          selectedOrganizationId: organizationId,
        });

        return redirect(origin, `/r23/organizations/${organizationId}`, [
          cookieHeader(
            R23_SESSION_COOKIE,
            encryptSessionPayload(updatedSession, sessionKey),
            true,
          ),
        ]);
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}
