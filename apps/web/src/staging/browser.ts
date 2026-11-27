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
import { NVIDIA_MODEL_ID } from '../ai/server-ai-configuration';
import {
  candidateConfirmationParams,
  candidateEntryPath,
  candidateRecoveryPath,
  candidateResetPasswordPath,
  candidateSignInPath,
} from '../hiring/candidate-entry';
import { enforceRateLimit } from '../security/rate-limit';
import { encodeAccountAvatar, MAX_AVATAR_BYTES } from './account-avatar';

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

import { R211ProblemConcurrencyConflict } from '../../../../database/postgres/r211/adapter.mjs';
import type {
  R23Membership,
  R23Session,
} from '../../../../database/postgres/r23/adapter.mjs';
import type {
  R23CandidateInvitationResponse,
  R23CandidateInvitationRevocationResponse,
} from '../r23-auth/contract';
import {
  candidateTokenHash,
  decryptCandidateToken,
  encryptCandidateToken,
  loadCandidateTokenEncryptionKey,
} from '../sessions/candidate-token-storage.mjs';
import type {
  R27Evidence,
  R27EvidenceQuery,
} from '../../../../database/postgres/r27/contract.mjs';
import {
  AI_REVIEW_MODEL_CATALOG,
  generateR27AiCandidateReview,
} from '../r27-evidence/ai-review';
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
  requestR23EmailChange,
  revokeAuthSession,
  R23AuthenticationDenied,
  R23EmailConfirmationRequired,
  R23AuthUnavailable,
  verifyR23AccessToken,
  verifyR23Otp,
  type R23CredentialPair,
  type R23TokenGrant,
  type R23VerifiedIdentity,
} from '../r23-auth/identity';
import {
  clearFounderUatPendingInvitation,
  readFounderUatPendingInvitation,
  readFounderUatRecovery,
} from '../r23-auth/founder-uat-state';
import {
  resolveOrgDisplay,
  reusableProblemError,
  reusableProblemJson,
  reusableProblemNotFound,
  type R211ProblemAction,
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
  R211TemplateId,
  R211ValidatedVersion,
} from '../r211-builder/contract';
import {
  formatPlanBadge,
  getPlanDefinition,
  hasPlanFeature,
  isPlanTier,
  PAID_PLAN_ORDER,
  type OrganizationPlanSummary,
} from '../plans/entitlements';
import type {
  SessionHiringReviewContext,
  WorkspaceRoleKind,
} from '../hiring/types';
import { formatUtcDateTime } from '../ui/relative-time';
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
import {
  isAuthenticatedStaging,
  isHiringPlatformEnabled,
} from '../runtime/profile';
import {
  founderUatMailInboxUrl,
  isFounderUatEnabled,
} from '../runtime/founder-uat';
import {
  dispatchVerifiedStagingOperation,
  loadStagingConfiguration,
  type StagingConfiguration,
  type StagingProofArgs,
} from './server';
import { operationalLogger, sanitizeError } from '../observability/logger.mjs';
import {
  renderSoftwareDocument,
  resolveWorkspaceRoleLabel,
  type SoftwareDocumentTheme,
  type SoftwareWorkspace,
} from '../ui/software-document';
import {
  readAttributionCookie,
  recordServerTelemetryEvent,
} from '../telemetry/server';

const ENVELOPE_VERSION = 1;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const APP_SESSION_TTL_SECONDS = 3600;
const REFRESH_AHEAD_SECONDS = 30;
const MAX_BODY_BYTES = 4096;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const R27_MAX_SEQUENCE = 9223372036854775807n;

export class StagingBrowserRefreshRequired extends Error {}

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
  postLoginPath?: string | null;
  expiresAt: number;
}>;

type StagingMembershipItem = Readonly<{
  organizationId: string;
  role: WorkspaceRoleKind;
  version: number;
  displayName: string | null;
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
  templateId: R211TemplateId;
  title: string;
  description: string;
  scenarioId?: string;
  scenarioVersion?: string;
}>;

type StagingOrganizationContextResponse = Readonly<{
  organizationId: string;
  principalId: string;
  role: WorkspaceRoleKind;
  isOwner?: boolean;
  displayName: string | null;
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

const POST_LOGIN_ORG_PATH =
  /^\/(?:r23|r27)\/organizations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/[A-Za-z0-9_./-]*)?(?:\?[A-Za-z0-9_=&%.-]*)?$/i;

export function sanitizePostLoginPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > 512 ||
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    /[\r\n\0]/.test(trimmed)
  ) {
    return null;
  }
  if (!POST_LOGIN_ORG_PATH.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed, 'https://hirearchy.invalid');
    if (parsed.origin !== 'https://hirearchy.invalid') return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function extractOrganizationIdFromPath(path: string): string | null {
  const match = POST_LOGIN_ORG_PATH.exec(path);
  return match?.[1] ? match[1].toLowerCase() : null;
}

export function resolveStagingPublicOrigin(request: Request): string {
  return resolvePublicOrigin(request);
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
      (obj.postLoginPath !== undefined &&
        obj.postLoginPath !== null &&
        sanitizePostLoginPath(obj.postLoginPath) === null) ||
      typeof obj.expiresAt !== 'number' ||
      !Number.isSafeInteger(obj.expiresAt)
    ) {
      throw new R23AuthenticationDenied();
    }
    const postLoginPath = sanitizePostLoginPath(obj.postLoginPath);
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
      ...(postLoginPath ? { postLoginPath } : {}),
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

const R23_PERSISTENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function cookieHeader(name: string, value: string, httpOnly: boolean): string {
  const maxAge =
    name === R23_SESSION_COOKIE || name === R23_CSRF_COOKIE
      ? `; Max-Age=${R23_PERSISTENT_COOKIE_MAX_AGE_SECONDS}`
      : '';
  return `${name}=${value}; Path=/; Secure; SameSite=Strict${httpOnly ? '; HttpOnly' : ''}${maxAge}`;
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

function securityHeaders(extraDirectives?: string): Headers {
  const base =
    "default-src 'none'; style-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
  return new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': extraDirectives
      ? `${base}; ${extraDirectives}`
      : base,
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });
}

function scriptCspDirectives(scriptBody: string, allowFetch = false): string {
  const hash = createHash('sha256').update(scriptBody, 'utf8').digest('base64');
  return allowFetch
    ? `script-src 'sha256-${hash}'; connect-src 'self'`
    : `script-src 'sha256-${hash}'`;
}

function readRequestTheme(request?: Request): SoftwareDocumentTheme {
  const cookieHeader = request?.headers.get('cookie');
  if (!cookieHeader) {
    return 'light';
  }
  const match = cookieHeader.match(/(?:^|;\s*)hirearchy-theme=(dark|light)/);
  return match?.[1] === 'dark' ? 'dark' : 'light';
}

function htmlResponse(
  title: string,
  content: string,
  status = 200,
  headers = securityHeaders(),
  workspace?: SoftwareWorkspace,
  theme?: SoftwareDocumentTheme,
  currentPath?: string,
  homeHref?: string,
): Response {
  return new Response(
    renderSoftwareDocument(
      title,
      content,
      workspace,
      theme,
      currentPath,
      homeHref,
    ),
    {
      status,
      headers,
    },
  );
}

function loginForm(message = '', nextPath: string | null = null): string {
  const safeNext = sanitizePostLoginPath(nextPath);
  return `${
    message ? `<p role="alert">${safeHtml(message)}</p>` : ''
  }<form action="/r23/auth/login" method="post">${
    safeNext
      ? `<input type="hidden" name="next" value="${safeHtml(safeNext)}">`
      : ''
  }<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="320"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button type="submit">Sign in</button></form><nav aria-label="Account access options">${
    isFounderUatEnabled() ||
    process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED === 'true'
      ? '<p><a href="/r23/signup">Create an account</a></p>'
      : ''
  }<p><a href="/r23/recover">Forgot password?</a></p></nav>`;
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
  if (details.status === 500) {
    const sanitized = sanitizeError(error);
    operationalLogger.error('Authenticated staging request failed', {
      operation: 'browser_api',
      error: {
        name: sanitized.name,
        ...(sanitized.code ? { code: sanitized.code } : {}),
      },
    });
  }
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
  return htmlResponse(
    'Request denied',
    content,
    details.status,
    securityHeaders(),
    undefined,
    readRequestTheme(request),
  );
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
  allowMultipart = false,
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
  if (allowMultipart && contentType === 'multipart/form-data') {
    let form: FormData;
    try {
      form = await new Response(new Uint8Array(Buffer.concat(chunks)), {
        headers: { 'Content-Type': request.headers.get('content-type')! },
      }).formData();
    } catch {
      throw new StagingBadRequest();
    }
    const parsed: Record<string, unknown> = Object.create(null);
    for (const [name, value] of form) {
      if (Object.hasOwn(parsed, name)) throw new StagingBadRequest();
      parsed[name] = value;
    }
    return parsed;
  }
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
  refresh: 'automatic' | 'force' | 'defer' = 'automatic',
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
    refresh === 'force' ||
    storedClaims.exp <= Date.now() / 1000 + REFRESH_AHEAD_SECONDS;
  // A server component cannot deliver the rotated HttpOnly cookie.
  if (needsRefresh && refresh === 'defer')
    throw new StagingBrowserRefreshRequired();
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
  assessmentId?: string,
): Promise<StagingOrganizationContextResponse> {
  const raw = await dispatchVerifiedStagingOperation(
    config,
    identity,
    'organization.context',
    { organizationId, ...(assessmentId ? { assessmentId } : {}) },
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

export function stagingLoginGet(request?: Request): Response {
  if (!isAuthenticatedStaging()) {
    return htmlResponse('Not found', '<p>Not found.</p>', 404);
  }
  try {
    loadStagingConfiguration();
    return htmlResponse(
      'Sign in to Hirearchy',
      loginForm(),
      200,
      securityHeaders(),
      undefined,
      readRequestTheme(request),
      '/r23/login',
    );
  } catch {
    return htmlResponse(
      'Sign in unavailable',
      '<p role="alert">The sign-in service is temporarily unavailable.</p>',
      503,
      securityHeaders(),
      undefined,
      readRequestTheme(request),
      '/r23/login',
    );
  }
}

export async function stagingLoginPost(request: Request): Promise<Response> {
  if (!isAuthenticatedStaging()) {
    return htmlResponse('Not found', '<p>Not found.</p>', 404);
  }
  let requestedNextPath: string | null = null;
  try {
    const config = loadStagingConfiguration();
    const origin = requireSameOrigin(request);
    const body = await parseBody(request, false);
    allowedFields(body, ['email', 'password', 'next']);
    const email = requiredText(body, 'email', 320);
    const password = requiredText(body, 'password', 1024);
    requestedNextPath = sanitizePostLoginPath(body.next);

    let pair: R23TokenGrant;
    try {
      pair = await passwordGrant(config.auth, email, password);
    } catch (error) {
      if (
        error instanceof R23EmailConfirmationRequired &&
        !isJsonRequest(request)
      ) {
        return redirect(
          origin,
          '/r23/verify-email?email=' + encodeURIComponent(email),
        );
      }
      throw error;
    }
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
      ...(requestedNextPath ? { postLoginPath: requestedNextPath } : {}),
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
        'Team sign in',
        loginForm(
          'Invalid email or password. Check credentials and try again.',
          requestedNextPath,
        ),
        401,
        securityHeaders(),
        undefined,
        readRequestTheme(request),
        '/r23/login',
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

    let destination = '/r23/organizations';
    let selectedOrganizationId = session.selectedOrganizationId;
    const requestedPath = sanitizePostLoginPath(session.postLoginPath);
    if (requestedPath && isHiringPlatformEnabled()) {
      const targetOrgId = extractOrganizationIdFromPath(requestedPath);
      if (targetOrgId) {
        try {
          await dispatchVerifiedStagingOperation(
            config,
            identity,
            'session.open',
            { organizationId: targetOrgId },
          );
          selectedOrganizationId = targetOrgId;
          destination = requestedPath;
        } catch {
          selectedOrganizationId = null;
          destination = '/r23/organizations';
        }
      }
    } else if (isHiringPlatformEnabled()) {
      try {
        const statusResult = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'onboarding.status',
          {},
        )) as OnboardingStatusResponse | null;
        if (statusResult?.status === 'has_active_membership') {
          const membershipRes = (await dispatchVerifiedStagingOperation(
            config,
            identity,
            'membership.list',
            {},
          )) as { memberships?: StagingMembershipItem[] } | null;
          const memberships = membershipRes?.memberships ?? [];
          const lastOrgCookie = cookieValue(
            request,
            'hirearchy-last-org',
          )?.toLowerCase();
          const preferredOrg =
            (lastOrgCookie &&
              UUID.test(lastOrgCookie) &&
              memberships
                .find((m) => m.organizationId.toLowerCase() === lastOrgCookie)
                ?.organizationId.toLowerCase()) ||
            (memberships.length === 1
              ? memberships[0].organizationId.toLowerCase()
              : null);
          if (preferredOrg) {
            await dispatchVerifiedStagingOperation(
              config,
              identity,
              'session.open',
              { organizationId: preferredOrg },
            );
            selectedOrganizationId = preferredOrg;
            destination = `/r23/organizations/${preferredOrg}/candidates`;
          }
        }
      } catch {
        // Fall back safely to workspace picker if membership lookup fails
      }
    }

    const updatedSession: StagingBrowserSessionPayload = Object.freeze({
      v: session.v,
      sub: session.sub,
      sid: session.sid,
      aal: session.aal,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      csrfHash: session.csrfHash,
      callbackHash: null,
      selectedOrganizationId,
      expiresAt: session.expiresAt,
    });

    return redirect(origin, destination, [
      cookieHeader(
        R23_SESSION_COOKIE,
        encryptSessionPayload(updatedSession, sessionKey),
        true,
      ),
      clearCookieHeader(R23_CALLBACK_COOKIE, true),
      ...(selectedOrganizationId
        ? [
            `hirearchy-last-org=${encodeURIComponent(selectedOrganizationId)}; Path=/; Max-Age=2592000; SameSite=Lax`,
          ]
        : []),
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

function workspaceMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0].charAt(0)}${words[1].charAt(0)}`.toUpperCase();
  }
  return (words[0]?.slice(0, 2) || 'WS').toUpperCase();
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
        const statusResult = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'onboarding.status',
          {},
        )) as OnboardingStatusResponse | null;
        if (
          !statusResult ||
          (statusResult.status !== 'needs_team' &&
            statusResult.status !== 'has_active_membership') ||
          typeof statusResult.capabilities?.selfServiceOnboardingEnabled !==
            'boolean'
        ) {
          throw new StagingUnavailable();
        }

        let memberships: StagingMembershipItem[] = [];
        if (statusResult.status === 'has_active_membership') {
          const result = (await dispatchVerifiedStagingOperation(
            config,
            identity,
            'membership.list',
            {},
          )) as { memberships?: StagingMembershipItem[] } | null;
          if (
            !Array.isArray(result?.memberships) ||
            result.memberships.length === 0
          ) {
            throw new StagingUnavailable();
          }
          memberships = result.memberships;
        }
        const items = memberships
          .map((membership) => {
            if (!UUID.test(membership.organizationId)) {
              throw new StagingUnavailable();
            }
            const id = safeHtml(membership.organizationId.toLowerCase());
            const roleLabel = safeHtml(membership.role);
            const rawDisplayName =
              membership.displayName?.trim() ||
              `Organization ${membership.organizationId.slice(0, 8)}`;
            const displayName = safeHtml(rawDisplayName);
            const monogram = safeHtml(workspaceMonogram(rawDisplayName));
            const roleLabelDisplay =
              membership.role === 'cto'
                ? 'CTO / Owner'
                : membership.role === 'reviewer'
                  ? 'Evaluator'
                  : 'Recruiter';
            return `<li><form action="/r23/organization" method="post"><input type="hidden" name="csrf" value="${safeHtml(csrfToken)}"><input type="hidden" name="organizationId" value="${id}"><button type="submit" aria-label="Select ${displayName} (${roleLabel})"><span class="software-org-picker-main"><span class="software-org-avatar" aria-hidden="true">${monogram}</span><span class="software-org-picker-copy"><span class="software-org-picker-name">${displayName}</span><span class="software-org-picker-meta">Workspace · ${id.slice(0, 8)}</span></span></span><span class="software-org-picker-trail"><span class="software-role-badge">${roleLabelDisplay}</span><span class="software-org-picker-arrow" aria-hidden="true">→</span></span></button></form></li>`;
          })
          .join('');
        let content = '';
        if (memberships.length > 0) {
          content = `<h1>Choose a workspace</h1><p class="software-picker-subtitle">Select an engineering workspace to review submissions and manage assessments.</p><ul class="software-organization-picker">${items}</ul>`;
        } else {
          if (
            statusResult.status === 'needs_team' &&
            statusResult.capabilities.selfServiceOnboardingEnabled
          ) {
            content = `
              <section class="software-bootstrap-card" aria-labelledby="create-org-title">
                <ol class="software-bootstrap-steps" aria-label="Workspace setup progress">
                  <li data-step-state="done"><span class="software-bootstrap-step-badge" aria-hidden="true">✓</span><span>1. Account</span></li>
                  <li data-step-state="active" aria-current="step"><span class="software-bootstrap-step-badge" aria-hidden="true">2</span><span>2. Workspace</span></li>
                  <li data-step-state="upcoming"><span class="software-bootstrap-step-badge" aria-hidden="true">3</span><span>3. First Assessment</span></li>
                </ol>
                <h1 id="create-org-title">Create your workspace</h1>
                <p>Create your first organization, then prepare an assessment and invite your team.</p>
                <div class="software-owner-note" role="note" aria-label="Workspace owner note">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 9h.01"></path><path d="M11 12h1v4h1"></path></svg>
                  <p>You&apos;ll be set up as the workspace owner. Owner transfer isn&apos;t available in this version.</p>
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
          200,
          securityHeaders(),
          undefined,
          readRequestTheme(request),
          '/r23/organizations',
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
        const landingPath = isHiringPlatformEnabled()
          ? `/r23/organizations/${organizationId}/candidates`
          : `/r23/organizations/${organizationId}`;
        return redirect(origin, landingPath, [
          cookieHeader(
            R23_SESSION_COOKIE,
            encryptSessionPayload(updatedSession, sessionKey),
            true,
          ),
          `hirearchy-last-org=${encodeURIComponent(organizationId)}; Path=/; Max-Age=2592000; SameSite=Lax`,
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
    assessmentId?: string;
  },
  refresh: 'automatic' | 'defer' = 'automatic',
): Promise<
  AuthenticatedSessionListContext & {
    isOwner: boolean;
    reviewers: StagingReviewerItem[];
    draft: R211AssessmentDraft | null;
    validatedVersions: R211ValidatedVersion[];
    availableTemplates?: StagingTemplateSummary[];
    plan?: OrganizationPlanSummary | null;
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
        queryParams?.assessmentId,
      );
      const { filtered, totalAuthorizedCount, filteredAuthorizedCount } =
        filterStagingSessions(orgContext.sessions ?? [], queryParams);

      const membership: R23Membership & { displayName: string | null } = {
        organizationId: orgIdLower,
        role: orgContext.role,
        membershipVersion: '1',
        displayName: orgContext.displayName,
      };
      const orgDisplay = resolveOrgDisplay(orgIdLower, membership);
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

      const plan = isHiringPlatformEnabled()
        ? ((await dispatchVerifiedStagingOperation(
            config,
            identity,
            'hiring.plan.get',
            { organizationId: orgIdLower },
          ).catch(() => null)) as OrganizationPlanSummary | null)
        : null;

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
        isOwner: Boolean(orgContext.isOwner),
        reviewers: orgContext.reviewers ?? [],
        draft: orgContext.draft ?? null,
        validatedVersions: orgContext.validatedVersions ?? [],
        availableTemplates: orgContext.availableTemplates ?? [],
        plan,
        refreshedSessionCookie,
      };
    },
    refresh,
  );
}

