import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { isIP } from 'node:net';

import type {
  R23Membership,
  R23Session,
} from '../../../../database/postgres/r23/adapter.mjs';
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
} from '../r23-auth/config';
import {
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

type StagingOrganizationContextResponse = Readonly<{
  organizationId: string;
  principalId: string;
  role: 'recruiter' | 'reviewer';
  reviewers: StagingReviewerItem[];
  draft: R211AssessmentDraft | null;
  validatedVersions: R211ValidatedVersion[];
  sessions: StagingSessionRecord[];
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
  return `${message ? `<p role="alert">${safeHtml(message)}</p>` : ''}<form action="/r23/auth/login" method="post"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="320"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button type="submit">Sign in</button></form>`;
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

function errorDetails(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  const code = getSqlErrorCode(error);
  if (error instanceof StagingBadRequest || code === '22023') {
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
    return {
      status: 403,
      code: 'ACCESS_DENIED',
      message: 'Access was denied.',
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
    const identity = assertR23VerifiedIdentity(
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
        const result = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'membership.list',
          {},
        )) as { memberships?: StagingMembershipItem[] } | null;
        const memberships = Array.isArray(result?.memberships)
          ? result.memberships
          : [];
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
        const content = items
          ? `<p>Select one organization for this session.</p><ul>${items}</ul>`
          : '<p>No active organization membership is available for this account.</p>';
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
            ? `<p><a href="/r27/organizations/${safeOrgId}/sessions/${safeHtml(s.sessionId)}" data-testid="open-submitted-evidence-workbench-link">Open submitted evidence workbench (read only)</a></p>`
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

        <section aria-labelledby="candidate-token-recovery-title" data-testid="staging-candidate-invitation-unavailable">
          <h3 id="candidate-token-recovery-title">Candidate link &amp; token status</h3>
          <p>Availability: <code>not_issued_in_staging</code></p>
          <p role="status">No candidate invitation token or candidate workspace link is issued in the R2.15 internal staging slice. Candidate runtime execution and live AI-provider operations remain disabled.</p>
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
  return (raw.observations ?? []).map((obs) => {
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
      visibility: 'private' as const,
      createdAt: obs.createdAt,
      updatedAt: obs.updatedAt,
      history: matchingHistory,
    };
  });
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
        return attachRefreshedCookie(
          Response.json(
            {
              observations,
              writesEnabled: false,
              writesUnavailableReason:
                'Private observation creation and editing are disabled in the R2.15 internal staging slice (read-only access).',
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
            { observation: match, writesEnabled: false },
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
              writesEnabled: false,
              writesUnavailableReason:
                'Review packet draft saving and finalization are disabled in the R2.15 internal staging slice (read-only access).',
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