export async function stagingLoadOrganizationSessionSummary(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<
  AuthenticatedSessionSummaryContext & {
    isOwner: boolean;
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

      const membership: R23Membership & { displayName: string | null } = {
        organizationId: orgIdLower,
        role: orgContext.role,
        membershipVersion: '1',
        displayName: orgContext.displayName,
      };
      const orgDisplay = resolveOrgDisplay(orgIdLower, membership);
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
        isOwner: Boolean(orgContext.isOwner),
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
    const hiring = isHiringPlatformEnabled();
    const isOrgManager =
      membership.role === 'recruiter' || membership.role === 'cto';
    const safeOrgId = safeHtml(organizationId.toLowerCase());
    const safeOrgName = safeHtml(organization.name);
    const roleScopeText = hiring
      ? isOrgManager
        ? 'All assessments across your hiring workspace.'
        : 'Assessments assigned to you for evaluation or authored by you.'
      : membership.role === 'recruiter'
        ? 'Assessments issued by you, from invitation to human review.'
        : 'The submitted work assigned to you for review.';

    let sessionsHtml = '';
    if (result.sessions.length === 0) {
      const filtered = Boolean(
        search ||
        (lifecycleFilter && lifecycleFilter !== 'all') ||
        (reviewStatusFilter && reviewStatusFilter !== 'all') ||
        cursor,
      );
      const emptyTitle = filtered
        ? 'No matching assessments'
        : isOrgManager || hiring
          ? 'Create your first assessment'
          : 'No assigned reviews yet';
      const emptyExplanation = filtered
        ? 'Try a different search or clear the filters.'
        : isOrgManager || hiring
          ? 'Start from a platform template, generate a task with AI, or reuse one from your library.'
          : 'When your team assigns a session to you, it will appear here.';

      sessionsHtml = `
        <section class="software-empty-state" aria-labelledby="empty-sessions-title">
          <h2 id="empty-sessions-title">${emptyTitle}</h2>
          <p>${emptyExplanation}</p>
          ${
            filtered
              ? `<p><a href="/r23/organizations/${safeOrgId}">Clear filters</a></p>`
              : ''
          }
        </section>
      `;
    } else {
      const rows = result.sessions
        .map((s) => {
          const isTimedOut =
            s.status === 'SUBMITTED' && s.closureReason === 'timeout';
          const lifecycleLabel =
            s.status === 'CREATED'
              ? 'Invited'
              : s.status === 'ACTIVE'
                ? 'In progress'
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
          const reviewUrl = `/r27/organizations/${encodeURIComponent(organizationId.toLowerCase())}/sessions/${encodeURIComponent(s.sessionId)}`;
          const actionLinkHtml =
            hiring && s.status === 'SUBMITTED'
              ? `<a href="${safeHtml(reviewUrl)}">Review submission →</a>`
              : `<a href="${safeHtml(inspectUrl)}">Inspect session</a>`;

          const sessionDetailsHtml = `<details${hiring ? ' class="team-session-details"' : ''}>
                  <summary aria-label="Session details for ${safeHtml(s.scenarioTitle)}">Details</summary>
                  <div>
                    <dl>
                      <dt>Full session reference</dt><dd><code>${safeHtml(
                        s.sessionId,
                      )}</code></dd>
                      <dt>Scenario</dt><dd><code>${safeHtml(
                        s.scenarioId,
                      )}</code> (v${safeHtml(s.scenarioVersion)})</dd>
                      <dt>Issued</dt><dd><time datetime="${safeHtml(
                        s.createdAt,
                      )}">${safeHtml(s.createdAt)}</time></dd>
                    </dl>
                  </div>
                </details>`;

          return `
            <li class="software-session-row" data-session-id="${safeHtml(s.sessionId)}">
              <div class="software-session-identity">
                <h3>${safeHtml(s.scenarioTitle)}</h3>
                <p>${safeHtml(budgetStr)}</p>
              </div>
              <div class="software-session-state">
                <span class="software-state-badge" data-state="${safeHtml(s.status.toLowerCase())}">${safeHtml(lifecycleLabel)}</span>
                ${isTimedOut ? '<span>(Timed out)</span>' : ''}
                <p>${safeHtml(currentTimestampLabel)} ${currentTimestamp ? `<time datetime="${safeHtml(currentTimestamp)}">${safeHtml(new Date(currentTimestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }))}</time>` : '—'}</p>
              </div>
              <div class="software-session-review">
                <span class="software-table-label">Review progress</span>
                <span>${safeHtml(reviewLabel)}</span>
              </div>
              <div class="software-session-actions">
                ${actionLinkHtml}
                ${hiring ? '' : sessionDetailsHtml}
              </div>
              ${hiring ? sessionDetailsHtml : ''}
            </li>
          `;
        })
        .join('');

      sessionsHtml = `
        <ul class="software-session-list">${rows}</ul>
      `;
    }

    const content = `
      <header class="software-page-heading">
        <div>${hiring ? '' : `<p class="software-eyebrow">${safeOrgName}</p>`}<h1>${isOrgManager ? 'Assessments' : 'Assigned reviews'}</h1>${hiring && isOrgManager ? '' : `<p>${safeHtml(roleScopeText)}</p>`}</div>
        ${
          hiring
            ? `<div class="hiring-header-actions">
                <a class="hiring-btn hiring-btn-sm" href="/r23/organizations/${safeOrgId}/sample-review" data-testid="explore-sample-candidate-link">Explore sample candidate</a>
                <a class="hiring-btn hiring-btn-sm" href="/r23/organizations/${safeOrgId}/builder/candidate-preview" data-testid="preview-as-candidate-link">Preview as Candidate</a>
                <a class="software-document-primary-link" href="/r23/organizations/${safeOrgId}/builder?mode=new" data-testid="open-assessment-builder-link">Create assessment</a>
              </div>`
            : membership.role === 'recruiter'
              ? `<div>
                <a class="software-document-primary-link" href="/r23/organizations/${safeOrgId}/builder" data-testid="open-assessment-builder-link">Create assessment</a>
                <a href="/r23/organizations/${safeOrgId}/problems">Problems</a>
              </div>`
              : ''
        }
      </header>

      ${
        !isFounderUatEnabled()
          ? `
      <aside class="software-workspace-notice" aria-label="Staging workspace" data-testid="staging-workspace-capability-notice">
        <strong>Staging workspace.</strong> Submitted work is visible to the assigned evaluator.
      </aside>
      `
          : ''
      }

      <section class="software-work-list" aria-label="Assessments">
        <form class="software-session-filters" method="get" action="/r23/organizations/${safeOrgId}">
          <label>
            <span>Find an assessment</span>
            <input type="search" name="search" value="${safeHtml(search ?? '')}" placeholder="Assessment title or session reference" aria-label="Search by assessment title or session reference">
          </label>
          <label>
            <span>Assessment status</span>
            <select name="lifecycle">
              <option value="all" ${lifecycleFilter === 'all' || !lifecycleFilter ? 'selected' : ''}>All assessments</option>
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

        <div class="software-list-caption"><p role="status">Showing ${result.sessions.length} of ${result.totalAuthorizedCount} assessments</p></div>

        ${sessionsHtml}
      </section>
    `;

    const response = htmlResponse(
      isOrgManager ? 'Assessments' : 'Assigned reviews',
      content,
      200,
      securityHeaders(),
      {
        organizationId: organizationId.toLowerCase(),
        organizationName: organization.name,
        role: context.isOwner ? 'cto' : membership.role,
        email: identity.email ?? '',
        csrf: csrfToken,
        active: 'assessments',
        planBadge: context.plan ? formatPlanBadge(context.plan) : undefined,
        planTier: context.plan?.planTier,
        theme: readRequestTheme(request),
        currentPath: `/r23/organizations/${organizationId.toLowerCase()}`,
      },
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
          `<p role="alert">We couldn&apos;t find that assessment in this workspace.</p><p><a href="/r23/organizations/${safeHtml(organizationId.toLowerCase())}">Back to Assessments</a></p>`,
          404,
          securityHeaders(),
          undefined,
          readRequestTheme(request),
        ),
        context.refreshedSessionCookie,
      );
    }

    const { organization, membership, identity, csrfToken } = context;
    const s = sessionRecord;
    const safeOrgId = safeHtml(organizationId.toLowerCase());

    const isTimedOut =
      s.status === 'SUBMITTED' && s.closureReason === 'timeout';
    const lifecycleLabel =
      s.status === 'CREATED'
        ? 'Invited'
        : s.status === 'ACTIVE'
          ? 'In progress'
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
      <header class="software-page-heading">
        <div><p class="software-eyebrow">Assessment overview</p><h1 id="session-summary-title">${safeHtml(s.scenarioTitle)}</h1><p>Session details, candidate access and the next step for your team.</p></div>
        <a href="/r23/organizations/${safeOrgId}">Back to Assessments</a>
      </header>

      <section class="software-settings-section software-session-overview" aria-labelledby="session-summary-title">
        ${
          isSubmittedReviewerSession
            ? `<div class="software-session-action-bar"><a href="/r27/organizations/${safeOrgId}/sessions/${safeHtml(
                s.sessionId,
              )}" class="software-document-primary-link" data-testid="open-submitted-evidence-workbench-link">Review submitted work</a></div>`
            : isSubmittedSession
              ? `<section aria-labelledby="assigned-reviewer-scope-title" data-testid="staging-assigned-reviewer-scope">
                  <h2 id="assigned-reviewer-scope-title">Evidence access</h2>
                  <p role="status">This session has been submitted. Submitted evidence and reviewer notes are available only to the reviewer assigned to this session.</p>
                </section>`
              : `<section aria-labelledby="unsubmitted-evidence-notice-title" data-testid="staging-unsubmitted-evidence-unavailable">
                <h2 id="unsubmitted-evidence-notice-title">Waiting for submitted work</h2>
                <p role="status">Candidate evidence and review tools become available after the assessment is submitted.</p>
                ${
                  membership.role === 'reviewer'
                    ? `<p><a href="/r27/organizations/${safeOrgId}/sessions/${safeHtml(s.sessionId)}">View evidence workbench availability status</a></p>`
                    : ''
                }
              </section>`
        }

        <dl class="software-session-facts">
          <dt><strong>Scenario ID:</strong></dt><dd><code>${safeHtml(
            s.scenarioId,
          )}</code> (v${safeHtml(s.scenarioVersion.replace(/^v/i, ''))})</dd>
          <dt><strong>Status:</strong></dt><dd><span data-testid="session-lifecycle-status">${safeHtml(
            lifecycleLabel,
          )}</span> ${isTimedOut ? '<span>(Timed out)</span>' : ''}</dd>
          <dt><strong>Review progress:</strong></dt><dd>${safeHtml(
            reviewLabel,
          )}</dd>
          <dt><strong>Time budget:</strong></dt><dd>${safeHtml(budgetStr)}</dd>
          <dt><strong>Issued:</strong></dt><dd><time datetime="${safeHtml(
            s.createdAt,
          )}">${safeHtml(
            new Date(s.createdAt).toLocaleString('en-GB', {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: 'UTC',
            }),
          )} UTC</time></dd>
          <dt><strong>Started:</strong></dt><dd>${
            s.activatedAt
              ? `<time datetime="${safeHtml(s.activatedAt)}">${safeHtml(
                  new Date(s.activatedAt).toLocaleString('en-GB', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone: 'UTC',
                  }),
                )} UTC</time>`
              : 'Not recorded'
          }</dd>
          <dt><strong>Submitted:</strong></dt><dd>${
            s.submittedAt
              ? `<time datetime="${safeHtml(s.submittedAt)}">${safeHtml(
                  new Date(s.submittedAt).toLocaleString('en-GB', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone: 'UTC',
                  }),
                )} UTC</time>`
              : 'Not submitted'
          }</dd>
          
        </dl>
        <details class="software-session-reference"><summary>Technical details</summary><p>Session: <code>${safeHtml(
          s.sessionId,
        )}</code></p><p>Status key: <code>${safeHtml(s.status)}</code> · Visibility: <code>${safeHtml(
          s.visibilityScope ?? 'authorized_scope',
        )}</code></p></details>

        <section aria-labelledby="reviewer-assignments-title">
          <h2 id="reviewer-assignments-title">Assigned reviewers</h2>
          ${
            context.assignments && context.assignments.length > 0
              ? `<ul class="software-reviewer-list" data-testid="assigned-reviewers-list">${context.assignments
                  .map((a) => {
                    const reviewerInfo = context.reviewers?.find(
                      (r) => r.principalId === a.reviewerPrincipalId,
                    );
                    const reviewerRole =
                      reviewerInfo?.role === 'cto'
                        ? 'CTO / Owner'
                        : reviewerInfo?.role === 'recruiter'
                          ? 'Recruiter'
                          : 'Evaluator';
                    return `
                <li>
                  <span>${safeHtml(reviewerRole)} (<code title="${safeHtml(a.reviewerPrincipalId)}">${safeHtml(a.reviewerPrincipalId.slice(0, 8))}</code>)</span>
                  <span class="software-reviewer-status ${a.revokedAt ? 'is-revoked' : 'is-active'}">${a.revokedAt ? 'Revoked' : 'Active'}</span>
                </li>`;
                  })
                  .join('')}</ul>`
              : '<p>No reviewers currently assigned.</p>'
          }
        </section>

        <section aria-labelledby="candidate-token-recovery-title" data-testid="staging-candidate-invitation-management">
          <h2 id="candidate-token-recovery-title">Candidate invitation</h2>
          ${
            isRecruiterIssuedSession
              ? `<p role="status">The issuing recruiter manages this candidate invitation, including recovery and revocation.</p>
                 <p><a href="${safeHtml(invitationManagementUrl)}" data-testid="manage-candidate-invitation-link">Manage candidate invitation</a></p>`
              : `<p role="status">Candidate invitation links are managed by the issuing recruiter. Contact them for access or a replacement link.</p>`
          }
        </section>
      </section>
    `;

    return attachRefreshedCookie(
      htmlResponse(
        `Session ${s.sessionId.slice(0, 8)} summary`,
        content,
        200,
        securityHeaders(),
        {
          organizationId: organizationId.toLowerCase(),
          organizationName: organization.name,
          role: context.isOwner ? 'cto' : membership.role,
          email: identity.email ?? '',
          csrf: csrfToken,
          active: 'assessments',
          theme: readRequestTheme(request),
          currentPath: `/r23/organizations/${organizationId.toLowerCase()}/sessions/${encodeURIComponent(s.sessionId)}`,
        },
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
      'force',
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

function requestedStagingDefinitionId(input: Record<string, unknown>) {
  if (input.definitionId === undefined) return undefined;
  if (typeof input.definitionId !== 'string' || !UUID.test(input.definitionId))
    throw new StagingBadRequest();
  return input.definitionId.toLowerCase();
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
                  app.kind === 'recorded_integrated_ai_interaction' ||
                  app.kind === 'conditional'
                    ? app.kind
                    : ('always' as const),
                rule: typeof app.rule === 'string' ? app.rule : 'always',
              },
            };
          }) as R211RubricCriterion[])
      : [],
  };

  const normalized = normalizeAssessmentTemplate(rawDraft);
  const requestedDefinitionId = requestedStagingDefinitionId(input);
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

export async function stagingReusableProblemApi(
  request: Request,
  targetOrganizationId: string,
  action: R211ProblemAction,
  problemId?: string,
  refresh: 'automatic' | 'defer' = 'automatic',
): Promise<Response> {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, { headers: jsonHeaders });
  let refreshedSessionCookie: string | null = null;
  let response: Response;
  try {
    if (!UUID.test(targetOrganizationId)) throw new StagingBadRequest();
    const organizationId = targetOrganizationId.toLowerCase();
    const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);
    let body: Record<string, unknown> = {};
    if (action !== 'list' && action !== 'get') {
      requireSameOrigin(request);
      body = await parseBody(request, action === 'reuse', 262144);
      requireOriginAndCsrf(request, body);
    }

    response = await withStagingBrowserSession(
      request,
      digest(csrf),
      async ({
        config,
        session,
        identity,
        refreshedSessionCookie: sessionCookie,
      }) => {
        refreshedSessionCookie = sessionCookie;
        if (session.selectedOrganizationId !== organizationId) {
          return reusableProblemNotFound();
        }

        const args: StagingProofArgs = { organizationId };
        const bodyFields = ['csrf'];
        if (action !== 'list' && action !== 'create') {
          if (!problemId || !UUID.test(problemId)) {
            return reusableProblemNotFound();
          }
          args.problemId = problemId.toLowerCase();
        }
        if (action === 'create' || action === 'update') {
          bodyFields.push('content');
          args.content = body.content as StagingProofArgs[string];
        }
        if (action === 'update' || action === 'delete') {
          const { expectedVersion } = body;
          if (
            typeof expectedVersion !== 'number' ||
            !Number.isSafeInteger(expectedVersion) ||
            expectedVersion < 1
          ) {
            throw new StagingBadRequest();
          }
          bodyFields.push('expectedVersion');
          args.expectedVersion = expectedVersion;
        }
        allowedFields(body, bodyFields);

        const result = await dispatchVerifiedStagingOperation(
          config,
          identity,
          `problem.${action}`,
          args,
        );
        return reusableProblemJson(
          result as object,
          action === 'create' || action === 'reuse' ? 201 : 200,
        );
      },
      refresh,
    );
  } catch (error) {
    if (error instanceof StagingBrowserRefreshRequired)
      return new Response(null, { status: 428 });
    const code = getSqlErrorCode(error);
    if (code === 'P0002') {
      response = reusableProblemNotFound();
    } else {
      response =
        reusableProblemError(
          code === 'R2111' ? new R211ProblemConcurrencyConflict() : error,
        ) ?? failureResponse(jsonRequest, error);
    }
  }
  return attachRefreshedCookie(response, refreshedSessionCookie);
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
    const definitionId = new URL(request.url).searchParams.get('definitionId');
    if (definitionId !== null && !UUID.test(definitionId))
      throw new StagingBadRequest();
    const context = await stagingLoadOrganizationSessionList(
      request,
      targetOrganizationId,
      { assessmentId: definitionId ?? undefined },
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
          requestedStagingDefinitionId(body),
        );
        if (beforeContext.role !== 'recruiter') {
          throw new StagingForbidden();
        }

        const { assessmentId, content } = buildStagingDraftContent(
          body,
          beforeContext.draft,
        );
        const created = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'assessment.create',
          {
            organizationId,
            ...(assessmentId ? { assessmentId } : {}),
            content: content as unknown as StagingProofArgs,
          },
        )) as { assessmentId: string };

        const afterContext = await fetchOrganizationContext(
          config,
          identity,
          organizationId,
          created.assessmentId,
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
          requestedStagingDefinitionId(body),
        );
        if (beforeContext.role !== 'recruiter') {
          throw new StagingForbidden();
        }

        const { assessmentId: existingOrRequestedId, content } =
          buildStagingDraftContent(
            {
              ...body,
              expectedVersion:
                body.expectedDraftVersion ?? body.expectedVersion,
            },
            beforeContext.draft,
          );

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
          assessmentId,
        );
        const createdVersion = afterContext.validatedVersions.find(
          (v) => v.id === validatedResult.validatedVersionId,
        );
        if (!createdVersion) throw new StagingUnavailable();

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
    if (isHiringPlatformEnabled()) throw new StagingForbidden();
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
  aiInteractions?: R27Evidence['aiInteractions'];
  executions?: R27Evidence['executions'];
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
    aiInteractions: Array.isArray(raw.aiInteractions) ? raw.aiInteractions : [],
    executions: Array.isArray(raw.executions) ? raw.executions : [],
    pagination: {
      limit,
      nextAfterSequence,
    },
    availability: {
      terminal:
        Array.isArray(raw.executions) && raw.executions.length > 0
          ? 'available'
          : 'unavailable',
      ai:
        Array.isArray(raw.aiInteractions) && raw.aiInteractions.length > 0
          ? 'available'
          : 'unavailable',
      verification: 'unavailable',
      history: 'metadata_only',
      limitations: raw.captureLimitation ? [raw.captureLimitation] : [],
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
          isHiringPlatformEnabled() ? 'hiring.evidence.read' : 'evidence.read',
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

async function loadHiringAiReviewGuardAndContext(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<{
  blockedResponse: Response | null;
  hiringContext?: {
    targetRole?: string;
    experienceLevel?: string;
    skills?: readonly string[];
  };
}> {
  if (!isHiringPlatformEnabled()) {
    return { blockedResponse: null };
  }
  const orgIdLower = targetOrganizationId.toLowerCase();
  const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);
  return withStagingBrowserSession(
    request,
    digest(csrf),
    async ({ session, config, identity }) => {
      if (session.selectedOrganizationId !== orgIdLower) {
        throw new StagingForbidden();
      }
      const plan = (await dispatchVerifiedStagingOperation(
        config,
        identity,
        'hiring.plan.get',
        { organizationId: orgIdLower },
      )) as OrganizationPlanSummary;

      if (!hasPlanFeature(plan.planTier, 'aiCandidateReview')) {
        return {
          blockedResponse: Response.json(
            {
              error: {
                code: 'PLAN_UPGRADE_REQUIRED',
                requiredPlan: 'ultra',
                currentPlan: plan.planTier,
                message:
                  'AI Candidate Review requires the Ultra plan. See Upgrade for plan options.',
              },
            },
            {
              status: 402,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          ),
        };
      }

      const reviewContext = (await dispatchVerifiedStagingOperation(
        config,
        identity,
        'hiring.review.context',
        { organizationId: orgIdLower, sessionId },
      ).catch(() => null)) as SessionHiringReviewContext | null;

      return {
        blockedResponse: null,
        hiringContext: reviewContext
          ? {
              targetRole: reviewContext.targetRole,
              experienceLevel: reviewContext.experienceLevel,
              skills: reviewContext.skills,
            }
          : undefined,
      };
    },
  );
}

export async function stagingAiReviewApiGet(
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
    const params = new URL(request.url).searchParams;
    const preset = params.get('preset') ?? undefined;
    const customModelId = params.get('customModelId') ?? undefined;
    const forcePreview =
      isHiringPlatformEnabled() || params.get('forcePreview') === 'true';

    const { blockedResponse, hiringContext } =
      await loadHiringAiReviewGuardAndContext(
        request,
        organizationId,
        sessionId,
      );
    if (blockedResponse) return blockedResponse;

    const evidence = await stagingLoadR27Evidence(
      request,
      organizationId,
      sessionId,
      { limit: 100 },
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

    const report = await generateR27AiCandidateReview(evidence, {
      ...(isHiringPlatformEnabled()
        ? { preset: 'nvidia:kimi-k2', customModelId: NVIDIA_MODEL_ID }
        : { preset, customModelId }),
      forcePreview,
      hiringContext,
    });
    return Response.json(
      { report, availablePresets: AI_REVIEW_MODEL_CATALOG },
      {
        status: 200,
        headers: {
          'Cache-Control': 'private, no-store, max-age=0',
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function stagingAiReviewApiPost(
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
    const body = await parseBody(request, false, 16384);
    allowedFields(body, ['csrf', 'preset', 'customModelId', 'forcePreview']);
    requireOriginAndCsrf(request, body);

    const preset =
      typeof body.preset === 'string' && body.preset.length <= 120
        ? body.preset
        : undefined;
    const customModelId =
      typeof body.customModelId === 'string' && body.customModelId.length <= 160
        ? body.customModelId
        : undefined;
    const forcePreview = body.forcePreview === true;

    const { blockedResponse, hiringContext } =
      await loadHiringAiReviewGuardAndContext(
        request,
        targetOrganizationId,
        sessionId,
      );
    if (blockedResponse) return blockedResponse;

    const evidence = await stagingLoadR27Evidence(
      request,
      targetOrganizationId,
      sessionId,
      { limit: 100 },
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

    const report = await generateR27AiCandidateReview(evidence, {
      ...(isHiringPlatformEnabled()
        ? { preset: 'nvidia:kimi-k2', customModelId: NVIDIA_MODEL_ID }
        : { preset, customModelId }),
      forcePreview,
      hiringContext,
    });
    return Response.json(
      { report, availablePresets: AI_REVIEW_MODEL_CATALOG },
      {
        status: 200,
        headers: {
          'Cache-Control': 'private, no-store, max-age=0',
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
    );
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
          isHiringPlatformEnabled() ? 'hiring.evidence.read' : 'evidence.read',
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
          isHiringPlatformEnabled() ? 'hiring.evidence.read' : 'evidence.read',
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
          isHiringPlatformEnabled() ? 'hiring.evidence.read' : 'evidence.read',
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
          <h1 id="gated-signup-heading">Self-service registration disabled</h1>
          <p>Account signup isn&apos;t open here yet. Ask your workspace admin for an invite link.</p>
          <details class="software-tech-details"><summary>Environment details</summary><p>Automated email delivery is off (<code>emailDeliveryEnabled: false</code>).</p></details>
          <p><a href="/r23/login">Return to sign in</a></p>
        </section>
      `,
      403,
      securityHeaders(),
      undefined,
      readRequestTheme(request),
      '/r23/signup',
    );
  }

  const url = new URL(request.url);
  const emailParam = url.searchParams.get('email') ?? '';
  const deliveryNotice = isFounderUatEnabled()
    ? 'A confirmation message will appear in the local inbox after you sign up. No email leaves this machine.'
    : '<p>Email isn&apos;t connected here yet — verify your account directly after signing up.</p><details class="software-tech-details"><summary>Environment details</summary><p><code>emailDeliveryEnabled: false</code></p></details>';

  return htmlResponse(
    'Create your account',
    `
      <section class="software-bootstrap-card" aria-labelledby="signup-heading">
        <ol class="software-bootstrap-steps" aria-label="Workspace setup progress">
          <li data-step-state="active" aria-current="step"><span class="software-bootstrap-step-badge" aria-hidden="true">1</span><span>1. Account</span></li>
          <li data-step-state="upcoming"><span class="software-bootstrap-step-badge" aria-hidden="true">2</span><span>2. Workspace</span></li>
          <li data-step-state="upcoming"><span class="software-bootstrap-step-badge" aria-hidden="true">3</span><span>3. First Assessment</span></li>
        </ol>
        <h1 id="signup-heading">Create your Hirearchy account</h1>
        <div class="software-owner-note" role="note" aria-label="Environment notice">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 9h.01"></path><path d="M11 12h1v4h1"></path></svg>
          <div>${deliveryNotice}</div>
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
    200,
    securityHeaders(),
    undefined,
    readRequestTheme(request),
    '/r23/signup',
  );
}

export async function stagingSignupPost(request: Request): Promise<Response> {
  const enabled =
    process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED === 'true';

  if (!enabled) {
    const response = htmlResponse(
      'Create your account',
      '<p role="alert">Self-service onboarding is disabled in this environment.</p><p><a href="/r23/login">Return to sign in</a></p>',
      403,
      securityHeaders(),
      undefined,
      readRequestTheme(request),
      '/r23/signup',
    );
    return response;
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
        securityHeaders(),
        undefined,
        readRequestTheme(request),
        '/r23/signup',
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
        securityHeaders(),
        undefined,
        readRequestTheme(request),
        '/r23/signup',
      );
    }

    const inboxUrl = isFounderUatEnabled()
      ? founderUatMailInboxUrl(email.trim().toLowerCase())
      : null;
    const confirmation = inboxUrl
      ? `<p>Open the local inbox to confirm your email and finish setting up your account.</p><p><a href="${safeHtml(inboxUrl)}">Open local inbox for ${safeHtml(email)}</a></p>`
      : `<div role="note" aria-label="Email delivery notice"><p>Email isn&apos;t connected here, so we didn&apos;t send a confirmation message.</p><details class="software-tech-details"><summary>Environment details</summary><p><code>emailDeliveryEnabled: false</code></p></details></div><p>Verify your email below before signing in.</p><p><a href="/r23/verify-email?email=${encodeURIComponent(email)}">Verify email address now</a></p>`;

    return htmlResponse(
      'Confirm your email',
      `
        <section aria-labelledby="registered-heading">
          <h1 id="registered-heading">Confirm your email</h1>
          <p>Continue setup for <strong>${safeHtml(email)}</strong>.</p>
          <div>
            ${confirmation}
            <p><a href="/r23/login">Already confirmed? Sign in</a></p>
          </div>
        </section>
      `,
      200,
      securityHeaders(),
      undefined,
      readRequestTheme(request),
      '/r23/signup',
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

function candidateConfirmationForm(
  request: Request,
  email: string,
  next: string | null,
  invalid = false,
): Response {
  const query = candidateConfirmationParams(email, next);
  const action = '/r23/verify-email?' + query;
  const signIn = candidateSignInPath(next);
  const local = isFounderUatEnabled();
  return htmlResponse(
    'Confirm your email',
    `<section aria-labelledby="verify-heading">
      <h1 id="verify-heading">Confirm your email</h1>
      ${invalid ? '<p role="alert">That code could not be confirmed. Check your email and try again.</p>' : ''}
      <p>${local ? 'Open the local inbox to confirm your account.' : 'Enter the confirmation code from your account email.'}</p>
      <form action="${local ? '/r23/mail' : safeHtml(action)}" method="${local ? 'get' : 'post'}">
        <label for="verify-email">Email</label>
        <input id="verify-email" name="email" type="email" value="${safeHtml(email)}" autocomplete="email" required maxlength="320">
        ${
          local
            ? `<input type="hidden" name="audience" value="candidate"><input type="hidden" name="next" value="${safeHtml(query.get('next') ?? '')}">`
            : '<label for="verify-code">Confirmation code</label><input id="verify-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" minlength="6" maxlength="6" required>'
        }
        <button type="submit">${local ? 'Open local inbox' : 'Confirm email'}</button>
      </form>
      <nav aria-label="Account help"><a href="${safeHtml(signIn)}">Return to candidate sign in</a></nav>
    </section>`,
    invalid ? 400 : 200,
    securityHeaders(),
    undefined,
    readRequestTheme(request),
    action,
  );
}

export async function stagingVerifyEmailGet(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    isHiringPlatformEnabled() &&
    url.searchParams.get('audience') === 'candidate'
  ) {
    return candidateConfirmationForm(
      request,
      url.searchParams.get('email') ?? '',
      url.searchParams.get('next'),
    );
  }
  const token = url.searchParams.get('token');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') || 'signup';

  if (isFounderUatEnabled()) {
    const email = url.searchParams.get('email')?.trim() ?? '';
    const inboxUrl = email ? founderUatMailInboxUrl(email) : null;
    return htmlResponse(
      'Confirm your email address',
      `
        <section aria-labelledby="verify-heading">
          <h1 id="verify-heading">Confirm your email address</h1>
          <p>Open the local inbox to confirm your account.</p>
          ${
            inboxUrl
              ? `<p><a href="${safeHtml(inboxUrl)}">Open local inbox for ${safeHtml(email)}</a></p>`
              : `<form action="/r23/mail" method="get">
                  <label for="verify-email">Account email</label>
                  <input id="verify-email" name="email" type="email" autocomplete="email" required maxlength="320">
                  <button type="submit">Open local inbox</button>
                </form>`
          }
          <p><a href="/r23/login">Return to sign in</a></p>
        </section>
      `,
      200,
      securityHeaders(),
      undefined,
      readRequestTheme(request),
      '/r23/verify-email',
    );
  }

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
            <p>Your account is confirmed. Sign in below to continue.</p>
            <p><a href="/r23/login">Proceed to sign in</a></p>
          </section>
        `,
          200,
          securityHeaders(),
          undefined,
          readRequestTheme(request),
          '/r23/verify-email',
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
        <h1 id="verify-heading">Confirm your email address</h1>
        <div role="note" aria-label="Verification instructions">
          <p>Enter the verification code for your account to confirm your email.</p>
        </div>
        <form action="/r23/verify-email" method="post">
          <label for="token">Verification code</label>
          <input id="token" name="token" type="text" required placeholder="Verification code" value="${safeHtml(token ?? '')}">
          <input type="hidden" name="type" value="${safeHtml(type)}">
          <button type="submit">Confirm email</button>
        </form>
        <p><a href="/r23/login">Return to sign in</a></p>
      </section>
    `,
    200,
    securityHeaders(),
    undefined,
    readRequestTheme(request),
    '/r23/verify-email',
  );
}

export async function stagingVerifyEmailPost(
  request: Request,
): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams;
    if (isHiringPlatformEnabled() && query.get('audience') === 'candidate') {
      const origin = requireSameOrigin(request);
      const limited = enforceRateLimit(request, 'auth');
      if (limited) return limited;
      const next = query.get('next');
      if (isFounderUatEnabled())
        return candidateConfirmationForm(request, '', next);
      const body = await parseBody(request, false);
      allowedFields(body, ['email', 'code']);
      const email = String(body.email ?? '')
        .trim()
        .toLowerCase();
      const config = resolveAuthAuthConfig();
      try {
        const grant = await verifyR23Otp(
          config,
          email,
          String(body.code ?? '').trim(),
          'signup',
        );
        const identity = assertR23StagingEligibleIdentity(
          await verifyR23AccessToken(config, grant.accessToken, grant),
        );
        if (
          identity.email?.toLowerCase() !== email ||
          !identity.authMethods.includes('otp')
        )
          throw new R23AuthenticationDenied();
      } catch (error) {
        if (!(error instanceof R23AuthenticationDenied)) throw error;
        return candidateConfirmationForm(request, email, next, true);
      }
      return redirect(origin, candidateSignInPath(next, true));
    }
    if (isFounderUatEnabled()) {
      return htmlResponse(
        'Confirm your email address',
        '<p role="alert">Use the local inbox to confirm your email address. Verification tokens are not accepted on this page.</p><p><a href="/r23/mail">Open local inbox</a></p>',
        400,
      );
    }

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

function resolveRecoveryDestination(
  audienceValue: unknown,
  nextValue: unknown,
): Readonly<{
  isCandidate: boolean;
  next: string | null;
  signInPath: string;
  recoverPath: string;
  resetPasswordPath: string;
  mailPath: string;
}> {
  const isCandidate =
    isHiringPlatformEnabled() &&
    typeof audienceValue === 'string' &&
    audienceValue.trim() === 'candidate';
  const next = isCandidate ? candidateEntryPath(nextValue) : null;
  const mailQuery = new URLSearchParams();
  if (isCandidate) mailQuery.set('audience', 'candidate');
  if (next) mailQuery.set('next', next);
  return {
    isCandidate,
    next,
    signInPath: isCandidate ? candidateSignInPath(next) : '/r23/login',
    recoverPath: isCandidate ? candidateRecoveryPath(next) : '/r23/recover',
    resetPasswordPath: isCandidate
      ? candidateResetPasswordPath(next)
      : '/r23/reset-password',
    mailPath: mailQuery.size ? `/r23/mail?${mailQuery}` : '/r23/mail',
  };
}

export function stagingRecoverGet(request?: Request): Response {
  const url = request ? new URL(request.url) : null;
  const dest = resolveRecoveryDestination(
    url?.searchParams.get('audience'),
    url?.searchParams.get('next'),
  );
  const recoveryNotice = isFounderUatEnabled()
    ? '<p>Recovery messages for this local test appear in the local inbox. No email leaves this machine.</p>'
    : '<p>Reset emails aren&apos;t sent automatically in this environment. Ask your admin for a reset code.</p><details class="software-tech-details"><summary>Environment details</summary><p><code>emailDeliveryEnabled: false</code></p></details>';
  const hiddenInputs = dest.isCandidate
    ? `<input type="hidden" name="audience" value="candidate">${
        dest.next
          ? `<input type="hidden" name="next" value="${safeHtml(dest.next)}">`
          : ''
      }`
    : '';
  return htmlResponse(
    'Reset your password',
    `
      <section aria-labelledby="recover-heading">
        <h1 id="recover-heading">Request password recovery</h1>
        <div role="note" aria-label="Recovery instructions">${recoveryNotice}</div>
        <form action="/r23/recover" method="post">
          ${hiddenInputs}
          <label for="email">Account email</label>
          <input id="email" name="email" type="email" autocomplete="email" required maxlength="320">
          <button type="submit">Request password recovery</button>
        </form>
        <p><a href="${safeHtml(dest.signInPath)}">${dest.isCandidate ? 'Return to candidate sign in' : 'Return to sign in'}</a></p>
      </section>
    `,
    200,
    securityHeaders(),
    undefined,
    readRequestTheme(request),
    dest.recoverPath,
    dest.signInPath,
  );
}

export async function stagingRecoverPost(request: Request): Promise<Response> {
  try {
    const authConfig = resolveAuthAuthConfig();
    const body = await parseBody(request, false);
    allowedFields(body, ['email', 'audience', 'next']);
    const email = requiredText(body, 'email', 320);
    const dest = resolveRecoveryDestination(body.audience, body.next);

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
        `<p role="alert">${safeHtml(String(data?.msg ?? data?.error_description ?? 'Password recovery request failed'))}</p><p><a href="${safeHtml(dest.recoverPath)}">Try again</a></p>`,
        authResponse.status,
        securityHeaders(),
        undefined,
        readRequestTheme(request),
        dest.recoverPath,
        dest.signInPath,
      );
    }

    const baseInboxUrl = isFounderUatEnabled()
      ? founderUatMailInboxUrl(email.trim().toLowerCase())
      : null;
    const inboxUrl = (() => {
      if (!baseInboxUrl) return null;
      if (!dest.isCandidate) return baseInboxUrl;
      const inboxQuery = new URLSearchParams({
        email: email.trim().toLowerCase(),
        audience: 'candidate',
      });
      if (dest.next) inboxQuery.set('next', dest.next);
      return `/r23/mail?${inboxQuery}`;
    })();
    const recoveryNextStep = inboxUrl
      ? `<p>Open the local inbox and choose the recovery message for this account.</p><p><a href="${safeHtml(inboxUrl)}">Open local inbox for ${safeHtml(email)}</a></p>`
      : `<div role="note" aria-label="Email delivery notice"><p>Reset emails aren&apos;t sent in this environment.</p><details class="software-tech-details"><summary>Environment details</summary><p><code>emailDeliveryEnabled: false</code></p></details></div><p>If you have a reset code, enter it below to set your new password:</p><p><a href="${safeHtml(dest.resetPasswordPath)}">Enter reset code and set new password</a></p>`;

    return htmlResponse(
      'Password recovery initiated',
      `
        <section aria-labelledby="recovery-receipt-title">
          <h1 id="recovery-receipt-title">Password recovery initiated</h1>
          <p>A password recovery request has been processed for <strong>${safeHtml(email)}</strong>.</p>
          ${recoveryNextStep}
          <p><a href="${safeHtml(dest.signInPath)}">${dest.isCandidate ? 'Return to candidate sign in' : 'Return to sign in'}</a></p>
        </section>
      `,
      200,
      securityHeaders(),
      undefined,
      readRequestTheme(request),
      dest.recoverPath,
      dest.signInPath,
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export function stagingResetPasswordGet(request: Request): Response {
  const url = new URL(request.url);
  if (isFounderUatEnabled()) {
    const recoveryCookie = readFounderUatRecovery(request);
    const dest = resolveRecoveryDestination(
      url.searchParams.get('audience') ?? recoveryCookie?.audience,
      url.searchParams.get('next') ?? recoveryCookie?.next,
    );
    const error = url.searchParams.get('error');
    const errorMessage =
      error === 'expired'
        ? '<p role="alert">This recovery message has expired or was already used. Request a new recovery message.</p>'
        : error === 'unavailable'
          ? '<p role="alert">Your password could not be updated right now. Try again in a moment.</p>'
          : error === 'password'
            ? '<p role="alert">Choose a different password that meets the account requirements.</p>'
            : '';
    const hiddenInputs = dest.isCandidate
      ? `<input type="hidden" name="audience" value="candidate">${
          dest.next
            ? `<input type="hidden" name="next" value="${safeHtml(dest.next)}">`
            : ''
        }`
      : '';
    return htmlResponse(
      'Set new password',
      `
        <section aria-labelledby="reset-password-heading">
          <h1 id="reset-password-heading">Set a new password</h1>
          ${errorMessage}
          <p>Choose a new password, then sign in again.</p>
          <form action="/api/founder-uat/auth/reset-password" method="post">
            ${hiddenInputs}
            <label for="password">New password</label>
            <input id="password" name="password" type="password" autocomplete="new-password" required minlength="6" maxlength="1024">
            <button type="submit">Update password</button>
          </form>
          <p><a href="${safeHtml(dest.mailPath)}">Return to local inbox</a></p>
          <p><a href="${safeHtml(dest.recoverPath)}">Request another recovery message</a></p>
          <p><a href="${safeHtml(dest.signInPath)}">${dest.isCandidate ? 'Cancel and return to candidate sign in' : 'Cancel and return to sign in'}</a></p>
        </section>
      `,
      200,
      securityHeaders(),
      undefined,
      readRequestTheme(request),
      dest.resetPasswordPath,
      dest.signInPath,
    );
  }

  const dest = resolveRecoveryDestination(
    url.searchParams.get('audience'),
    url.searchParams.get('next'),
  );
  const token =
    url.searchParams.get('token') ?? url.searchParams.get('access_token') ?? '';
  const hiddenInputs = dest.isCandidate
    ? `<input type="hidden" name="audience" value="candidate">${
        dest.next
          ? `<input type="hidden" name="next" value="${safeHtml(dest.next)}">`
          : ''
      }`
    : '';

  return htmlResponse(
    'Set new password',
    `
      <section aria-labelledby="reset-password-heading">
        <h1 id="reset-password-heading">Set new password</h1>
        <div role="note" aria-label="Reset note">
          <p><strong>Security notice:</strong> Enter your reset code and choose a new password, then sign in again.</p>
        </div>
        <form action="/r23/reset-password" method="post">
          ${hiddenInputs}
          <label for="token">Reset code</label>
          <input id="token" name="token" type="password" required value="${safeHtml(token)}">
          <label for="password">New password</label>
          <input id="password" name="password" type="password" autocomplete="new-password" required minlength="6" maxlength="1024">
          <button type="submit">Update password</button>
        </form>
        <p><a href="${safeHtml(dest.signInPath)}">${dest.isCandidate ? 'Cancel and return to candidate sign in' : 'Cancel and return to sign in'}</a></p>
      </section>
    `,
    200,
    securityHeaders(),
    undefined,
    readRequestTheme(request),
    dest.resetPasswordPath,
    dest.signInPath,
  );
}

export async function stagingResetPasswordPost(
  request: Request,
): Promise<Response> {
  try {
    if (isFounderUatEnabled()) {
      return htmlResponse(
        'Recovery session required',
        '<p role="alert">Open a recovery message in the local inbox to set a new password.</p><p><a href="/r23/mail">Open local inbox</a></p>',
        403,
      );
    }

    const body = await parseBody(request, false);
    allowedFields(body, ['token', 'password', 'audience', 'next']);
    const token = requiredText(body, 'token', 16384);
    const password = requiredText(body, 'password', 1024);
    const dest = resolveRecoveryDestination(body.audience, body.next);

    if (password.length < 6) {
      return htmlResponse(
        'Set new password',
        `<p role="alert">New password must be at least 6 characters.</p><p><a href="${safeHtml(dest.resetPasswordPath)}">Try again</a></p>`,
        400,
      );
    }

    const authConfig = resolveAuthAuthConfig();

    const identity = await verifyR23AccessToken(authConfig, token);
    if (identity.isRecovery !== true) {
      return htmlResponse(
        'Recovery credential required',
        `<p role="alert">A valid recovery credential is required for password reset.</p><p><a href="${safeHtml(dest.recoverPath)}">Request recovery</a></p>`,
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
        `<p role="alert">${safeHtml(String(data?.msg ?? data?.error_description ?? 'Password update failed'))}</p><p><a href="${safeHtml(dest.resetPasswordPath)}">Try again</a></p>`,
        updateResponse.status,
        securityHeaders(),
        undefined,
        readRequestTheme(request),
        dest.resetPasswordPath,
        dest.signInPath,
      );
    }

    return htmlResponse(
      'Password updated successfully',
      `
        <section aria-labelledby="reset-complete-heading">
          <h1 id="reset-complete-heading">Password Updated Successfully</h1>
          <p>Your password has been changed. Please sign in with your new credentials.</p>
          <p><a href="${safeHtml(dest.signInPath)}">Sign in now</a></p>
        </section>
      `,
      200,
      securityHeaders(),
      undefined,
      readRequestTheme(request),
      dest.resetPasswordPath,
      dest.signInPath,
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

        const attr = readAttributionCookie(request);
        recordServerTelemetryEvent({
          eventName: 'acquisition.org_created',
          category: 'acquisition',
          actorType: 'team_member',
          anonymousId: attr?.anonymousId,
          attribution: attr,
          organizationId,
          principalId: identity.subjectId,
          route: '/r23/organization/bootstrap',
          properties: {
            hiringPlatform: isHiringPlatformEnabled(),
          },
        });

        const updatedSession: StagingBrowserSessionPayload = Object.freeze({
          ...session,
          selectedOrganizationId: organizationId,
        });

        const landingPath = isHiringPlatformEnabled()
          ? `/r23/organizations/${organizationId}/candidates`
          : `/r23/organizations/${organizationId}`;

        return redirect(origin, landingPath, [
          cookieHeader(
            R23_SESSION_COOKIE,
            encryptSessionPayload(updatedSession, sessionKey),
            true,
          ),
          `hirearchy-last-org=${encodeURIComponent(organizationId)}; Path=/; Max-Age=2592000; SameSite=Lax`,
        ]);
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

const ACCOUNT_PATH = '/r23/account';
const accountNotices = {
  update_account_profile: 'Display name saved.',
  update_avatar: 'Profile photo saved.',
  remove_avatar: 'Profile photo removed.',
  email_requested:
    'Confirm the change from both email addresses. Your current email remains active until then.',
  email_same: 'That is already your sign-in email.',
  email_unavailable:
    'The confirmation could not be sent. Check the address or try again in a minute.',
  invalid_avatar: 'Choose a JPG, PNG or WebP under 2 MB.',
} as const;

export async function stagingAccountGet(request: Request): Promise<Response> {
  try {
    if (!isHiringPlatformEnabled()) throw new StagingBadRequest();
    const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);
    return await withStagingBrowserSession(
      request,
      digest(csrf),
      async ({
        session,
        config,
        identity,
        csrfToken,
        refreshedSessionCookie,
      }) => {
        const profile = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'account.profile.get',
          {},
        )) as AccountProfile;
        const email = profile.email || identity.email || '';
        const url = new URL(request.url);
        const notice = url.searchParams.get('notice');
        const message =
          notice && Object.hasOwn(accountNotices, notice)
            ? accountNotices[notice as keyof typeof accountNotices]
            : null;
        const needsAttention =
          notice === 'invalid_avatar' ||
          notice === 'email_unavailable' ||
          notice === 'email_same';
        const csrfField = `<input type="hidden" name="csrf" value="${safeHtml(csrfToken)}">`;
        const displayTitle = profile.displayName || email || 'Account';
        const avatar = profile.avatarWebp
          ? `<img width="72" height="72" alt="" src="data:image/webp;base64,${safeHtml(profile.avatarWebp)}">`
          : `<span aria-hidden="true">${safeHtml(displayTitle.slice(0, 1).toUpperCase())}</span>`;

        let workspace: SoftwareWorkspace | undefined;
        const organizationId = session.selectedOrganizationId;
        if (organizationId) {
          try {
            const org = await fetchOrganizationContext(
              config,
              identity,
              organizationId,
            );
            const role = org.isOwner ? 'cto' : org.role;
            const plan = (await dispatchVerifiedStagingOperation(
              config,
              identity,
              'hiring.plan.get',
              { organizationId },
            )) as OrganizationPlanSummary;
            workspace = {
              organizationId,
              role,
              email,
              csrf: csrfToken,
              active: 'account',
              currentPath: ACCOUNT_PATH,
              organizationName: resolveOrgDisplay(organizationId, {
                role,
                displayName: org.displayName,
              }).name,
              planTier: plan.planTier,
              planBadge: formatPlanBadge(plan),
              theme: readRequestTheme(request),
            };
          } catch (error) {
            if (errorDetails(error).status !== 403) throw error;
          }
        }

        const workspaceRolePill = workspace
          ? `<span class="hiring-pill hiring-pill-plum">${safeHtml(workspace.organizationName)} · ${safeHtml(resolveWorkspaceRoleLabel(workspace.role, true))}</span>`
          : '';
        const workspaceSignInRow = workspace
          ? `<div class="team-account-sign-in-row"><div><h3>Active workspace</h3><p>${safeHtml(workspace.organizationName)}</p></div><a class="hiring-btn" href="/r23/organizations">Switch workspace</a></div>`
          : '';

        const accountPhotoScript = `
(function () {
  var dropzone = document.getElementById('account-photo-dropzone');
  var input = document.getElementById('account-photo');
  var preview = document.getElementById('account-photo-preview');
  var fileNameEl = document.getElementById('account-photo-filename');
  if (!dropzone || !input) return;
  function updatePreview(file) {
    if (!file) return;
    if (fileNameEl) fileNameEl.textContent = file.name;
    dropzone.setAttribute('data-has-file', 'true');
    if (preview && typeof FileReader !== 'undefined' && file.type && file.type.indexOf('image/') === 0) {
      var reader = new FileReader();
      reader.onload = function (ev) {
        if (!ev.target || typeof ev.target.result !== 'string') return;
        preview.textContent = '';
        var img = document.createElement('img');
        img.width = 52;
        img.height = 52;
        img.alt = '';
        img.src = ev.target.result;
        preview.appendChild(img);
      };
      reader.readAsDataURL(file);
    }
  }
  input.addEventListener('change', function () {
    updatePreview(input.files && input.files[0]);
  });
  dropzone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropzone.setAttribute('data-dragover', 'true');
  });
  dropzone.addEventListener('dragleave', function () {
    dropzone.removeAttribute('data-dragover');
  });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.removeAttribute('data-dragover');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      try {
        input.files = e.dataTransfer.files;
      } catch (err) {}
      updatePreview(e.dataTransfer.files[0]);
    }
  });
})();
`;

        const content = `<div class="team-account-page">
        <header class="software-page-heading team-account-header">
          <div>
            <h1>My account</h1>
            <p class="team-page-subtitle">Manage your profile identity, avatar, and sign-in security.</p>
          </div>
        </header>
        ${message ? `<p class="hiring-banner ${needsAttention ? 'hiring-banner-warning' : 'hiring-banner-success'}" role="${needsAttention ? 'alert' : 'status'}">${message}</p>` : ''}
        <section class="team-account-hero" aria-label="Account summary">
          <div class="team-account-avatar">${avatar}</div>
          <div class="team-account-hero-meta">
            <strong>${safeHtml(displayTitle)}</strong>
            <span>${safeHtml(email)}</span>
            ${workspaceRolePill}
          </div>
        </section>
        <div class="team-account-grid">
          <section class="software-settings-section team-account-profile" aria-labelledby="team-account-profile-title">
            <header class="software-section-intro">
              <h2 id="team-account-profile-title">Profile</h2>
              <p>How your name and avatar appear across reviews, comments, and the problem library.</p>
            </header>
            <div class="team-account-photo-block">
              <form class="team-account-photo-form" action="${ACCOUNT_PATH}" method="post" enctype="multipart/form-data">
                ${csrfField}<input type="hidden" name="action" value="update_avatar">
                <div class="team-account-dropzone" id="account-photo-dropzone">
                  <div class="team-account-dropzone-preview" id="account-photo-preview" aria-hidden="true">${avatar}</div>
                  <div class="team-account-dropzone-body">
                    <label for="account-photo" class="team-account-dropzone-label">Profile photo</label>
                    <span id="account-photo-filename" class="team-account-dropzone-hint">Drop an image or choose a file</span>
                    <input id="account-photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp" required aria-describedby="photo-help">
                  </div>
                  <button type="submit" class="hiring-btn hiring-btn-primary">Save photo</button>
                </div>
              </form>
              <div class="team-account-photo-meta">
                <p class="software-field-help" id="photo-help">JPG, PNG or WebP, up to 2 MB.</p>
                ${profile.avatarWebp ? `<form class="team-account-remove-photo" action="${ACCOUNT_PATH}" method="post">${csrfField}<input type="hidden" name="action" value="remove_avatar"><button type="submit">Remove photo</button></form>` : ''}
              </div>
            </div>
            <form class="team-account-field-form" action="${ACCOUNT_PATH}" method="post">
              ${csrfField}<input type="hidden" name="action" value="update_account_profile">
              <div class="hiring-field"><label for="account-display-name">Display name</label><input id="account-display-name" name="displayName" value="${safeHtml(profile.displayName || '')}" maxlength="100" autocomplete="name" required></div>
              <button type="submit" class="hiring-btn hiring-btn-primary">Save name</button>
            </form>
          </section>
          <section class="software-settings-section team-account-security" aria-labelledby="team-account-security-title">
            <header class="software-section-intro">
              <h2 id="team-account-security-title">Sign-in details</h2>
              <p>Credentials and workspace session controls.</p>
            </header>
            <div class="team-account-rows">
              <div class="team-account-email-block">
                <div class="team-account-sign-in-row"><div><h3>Email address</h3><p>${safeHtml(email)}</p></div></div>
                <details class="hiring-disclosure team-account-email-change"${needsAttention && notice !== 'invalid_avatar' ? ' open' : ''}>
                  <summary>Change email</summary>
                  <p>Confirm the change at your current and new address.</p>
                  <form class="team-account-field-form" action="${ACCOUNT_PATH}" method="post">
                    ${csrfField}<input type="hidden" name="action" value="change_email">
                    <div class="hiring-field"><label for="account-new-email">New email address</label><input id="account-new-email" name="email" type="email" autocomplete="email" maxlength="254" required></div>
                    <button type="submit" class="hiring-btn hiring-btn-primary">Send confirmation</button>
                  </form>
                </details>
              </div>
              <div class="team-account-sign-in-row"><div><h3>Password</h3><p>Send a verification link to reset your password.</p></div><a class="hiring-btn" href="/r23/recover">Change password</a></div>
              ${workspaceSignInRow}
            </div>
          </section>
        </div>
      </div><script>${accountPhotoScript}</script>`;
        const headers = securityHeaders(
          scriptCspDirectives(accountPhotoScript, false),
        );
        headers.set(
          'Content-Security-Policy',
          `${headers.get('Content-Security-Policy')}; img-src data:`,
        );
        return attachRefreshedCookie(
          htmlResponse(
            'My account',
            content,
            200,
            headers,
            workspace,
            readRequestTheme(request),
            ACCOUNT_PATH,
          ),
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingAccountPost(request: Request): Promise<Response> {
  try {
    if (!isHiringPlatformEnabled()) throw new StagingBadRequest();
    const origin = requireSameOrigin(request);
    const multipart =
      request.headers
        .get('content-type')
        ?.startsWith('multipart/form-data;') === true;
    const body = await parseBody(
      request,
      false,
      multipart ? MAX_AVATAR_BYTES + 8192 : MAX_BODY_BYTES,
      multipart,
    );
    const csrf = requiredText(body, 'csrf', 100);
    const action = requiredText(body, 'action', 40);
    if (multipart !== (action === 'update_avatar'))
      throw new StagingBadRequest();

    return await withStagingBrowserSession(
      request,
      digest(csrf),
      async ({ session, config, identity, refreshedSessionCookie }) => {
        let notice: keyof typeof accountNotices;
        if (action === 'update_account_profile') {
          allowedFields(body, ['csrf', 'action', 'displayName']);
          const displayName = requiredText(body, 'displayName', 100).trim();
          if (!displayName) throw new StagingBadRequest();
          await dispatchVerifiedStagingOperation(
            config,
            identity,
            'account.profile.update',
            { displayName },
          );
          notice = action;
        } else if (action === 'update_avatar' || action === 'remove_avatar') {
          allowedFields(
            body,
            action === 'update_avatar'
              ? ['csrf', 'action', 'photo']
              : ['csrf', 'action'],
          );
          const avatarWebp =
            action === 'update_avatar'
              ? await encodeAccountAvatar(body.photo)
              : null;
          if (action === 'update_avatar' && avatarWebp === null) {
            notice = 'invalid_avatar';
          } else {
            await dispatchVerifiedStagingOperation(
              config,
              identity,
              'account.avatar.update',
              { avatarWebp },
            );
            notice = action;
          }
        } else if (action === 'change_email') {
          allowedFields(body, ['csrf', 'action', 'email']);
          const email = requiredText(body, 'email', 254).trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
            throw new StagingBadRequest();
          if (email === identity.email?.toLowerCase()) {
            notice = 'email_same';
          } else {
            const sent = await requestR23EmailChange(
              config.auth,
              session.accessToken,
              email,
              new URL(ACCOUNT_PATH, origin).toString(),
            );
            notice = sent ? 'email_requested' : 'email_unavailable';
          }
        } else {
          throw new StagingBadRequest();
        }
        return attachRefreshedCookie(
          redirect(origin, `${ACCOUNT_PATH}?notice=${notice}`),
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingOrganizationPlanGet(
  request: Request,
  targetOrganizationId: string,
  surface: 'plan' | 'upgrade',
): Promise<Response> {
  try {
    if (!isHiringPlatformEnabled() || !UUID.test(targetOrganizationId))
      throw new StagingBadRequest();
    const organizationId = targetOrganizationId.toLowerCase();
    const orgBase = `/r23/organizations/${organizationId}`;
    const csrf = requiredOpaqueCookie(request, R23_CSRF_COOKIE);

    return await withStagingBrowserSession(
      request,
      digest(csrf),
      async ({
        session,
        config,
        identity,
        csrfToken,
        refreshedSessionCookie,
      }) => {
        if (session.selectedOrganizationId !== organizationId)
          throw new StagingForbidden();
        const org = await fetchOrganizationContext(
          config,
          identity,
          organizationId,
        );
        const plan = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'hiring.plan.get',
          { organizationId },
        )) as OrganizationPlanSummary;
        const url = new URL(request.url);
        const isUltra = plan.planTier === 'ultra';
        const page = isUltra ? 'plan' : 'upgrade';
        const path = `${orgBase}/${page}`;
        if (surface !== page) {
          return attachRefreshedCookie(
            redirect(resolvePublicOrigin(request), `${path}${url.search}`),
            refreshedSessionCookie,
          );
        }

        const canManage = org.role === 'cto' || org.isOwner === true;
        const canChange = canManage && isFounderUatEnabled();
        const current = getPlanDefinition(plan.planTier);
        const currentRank = PAID_PLAN_ORDER.findIndex(
          (tier) => tier === plan.planTier,
        );
        const hasSlots = plan.planTier === 'per_candidate';
        const slotsPurchased = Math.max(0, plan.candidateCreditsPurchased ?? 0);
        const slotsRemaining = Math.max(0, plan.candidateCreditsRemaining ?? 0);
        const slotsUsed = Math.max(0, slotsPurchased - slotsRemaining);
        const slotMax = slotsPurchased > 0 ? slotsPurchased : 100;
        const slotProgressValue = hasSlots
          ? Math.min(slotMax, slotsRemaining)
          : plan.planTier === 'none'
            ? 0
            : 100;
        const capacity = hasSlots
          ? `${slotsRemaining} of ${slotsPurchased} candidate slots available`
          : plan.planTier === 'none'
            ? 'Activate a plan to issue assessments'
            : 'Unlimited candidate assessments';
        const capacityDetail = hasSlots
          ? `${slotsUsed} used · ${slotsRemaining} remaining`
          : plan.planTier === 'none'
            ? '0 active assessment slots'
            : 'Unlimited capacity included';
        const actionFor = (tier: (typeof PAID_PLAN_ORDER)[number]) =>
          currentRank < 0
            ? 'Choose'
            : PAID_PLAN_ORDER.indexOf(tier) < currentRank
              ? 'Downgrade to'
              : 'Upgrade to';
        const cards = PAID_PLAN_ORDER.map((tier) => {
          const definition = getPlanDefinition(tier);
          const isCurrent = tier === plan.planTier;
          const isDefaultRecommended = tier === 'pro' && !isCurrent;
          const statusChip = isCurrent
            ? '<span class="hiring-pill hiring-pill-plum">Current plan</span>'
            : isDefaultRecommended
              ? '<span class="hiring-pill hiring-pill-mint" data-roi-badge>Recommended</span>'
              : '<span class="hiring-pill hiring-pill-mint" data-roi-badge hidden>Recommended</span>';
          return `<article class="hiring-plan-card team-plan-card" data-tier="${tier}" data-current="${isCurrent}"${isDefaultRecommended ? ' data-recommended="true"' : ' data-recommended="false"'}>
          <div class="team-plan-card-title"><h2>${safeHtml(definition.name)}</h2>${statusChip}</div>
          <p class="team-plan-model">${safeHtml(definition.priceLabel)}</p>
          <ul>${definition.highlights.map((item) => `<li>${safeHtml(item)}</li>`).join('')}</ul>
          ${canChange && !isCurrent ? `<a class="hiring-btn ${tier === 'ultra' ? 'hiring-btn-primary' : ''}" href="${path}?target=${tier}#plan-review">${actionFor(tier)} ${safeHtml(definition.name)}</a>` : ''}
        </article>`;
        }).join('');
        const postAction = `${orgBase}/plan`;
        const csrfField = `<input type="hidden" name="csrf" value="${safeHtml(csrfToken)}">`;
        const target = url.searchParams.get('target');
        const slotQuery = url.searchParams.get('slots');
        const slots =
          slotQuery && /^\d{1,5}$/.test(slotQuery) ? Number(slotQuery) : 0;
        const validSlots = slots > 0 && slots <= 10000;
        let changeReview = '';
        if (
          canChange &&
          isPlanTier(target) &&
          target !== 'none' &&
          target !== plan.planTier
        ) {
          const nextPlan = getPlanDefinition(target);
          const nextCapacity =
            target === 'per_candidate'
              ? `${Math.max(0, plan.candidateCreditsPurchased - plan.candidateCreditsUsed)} candidate slots available with your saved slot balance.`
              : 'Unlimited candidate assessments.';
          changeReview = `<section id="plan-review" class="software-settings-section team-plan-review" aria-labelledby="plan-review-title">
          <h2 id="plan-review-title">${actionFor(target)} ${safeHtml(nextPlan.name)}</h2>
          <p>${safeHtml(current.name)} → ${safeHtml(nextPlan.name)}. ${safeHtml(nextCapacity)}${isUltra ? ' AI review summaries and hiring manager fit reports are available on Ultra.' : ''}</p>
          <form class="hiring-header-actions" action="${postAction}" method="post">
            ${csrfField}<input type="hidden" name="action" value="save_plan"><input type="hidden" name="planTier" value="${target}">
            <button type="submit" class="hiring-btn hiring-btn-primary">Confirm plan change</button><a class="hiring-btn" href="${path}">Cancel</a>
          </form>
        </section>`;
        }

        const slotReview =
          hasSlots && canChange && validSlots
            ? `<form class="team-plan-slot-review" action="${postAction}" method="post">${csrfField}
            <input type="hidden" name="action" value="update_slots"><input type="hidden" name="slotMode" value="add"><input type="hidden" name="slotAmount" value="${slots}">
            <p>Purchased slots will increase from <strong>${plan.candidateCreditsPurchased}</strong> to <strong>${plan.candidateCreditsPurchased + slots}</strong>.</p>
            <div class="hiring-header-actions"><button type="submit" class="hiring-btn hiring-btn-primary">Add ${slots} ${slots === 1 ? 'slot' : 'slots'}</button><a class="hiring-btn" href="${path}#add-ons">Cancel</a></div>
          </form>`
            : '';
        const slotForm =
          hasSlots && canChange && !slotReview
            ? `<form class="team-plan-slot-form hiring-header-actions" method="get" action="${path}#add-ons">
            <div class="hiring-field"><label for="candidate-slots">Slots to add</label><input id="candidate-slots" name="slots" type="number" min="1" max="10000" required></div>
            <button type="submit" class="hiring-btn hiring-btn-primary">Review add-on</button>
          </form>`
            : '';
        const notice = url.searchParams.get('notice');
        const noticeText =
          notice === 'update_slots'
            ? 'Candidate slots added.'
            : notice === 'save_plan' || notice === 'update_plan'
              ? 'Plan updated.'
              : '';
        const title = isUltra ? 'Plan & add-ons' : 'Upgrade';
        recordServerTelemetryEvent({
          eventName: 'monetization.upgrade_viewed',
          category: 'monetization',
          actorType: 'team_member',
          organizationId,
          principalId: org.principalId,
          planTier: plan.planTier,
          route: `/r23/organizations/:id/${page}`,
          properties: {
            surface: page,
            canChange,
          },
        });
        const planSubtitle = isUltra
          ? 'Review your active Ultra subscription, compare tiers, or adjust workspace plan settings.'
          : 'Protect senior engineering hours. Pay per distinct candidate or unlock unlimited evaluations and advisory AI synthesis.';
        const roiCalculatorScript = `
(function () {
  var root = document.getElementById('team-roi-calculator');
  if (!root) return;
  var pairs = [
    { num: document.getElementById('roi-hires'), range: document.getElementById('roi-hires-range'), min: 1, max: 200, def: 8 },
    { num: document.getElementById('roi-candidates'), range: document.getElementById('roi-candidates-range'), min: 1, max: 50, def: 6 },
    { num: document.getElementById('roi-hours'), range: document.getElementById('roi-hours-range'), min: 0.5, max: 8, def: 2.5 },
    { num: document.getElementById('roi-rate'), range: document.getElementById('roi-rate-range'), min: 40, max: 400, def: 110 }
  ];
  var totalOut = document.getElementById('roi-total-assessments');
  var hoursOut = document.getElementById('roi-hours-saved');
  var valueOut = document.getElementById('roi-value-saved');
  var onsiteOut = document.getElementById('roi-onsite-saved');
  var tierOut = document.getElementById('roi-recommended-tier');
  var tierNoteOut = document.getElementById('roi-recommended-note');
  var planCards = document.querySelectorAll('.hiring-plan-card[data-tier]');
  function clamp(num, min, max, fallback) {
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }
  function update() {
    var hires = clamp(Number(pairs[0].num && pairs[0].num.value), 1, 200, 8);
    var cands = clamp(Number(pairs[1].num && pairs[1].num.value), 1, 50, 6);
    var hrs = clamp(Number(pairs[2].num && pairs[2].num.value), 0.5, 8, 2.5);
    var rate = clamp(Number(pairs[3].num && pairs[3].num.value), 40, 400, 110);
    var total = Math.round(hires * cands);
    var savedHrs = Math.round(total * hrs);
    var savedValue = Math.round(savedHrs * rate);
    var onsiteHrs = Math.round(total * 0.4 * 3);
    if (totalOut) totalOut.textContent = String(total);
    if (hoursOut) hoursOut.textContent = savedHrs.toLocaleString('en-US') + ' hrs/yr';
    if (valueOut) valueOut.textContent = '$' + savedValue.toLocaleString('en-US') + '/yr';
    if (onsiteOut) onsiteOut.textContent = onsiteHrs.toLocaleString('en-US') + ' hrs/yr';
    var recTier = total <= 15 ? 'per_candidate' : total <= 60 ? 'pro' : 'ultra';
    if (tierOut && tierNoteOut) {
      if (recTier === 'per_candidate') {
        tierOut.textContent = 'Per Candidate';
        tierNoteOut.textContent = 'Best fit for focused hiring (<= 15 distinct candidates/yr) — re-assessments reuse the same candidate slot.';
      } else if (recTier === 'pro') {
        tierOut.textContent = 'Pro';
        tierNoteOut.textContent = 'Best fit for continuous hiring (16–60 candidates/yr) — unlimited assessments with zero per-invite surprises.';
      } else {
        tierOut.textContent = 'Ultra';
        tierNoteOut.textContent = 'Best fit for high-velocity engineering teams (> 60 candidates/yr) — adds advisory AI reviews with timeline deltas and fit reports.';
      }
    }
    planCards.forEach(function (card) {
      var isRec = card.getAttribute('data-tier') === recTier && card.getAttribute('data-current') !== 'true';
      card.setAttribute('data-recommended', isRec ? 'true' : 'false');
      var badge = card.querySelector('[data-roi-badge]');
      if (badge) badge.hidden = !isRec;
    });
  }
  pairs.forEach(function (p) {
    if (p.num) {
      p.num.addEventListener('input', function () {
        if (p.range) p.range.value = String(clamp(Number(p.num.value), p.min, p.max, p.def));
        update();
      });
    }
    if (p.range) {
      p.range.addEventListener('input', function () {
        if (p.num) p.num.value = p.range.value;
        update();
      });
    }
  });
  update();
})();
`;
        const content = `<div class="team-plan-page">
        <header class="software-page-heading">
          <div>
            <h1>${safeHtml(title)}</h1>
            <p class="team-page-subtitle">${safeHtml(planSubtitle)}</p>
          </div>
        </header>
        ${noticeText ? `<p class="hiring-banner hiring-banner-success" role="status">${noticeText}</p>` : ''}
        <div class="team-plan-above-fold">
          <section class="team-plan-current" aria-labelledby="current-plan-title">
            <div>
              <p class="team-plan-kicker">Current plan</p>
              <h2 id="current-plan-title">${safeHtml(current.name)}</h2>
            </div>
            <div class="team-plan-meter">
              <div class="team-plan-capacity">${safeHtml(capacity)}</div>
              <progress class="team-plan-progress" value="${slotProgressValue}" max="${slotMax}" aria-label="Candidate slot capacity"></progress>
              <p class="team-plan-capacity-detail">${safeHtml(capacityDetail)}</p>
            </div>
            <p class="team-plan-trust-line">Human evaluators remain in full control of every hiring decision.</p>
          </section>
          <section class="team-compare-plans" aria-labelledby="compare-plans-title">
            <h2 id="compare-plans-title">Compare plans</h2>
            <div class="hiring-plan-grid">${cards}</div>
            <p class="team-plan-trust-line">No automated candidate scoring. Every tier keeps human evaluators in full control of hiring verdicts.</p>
            <p class="team-plan-help">${canChange ? 'Demo changes update this workspace without charging a payment method.' : canManage ? 'Plan changes and slot purchases are managed with Hirearchy.' : 'A workspace owner or CTO can change this plan.'}</p>
          </section>
        </div>
        ${changeReview}
        <section id="team-roi-calculator" class="software-settings-section team-roi-calculator" aria-labelledby="roi-calculator-title">
          <div class="team-roi-head">
            <div>
              <p class="team-plan-kicker">Value &amp; engineering time</p>
              <h2 id="roi-calculator-title">ROI &amp; Engineering Hours Saved Calculator</h2>
              <p class="hiring-muted-copy">Estimate senior engineering hours reclaimed from live screening and unstructured code debriefs.</p>
            </div>
            <div class="team-roi-recommendation">
              <span class="hiring-pill hiring-pill-mint">Recommended: <strong id="roi-recommended-tier">Pro</strong></span>
            </div>
          </div>
          <div class="team-roi-inputs">
            <div class="hiring-field team-roi-field">
              <div class="team-roi-field-head"><label for="roi-hires">Target hires / year</label><input id="roi-hires" class="team-roi-number" type="number" min="1" max="200" value="8"></div>
              <input id="roi-hires-range" class="team-roi-slider" type="range" min="1" max="200" value="8" aria-label="Target hires per year">
            </div>
            <div class="hiring-field team-roi-field">
              <div class="team-roi-field-head"><label for="roi-candidates">Candidates / hire</label><input id="roi-candidates" class="team-roi-number" type="number" min="1" max="50" value="6"></div>
              <input id="roi-candidates-range" class="team-roi-slider" type="range" min="1" max="50" value="6" aria-label="Candidates per hire">
            </div>
            <div class="hiring-field team-roi-field">
              <div class="team-roi-field-head"><label for="roi-hours">Hours saved / candidate</label><input id="roi-hours" class="team-roi-number" type="number" min="0.5" max="8" step="0.5" value="2.5"></div>
              <input id="roi-hours-range" class="team-roi-slider" type="range" min="0.5" max="8" step="0.5" value="2.5" aria-label="Hours saved per candidate">
            </div>
            <div class="hiring-field team-roi-field">
              <div class="team-roi-field-head"><label for="roi-rate">Senior eng hourly cost ($)</label><input id="roi-rate" class="team-roi-number" type="number" min="40" max="400" step="5" value="110"></div>
              <input id="roi-rate-range" class="team-roi-slider" type="range" min="40" max="400" step="5" value="110" aria-label="Senior engineering hourly cost">
            </div>
          </div>
          <div class="team-roi-outputs">
            <div class="team-roi-stat"><span>Assessments / yr</span><strong id="roi-total-assessments">48</strong></div>
            <div class="team-roi-stat"><span>Engineering hours reclaimed</span><strong id="roi-hours-saved">120 hrs/yr</strong></div>
            <div class="team-roi-stat"><span>Reclaimed capacity value</span><strong id="roi-value-saved">$13,200/yr</strong></div>
            <div class="team-roi-stat"><span>Onsite loop hours avoided (est.)</span><strong id="roi-onsite-saved">58 hrs/yr</strong></div>
          </div>
          <p id="roi-recommended-note" class="hiring-muted-copy">Best fit for continuous hiring (16–60 candidates/yr) — unlimited assessments with zero per-invite surprises.</p>
          <p class="team-roi-formula">Formula: (Hires × Candidates) × Hours saved × Hourly cost; onsite avoidance assumes 40% early filter efficiency × 3 panel hrs.</p>
        </section>
        <section id="add-ons" class="software-settings-section team-plan-add-ons" aria-labelledby="add-ons-title">
          <h2 id="add-ons-title">Add-ons</h2>
          <h3>Candidate slots</h3>
          <p>${hasSlots ? 'One slot per distinct candidate. Additional assessments for the same email reuse their slot.' : 'Available with Per Candidate. Pro and Ultra include unlimited candidate assessments.'}</p>
          ${slotQuery && !validSlots && canChange && hasSlots ? '<p role="alert">Enter between 1 and 10,000 candidate slots.</p>' : ''}
          ${slotForm}${slotReview}
        </section>
      </div><script>${roiCalculatorScript}</script>`;
        const role = org.isOwner ? 'cto' : org.role;
        const organizationName = resolveOrgDisplay(organizationId, {
          role,
          displayName: org.displayName,
        }).name;
        return attachRefreshedCookie(
          htmlResponse(
            title,
            content,
            200,
            securityHeaders(scriptCspDirectives(roiCalculatorScript, false)),
            {
              organizationId,
              organizationName,
              role,
              email: identity.email ?? '',
              csrf: csrfToken,
              active: 'plan',
              planTier: plan.planTier,
              planBadge: formatPlanBadge(plan),
              theme: readRequestTheme(request),
              currentPath: path,
            },
          ),
          refreshedSessionCookie,
        );
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

      const hiring = isHiringPlatformEnabled();
      const isOrgAdmin =
        orgContext.isOwner === true ||
        orgContext.role === 'cto' ||
        (!hiring && orgContext.role === 'recruiter');
      if (hiring && !isOrgAdmin) {
        return attachRefreshedCookie(
          redirect(resolvePublicOrigin(request), '/r23/account'),
          refreshedSessionCookie,
        );
      }

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

      const membership: R23Membership & { displayName: string | null } = {
        organizationId: orgIdLower,
        role: orgContext.role,
        membershipVersion: '1',
        displayName: orgContext.displayName,
      };
      const orgDisplay = resolveOrgDisplay(orgIdLower, membership);

      const safeOrgId = safeHtml(orgIdLower);
      const safeOrgName = safeHtml(orgDisplay.name);
      const safeCsrf = safeHtml(csrfToken);
      const safeEmail = safeHtml(profile.email || identity.email || '');
      const safeDisplayName = safeHtml(profile.displayName || '');

      const planSummary = hiring
        ? ((await dispatchVerifiedStagingOperation(
            config,
            identity,
            'hiring.plan.get',
            { organizationId: orgIdLower },
          )) as OrganizationPlanSummary)
        : null;

      const membersRows = members
        .map((m) => {
          const displayLabel = m.displayName || 'No display name';
          const memberInitial = (m.displayName || m.email || '?')
            .trim()
            .slice(0, 1)
            .toUpperCase();
          const ownerLabel =
            !hiring && m.isOwner
              ? '<span class="software-owner-badge">Owner</span>'
              : '';
          const roleKey = hiring && m.isOwner ? 'owner' : m.role;
          const roleDisplay =
            hiring && m.isOwner
              ? 'Owner'
              : m.role === 'cto'
                ? 'CTO'
                : m.role === 'reviewer'
                  ? 'Evaluator'
                  : m.role === 'recruiter'
                    ? 'Recruiter'
                    : m.role;
          const statusClass =
            m.status === 'active'
              ? 'hiring-pill hiring-pill-success'
              : 'software-state-badge';
          const removeButton =
            !m.isOwner && (isOrgAdmin || m.principalId === profile.principalId)
              ? `<form action="/r23/organizations/${safeOrgId}/settings" method="post">
                  <input type="hidden" name="csrf" value="${safeCsrf}">
                  <input type="hidden" name="action" value="remove_member">
                  <input type="hidden" name="principalId" value="${safeHtml(m.principalId)}">
                  <button type="submit" class="hiring-btn hiring-btn-sm team-danger-btn" aria-label="Remove member ${safeHtml(m.email || m.principalId)}">Remove member</button>
                </form>`
              : m.isOwner && !hiring
                ? '<span class="software-field-help">Workspace owner</span>'
                : '';

          return `
            <tr>
              <td>${hiring ? `<div class="team-member-cell"><span class="team-member-avatar" aria-hidden="true">${safeHtml(memberInitial)}</span><span>${safeHtml(displayLabel)}</span></div>` : safeHtml(displayLabel)}</td>
              <td>${safeHtml(m.email || 'Email unavailable')}</td>
              <td><span class="${hiring && m.isOwner ? 'software-owner-badge' : 'software-role-badge'}" data-role="${safeHtml(roleKey)}">${safeHtml(roleDisplay)}</span></td>
              <td><span class="${hiring ? statusClass : ''}">${safeHtml(m.status.charAt(0).toUpperCase() + m.status.slice(1))}</span> ${ownerLabel}</td>
              <td><time datetime="${safeHtml(m.joinedAt)}" title="${safeHtml(m.joinedAt)}">${safeHtml(new Date(m.joinedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }))}</time></td>
              <td>${removeButton}</td>
            </tr>
          `;
        })
        .join('');

      const candidateEncryptionKey = loadCandidateTokenEncryptionKey();
      const pendingInviteCount = invitations.filter(
        (inv) => inv.status === 'active',
      ).length;
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
              const acceptUrl = new URL(
                `/r23/invitations/accept?token=${encodeURIComponent(rawToken)}`,
                resolvePublicOrigin(request),
              ).toString();
              const safeUrl = safeHtml(acceptUrl);
              const inviteInputId = `invite-link-${safeHtml(inv.id)}`;
              linkHtml = `<div class="software-invitation-share">
                <label class="software-invitation-share-label" for="${inviteInputId}">Invitation link</label>
                <div class="software-invitation-share-row">
                  <input id="${inviteInputId}" type="text" readonly value="${safeUrl}" aria-label="Invitation link for ${safeHtml(inv.targetEmail)}">
                  <button type="button" class="ct-copy-btn ct-copy-btn--sm ct-copy-btn--secondary software-invite-copy-btn" data-copy-invite="${safeUrl}" data-copied="false" aria-label="Copy invite link for ${safeHtml(inv.targetEmail)}">
                    <span class="ct-copy-icon-stack" aria-hidden="true">
                      <svg class="ct-copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7m0 2.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z"></path><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"></path></svg>
                      <svg class="ct-check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5l10 -10"></path></svg>
                    </span>
                    <span class="software-invite-copy-label">Copy invite link</span>
                    <span class="ct-sr-only" aria-live="polite"></span>
                  </button>
                </div>
                <span>Copy this full link and share it with your teammate.</span>
              </div>`;
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
                  <button type="submit" class="hiring-btn hiring-btn-sm team-danger-btn" aria-label="Revoke invitation for ${safeHtml(inv.targetEmail)}">Revoke invitation</button>
                </form>`
              : '';

          const inviteRoleText =
            inv.role === 'cto'
              ? 'CTO / Owner invitation'
              : inv.role === 'recruiter'
                ? 'Recruiter invitation'
                : 'Evaluator invitation';

          const statusBadgeClass =
            inv.status === 'active'
              ? 'hiring-pill hiring-pill-warning'
              : inv.status === 'accepted'
                ? 'hiring-pill hiring-pill-success'
                : 'software-role-badge';

          return `
            <li class="software-invitation-row" data-status="${safeHtml(inv.status)}">
              <div class="software-invitation-heading">
                <div><strong>${safeHtml(inv.targetEmail)}</strong><span>${inviteRoleText}</span></div>
                <span class="${hiring ? statusBadgeClass : 'software-role-badge'}">${inv.status === 'active' ? 'Pending' : safeHtml(inv.status)}</span>
              </div>
              <p class="software-invitation-meta">Expires <time datetime="${safeHtml(inv.expiresAt)}">${safeHtml(formatUtcDateTime(inv.expiresAt))}</time>${inv.acceptedAt ? ` · Accepted <time datetime="${safeHtml(inv.acceptedAt)}">${safeHtml(new Date(inv.acceptedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }))}</time>` : ''}</p>
              ${linkHtml}
              ${revokeButton}
            </li>
          `;
        })
        .join('');

      const noticeParam = new URL(request.url).searchParams.get('notice');

      const inviteRoleFieldHtml = hiring
        ? `<div><label for="inviteRole">Workspace role</label><select id="inviteRole" name="role"><option value="reviewer" selected>Evaluator</option><option value="recruiter">Recruiter</option><option value="cto">CTO (Workspace admin)</option></select></div>`
        : '';

      const noticeBannerHtml =
        noticeParam === 'update_plan'
          ? '<div class="hiring-banner hiring-banner-success" role="status"><span>Plan and candidate slots updated.</span></div>'
          : noticeParam === 'update_account_profile'
            ? '<div class="hiring-banner hiring-banner-success" role="status"><span>Profile display name updated.</span></div>'
            : noticeParam === 'update_organization_profile'
              ? '<div class="hiring-banner hiring-banner-success" role="status"><span>Workspace name updated.</span></div>'
              : noticeParam === 'create_invitation'
                ? '<div class="hiring-banner hiring-banner-success" role="status"><span>Team invitation created — copy the link in the invitations list below.</span></div>'
                : noticeParam === 'revoke_invitation'
                  ? '<div class="hiring-banner hiring-banner-success" role="status"><span>Invitation revoked.</span></div>'
                  : noticeParam === 'remove_member'
                    ? '<div class="hiring-banner hiring-banner-success" role="status"><span>Member removed from workspace.</span></div>'
                    : '';

      const legacyProfileHtml = `
          <section class="software-settings-section" aria-labelledby="account-profile-heading">
            <header class="software-section-intro"><h2 id="account-profile-heading">Your profile</h2><p>How your name appears to your team.</p></header>
            <p class="software-account-email">${safeEmail}</p>
            <form action="/r23/organizations/${safeOrgId}/settings" method="post">
              <input type="hidden" name="csrf" value="${safeCsrf}">
              <input type="hidden" name="action" value="update_account_profile">
              <label for="accountDisplayName">Display name</label>
              <input id="accountDisplayName" name="displayName" type="text" maxlength="100" value="${safeDisplayName}" placeholder="Your full name">
              <button type="submit">Update profile</button>
            </form>
          </section>

      `;
      const organizationDetailsHtml = `
          <section id="organization-details" class="software-settings-section${hiring ? ' team-org-identity-card' : ''}" aria-labelledby="org-profile-heading">
            <header class="software-section-intro"><h2 id="org-profile-heading">Workspace details</h2><p>The name everyone on your team sees.</p></header>
            ${
              isOrgAdmin
                ? `
              <form class="${hiring ? 'team-org-inline-form' : ''}" action="/r23/organizations/${safeOrgId}/settings" method="post">
                <input type="hidden" name="csrf" value="${safeCsrf}">
                <input type="hidden" name="action" value="update_organization_profile">
                <div class="${hiring ? 'hiring-field' : ''}"><label for="orgDisplayName">Organization display name</label><input id="orgDisplayName" name="organizationDisplayName" type="text" required maxlength="100" value="${safeOrgName}"></div>
                <button type="submit"${hiring ? ' class="hiring-btn hiring-btn-primary"' : ''}>Update organization name</button>
              </form>`
                : `<p>${safeOrgName}</p>`
            }
            <details class="${hiring ? 'hiring-disclosure team-org-ref-details' : 'software-reference-details'}"><summary>${hiring ? 'Workspace ID' : 'Workspace reference'}</summary><code>${safeOrgId}</code></details>
          </section>
      `;

      const hiringPlanCardHtml =
        hiring && planSummary
          ? (() => {
              const planDef = getPlanDefinition(planSummary.planTier);
              const isUltraPlan = planSummary.planTier === 'ultra';
              const capacityText =
                planSummary.planTier === 'per_candidate'
                  ? `${planSummary.candidateCreditsRemaining ?? 0} of ${planSummary.candidateCreditsPurchased} candidate slots available`
                  : planSummary.planTier === 'none'
                    ? 'Activate a plan to issue assessments'
                    : 'Unlimited candidate assessments';
              const upgradeHook =
                planSummary.planTier === 'pro'
                  ? 'Upgrade to Ultra to unlock AI review summaries and hiring manager fit reports.'
                  : planSummary.planTier === 'per_candidate'
                    ? 'Add candidate slots or upgrade to Pro/Ultra for unlimited assessments.'
                    : planSummary.planTier === 'none'
                      ? 'Choose a plan to start inviting candidates.'
                      : 'All Ultra AI evaluation and team workflows are active.';
              const actionHtml = isUltraPlan
                ? `<a class="hiring-btn" href="/r23/organizations/${safeOrgId}/plan">Manage plan &amp; add-ons</a>`
                : `<a class="hiring-btn hiring-btn-primary" href="/r23/organizations/${safeOrgId}/upgrade">${planSummary.planTier === 'pro' ? 'Upgrade to Ultra' : 'Upgrade plan'}</a>`;
              return `<section class="software-settings-section team-org-plan-card" data-tier="${safeHtml(planSummary.planTier)}" aria-labelledby="org-plan-heading">
                <div class="team-org-plan-head">
                  <span class="software-eyebrow">Subscription &amp; capacity</span>
                  <span class="hiring-pill hiring-pill-plum">${safeHtml(formatPlanBadge(planSummary))}</span>
                </div>
                <h2 id="org-plan-heading">${safeHtml(planDef.name)}</h2>
                <p class="team-org-plan-capacity">${safeHtml(capacityText)}</p>
                <p class="team-org-plan-hook">${safeHtml(upgradeHook)}</p>
                <div class="team-org-plan-actions">${actionHtml}</div>
              </section>`;
            })()
          : '';

      const webhooksScript =
        hiring && isOrgAdmin
          ? `
(function () {
  var root = document.getElementById('webhooks');
  if (!root) return;
  var orgId = root.getAttribute('data-org-id') || '';
  var apiUrl = '/r23/api/organizations/' + encodeURIComponent(orgId) + '/hiring/webhooks';
  var form = document.getElementById('org-webhook-create-form');
  var listEl = document.getElementById('org-webhook-list');
  var delivEl = document.getElementById('org-webhook-deliveries');
  var statusEl = document.getElementById('org-webhook-status');
  var secretBanner = document.getElementById('org-webhook-secret-banner');
  var secretValue = document.getElementById('org-webhook-secret-value');
  var secretDismiss = document.getElementById('org-webhook-secret-dismiss');

  function readCsrf() {
    var m = document.cookie.match(/(?:^|;\\s*)__Host-r23-csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function showStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.hidden = false;
    statusEl.className = 'hiring-banner ' + (isError ? 'hiring-banner-danger' : 'hiring-banner-success');
    statusEl.setAttribute('role', isError ? 'alert' : 'status');
    statusEl.textContent = msg;
  }

  function renderWebhooks(webhooks) {
    if (!listEl) return;
    listEl.textContent = '';
    if (!webhooks || webhooks.length === 0) {
      var p = document.createElement('p');
      p.className = 'hiring-muted-copy';
      p.textContent = 'No webhooks configured yet. Add a Slack incoming webhook or JSON endpoint above.';
      listEl.appendChild(p);
      return;
    }
    webhooks.forEach(function (hook) {
      var card = document.createElement('article');
      card.className = 'hiring-card-subtle org-webhook-card';
      var head = document.createElement('div');
      head.className = 'org-webhook-card-head';

      var info = document.createElement('div');
      var titleRow = document.createElement('div');
      titleRow.className = 'hiring-candidate-name';
      var strong = document.createElement('strong');
      strong.textContent = hook.label;
      titleRow.appendChild(strong);
      var statePill = document.createElement('span');
      statePill.className = 'hiring-pill ' + (hook.isActive ? 'hiring-pill-success' : 'hiring-pill-warning');
      statePill.textContent = hook.isActive ? 'Active' : 'Paused';
      titleRow.appendChild(statePill);
      var modePill = document.createElement('span');
      modePill.className = 'hiring-pill hiring-pill-plum';
      modePill.textContent = hook.payloadMode === 'slack_block_kit' ? 'Slack Block Kit' : 'JSON HMAC';
      titleRow.appendChild(modePill);
      info.appendChild(titleRow);

      var urlP = document.createElement('p');
      urlP.className = 'hiring-muted-copy org-webhook-url';
      urlP.textContent = hook.targetUrl + ' · Secret ' + (hook.signingSecretPrefix || '');
      info.appendChild(urlP);

      var evP = document.createElement('p');
      evP.className = 'hiring-muted-copy';
      evP.textContent = 'Events: ' + (hook.eventTypes || []).join(', ') + (hook.disabledReason ? ' · Disabled: ' + hook.disabledReason : '');
      info.appendChild(evP);

      var actions = document.createElement('div');
      actions.className = 'hiring-header-actions';
      function mkBtn(label, extraClass, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'hiring-btn hiring-btn-sm' + (extraClass ? ' ' + extraClass : '');
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
      }
      actions.appendChild(mkBtn('Test ping', '', function () {
        postAction({ action: 'ping', webhookId: hook.id });
      }));
      actions.appendChild(mkBtn(hook.isActive ? 'Pause' : 'Resume', '', function () {
        postAction({ action: 'update', webhookId: hook.id, isActive: !hook.isActive });
      }));
      actions.appendChild(mkBtn('Rotate secret', '', function () {
        postAction({ action: 'rotate', webhookId: hook.id });
      }));
      actions.appendChild(mkBtn('Delete', 'team-danger-btn', function () {
        postAction({ action: 'delete', webhookId: hook.id });
      }));

      head.appendChild(info);
      head.appendChild(actions);
      card.appendChild(head);
      listEl.appendChild(card);
    });
  }

  function renderDeliveries(deliveries) {
    if (!delivEl) return;
    delivEl.textContent = '';
    if (!deliveries || deliveries.length === 0) return;
    var heading = document.createElement('h3');
    heading.textContent = 'Recent deliveries';
    delivEl.appendChild(heading);
    var wrap = document.createElement('div');
    wrap.className = 'software-overflow-region';
    wrap.setAttribute('tabindex', '0');
    var table = document.createElement('table');
    table.className = 'software-members-table org-deliveries-table';
    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    ['Event', 'Status', 'HTTP', 'Latency', 'Error'].forEach(function (col) {
      var th = document.createElement('th');
      th.textContent = col;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    deliveries.slice(0, 15).forEach(function (d) {
      var tr = document.createElement('tr');
      var vals = [
        d.eventType,
        d.status,
        d.httpStatus != null ? String(d.httpStatus) : '—',
        d.latencyMs != null ? d.latencyMs + 'ms' : '—',
        d.errorSummary || '—'
      ];
      vals.forEach(function (v, idx) {
        var td = document.createElement('td');
        if (idx === 1) {
          var pill = document.createElement('span');
          pill.className = 'hiring-pill ' + (v === 'delivered' ? 'hiring-pill-success' : (v === 'failed' || v === 'blocked_ssrf') ? 'hiring-pill-danger' : 'hiring-pill-warning');
          pill.textContent = v;
          td.appendChild(pill);
        } else {
          td.textContent = v;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    delivEl.appendChild(wrap);
  }

  function loadAll() {
    fetch(apiUrl, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.d && res.d.error && res.d.error.message) || 'Unable to load webhooks.');
        renderWebhooks(res.d.webhooks || []);
        renderDeliveries(res.d.deliveries || []);
      })
      .catch(function (err) {
        showStatus(err && err.message ? err.message : 'Unable to load webhooks.', true);
      });
  }

  function postAction(payload) {
    var csrf = readCsrf();
    fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-csrf-token': csrf
      },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.d && res.d.error && res.d.error.message) || 'Webhook operation failed.');
        if (res.d && res.d.signingSecret && secretBanner && secretValue) {
          secretValue.textContent = res.d.signingSecret;
          secretBanner.hidden = false;
        }
        if (payload.action === 'ping' && res.d && res.d.delivery) {
          var dlv = res.d.delivery;
          showStatus('Test ping ' + dlv.status + (dlv.httpStatus ? ' (HTTP ' + dlv.httpStatus + ')' : '') + '.', dlv.status !== 'delivered');
        } else if (payload.action === 'create') {
          if (form) form.reset();
          showStatus('Webhook endpoint created.', false);
        } else if (payload.action === 'rotate') {
          showStatus('Signing secret rotated.', false);
        } else if (payload.action === 'delete') {
          showStatus('Webhook removed.', false);
        } else {
          showStatus('Webhook updated.', false);
        }
        loadAll();
      })
      .catch(function (err) {
        showStatus(err && err.message ? err.message : 'Webhook operation failed.', true);
      });
  }

  if (secretDismiss && secretBanner) {
    secretDismiss.addEventListener('click', function () {
      secretBanner.hidden = true;
    });
  }
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var labelInput = document.getElementById('org-webhook-label');
      var urlInput = document.getElementById('org-webhook-url');
      var modeInput = document.getElementById('org-webhook-mode');
      var checks = form.querySelectorAll('input[name="webhookEvent"]:checked');
      var events = [];
      checks.forEach(function (c) { events.push(c.value); });
      postAction({
        action: 'create',
        label: labelInput ? labelInput.value.trim() : '',
        targetUrl: urlInput ? urlInput.value.trim() : '',
        payloadMode: modeInput ? modeInput.value : 'json',
        eventTypes: events
      });
    });
  }
  loadAll();
})();
`
          : '';

      const webhooksSectionHtml =
        hiring && isOrgAdmin
          ? `<section id="webhooks" data-org-id="${safeOrgId}" class="software-settings-section org-webhooks-panel" aria-labelledby="org-webhooks-heading">
            <header class="software-section-intro">
              <h2 id="org-webhooks-heading">Integrations: Webhooks &amp; Slack</h2>
              <p>Send HMAC-SHA256 JSON events or Slack Block Kit alerts when candidates start, submit, or receive a verdict.</p>
            </header>
            <div id="org-webhook-secret-banner" class="hiring-banner hiring-banner-success org-webhook-secret-banner" role="status" hidden>
              <div>
                <strong>Save your signing secret now (shown once)</strong>
                <div><code id="org-webhook-secret-value" class="org-webhook-secret-value"></code></div>
              </div>
              <button type="button" id="org-webhook-secret-dismiss" class="hiring-btn hiring-btn-sm">Dismiss</button>
            </div>
            <div id="org-webhook-status" hidden></div>
            <form id="org-webhook-create-form" class="org-webhook-create-form">
              <div class="hiring-two-col">
                <div class="hiring-field"><label for="org-webhook-label">Endpoint label</label><input id="org-webhook-label" type="text" required maxlength="80" placeholder="#hiring-alerts Slack"></div>
                <div class="hiring-field"><label for="org-webhook-url">HTTPS endpoint URL</label><input id="org-webhook-url" type="url" required maxlength="500" placeholder="https://hooks.slack.com/services/..."></div>
              </div>
              <div class="hiring-two-col">
                <div class="hiring-field"><label for="org-webhook-mode">Payload format</label><select id="org-webhook-mode"><option value="json">Standard JSON (HMAC-SHA256)</option><option value="slack_block_kit">Slack Incoming Webhook (Block Kit)</option></select></div>
                <fieldset class="hiring-field org-webhook-events-fieldset"><legend>Subscribed events</legend><div class="org-webhook-event-checks">
                  <label class="org-webhook-checkbox"><input type="checkbox" name="webhookEvent" value="candidate.started" checked><span>candidate.started</span></label>
                  <label class="org-webhook-checkbox"><input type="checkbox" name="webhookEvent" value="candidate.submitted" checked><span>candidate.submitted</span></label>
                  <label class="org-webhook-checkbox"><input type="checkbox" name="webhookEvent" value="verdict.published" checked><span>verdict.published</span></label>
                  <label class="org-webhook-checkbox"><input type="checkbox" name="webhookEvent" value="handoff.updated" checked><span>handoff.updated</span></label>
                </div></fieldset>
              </div>
              <div><button type="submit" class="hiring-btn hiring-btn-primary">Add webhook endpoint</button></div>
            </form>
            <div id="org-webhook-list" class="org-webhook-list"><p class="hiring-muted-copy">Loading webhooks…</p></div>
            <div id="org-webhook-deliveries" class="org-deliveries-section"></div>
          </section>`
          : '';

      const inviteCopyScript = `
(function () {
  var buttons = document.querySelectorAll('[data-copy-invite]');
  if (!buttons.length) return;
  buttons.forEach(function (btn) {
    var timer = null;
    btn.addEventListener('click', function () {
      var val = btn.getAttribute('data-copy-invite') || '';
      var labelEl = btn.querySelector('.software-invite-copy-label');
      var liveEl = btn.querySelector('[aria-live="polite"]');
      function markCopied() {
        btn.setAttribute('data-copied', 'true');
        if (labelEl) labelEl.textContent = 'Copied';
        if (liveEl) liveEl.textContent = 'Invite link copied';
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          btn.setAttribute('data-copied', 'false');
          if (labelEl) labelEl.textContent = 'Copy invite link';
          if (liveEl) liveEl.textContent = '';
          timer = null;
        }, 2000);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(val).then(markCopied).catch(function () {
          if (liveEl) liveEl.textContent = 'Copy the link from the input field.';
        });
      } else {
        var row = btn.closest('.software-invitation-share-row');
        var input = row ? row.querySelector('input') : null;
        if (input) {
          input.focus();
          input.select();
          try {
            if (document.execCommand('copy')) markCopied();
          } catch (e) {}
        }
      }
    });
  });
})();
`;
      const combinedSettingsScript = `${webhooksScript}${inviteCopyScript}`;

      const content = hiring
        ? `<div class="team-org-page">
          <header class="software-page-heading team-org-header">
            <div>
              <h1>Organization</h1>
              <p class="team-page-subtitle">Manage workspace identity, team access, and plan capacity.</p>
            </div>
          </header>
          ${noticeBannerHtml}
          <nav class="software-settings-anchor-nav" aria-label="Organization settings sections">
            <a href="#organization-overview" class="software-anchor-pill">Overview</a>
            <a href="#team" class="software-anchor-pill">Team <span class="software-anchor-count">${members.length}</span></a>
            <a href="#team-invitations" class="software-anchor-pill">Invitations${pendingInviteCount > 0 ? ` <span class="software-anchor-count">${pendingInviteCount}</span>` : ''}</a>
            ${isOrgAdmin ? '<a href="#webhooks" class="software-anchor-pill">Webhooks &amp; Slack</a>' : ''}
          </nav>
          <div id="organization-overview" class="team-org-overview">${organizationDetailsHtml}${hiringPlanCardHtml}</div>
          <section id="team" class="software-settings-section software-team-section" aria-labelledby="team-members-heading">
            <header class="software-section-intro team-section-header-row">
              <div>
                <h2 id="team-members-heading">Your team</h2>
                <p>People with access to this workspace and its assigned reviews.</p>
              </div>
              <span class="hiring-pill">${members.length} ${members.length === 1 ? 'member' : 'members'}</span>
            </header>
            <p id="software-team-scroll-hint" class="software-table-hint">On smaller screens, scroll the table sideways to see all member details.</p><div tabindex="0" role="region" aria-label="Organization members" aria-describedby="software-team-scroll-hint" class="software-overflow-region">
              <table class="software-members-table">
                <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
                <tbody>${membersRows}</tbody>
              </table>
            </div>
          </section>
          <section id="team-invitations" class="software-settings-section team-org-invites-section" aria-labelledby="invitations-heading">
            <header class="software-section-intro team-section-header-row">
              <div>
                <h2 id="invitations-heading">Invite a teammate</h2>
                <p>Create an invitation link to share with your teammate.</p>
              </div>
              ${pendingInviteCount > 0 ? `<span class="hiring-pill hiring-pill-warning">${pendingInviteCount} pending</span>` : ''}
            </header>
            ${
              isOrgAdmin
                ? `<form class="software-invite-form team-org-invite-form" action="/r23/organizations/${safeOrgId}/settings" method="post">
                    <input type="hidden" name="csrf" value="${safeCsrf}">
                    <input type="hidden" name="action" value="create_invitation">
                    <input type="hidden" name="idempotencyKey" value="${safeHtml(randomUUID())}">
                    <div class="hiring-field"><label for="targetEmail">Teammate email</label><input id="targetEmail" name="targetEmail" type="email" required maxlength="320" placeholder="name@company.com"></div>
                    ${inviteRoleFieldHtml}
                    <button type="submit" class="hiring-btn hiring-btn-primary">Create team invitation</button>
                  </form>`
                : ''
            }
            <div class="software-invitation-history"><h3>Pending &amp; past invitations</h3>${invitations.length === 0 ? '<p class="software-field-help">No invitations yet.</p>' : `<ul class="software-invitation-list">${invitationsList}</ul>`}</div>
          </section>
          ${webhooksSectionHtml}
        </div><script>${combinedSettingsScript}</script>`
        : `
        <header class="software-page-heading">
          <div><p class="software-eyebrow">${safeOrgName}</p><h1>Team &amp; settings</h1></div>
          <a class="software-text-link" href="/r23/organizations/${safeOrgId}">Back to Assessments</a>
        </header>

        ${noticeBannerHtml}
        <div class="software-settings-grid">${legacyProfileHtml}${organizationDetailsHtml}</div>
        <section id="team" class="software-settings-section software-team-section" aria-labelledby="team-members-heading">
          <header class="software-section-intro"><h2 id="team-members-heading">Your team</h2><p>People with access to this workspace and its assigned reviews.</p></header>
          <p id="software-team-scroll-hint" class="software-table-hint">On smaller screens, scroll the table sideways to see all member details.</p><div tabindex="0" role="region" aria-label="Organization members" aria-describedby="software-team-scroll-hint" class="software-overflow-region">
            <table class="software-members-table">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
              <tbody>${membersRows}</tbody>
            </table>
          </div>
        </section>

        <section id="team-invitations" class="software-settings-section" aria-labelledby="invitations-heading">
          <header class="software-section-intro"><h2 id="invitations-heading">Invite an evaluator</h2></header>
          ${
            isOrgAdmin
              ? `
            <p class="software-field-help">Create an invitation link to share with your teammate.</p>
            <form class="software-invite-form" action="/r23/organizations/${safeOrgId}/settings" method="post">
              <input type="hidden" name="csrf" value="${safeCsrf}">
              <input type="hidden" name="action" value="create_invitation">
              <input type="hidden" name="idempotencyKey" value="${safeHtml(randomUUID())}">
              <div><label for="targetEmail">Reviewer email</label><input id="targetEmail" name="targetEmail" type="email" required maxlength="320" placeholder="name@company.com"></div>
              <button type="submit">Create reviewer invitation</button>
            </form>`
              : ''
          }
          <div class="software-invitation-history"><h3>Pending &amp; past invitations</h3>${invitations.length === 0 ? '<p class="software-field-help">No invitations yet.</p>' : `<ul class="software-invitation-list">${invitationsList}</ul>`}</div>
        </section>
      <script>${combinedSettingsScript}</script>`;

      const response = htmlResponse(
        hiring ? 'Organization' : 'Team & Settings',
        content,
        200,
        securityHeaders(
          scriptCspDirectives(combinedSettingsScript, Boolean(webhooksScript)),
        ),
        {
          organizationId: orgIdLower,
          organizationName: orgDisplay.name,
          role: orgContext.isOwner ? 'cto' : orgContext.role,
          email: profile.email || identity.email || '',
          csrf: csrfToken,
          active: 'settings',
          planBadge: planSummary ? formatPlanBadge(planSummary) : undefined,
          planTier: planSummary?.planTier,
          theme: readRequestTheme(request),
          currentPath: `/r23/organizations/${orgIdLower}/settings`,
        },
      );
      return attachRefreshedCookie(response, refreshedSessionCookie);
    },
  );
}

export async function stagingOrganizationSettingsPost(
  request: Request,
  targetOrganizationId: string,
  surface: 'settings' | 'plan' = 'settings',
): Promise<Response> {
  try {
    if (!UUID.test(targetOrganizationId)) throw new StagingBadRequest();
    const orgIdLower = targetOrganizationId.toLowerCase();
    const origin = requireSameOrigin(request);
    const body = await parseBody(request, false);
    const action = String(body.action ?? '');
    const planAction = ['save_plan', 'update_plan', 'update_slots'].includes(
      action,
    );
    if (surface === 'plan' && !planAction) throw new StagingBadRequest();
    const csrf = requiredText(body, 'csrf', 100);
    const csrfHash = digest(csrf);

    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ session, identity, config, refreshedSessionCookie }) => {
        if (session.selectedOrganizationId !== orgIdLower) {
          throw new StagingForbidden();
        }

        const hiring = isHiringPlatformEnabled();
        if (hiring && action !== 'update_account_profile') {
          const context = await fetchOrganizationContext(
            config,
            identity,
            orgIdLower,
          );
          if (context.role !== 'cto' && context.isOwner !== true)
            throw new StagingForbidden();
        }

        if (action === 'update_slots' && hiring) {
          if (!isFounderUatEnabled()) throw new StagingForbidden();
          const creditsMode = requiredText(body, 'slotMode', 8);
          const amount = requiredText(body, 'slotAmount', 5);
          const creditsAmount = Number(amount);
          if (
            (creditsMode !== 'set' && creditsMode !== 'add') ||
            !/^\d{1,5}$/.test(amount) ||
            creditsAmount > 10000 ||
            (creditsMode === 'add' && creditsAmount === 0)
          )
            throw new StagingBadRequest();
          await dispatchVerifiedStagingOperation(
            config,
            identity,
            'hiring.plan.update',
            {
              organizationId: orgIdLower,
              planTier: 'current',
              creditsMode,
              creditsAmount,
            },
          );
          recordServerTelemetryEvent({
            eventName: 'monetization.slots_added',
            category: 'monetization',
            actorType: 'team_member',
            organizationId: orgIdLower,
            principalId: identity.subjectId,
            planTier: 'per_candidate',
            route: '/r23/organizations/:id/upgrade',
            properties: { creditsAmount },
          });
        } else if (
          (action === 'save_plan' || action === 'update_plan') &&
          isHiringPlatformEnabled()
        ) {
          if (!isFounderUatEnabled()) throw new StagingForbidden();
          const planTier = requiredText(body, 'planTier', 32);
          if (!isPlanTier(planTier) || planTier === 'none')
            throw new StagingBadRequest();
          const legacySlotChange = action === 'update_plan';
          const creditsMode =
            legacySlotChange && body.creditsMode === 'set' ? 'set' : 'add';
          const creditsRaw = legacySlotChange
            ? Number(body.creditsAmount ?? 0)
            : 0;
          const creditsAmount = Number.isFinite(creditsRaw)
            ? Math.min(10000, Math.max(0, Math.trunc(creditsRaw)))
            : 0;
          await dispatchVerifiedStagingOperation(
            config,
            identity,
            'hiring.plan.update',
            {
              organizationId: orgIdLower,
              planTier,
              creditsMode,
              creditsAmount,
            },
          );
          recordServerTelemetryEvent({
            eventName: 'monetization.plan_changed',
            category: 'monetization',
            actorType: 'team_member',
            organizationId: orgIdLower,
            principalId: identity.subjectId,
            planTier,
            route: '/r23/organizations/:id/upgrade',
            properties: { planTier, creditsAmount },
          });
        } else if (action === 'update_account_profile') {
          const displayName = requiredText(body, 'displayName', 100);
          await dispatchVerifiedStagingOperation(
            config,
            identity,
            'account.profile.update',
            { displayName },
          );
        } else if (action === 'update_organization_profile') {
          const displayName = requiredText(
            body,
            'organizationDisplayName',
            100,
          );
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
          const requestedRole =
            typeof body.role === 'string' &&
            ['cto', 'recruiter', 'reviewer'].includes(body.role)
              ? body.role
              : null;
          if (isHiringPlatformEnabled() && requestedRole) {
            await dispatchVerifiedStagingOperation(
              config,
              identity,
              'hiring.team.invitation.create',
              {
                organizationId: orgIdLower,
                targetEmail,
                role: requestedRole,
                expiresAt,
                idempotencyKey,
                invitationTokenHash: tokenHash,
                invitationTokenCiphertext: ciphertext,
              },
            );
          } else {
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
          }
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
            { organizationId: orgIdLower, targetPrincipalId: principalId },
          );
        } else {
          throw new StagingBadRequest();
        }

        const page = planAction
          ? 'plan'
          : action === 'update_account_profile' && hiring
            ? null
            : 'settings';
        const path = page
          ? `/r23/organizations/${orgIdLower}/${page}`
          : '/r23/account';
        return attachRefreshedCookie(
          redirect(origin, `${path}?notice=${encodeURIComponent(action)}`),
          refreshedSessionCookie,
        );
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function stagingInvitationAcceptGet(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const founderUat = isFounderUatEnabled();

  if (founderUat && url.searchParams.get('pending') === '1') {
    const encodedSession = cookieValue(request, R23_SESSION_COOKIE);
    const csrf = cookieValue(request, R23_CSRF_COOKIE);
    if (!encodedSession || !csrf) {
      return htmlResponse(
        'Reviewer invitation',
        '<p role="status">Sign in with the invited account to continue.</p><p><a href="/r23/login">Sign in</a></p>',
      );
    }

    try {
      return await withStagingBrowserSession(
        request,
        digest(csrf),
        async ({ identity, csrfToken }) => {
          const invitation = await readFounderUatPendingInvitation(
            request,
            identity,
          );
          if (!invitation) throw new StagingForbidden();

          return htmlResponse(
            'Accept workspace invitation',
            `
              <section aria-labelledby="accept-invitation-title">
                <h2 id="accept-invitation-title">Join this workspace</h2>
                <p>You are signed in as <strong>${safeHtml(identity.email ?? '')}</strong>.</p>
                <p>Accept the invitation to join the organization and collaborate with your team.</p>
                <form action="/r23/invitations/accept" method="post">
                  <input type="hidden" name="csrf" value="${safeHtml(csrfToken)}">
                  <button type="submit">Accept invitation and join organization</button>
                </form>
                <p><a href="/r23/organizations">Cancel</a></p>
              </section>
            `,
            200,
            securityHeaders(),
            undefined,
            readRequestTheme(request),
          );
        },
      );
    } catch {
      return htmlResponse(
        'Invitation could not be opened',
        '<p role="alert">This invitation is unavailable for the signed-in account. Sign in with the invited email address or ask the inviter for a new link.</p><p><a href="/r23/login">Sign in</a></p>',
        403,
        securityHeaders(),
        undefined,
        readRequestTheme(request),
      );
    }
  }

  if (founderUat) {
    if (!token || token.length > 256) {
      return htmlResponse(
        'Reviewer invitation',
        '<p role="alert">An invitation link is required.</p><p><a href="/r23/login">Sign in</a></p>',
        400,
        securityHeaders(),
        undefined,
        readRequestTheme(request),
      );
    }

    const safeToken = safeHtml(token);
    const actions = [
      ['login', 'Sign in with invited account'],
      ['signup', 'Create an account'],
    ] as const;
    const actionForms = actions
      .map(
        ([destination, label]) => `
          <form action="/api/founder-uat/invitations/context" method="post">
            <input type="hidden" name="token" value="${safeToken}">
            <input type="hidden" name="destination" value="${destination}">
            <button type="submit">${label}</button>
          </form>`,
      )
      .join('');
    const hasSession =
      Boolean(cookieValue(request, R23_SESSION_COOKIE)) &&
      Boolean(cookieValue(request, R23_CSRF_COOKIE));

    return htmlResponse(
      'Reviewer invitation',
      `
        <section aria-labelledby="invitation-intro-title">
          <h2 id="invitation-intro-title">Join organization as a reviewer</h2>
          <p>You have been invited to join an engineering organization on Hirearchy as a reviewer.</p>
          <div role="note" aria-label="Invitation instructions">
            <p>Use the email address your inviter specified. Your invitation will stay available while you sign in or create an account.</p>
          </div>
          <div aria-label="Invitation account options">${actionForms}</div>
          ${
            hasSession
              ? `<form action="/api/founder-uat/invitations/context" method="post">
                  <input type="hidden" name="token" value="${safeToken}">
                  <input type="hidden" name="destination" value="accept">
                  <button type="submit">Continue with this account</button>
                </form>`
              : ''
          }
        </section>
      `,
      200,
      securityHeaders(),
      undefined,
      readRequestTheme(request),
    );
  }

  if (!token || token.length > 256) {
    return htmlResponse(
      'Invitation link required',
      '<p role="alert">An invitation token is required in the link.</p><p><a href="/r23/login">Sign in</a></p>',
      400,
      securityHeaders(),
      undefined,
      readRequestTheme(request),
    );
  }

  const encodedSession = cookieValue(request, R23_SESSION_COOKIE);
  const csrf = cookieValue(request, R23_CSRF_COOKIE);

  if (!encodedSession || !csrf) {
    return htmlResponse(
      'Team Invitation',
      `
        <section aria-labelledby="invitation-intro-title">
          <h2 id="invitation-intro-title">Join organization as reviewer</h2>
          <p>You have been invited to join an engineering organization on Hirearchy.</p>
          <div role="note" aria-label="Invitation instructions">
            <p>Sign in or create an account using the email address your invite was sent to.</p>
          </div>
          <p><a href="/r23/login?next=${encodeURIComponent(`/r23/invitations/accept?token=${token}`)}">Sign in with invited account</a></p>
          <p><a href="/r23/signup">Create new account</a></p>
        </section>
      `,
      200,
      securityHeaders(),
      undefined,
      readRequestTheme(request),
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
          'Accept Team Invitation',
          `
            <section aria-labelledby="accept-invitation-title">
              <h2 id="accept-invitation-title">Accept Team Invitation</h2>
              <p>You are signed in as <strong>${safeEmail}</strong>.</p>
              <form action="/r23/invitations/accept" method="post">
                <input type="hidden" name="csrf" value="${safeCsrf}">
                <input type="hidden" name="token" value="${safeToken}">
                <button type="submit">Accept invitation and join organization</button>
              </form>
              <p><a href="/r23/organizations">Cancel</a></p>
            </section>
          `,
          200,
          securityHeaders(),
          undefined,
          readRequestTheme(request),
        );
      },
    );
  } catch {
    return htmlResponse(
      'Team Invitation',
      `
        <p>Your session has expired. Please sign in to accept the invitation.</p>
        <p><a href="/r23/login?next=${encodeURIComponent(`/r23/invitations/accept?token=${token}`)}">Sign in</a></p>
      `,
      401,
      securityHeaders(),
      undefined,
      readRequestTheme(request),
    );
  }
}

export async function stagingInvitationAcceptPost(
  request: Request,
): Promise<Response> {
  try {
    const origin = requireSameOrigin(request);
    const body = await parseBody(request, false);
    const founderUat = isFounderUatEnabled();
    allowedFields(body, founderUat ? ['csrf'] : ['token', 'csrf']);
    const token = founderUat ? null : requiredText(body, 'token', 256);
    const csrf = requiredText(body, 'csrf', 100);
    const csrfHash = digest(csrf);

    return await withStagingBrowserSession(
      request,
      csrfHash,
      async ({ config, sessionKey, session, identity }) => {
        const pendingInvitation = founderUat
          ? await readFounderUatPendingInvitation(request, identity)
          : null;
        if (founderUat && !pendingInvitation) {
          throw new StagingForbidden();
        }
        const invitationToken = pendingInvitation?.token ?? token;
        if (!invitationToken) throw new StagingForbidden();
        const tokenHash = invitationTokenHash(invitationToken);
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

        const attr = readAttributionCookie(request);
        recordServerTelemetryEvent({
          eventName: 'acquisition.invite_accepted',
          category: 'acquisition',
          actorType: 'team_member',
          anonymousId: attr?.anonymousId,
          attribution: attr,
          organizationId,
          principalId: identity.subjectId,
          route: '/r23/invitations/accept',
          properties: {
            hiringPlatform: isHiringPlatformEnabled(),
          },
        });

        const updatedSession: StagingBrowserSessionPayload = Object.freeze({
          ...session,
          selectedOrganizationId: organizationId,
        });

        const cookies = [
          cookieHeader(
            R23_SESSION_COOKIE,
            encryptSessionPayload(updatedSession, sessionKey),
            true,
          ),
        ];
        if (founderUat && pendingInvitation) {
          cookies.push(clearFounderUatPendingInvitation());
        }
        return redirect(
          origin,
          `/r23/organizations/${organizationId}`,
          cookies,
        );
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

/* ========================================================================== */
/* Hiring Platform Bridge Exports                                             */
/* ========================================================================== */

export { StagingBadRequest, StagingForbidden, StagingUnavailable };

export function buildHiringSyntheticRequest(
  cookieHeaderValue: string,
): Request {
  return new Request('https://hirearchy-internal.invalid/', {
    headers: {
      Accept: 'application/json',
      ...(cookieHeaderValue ? { Cookie: cookieHeaderValue } : {}),
    },
  });
}

export function hiringFailureJsonResponse(
  request: Request,
  error: unknown,
): Response {
  const jsonHeaders = new Headers(request.headers);
  jsonHeaders.set('Accept', 'application/json');
  const jsonRequest = new Request(request.url, {
    method: request.method,
    headers: jsonHeaders,
  });
  return failureResponse(jsonRequest, error);
}

export async function hiringParseJsonBody(
  request: Request,
  maxBytes = 256 * 1024,
): Promise<Record<string, unknown>> {
  return parseBody(request, false, maxBytes);
}

export async function withHiringOrganizationSession(
  request: Request,
  targetOrganizationId: string,
  opts: {
    requireOriginCsrf?: boolean;
    body?: Record<string, unknown>;
  },
  operation: (ctx: {
    config: StagingConfiguration;
    identity: R23VerifiedIdentity;
    session: StagingBrowserSessionPayload;
    csrfToken: string;
    organizationId: string;
    organizationName: string;
    orgContext: StagingOrganizationContextResponse;
    plan: OrganizationPlanSummary;
    dispatch: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  }) => Promise<Response>,
): Promise<Response> {
  if (!isHiringPlatformEnabled()) {
    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'Not found.' } },
      { status: 404 },
    );
  }
  if (!UUID.test(targetOrganizationId)) throw new StagingBadRequest();
  const orgIdLower = targetOrganizationId.toLowerCase();
  const body = opts.body ?? Object.create(null);
  const csrf = opts.requireOriginCsrf
    ? requireOriginAndCsrf(request, body).csrf
    : requiredOpaqueCookie(request, R23_CSRF_COOKIE);

  return withStagingBrowserSession(
    request,
    digest(csrf),
    async ({
      config,
      session,
      identity,
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
      const membership: R23Membership & { displayName: string | null } = {
        organizationId: orgIdLower,
        role: orgContext.role,
        membershipVersion: '1',
        displayName: orgContext.displayName,
      };
      const orgDisplay = resolveOrgDisplay(orgIdLower, membership);
      const plan = (await dispatchVerifiedStagingOperation(
        config,
        identity,
        'hiring.plan.get',
        { organizationId: orgIdLower },
      )) as OrganizationPlanSummary;

      const response = await operation({
        config,
        identity,
        session,
        csrfToken,
        organizationId: orgIdLower,
        organizationName: orgDisplay.name,
        orgContext,
        plan,
        dispatch: (op, args) =>
          dispatchVerifiedStagingOperation(
            config,
            identity,
            op,
            args as StagingProofArgs,
          ),
      });
      return attachRefreshedCookie(response, refreshedSessionCookie);
    },
  );
}

export async function loadHiringOrganizationWorkspaceFromCookie(
  cookieHeaderValue: string,
  targetOrganizationId: string,
): Promise<{
  config: StagingConfiguration;
  identity: R23VerifiedIdentity;
  csrfToken: string;
  organizationId: string;
  organizationName: string;
  role: WorkspaceRoleKind;
  isOwner: boolean;
  email: string;
  orgContext: StagingOrganizationContextResponse;
  plan: OrganizationPlanSummary;
  dispatch: (op: string, args: Record<string, unknown>) => Promise<unknown>;
} | null> {
  if (!isHiringPlatformEnabled() || !UUID.test(targetOrganizationId)) {
    return null;
  }
  const orgIdLower = targetOrganizationId.toLowerCase();
  const request = buildHiringSyntheticRequest(cookieHeaderValue);
  const csrf = cookieValue(request, R23_CSRF_COOKIE);
  if (!csrf || !RANDOM_VALUE.test(csrf)) return null;

  try {
    return await withStagingBrowserSession(
      request,
      digest(csrf),
      async ({ config, session, identity, csrfToken }) => {
        if (session.selectedOrganizationId !== orgIdLower) {
          throw new StagingForbidden();
        }
        const orgContext = await fetchOrganizationContext(
          config,
          identity,
          orgIdLower,
        );
        const membership: R23Membership & { displayName: string | null } = {
          organizationId: orgIdLower,
          role: orgContext.role,
          membershipVersion: '1',
          displayName: orgContext.displayName,
        };
        const orgDisplay = resolveOrgDisplay(orgIdLower, membership);
        const plan = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'hiring.plan.get',
          { organizationId: orgIdLower },
        )) as OrganizationPlanSummary;

        return {
          config,
          identity,
          csrfToken,
          organizationId: orgIdLower,
          organizationName: orgDisplay.name,
          role: orgContext.isOwner ? 'cto' : orgContext.role,
          isOwner: Boolean(orgContext.isOwner),
          email: identity.email ?? '',
          orgContext,
          plan,
          dispatch: (op, args) =>
            dispatchVerifiedStagingOperation(
              config,
              identity,
              op,
              args as StagingProofArgs,
            ),
        };
      },
    );
  } catch {
    return null;
  }
}

export async function withHiringAccountSession(
  request: Request,
  opts: {
    requireOriginCsrf?: boolean;
    body?: Record<string, unknown>;
  },
  operation: (ctx: {
    config: StagingConfiguration;
    identity: R23VerifiedIdentity;
    csrfToken: string;
    dispatch: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  }) => Promise<Response>,
): Promise<Response> {
  if (!isHiringPlatformEnabled()) {
    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'Not found.' } },
      { status: 404 },
    );
  }
  const body = opts.body ?? Object.create(null);
  const csrf = opts.requireOriginCsrf
    ? requireOriginAndCsrf(request, body).csrf
    : requiredOpaqueCookie(request, R23_CSRF_COOKIE);

  return withStagingBrowserSession(
    request,
    digest(csrf),
    async ({ config, identity, csrfToken, refreshedSessionCookie }) => {
      const response = await operation({
        config,
        identity,
        csrfToken,
        dispatch: (op, args) =>
          dispatchVerifiedStagingOperation(
            config,
            identity,
            op,
            args as StagingProofArgs,
          ),
      });
      return attachRefreshedCookie(response, refreshedSessionCookie);
    },
  );
}

export async function withHiringCandidateSession(
  request: Request,
  sessionId: string,
  operation: () => Promise<Response>,
): Promise<Response> {
  if (!isHiringPlatformEnabled()) return operation();
  try {
    return await withHiringAccountSession(request, {}, async ({ dispatch }) => {
      const access = (await dispatch('candidate.session.verify_access', {
        sessionId,
      })) as { gateState?: string } | null;
      if (access?.gateState !== 'ready') throw new StagingForbidden();
      return operation();
    });
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}

export async function tryResolveSignedInLandingPath(
  cookieHeaderValue: string,
  requestedNextPath: string | null = null,
): Promise<string | null> {
  if (!isAuthenticatedStaging() || !isHiringPlatformEnabled()) return null;
  const request = buildHiringSyntheticRequest(cookieHeaderValue);
  const csrf = cookieValue(request, R23_CSRF_COOKIE);
  if (!csrf || !RANDOM_VALUE.test(csrf)) return null;

  try {
    return await withStagingBrowserSession(
      request,
      digest(csrf),
      async ({ session, config, identity }) => {
        if (requestedNextPath) {
          const targetOrgId = extractOrganizationIdFromPath(requestedNextPath);
          if (
            targetOrgId &&
            session.selectedOrganizationId?.toLowerCase() === targetOrgId
          ) {
            return requestedNextPath;
          }
        }
        if (session.selectedOrganizationId) {
          return `/r23/organizations/${session.selectedOrganizationId.toLowerCase()}/candidates`;
        }
        const statusResult = (await dispatchVerifiedStagingOperation(
          config,
          identity,
          'onboarding.status',
          {},
        )) as OnboardingStatusResponse | null;
        if (statusResult?.status === 'has_active_membership') {
          return '/r23/organizations';
        }
        return null;
      },
      'defer',
    );
  } catch {
    return null;
  }
}

export async function tryReadHiringAccountFromCookie(
  cookieHeaderValue: string,
): Promise<{
  config: StagingConfiguration;
  identity: R23VerifiedIdentity;
  csrfToken: string;
  dispatch: (op: string, args: Record<string, unknown>) => Promise<unknown>;
} | null> {
  if (!isHiringPlatformEnabled()) return null;
  const request = buildHiringSyntheticRequest(cookieHeaderValue);
  const csrf = cookieValue(request, R23_CSRF_COOKIE);
  if (!csrf || !RANDOM_VALUE.test(csrf)) return null;

  try {
    return await withStagingBrowserSession(
      request,
      digest(csrf),
      async ({ config, identity, csrfToken }) => ({
        config,
        identity,
        csrfToken,
        dispatch: (op, args) =>
          dispatchVerifiedStagingOperation(
            config,
            identity,
            op,
            args as StagingProofArgs,
          ),
      }),
    );
  } catch {
    return null;
  }
}

export async function authenticateCandidatePasswordLogin(
  request: Request,
  email: string,
  password: string,
): Promise<
  | {
      status: 'ok';
      email: string;
      cookies: readonly string[];
    }
  | {
      status: 'email_confirmation_required';
    }
> {
  if (!isAuthenticatedStaging() || !isHiringPlatformEnabled()) {
    throw new StagingForbidden();
  }
  const config = loadStagingConfiguration();
  requireSameOrigin(request);
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !password) throw new StagingBadRequest();

  let pair: R23TokenGrant;
  try {
    pair = await passwordGrant(config.auth, cleanEmail, password);
  } catch (error) {
    if (error instanceof R23EmailConfirmationRequired) {
      return { status: 'email_confirmation_required' };
    }
    throw error;
  }

  const identity = assertR23StagingEligibleIdentity(
    await verifyR23AccessToken(config.auth, pair.accessToken, pair),
  );
  const csrf = randomOpaqueValue();
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
    callbackHash: null,
    selectedOrganizationId: null,
    expiresAt: now + APP_SESSION_TTL_SECONDS,
  });
  const encodedSession = encryptSessionPayload(payload, sessionKey);
  return {
    status: 'ok',
    email: identity.email ?? cleanEmail,
    cookies: [
      cookieHeader(R23_SESSION_COOKIE, encodedSession, true),
      cookieHeader(R23_CSRF_COOKIE, csrf, false),
    ],
  };
}

export async function registerCandidateAccount(
  request: Request,
  email: string,
  password: string,
): Promise<
  | {
      ok: true;
      email: string;
      localConfirmation: boolean;
    }
  | {
      ok: false;
      status: number;
      message: string;
    }
> {
  if (!isHiringPlatformEnabled()) throw new StagingForbidden();
  requireSameOrigin(request);
  const cleanEmail = email.trim().toLowerCase();
  if (
    !cleanEmail.includes('@') ||
    password.length < 6 ||
    password.length > 1024
  ) {
    return {
      ok: false,
      status: 400,
      message:
        'Please provide a valid email address and a password of at least 6 characters.',
    };
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
      body: JSON.stringify({ email: cleanEmail, password }),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!authResponse.ok) {
    const data = (await authResponse.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const message = String(
      data?.msg ??
        data?.error_description ??
        'Unable to create candidate account.',
    );
    return {
      ok: false,
      status: authResponse.status,
      message,
    };
  }
  return {
    ok: true,
    email: cleanEmail,
    localConfirmation: founderUatMailInboxUrl(cleanEmail) !== null,
  };
}

export function clearHiringAuthCookies(): readonly string[] {
  return [
    clearCookieHeader(R23_SESSION_COOKIE, true),
    clearCookieHeader(R23_CSRF_COOKIE, false),
  ];
}

export function generateOpaqueLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

export function computeCandidateLinkTokenHash(rawToken: string): string {
  return candidateTokenHash(rawToken);
}

export function encryptCandidateLinkToken(
  rawToken: string,
  sessionId: string,
): string {
  return encryptCandidateToken(
    rawToken,
    sessionId,
    loadCandidateTokenEncryptionKey(),
  );
}

export function decryptCandidateLinkToken(
  ciphertext: string,
  sessionId: string,
): string {
  return decryptCandidateToken(
    ciphertext,
    sessionId,
    loadCandidateTokenEncryptionKey(),
  );
}
