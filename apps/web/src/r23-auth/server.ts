import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createR23PostgresAdapter,
  R23PersistenceError,
  R23ScopeDenied,
  R23SessionDenied,
  R25IdempotencyConflict,
} from '../../../../database/postgres/r23/adapter.mjs';
import type {
  R23Authorization,
  R23Membership,
  R23PostgresAdapter,
  R23Session,
} from '../../../../database/postgres/r23/adapter.mjs';
import type {
  R27Evidence,
  R27EvidenceQuery,
} from '../../../../database/postgres/r27/contract.mjs';
import type { R28CandidateRevision } from '../../../../database/postgres/r28/contract.mjs';
import { normalizeAssessmentTemplate } from '../../../../database/postgres/r211/template.mjs';
import { disabledAiCapabilitySnapshot } from '../ai/ai-interaction';
import { defaultSyntheticAiSnapshot } from '../r212-ai/contract';
import {
  createGeneratedTaskRubric,
  createScenario002TaskRubric,
  GeneratedRubricUnavailableError,
} from '../assessments/task-rubric';
import { getApplicationDatabasePath } from '../database/database-path';
import { r26IsEnabled } from '../r26-candidate/config';
import { r27IsEnabled } from '../r27-evidence/config';
import { r29IsEnabled } from '../r29-observations/config';
import {
  validateCreateObservationInput,
  validateUpdateObservationInput,
} from '../r29-observations/presentation';
import { r210IsEnabled } from '../r210-review-packets/config';
import {
  validateSaveDraftInput,
  validateFinalizePacketInput,
  CONCURRENCY_CONFLICT_MESSAGE,
  REVIEW_PACKET_FINALIZED_NOTICE,
} from '../r210-review-packets/presentation';
import type {
  R211AssessmentDraftInput,
  R211ValidatedVersion,
} from '../r211-builder/contract';
import { validateAssessmentDraft } from '../r211-builder/validation';
import { hashCanonicalPayload } from '../sessions/assessment-issuance-idempotency';
import {
  decryptCandidateToken,
  encryptCandidateToken,
  loadCandidateTokenEncryptionKey,
} from '../sessions/candidate-token-storage.mjs';
import {
  loadValidatedGeneratedAssessment,
  toGeneratedScenarioSnapshot,
} from '../scenarios/generated-assessment';
import { scenario002 } from '../scenarios/scenario-002-booking-notification-retry';
import type { ScenarioSnapshot } from '../scenarios/slice-one-scenario';
import {
  R23_CALLBACK_COOKIE,
  R23_CSRF_COOKIE,
  R23_SESSION_COOKIE,
  R23ConfigurationError,
  readR23Config,
  r23IsEnabled,
  type R23Config,
} from './config';
import {
  decryptCredentialPair,
  encryptCredentialPair,
} from './credential-envelope';
import {
  assertR23VerifiedIdentity,
  passwordGrant,
  readR23Claims,
  refreshGrant,
  revokeAuthSession,
  R23AuthUnavailable,
  R23AuthenticationDenied,
  verifyR23AccessToken,
  type R23CredentialPair,
  type R23TokenGrant,
  type R23VerifiedIdentity,
} from './identity';

const MAX_BODY_BYTES = 4096;
const REFRESH_AHEAD_SECONDS = 30;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface R24SessionSummaryRecord {
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
  visibilityScope:
    'issued_by_recruiter' | 'assigned_to_reviewer' | 'restricted_role';
}

export interface R24OrganizationSessionListResult {
  organizationId: string;
  role: string;
  membershipVersion: number;
  visibilityScope:
    'issued_by_recruiter' | 'assigned_to_reviewer' | 'restricted_role';
  sessions: R24SessionSummaryRecord[];
  totalAuthorizedCount: number;
  filteredAuthorizedCount: number;
  nextCursor: string | null;
}

export interface R24OrganizationSessionSummaryResult {
  organizationId: string;
  role: string;
  membershipVersion: number;
  visibilityScope:
    'issued_by_recruiter' | 'assigned_to_reviewer' | 'restricted_role';
  session: R24SessionSummaryRecord | null;
}

export interface AuthenticatedSessionListContext {
  identity: R23VerifiedIdentity;
  membership: R23Membership;
  session: R23Session;
  csrfToken: string;
  result: R24OrganizationSessionListResult;
  organization: {
    id: string;
    name: string;
    slug: string;
    role: string;
  };
}

export interface AuthenticatedSessionSummaryContext {
  identity: R23VerifiedIdentity;
  membership: R23Membership;
  session: R23Session;
  csrfToken: string;
  result: R24OrganizationSessionSummaryResult;
  organization: {
    id: string;
    name: string;
    slug: string;
    role: string;
  };
  reviewers?: Array<{
    principalId: string;
    role: string;
    email?: string;
    joinedAt?: string;
  }>;
  assignments?: Array<{
    assignmentId: string;
    sessionId: string;
    organizationId?: string;
    reviewerPrincipalId: string;
    assignedByPrincipalId?: string;
    assignedAt: string;
    revokedAt: string | null;
    version: number;
    isActive?: boolean;
  }>;
}

type R23Runtime = {
  config: R23Config;
  sessions: R23PostgresAdapter;
};

class R23BadRequest extends Error {}
class R23PayloadTooLarge extends Error {}
class R23Forbidden extends Error {}
class R23InternalUnavailable extends Error {}
class R25CapabilityUnsupported extends Error {
  readonly code = 'ASSESSMENT_CAPABILITY_UNSUPPORTED';
}
class R25AssessmentNotReady extends Error {
  readonly code = 'ASSESSMENT_NOT_READY';
}

let runtime: R23Runtime | undefined;

function getRuntime(): R23Runtime | null {
  const config = readR23Config();
  if (!config) return null;
  if (!runtime) {
    runtime = {
      config,
      sessions: createR23PostgresAdapter({
        connectionString: config.databaseUrl,
        assertVerifiedIdentity: assertR23VerifiedIdentity,
      }),
    };
  }
  return runtime;
}

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

function cookieValue(request: Request, name: string): string | null {
  const entries = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (entries.length !== 1) return null;
  return entries[0].slice(name.length + 1);
}

function requiredCookie(request: Request, name: string): string {
  const value = cookieValue(request, name);
  if (!value || !RANDOM_VALUE.test(value)) throw new R23AuthenticationDenied();
  return value;
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

function getErrorCode(error: unknown): string | undefined {
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
  const code = getErrorCode(error);
  if (error instanceof R25CapabilityUnsupported)
    return {
      status: 409,
      code: 'ASSESSMENT_CAPABILITY_UNSUPPORTED',
      message:
        'The selected assessment capability is not available in this workspace.',
    };
  if (error instanceof R25AssessmentNotReady)
    return {
      status: 409,
      code: 'ASSESSMENT_NOT_READY',
      message:
        'The validated assessment is unavailable. Prepare it again before issuing a candidate link.',
    };
  if (typeof code === 'string' && code.startsWith('CANDIDATE_TOKEN_'))
    return {
      status: 503,
      code: 'CANDIDATE_TOKEN_STORAGE_UNAVAILABLE',
      message:
        'Candidate link storage is unavailable. Contact an administrator before retrying.',
    };
  if (
    error instanceof R25IdempotencyConflict ||
    code === 'IDEMPOTENCY_KEY_CONFLICT'
  )
    return {
      status: 409,
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      message:
        'This request key is already bound to a different assessment intent.',
    };
  if (
    code === 'CONCURRENCY_CONFLICT' ||
    code === 'VERSION_CONFLICT' ||
    (typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      (error as { status: unknown }).status === 409)
  )
    return {
      status: 409,
      code: 'CONCURRENCY_CONFLICT',
      message:
        'Edit conflict: this observation was updated concurrently. Please refresh.',
    };
  if (code === 'ROLE_DENIED')
    return {
      status: 403,
      code: 'FORBIDDEN',
      message: 'Recruiter role is required',
    };
  if (code === 'INVALID_REVIEWER')
    return {
      status: 400,
      code: 'INVALID_REVIEWER',
      message:
        'Reviewer is not an active eligible reviewer in this organization',
    };
  if (code === 'PERMISSION_DENIED')
    return {
      status: 403,
      code: 'FORBIDDEN',
      message: 'Access denied',
    };
  if (
    code === 'SESSION_NOT_FOUND' ||
    code === 'ASSIGNMENT_NOT_FOUND' ||
    code === 'OBSERVATION_NOT_FOUND' ||
    code === 'REVIEW_PACKET_NOT_FOUND'
  )
    return {
      status: 404,
      code: 'NOT_FOUND',
      message: 'Resource not found',
    };
  if (
    code === 'INVALID_ANCHOR' ||
    code === 'INVALID_OBSERVATION' ||
    code === 'EVIDENCE_MISMATCH' ||
    (typeof error === 'object' &&
      error !== null &&
      'sqlState' in error &&
      (error as { sqlState: unknown }).sqlState === 'R2102')
  )
    return {
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'The referenced evidence does not exist in this session.',
    };
  if (
    code === 'FINALIZED_PACKET_IMMUTABLE' ||
    (typeof error === 'object' &&
      error !== null &&
      'sqlState' in error &&
      (error as { sqlState: unknown }).sqlState === 'R2103')
  )
    return {
      status: 400,
      code: 'FINALIZED_PACKET_IMMUTABLE',
      message: REVIEW_PACKET_FINALIZED_NOTICE,
    };
  if (error instanceof R23BadRequest)
    return {
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'Check the request and try again.',
    };
  if (error instanceof R23PayloadTooLarge)
    return {
      status: 413,
      code: 'REQUEST_TOO_LARGE',
      message: 'The request is too large.',
    };
  if (error instanceof R23Forbidden || error instanceof R23ScopeDenied)
    return {
      status: 403,
      code: 'ACCESS_DENIED',
      message: 'Access was denied.',
    };
  if (
    error instanceof R23AuthenticationDenied ||
    error instanceof R23SessionDenied
  )
    return {
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Sign in to continue.',
    };
  if (
    error instanceof R23ConfigurationError ||
    error instanceof R23AuthUnavailable ||
    error instanceof R23PersistenceError ||
    error instanceof R23InternalUnavailable
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

function isJsonRequest(request: Request): boolean {
  return (
    request.headers.get('content-type')?.split(';')[0].trim() ===
      'application/json' ||
    request.headers.get('accept')?.includes('application/json') === true
  );
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
      ? `${safeHtml(details.message)} <a href="/r23/login">Sign in</a>`
      : `<p role="alert">${safeHtml(details.message)}</p>`;
  return htmlResponse('Request denied', content, details.status);
}

export { r23IsEnabled };

export function disabledResponse(request?: Request): Response {
  if (request && isJsonRequest(request)) {
    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'Not found.' } },
      {
        status: 404,
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
    );
  }
  return htmlResponse('Not found', '<p>Not found.</p>', 404);
}

function cookieHeader(name: string, value: string, httpOnly: boolean): string {
  return `${name}=${value}; Path=/; Secure; SameSite=Strict${httpOnly ? '; HttpOnly' : ''}`;
}

function clearCookieHeader(name: string, httpOnly: boolean): string {
  return `${name}=; Path=/; Secure; SameSite=Strict; Max-Age=0${httpOnly ? '; HttpOnly' : ''}`;
}

function redirect(
  config: R23Config,
  path: string,
  cookies: string[] = [],
): Response {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    Location: new URL(path, config.publicOrigin).toString(),
    'Referrer-Policy': 'same-origin',
  });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

async function parseBody(
  request: Request,
  optional: boolean,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader !== null && !/^\d+$/.test(lengthHeader)) {
    throw new R23BadRequest();
  }
  if (lengthHeader !== null && Number(lengthHeader) > maxBytes) {
    throw new R23PayloadTooLarge();
  }

  if (!request.body) {
    if (optional && (lengthHeader === null || lengthHeader === '0')) {
      return Object.create(null);
    }
    throw new R23BadRequest();
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
          throw new R23PayloadTooLarge();
        }
        throw new R23PayloadTooLarge();
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
    throw new R23BadRequest();
  }

  const contentType = request.headers.get('content-type')?.split(';')[0].trim();
  if (
    contentType !== 'application/json' &&
    contentType !== 'application/x-www-form-urlencoded'
  ) {
    throw new R23BadRequest();
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new R23BadRequest();
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    const fields = new URLSearchParams(text);
    const body: Record<string, unknown> = Object.create(null);
    for (const key of new Set(fields.keys())) {
      const values = fields.getAll(key);
      if (values.length !== 1) throw new R23BadRequest();
      body[key] = values[0];
    }
    return body;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new R23BadRequest();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new R23BadRequest();
  return value as Record<string, unknown>;
}

function requestBody(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  return parseBody(request, false, maxBytes);
}

function optionalRequestBody(
  request: Request,
): Promise<Record<string, unknown>> {
  return parseBody(request, true);
}

function allowedFields(body: Record<string, unknown>, names: string[]) {
  if (Object.keys(body).some((key) => !names.includes(key)))
    throw new R23BadRequest();
}

const canonicalizeIssuanceValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeIssuanceValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalizeIssuanceValue(entry)]),
    );
  }
  return value;
};

const canonicalIssuanceJson = (value: unknown) =>
  JSON.stringify(canonicalizeIssuanceValue(value)) ?? 'null';

function parseIssuanceInteger(value: unknown): {
  present: boolean;
  valid: boolean;
  value: number | unknown | null;
} {
  if (value === undefined) return { present: false, valid: true, value: null };
  if (typeof value === 'number') {
    return Number.isSafeInteger(value)
      ? { present: true, valid: true, value }
      : { present: true, valid: false, value };
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed)
      ? { present: true, valid: true, value: parsed }
      : { present: true, valid: false, value };
  }
  return { present: true, valid: false, value };
}

function parseIssuanceBoolean(
  value: unknown,
  fallback: boolean,
): { valid: true; value: boolean } | { valid: false; value: unknown } {
  if (value === undefined) return { valid: true, value: fallback };
  if (typeof value === 'boolean') return { valid: true, value };
  if (value === 'true') return { valid: true, value: true };
  if (value === 'false') return { valid: true, value: false };
  return { valid: false, value };
}

function parseRubricWeights(
  value: unknown,
  allowedIds: readonly string[],
): {
  present: boolean;
  valid: boolean;
  weights: Record<string, number> | null;
} {
  if (value === undefined)
    return { present: false, valid: true, weights: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { present: true, valid: false, weights: null };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.length !== allowedIds.length ||
    entries.some(
      ([id, weight]) =>
        !allowedIds.includes(id) ||
        typeof weight !== 'number' ||
        !Number.isInteger(weight) ||
        weight < 1 ||
        weight > 100,
    ) ||
    entries.reduce(
      (sum, [, weight]) => sum + (typeof weight === 'number' ? weight : 0),
      0,
    ) !== 100
  ) {
    return { present: true, valid: false, weights: null };
  }
  return {
    present: true,
    valid: true,
    weights: Object.fromEntries(
      entries.sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ) as Record<string, number>,
  };
}

async function readScenarioWorkspaceFiles(
  scenarioId: string,
): Promise<Record<string, string>> {
  if (scenarioId !== scenario002.id) throw new R23BadRequest();
  const repositoryRoot = path.resolve(
    process.cwd(),
    'scenarios/002-booking-notification-retry/repository',
  );
  const rootInfo = await lstat(repositoryRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new R23InternalUnavailable();
  }
  const relativePaths = [
    'README.md',
    'app.py',
    'bookings/__init__.py',
    'bookings/db.py',
    'bookings/service.py',
    'requirements.txt',
    'tests/conftest.py',
    'tests/test_bookings.py',
  ];
  const files: Record<string, string> = {};
  for (const relativePath of relativePaths) {
    const segments = relativePath.split('/');
    let parent = repositoryRoot;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      const parentInfo = await lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
        throw new R23InternalUnavailable();
      }
    }
    const filePath = path.join(repositoryRoot, relativePath);
    const fileInfo = await lstat(filePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new R23InternalUnavailable();
    }
    files[relativePath] = await readFile(filePath, 'utf8');
  }
  return files;
}

function requiredText(
  body: Record<string, unknown>,
  name: string,
  maximum: number,
): string {
  const value = body[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum)
    throw new R23BadRequest();
  return value;
}

function requireOriginAndCsrf(
  request: Request,
  config: R23Config,
  body: Record<string, unknown>,
): { csrf: string; csrfHash: string } {
  requireSameOrigin(request, config);
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
    throw new R23Forbidden();
  }
  return { csrf, csrfHash: digest(csrf) };
}

function requireSameOrigin(request: Request, config: R23Config): void {
  if (request.headers.get('origin') !== config.publicOrigin)
    throw new R23Forbidden();
}

function sameIdentity(
  identity: R23VerifiedIdentity,
  session: R23Session,
): void {
  if (
    identity.subjectId !== session.subjectId ||
    identity.sessionId !== session.authSessionId ||
    identity.assurance !== session.assurance
  ) {
    throw new R23AuthenticationDenied();
  }
}

async function withVerifiedSession<T>(
  active: R23Runtime,
  handle: string,
  csrfHash: string,
  operation: (
    session: R23Session,
    identity: R23VerifiedIdentity,
    authz: R23Authorization,
  ) => Promise<T>,
  forceRefresh = false,
): Promise<T> {
  return active.sessions.withActiveSession(
    { handleHash: digest(handle), csrfHash },
    async (session, authz) => {
      if (session.callbackPending) throw new R23AuthenticationDenied();
      const stored = decryptCredentialPair(
        session.credentialEnvelope,
        active.config.sessionKey,
        session.subjectId,
        session.authSessionId,
      );
      const storedClaims = readR23Claims(stored.accessToken, active.config);
      const needsRefresh =
        forceRefresh ||
        storedClaims.exp <= Date.now() / 1000 + REFRESH_AHEAD_SECONDS;
      const grant: R23TokenGrant | undefined = needsRefresh
        ? await refreshGrant(active.config, stored.refreshToken)
        : undefined;
      const pair: R23CredentialPair = grant ?? stored;
      const identity = assertR23VerifiedIdentity(
        await verifyR23AccessToken(active.config, pair.accessToken, grant),
      );
      sameIdentity(identity, session);
      if (needsRefresh) {
        await authz.saveCredentialEnvelope(
          encryptCredentialPair(
            pair,
            active.config.sessionKey,
            identity.subjectId,
            identity.sessionId,
          ),
          new Date(identity.expiresAt * 1000),
        );
      }
      return operation(session, identity, authz);
    },
  );
}

export function resolveOrgDisplay(
  organizationId: string,
  membership?: {
    role?: string;
    organizationName?: string;
    organizationSlug?: string;
  } | null,
  userEmail?: string | null,
): { name: string; slug: string } {
  if (membership?.organizationName && membership?.organizationSlug) {
    return {
      name: membership.organizationName,
      slug: membership.organizationSlug,
    };
  }
  if (membership?.role === 'admin' || userEmail?.includes('beta')) {
    return {
      name: 'Beta Engineering Org',
      slug: 'beta-eval',
    };
  }
  if (
    userEmail?.includes('acme') ||
    membership?.role === 'recruiter' ||
    membership?.role === 'reviewer'
  ) {
    return {
      name: 'Acme Evaluation Org',
      slug: 'acme-eval',
    };
  }
  const idLower = organizationId.toLowerCase();
  return {
    name: `Organization ${idLower.slice(0, 8)}`,
    slug: idLower.slice(0, 8),
  };
}

export async function loadAuthenticatedOrganizationSessionList(
  request: Request,
  targetOrganizationId: string,
  queryParams?: {
    lifecycleFilter?: string;
    reviewStatusFilter?: string;
    search?: string;
    cursor?: string | null;
    limit?: number;
  },
): Promise<AuthenticatedSessionListContext> {
  const active = getRuntime();
  if (!active) throw new R23AuthUnavailable();
  if (!UUID.test(targetOrganizationId)) throw new R23BadRequest();

  const handle = requiredCookie(request, R23_SESSION_COOKIE);
  const csrf = requiredCookie(request, R23_CSRF_COOKIE);

  return withVerifiedSession(
    active,
    handle,
    digest(csrf),
    async (session, identity, authz) => {
      if (
        session.selectedOrganizationId !== targetOrganizationId.toLowerCase()
      ) {
        throw new R23ScopeDenied();
      }

      let result: R24OrganizationSessionListResult;
      let membership: R23Membership;

      if (
        typeof (authz as unknown as Record<string, unknown>)
          .listOrganizationSessions === 'function'
      ) {
        result = await (
          authz as unknown as {
            listOrganizationSessions: (
              identity: R23VerifiedIdentity,
              organizationId: string,
              query: unknown,
            ) => Promise<R24OrganizationSessionListResult>;
          }
        ).listOrganizationSessions(
          identity,
          targetOrganizationId.toLowerCase(),
          {
            lifecycleFilter: queryParams?.lifecycleFilter,
            reviewStatusFilter: queryParams?.reviewStatusFilter,
            search: queryParams?.search,
            cursor: queryParams?.cursor,
            limit: queryParams?.limit,
          },
        );
        membership = {
          organizationId: result.organizationId,
          role: result.role,
          membershipVersion: String(result.membershipVersion),
        };
      } else {
        membership = await authz.authorizeOrganization(
          identity,
          targetOrganizationId.toLowerCase(),
        );
        result = {
          organizationId: targetOrganizationId.toLowerCase(),
          role: membership.role,
          membershipVersion: Number(membership.membershipVersion) || 1,
          visibilityScope:
            membership.role === 'admin'
              ? 'restricted_role'
              : membership.role === 'recruiter'
                ? 'issued_by_recruiter'
                : 'assigned_to_reviewer',
          sessions: [],
          totalAuthorizedCount: 0,
          filteredAuthorizedCount: 0,
          nextCursor: null,
        };
      }

      const orgDisplay = resolveOrgDisplay(
        targetOrganizationId,
        membership,
        identity.email,
      );

      return {
        identity,
        membership,
        session,
        csrfToken: csrf,
        result,
        organization: {
          id: targetOrganizationId.toLowerCase(),
          name: orgDisplay.name,
          slug: orgDisplay.slug,
          role: membership.role,
        },
      };
    },
  );
}

export async function loadAuthenticatedOrganizationSessionSummary(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<AuthenticatedSessionSummaryContext> {
  const active = getRuntime();
  if (!active) throw new R23AuthUnavailable();
  if (!UUID.test(targetOrganizationId)) throw new R23BadRequest();
  if (!sessionId || sessionId.length > 256) throw new R23BadRequest();

  const handle = requiredCookie(request, R23_SESSION_COOKIE);
  const csrf = requiredCookie(request, R23_CSRF_COOKIE);

  return withVerifiedSession(
    active,
    handle,
    digest(csrf),
    async (session, identity, authz) => {
      if (
        session.selectedOrganizationId !== targetOrganizationId.toLowerCase()
      ) {
        throw new R23ScopeDenied();
      }

      let result: R24OrganizationSessionSummaryResult;
      let membership: R23Membership;

      if (
        typeof (authz as unknown as Record<string, unknown>)
          .getOrganizationSessionSummary === 'function'
      ) {
        result = await (
          authz as unknown as {
            getOrganizationSessionSummary: (
              identity: R23VerifiedIdentity,
              organizationId: string,
              sessionId: string,
            ) => Promise<R24OrganizationSessionSummaryResult>;
          }
        ).getOrganizationSessionSummary(
          identity,
          targetOrganizationId.toLowerCase(),
          sessionId,
        );
        membership = {
          organizationId: result.organizationId,
          role: result.role,
          membershipVersion: String(result.membershipVersion),
        };
      } else {
        membership = await authz.authorizeOrganization(
          identity,
          targetOrganizationId.toLowerCase(),
        );
        result = {
          organizationId: targetOrganizationId.toLowerCase(),
          role: membership.role,
          membershipVersion: Number(membership.membershipVersion) || 1,
          visibilityScope:
            membership.role === 'admin'
              ? 'restricted_role'
              : membership.role === 'recruiter'
                ? 'issued_by_recruiter'
                : 'assigned_to_reviewer',
          session: null,
        };
      }

      const orgDisplay = resolveOrgDisplay(
        targetOrganizationId,
        membership,
        identity.email,
      );

      let reviewers: Array<{
        principalId: string;
        role: string;
        email?: string;
        joinedAt?: string;
      }> = [];
      let assignments: Array<{
        assignmentId: string;
        sessionId: string;
        organizationId?: string;
        reviewerPrincipalId: string;
        assignedByPrincipalId?: string;
        assignedAt: string;
        revokedAt: string | null;
        version: number;
        isActive?: boolean;
      }> = [];

      if (membership.role === 'recruiter') {
        const reviewerRows = await authz.listOrganizationReviewers(
          identity,
          targetOrganizationId.toLowerCase(),
        );
        reviewers = (reviewerRows || []).map((r) => ({
          principalId: r.principalId,
          role: r.role,
          joinedAt:
            r.joinedAt instanceof Date
              ? r.joinedAt.toISOString()
              : String(r.joinedAt),
        }));

        const assignmentRows = await authz.listSessionReviewerAssignments(
          identity,
          targetOrganizationId.toLowerCase(),
          sessionId,
        );
        assignments = (assignmentRows || []).map((a) => ({
          assignmentId: a.assignmentId,
          sessionId: a.sessionId,
          organizationId: a.organizationId,
          reviewerPrincipalId: a.reviewerPrincipalId,
          assignedByPrincipalId: a.assignedByPrincipalId,
          assignedAt:
            a.assignedAt instanceof Date
              ? a.assignedAt.toISOString()
              : String(a.assignedAt),
          revokedAt:
            a.revokedAt instanceof Date
              ? a.revokedAt.toISOString()
              : a.revokedAt
                ? String(a.revokedAt)
                : null,
          version: a.version,
          isActive: a.isActive,
        }));
      }

      return {
        identity,
        membership,
        session,
        csrfToken: csrf,
        result,
        organization: {
          id: targetOrganizationId.toLowerCase(),
          name: orgDisplay.name,
          slug: orgDisplay.slug,
          role: membership.role,
        },
        reviewers,
        assignments,
      };
    },
  );
}

export async function loadAuthenticatedR27Evidence(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
  query: R27EvidenceQuery = {},
): Promise<R27Evidence | null> {
  const active = getRuntime();
  if (!active) throw new R23AuthUnavailable();
  if (
    !UUID.test(targetOrganizationId) ||
    !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
  )
    throw new R23BadRequest();

  const handle = requiredCookie(request, R23_SESSION_COOKIE);
  const csrf = requiredCookie(request, R23_CSRF_COOKIE);

  return withVerifiedSession(
    active,
    handle,
    digest(csrf),
    async (session, identity, authz) => {
      const organizationId = targetOrganizationId.toLowerCase();
      if (session.selectedOrganizationId !== organizationId)
        throw new R23ScopeDenied();

      return authz.getSubmittedEvidence(
        identity,
        organizationId,
        sessionId,
        query,
      );
    },
  );
}

const R27_MAX_SEQUENCE = 9223372036854775807n;

function readR27EvidenceQuery(request: Request): R27EvidenceQuery {
  const params = new URL(request.url).searchParams;
  if (
    [...params.keys()].some((key) => !['afterSequence', 'limit'].includes(key))
  )
    throw new R23BadRequest();

  const afterValues = params.getAll('afterSequence');
  const limitValues = params.getAll('limit');
  if (afterValues.length > 1 || limitValues.length > 1)
    throw new R23BadRequest();

  let afterSequence: string | undefined;
  if (afterValues.length) {
    const value = afterValues[0];
    if (
      !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
      BigInt(value) > R27_MAX_SEQUENCE
    )
      throw new R23BadRequest();
    afterSequence = value;
  }

  const limitValue = limitValues[0];
  const limit = limitValue === undefined ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new R23BadRequest();

  return {
    ...(afterSequence === undefined ? {} : { afterSequence }),
    limit,
  };
}

function asR27JsonRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set('Accept', 'application/json');
  return new Request(request.url, { method: 'GET', headers });
}

export async function r27EvidenceApiGet(
  request: Request,
  organizationId: string,
  sessionId: string,
): Promise<Response> {
  const jsonRequest = asR27JsonRequest(request);
  if (!r27IsEnabled()) return disabledResponse(jsonRequest);

  try {
    const evidence = await loadAuthenticatedR27Evidence(
      request,
      organizationId,
      sessionId,
      readR27EvidenceQuery(request),
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

export async function loadAuthenticatedR28Revision(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
  sequence: string,
): Promise<R28CandidateRevision | null> {
  const active = getRuntime();
  if (!active) throw new R23AuthUnavailable();
  if (
    !UUID.test(targetOrganizationId) ||
    !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
    !/^(0|[1-9][0-9]{0,18})$/.test(sequence)
  ) {
    throw new R23BadRequest();
  }

  const handle = requiredCookie(request, R23_SESSION_COOKIE);
  const csrf = requiredCookie(request, R23_CSRF_COOKIE);

  return withVerifiedSession(
    active,
    handle,
    digest(csrf),
    async (session, identity, authz) => {
      const organizationId = targetOrganizationId.toLowerCase();
      if (session.selectedOrganizationId !== organizationId) {
        throw new R23ScopeDenied();
      }

      return authz.getFileRevision(
        identity,
        organizationId,
        sessionId,
        sequence,
      );
    },
  );
}

export async function r28RevisionApiGet(
  request: Request,
  organizationId: string,
  sessionId: string,
  sequence: string,
): Promise<Response> {
  const jsonRequest = asR27JsonRequest(request);
  if (!r27IsEnabled()) return disabledResponse(jsonRequest);

  try {
    const revision = await loadAuthenticatedR28Revision(
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

export function r23LoginGet(): Response {
  if (!r23IsEnabled()) return disabledResponse();
  try {
    getRuntime();
    return htmlResponse('Evaluator sign in', loginForm());
  } catch {
    return htmlResponse(
      'Sign in unavailable',
      '<p role="alert">The sign-in service is temporarily unavailable.</p>',
      503,
    );
  }
}

export async function r23LoginPost(request: Request): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  try {
    const active = getRuntime();
    if (!active) return disabledResponse(request);
    if (request.headers.get('origin') !== active.config.publicOrigin)
      throw new R23Forbidden();
    const body = await requestBody(request);
    allowedFields(body, ['email', 'password']);
    const email = requiredText(body, 'email', 320);
    const password = requiredText(body, 'password', 1024);
    const pair = await passwordGrant(active.config, email, password);
    const identity = assertR23VerifiedIdentity(
      await verifyR23AccessToken(active.config, pair.accessToken, pair),
    );
    const handle = randomOpaqueValue();
    const csrf = randomOpaqueValue();
    const callback = randomOpaqueValue();
    const envelope = encryptCredentialPair(
      pair,
      active.config.sessionKey,
      identity.subjectId,
      identity.sessionId,
    );
    try {
      await active.sessions.createSession({
        handleHash: digest(handle),
        csrfHash: digest(csrf),
        callbackHash: digest(callback),
        credentialEnvelope: envelope,
        identity,
        expiresAt: new Date(
          Date.now() + active.config.appSessionTtlSeconds * 1000,
        ),
        accessExpiresAt: new Date(identity.expiresAt * 1000),
      });
    } catch {
      try {
        await revokeAuthSession(active.config, pair.accessToken);
      } catch {
        // Local creation failed; no browser session is issued.
      }
      throw new R23InternalUnavailable();
    }
    return redirect(active.config, '/r23/auth/callback', [
      cookieHeader(R23_SESSION_COOKIE, handle, true),
      cookieHeader(R23_CSRF_COOKIE, csrf, false),
      cookieHeader(R23_CALLBACK_COOKIE, callback, true),
    ]);
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function r23CallbackGet(request: Request): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  let sessionPending = false;
  try {
    const active = getRuntime();
    if (!active) return disabledResponse(request);
    if (new URL(request.url).search) throw new R23AuthenticationDenied();
    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrf = requiredCookie(request, R23_CSRF_COOKIE);
    const callback = requiredCookie(request, R23_CALLBACK_COOKIE);
    await active.sessions.withActiveSession(
      { handleHash: digest(handle), csrfHash: digest(csrf) },
      async (session, authz) => {
        if (!session.callbackPending) throw new R23AuthenticationDenied();
        sessionPending = true;
        const pair = decryptCredentialPair(
          session.credentialEnvelope,
          active.config.sessionKey,
          session.subjectId,
          session.authSessionId,
        );
        const identity = assertR23VerifiedIdentity(
          await verifyR23AccessToken(active.config, pair.accessToken),
        );
        sameIdentity(identity, session);
        await authz.consumeCallback(digest(callback));
      },
    );
    return redirect(active.config, '/r23/organizations', [
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

export async function r23OrganizationsGet(request: Request): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  try {
    const active = getRuntime();
    if (!active) return disabledResponse(request);
    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrf = requiredCookie(request, R23_CSRF_COOKIE);
    const memberships: R23Membership[] = await withVerifiedSession(
      active,
      handle,
      digest(csrf),
      async (_session, identity, authz) => authz.listMemberships(identity),
    );
    const items = memberships
      .map((membership) => {
        if (!UUID.test(membership.organizationId))
          throw new R23InternalUnavailable();
        const id = safeHtml(membership.organizationId);
        return `<li><form action="/r23/organization" method="post"><input type="hidden" name="csrf" value="${safeHtml(csrf)}"><input type="hidden" name="organizationId" value="${id}"><button type="submit">Select organization ${id}</button></form></li>`;
      })
      .join('');
    const content = items
      ? `<p>Select one organization for this session.</p><ul>${items}</ul>`
      : '<p>No active organization membership is available for this account.</p>';
    return htmlResponse(
      'Choose an organization',
      `${content}<form action="/r23/auth/logout" method="post"><input type="hidden" name="csrf" value="${safeHtml(csrf)}"><button type="submit">Sign out</button></form>`,
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function r23OrganizationPost(request: Request): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  try {
    const active = getRuntime();
    if (!active) return disabledResponse(request);
    requireSameOrigin(request, active.config);
    const body = await requestBody(request);
    allowedFields(body, ['organizationId', 'csrf']);
    const organizationId = requiredText(body, 'organizationId', 64);
    if (!UUID.test(organizationId)) throw new R23BadRequest();
    const { csrfHash } = requireOriginAndCsrf(request, active.config, body);
    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    await withVerifiedSession(
      active,
      handle,
      csrfHash,
      async (_session, identity, authz) =>
        authz.selectOrganization(identity, organizationId.toLowerCase()),
    );
    return redirect(
      active.config,
      `/r23/organizations/${organizationId.toLowerCase()}`,
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function r23OrganizationGet(
  request: Request,
  organizationId: string,
): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
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

    const context = await loadAuthenticatedOrganizationSessionList(
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
      membership.role === 'admin'
        ? 'Organization admin scope: session access blocked pending P2 ratification'
        : membership.role === 'recruiter'
          ? 'Recruiter scope: sessions issued by your account'
          : membership.role === 'reviewer'
            ? 'Reviewer scope: submitted sessions actively assigned to you'
            : 'Authorized scope: organization sessions';

    let sessionsHtml = '';
    if (result.sessions.length === 0) {
      const emptyExplanation =
        membership.role === 'admin'
          ? 'Organization admin session access remains blocked until P2 access policies are ratified.'
          : membership.role === 'recruiter'
            ? 'No assessment sessions issued by your recruiter account were found in this organization.'
            : membership.role === 'reviewer'
              ? 'No submitted assessment sessions are currently assigned to your reviewer account in this organization.'
              : 'No candidate sessions yet.';

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

      const loadMoreParams = new URLSearchParams();
      if (lifecycleFilter && lifecycleFilter !== 'all') {
        loadMoreParams.set('lifecycle', lifecycleFilter);
      }
      if (reviewStatusFilter && reviewStatusFilter !== 'all') {
        loadMoreParams.set('reviewStatus', reviewStatusFilter);
      }
      if (search) {
        loadMoreParams.set('search', search);
      }
      if (limit !== undefined) {
        loadMoreParams.set('limit', String(limit));
      }
      if (result.nextCursor) {
        loadMoreParams.set('cursor', result.nextCursor);
      }
      sessionsHtml = `
        <div>
          <span>Assessment</span> | <span>Lifecycle</span> | <span>Time budget</span> | <span>Review progress</span> | <span>Action</span>
        </div>
        <ul>${rows}</ul>
        ${result.nextCursor ? `<p><a href="?${safeHtml(loadMoreParams.toString())}">Load more sessions</a></p>` : ''}
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

      <section aria-labelledby="lifecycle-list-title">
        <h2 id="lifecycle-list-title">Session lifecycle</h2>
        <div role="region" aria-label="Authorized visibility scope">
          <p>${safeHtml(roleScopeText)}</p>
        </div>

        ${
          membership.role === 'recruiter'
            ? `
        <section aria-labelledby="issue-assessment-title">
          <h3 id="issue-assessment-title">Issue Assessment</h3>
          <form action="/r23/api/organizations/${safeOrgId}/sessions" method="post" id="issue-assessment-form">
            <input type="hidden" name="csrf" value="${safeCsrf}">
            <label for="scenarioId">
              <span>Scenario:</span>
              <select id="scenarioId" name="scenarioId" required>
                <option value="scenario-002-booking-notification-retry" selected>Scenario 002: The second confirmation</option>
              </select>
            </label>
            <label for="durationMinutes">
              <span>Duration (minutes):</span>
              <select id="durationMinutes" name="durationMinutes" required>
                <option value="30">30</option>
                <option value="45">45</option>
                <option value="60" selected>60</option>
                <option value="90">90</option>
              </select>
            </label>
            <button type="submit">Issue assessment</button>
          </form>
          <p><a href="/r23/organizations/${safeOrgId}/builder">Open Assessment Builder</a></p>
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

    return htmlResponse(
      'Organization workspace',
      content,
      200,
      securityHeaders(),
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function r24OrganizationSessionsApiGet(
  request: Request,
  organizationId: string,
): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
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

    const context = await loadAuthenticatedOrganizationSessionList(
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

    return Response.json(
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
  } catch (error) {
    return failureResponse(request, error);
  }
}

export const r23OrganizationSessionsApiGet = r24OrganizationSessionsApiGet;

export async function r24OrganizationSessionSummaryApiGet(
  request: Request,
  organizationId: string,
  sessionId: string,
): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  try {
    const context = await loadAuthenticatedOrganizationSessionSummary(
      request,
      organizationId,
      sessionId,
    );

    const sessionRecord = context.result.session;
    if (!sessionRecord) {
      return Response.json(
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
      );
    }

    const s = sessionRecord;
    return Response.json(
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
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export const r23OrganizationSessionSummaryApiGet =
  r24OrganizationSessionSummaryApiGet;

export async function r24OrganizationSessionSummaryGet(
  request: Request,
  organizationId: string,
  sessionId: string,
): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  try {
    const context = await loadAuthenticatedOrganizationSessionSummary(
      request,
      organizationId,
      sessionId,
    );

    const sessionRecord = context.result.session;
    if (!sessionRecord) {
      return htmlResponse(
        'Session not found',
        `<p role="alert">Session not available in your authorized organization scope.</p><p><a href="/r23/organizations/${safeHtml(organizationId.toLowerCase())}">Back to organization sessions</a></p>`,
        404,
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
    const showR27Workbench =
      r27IsEnabled() &&
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
          <dt><strong>Lifecycle status:</strong></dt><dd><span>${safeHtml(lifecycleLabel)}</span> ${isTimedOut ? '<span>(Timed out)</span>' : ''}</dd>
          <dt><strong>Review progress:</strong></dt><dd>${safeHtml(reviewLabel)}</dd>
          <dt><strong>Time budget:</strong></dt><dd>${safeHtml(budgetStr)}</dd>
          <dt><strong>Issued:</strong></dt><dd><time datetime="${safeHtml(s.createdAt)}">${safeHtml(s.createdAt)}</time></dd>
          <dt><strong>Started:</strong></dt><dd>${s.activatedAt ? `<time datetime="${safeHtml(s.activatedAt)}">${safeHtml(s.activatedAt)}</time>` : 'Not recorded'}</dd>
          <dt><strong>Submitted:</strong></dt><dd>${s.submittedAt ? `<time datetime="${safeHtml(s.submittedAt)}">${safeHtml(s.submittedAt)}</time>` : 'Not submitted'}</dd>
          <dt><strong>Visibility scope:</strong></dt><dd>${safeHtml(s.visibilityScope ?? 'authorized_scope')}</dd>
        </dl>

        ${showR27Workbench ? `<p><a href="/r27/organizations/${safeOrgId}/sessions/${safeHtml(s.sessionId)}">Open submitted evidence workbench (read only)</a></p>` : ''}

        ${
          membership.role === 'recruiter'
            ? `
        <section aria-labelledby="reviewer-assignments-title">
          <h3 id="reviewer-assignments-title">Reviewer assignments</h3>
          <form action="/r23/api/organizations/${safeOrgId}/sessions/${safeHtml(s.sessionId)}/assignments" method="post" id="assign-reviewer-form">
            <input type="hidden" name="csrf" value="${safeCsrf}">
            <label for="reviewerPrincipalId">
              <span>Assign reviewer:</span>
              <select id="reviewerPrincipalId" name="reviewerPrincipalId" required>
                <option value="">Select an eligible reviewer</option>
                ${(context.reviewers || []).map((r) => `<option value="${safeHtml(r.principalId)}">${safeHtml(r.email ?? r.principalId)} (${safeHtml(r.role)})</option>`).join('')}
              </select>
            </label>
            <button type="submit">Assign reviewer</button>
          </form>
          <h4>Assigned reviewers</h4>
          ${
            context.assignments && context.assignments.length > 0
              ? `<ul>${context.assignments
                  .map(
                    (a) => `
                <li>
                  <span>Reviewer: <code>${safeHtml(a.reviewerPrincipalId)}</code></span>
                  <span>Status: ${a.revokedAt ? 'Revoked' : 'Active'}</span>
                  ${
                    !a.revokedAt
                      ? `
                    <form action="/r23/api/organizations/${safeOrgId}/sessions/${safeHtml(s.sessionId)}/assignments/${safeHtml(a.assignmentId)}/revoke" method="post">
                      <input type="hidden" name="csrf" value="${safeCsrf}">
                      <button type="submit">Revoke assignment</button>
                    </form>
                  `
                      : ''
                  }
                </li>`,
                  )
                  .join('')}</ul>`
              : '<p>No reviewers currently assigned.</p>'
          }
        </section>

        <section aria-labelledby="candidate-token-recovery-title">
          <h3 id="candidate-token-recovery-title">Candidate link & token recovery</h3>
          <p>Availability: <code>${r26IsEnabled() ? 'isolated_editing_only' : 'runtime_not_activated'}</code></p>
          <p>${r26IsEnabled() ? 'Synthetic isolated editing workflow is available. Terminal execution and AI remain unavailable. Do not distribute real invitations.' : 'Notice: Synthetic candidate link issued for evaluation prototype. Workspace runtime is not activated for this assessment session.'}</p>
          <details>
            <summary>Reveal synthetic candidate token</summary>
            <p><a href="/r23/api/organizations/${safeOrgId}/sessions/${safeHtml(s.sessionId)}/candidate-token">Reveal synthetic candidate token</a></p>
          </details>
        </section>
        `
            : ''
        }
        <p><a href="/r23/organizations/${safeOrgId}">Back to organization sessions</a></p>
      </section>
    `;

    return htmlResponse(
      `Session ${s.sessionId.slice(0, 8)} summary`,
      content,
      200,
      securityHeaders(),
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export const r23OrganizationSessionPageGet = r24OrganizationSessionSummaryGet;

export async function r23RefreshPost(request: Request): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  try {
    const active = getRuntime();
    if (!active) return disabledResponse(request);
    requireSameOrigin(request, active.config);
    const body = await optionalRequestBody(request);
    allowedFields(body, ['csrf']);
    const { csrfHash } = requireOriginAndCsrf(request, active.config, body);
    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    await withVerifiedSession(
      active,
      handle,
      csrfHash,
      async () => undefined,
      true,
    );
    return new Response(null, {
      status: 204,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function r23LogoutPost(request: Request): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  let active: R23Runtime | null = null;
  let localClosed = false;
  try {
    active = getRuntime();
    if (!active) return disabledResponse(request);
    requireSameOrigin(request, active.config);
    const body = await optionalRequestBody(request);
    allowedFields(body, ['csrf']);
    const { csrfHash } = requireOriginAndCsrf(request, active.config, body);
    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const revoked = await active.sessions.closeSession(
      digest(handle),
      csrfHash,
    );
    if (!revoked) throw new R23SessionDenied();
    localClosed = true;
    const pair = decryptCredentialPair(
      revoked.credentialEnvelope,
      active.config.sessionKey,
      revoked.subjectId,
      revoked.authSessionId,
    );
    const claims = readR23Claims(pair.accessToken, active.config);
    const needsRefresh =
      claims.exp <= Date.now() / 1000 + REFRESH_AHEAD_SECONDS;
    const grant: R23TokenGrant | undefined = needsRefresh
      ? await refreshGrant(active.config, pair.refreshToken)
      : undefined;
    const activePair: R23CredentialPair = grant ?? pair;
    const identity = assertR23VerifiedIdentity(
      await verifyR23AccessToken(active.config, activePair.accessToken, grant),
    );
    if (
      identity.subjectId !== revoked.subjectId ||
      identity.sessionId !== revoked.authSessionId
    ) {
      throw new R23AuthenticationDenied();
    }
    await revokeAuthSession(active.config, activePair.accessToken);
    const response = new Response(null, {
      status: isJsonRequest(request) ? 204 : 303,
      headers: new Headers({
        'Cache-Control': 'private, no-store',
        ...(!isJsonRequest(request) && active
          ? {
              Location: new URL(
                '/r23/login',
                active.config.publicOrigin,
              ).toString(),
            }
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

// =========================================================================
// R2.5 Assessment Issuance and Reviewer Management APIs
// =========================================================================

export async function r25AssessmentIssuanceApiPost(
  request: Request,
  organizationId: string,
): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  try {
    const active = getRuntime();
    if (!active) return disabledResponse(request);

    // Authentication check first so unauthenticated callers receive 401
    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrfCookieVal = requiredCookie(request, R23_CSRF_COOKIE);

    requireSameOrigin(request, active.config);
    const body = await requestBody(request);
    requireOriginAndCsrf(request, active.config, body);

    if (!UUID.test(organizationId)) throw new R23BadRequest();
    const orgIdLower = organizationId.toLowerCase();

    return await withVerifiedSession(
      active,
      handle,
      digest(csrfCookieVal),
      async (session, identity, authz) => {
        if (session.selectedOrganizationId !== orgIdLower) {
          throw new R23ScopeDenied();
        }

        allowedFields(body, [
          'csrf',
          'scenarioId',
          'scenarioTitle',
          'scenarioVersion',
          'durationMinutes',
          'durationSeconds',
          'terminalEnabled',
          'integratedAi',
          'rubricWeights',
          'generatedAssessmentId',
          'useCuratedBlueprint',
          'sessionId',
          'idempotencyKey',
          'validatedVersionId',
          'validated_version_id',
        ]);

        const membership = await authz.authorizeOrganization(
          identity,
          orgIdLower,
        );
        if (membership.role !== 'recruiter') throw new R23ScopeDenied();

        const rawValidatedVersionId =
          body.validatedVersionId !== undefined
            ? body.validatedVersionId
            : body.validated_version_id;
        let validatedVersion: R211ValidatedVersion | null = null;
        if (
          rawValidatedVersionId !== undefined &&
          rawValidatedVersionId !== null
        ) {
          if (
            typeof rawValidatedVersionId !== 'string' ||
            !UUID.test(rawValidatedVersionId)
          ) {
            throw new R23BadRequest();
          }
          validatedVersion = await authz.getValidatedVersion(
            identity,
            orgIdLower,
            rawValidatedVersionId,
          );
          if (!validatedVersion) {
            throw new R23BadRequest();
          }
        }

        const bodyIdempotencyKey =
          typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
            ? body.idempotencyKey
            : null;
        const headerIdempotencyKey = request.headers.get('idempotency-key');
        const idempotencyKey =
          (bodyIdempotencyKey ?? headerIdempotencyKey)?.trim() || null;
        if (
          idempotencyKey !== null &&
          (!/^[\x21-\x7e]{1,200}$/.test(idempotencyKey) ||
            idempotencyKey.trim() !== idempotencyKey)
        ) {
          throw new R23BadRequest();
        }

        const generatedIdPresent = body.generatedAssessmentId !== undefined;
        const useCuratedBlueprint = parseIssuanceBoolean(
          body.useCuratedBlueprint,
          !generatedIdPresent,
        );
        const mode = validatedVersion
          ? 'authored'
          : useCuratedBlueprint.value === false
            ? 'generated'
            : 'curated';
        const scenarioIdInput =
          body.scenarioId !== undefined
            ? body.scenarioId
            : validatedVersion
              ? (validatedVersion.scenarioId ?? validatedVersion.id)
              : mode === 'generated'
                ? body.generatedAssessmentId
                : scenario002.id;
        const scenarioId =
          typeof scenarioIdInput === 'string' ? scenarioIdInput.trim() : '';
        const generatedAssessmentId =
          typeof body.generatedAssessmentId === 'string'
            ? body.generatedAssessmentId.trim()
            : '';

        let sourceScenario: ScenarioSnapshot | null = null;
        let workspaceFiles: Record<string, string> | null = null;
        let generatedAssessment: Awaited<
          ReturnType<typeof loadValidatedGeneratedAssessment>
        > = null;

        if (validatedVersion) {
          sourceScenario = validatedVersion.scenarioSnapshot
            .scenario as unknown as ScenarioSnapshot;
          workspaceFiles = validatedVersion.scenarioSnapshot.workspaceFiles;
        } else if (
          mode === 'curated' &&
          scenarioId === scenario002.id &&
          !generatedIdPresent
        ) {
          sourceScenario = scenario002;
          workspaceFiles = await readScenarioWorkspaceFiles(scenario002.id);
        } else if (
          mode === 'generated' &&
          generatedAssessmentId &&
          scenarioId === generatedAssessmentId
        ) {
          generatedAssessment = await loadValidatedGeneratedAssessment(
            path.dirname(getApplicationDatabasePath()),
            generatedAssessmentId,
          );
          if (generatedAssessment) {
            sourceScenario = toGeneratedScenarioSnapshot(generatedAssessment);
            workspaceFiles = Object.fromEntries(
              [
                ...generatedAssessment.assessment.starterFiles,
                ...generatedAssessment.assessment.targetTests,
              ]
                .map((file) => [file.path, file.content] as const)
                .sort(([left], [right]) =>
                  left < right ? -1 : left > right ? 1 : 0,
                ),
            );
          }
        }

        const rawDurationMinutes = parseIssuanceInteger(body.durationMinutes);
        const rawDurationSeconds = parseIssuanceInteger(body.durationSeconds);
        const minutesSeconds =
          rawDurationMinutes.valid && rawDurationMinutes.present
            ? Number(rawDurationMinutes.value) * 60
            : null;
        const explicitDurationSeconds =
          rawDurationSeconds.valid && rawDurationSeconds.present
            ? Number(rawDurationSeconds.value)
            : null;
        const durationSeconds = rawDurationMinutes.present
          ? minutesSeconds
          : rawDurationSeconds.present
            ? explicitDurationSeconds
            : (sourceScenario?.durationSeconds ?? null);
        const durationInputsValid =
          rawDurationMinutes.valid &&
          rawDurationSeconds.valid &&
          (!rawDurationMinutes.present ||
            !rawDurationSeconds.present ||
            minutesSeconds === explicitDurationSeconds);

        const terminalEnabled = parseIssuanceBoolean(
          body.terminalEnabled,
          true,
        );
        const integratedAi = parseIssuanceBoolean(
          body.integratedAi !== undefined
            ? body.integratedAi
            : (validatedVersion?.integratedAi ?? false),
          false,
        );
        const isAiEnabled = Boolean(
          integratedAi.value ||
          (validatedVersion && validatedVersion.integratedAi),
        );
        const effectiveAiCapabilitySnapshot = isAiEnabled
          ? defaultSyntheticAiSnapshot
          : disabledAiCapabilitySnapshot;

        const baselineRubric = validatedVersion
          ? (validatedVersion.taskRubricSnapshot as unknown as ReturnType<
              typeof createScenario002TaskRubric
            >)
          : sourceScenario
            ? scenarioId === scenario002.id
              ? createScenario002TaskRubric()
              : (() => {
                  try {
                    if (!generatedAssessment) return null;
                    return createGeneratedTaskRubric({
                      artifactId: generatedAssessment.id,
                      title: generatedAssessment.assessment.title,
                      brief: generatedAssessment.assessment.brief,
                      acceptanceCriteria:
                        generatedAssessment.assessment.acceptanceCriteria,
                      rubric: generatedAssessment.assessment.rubric,
                      integratedAi: false,
                    });
                  } catch (error) {
                    if (error instanceof GeneratedRubricUnavailableError)
                      return null;
                    throw error;
                  }
                })()
            : null;
        const allowedRubricIds =
          baselineRubric?.criteria.map((criterion) => criterion.id) ?? [];
        const requestedRubricWeights = parseRubricWeights(
          body.rubricWeights,
          allowedRubricIds,
        );
        let taskRubricSnapshot = baselineRubric;
        if (
          requestedRubricWeights.valid &&
          requestedRubricWeights.weights &&
          baselineRubric
        ) {
          if (scenarioId === scenario002.id) {
            taskRubricSnapshot = {
              version: baselineRubric.version,
              criteria: baselineRubric.criteria.map((criterion) => ({
                ...criterion,
                weight: requestedRubricWeights.weights![criterion.id]!,
              })),
            };
          } else if (generatedAssessment) {
            try {
              taskRubricSnapshot = createGeneratedTaskRubric({
                artifactId: generatedAssessment.id,
                title: generatedAssessment.assessment.title,
                brief: generatedAssessment.assessment.brief,
                acceptanceCriteria:
                  generatedAssessment.assessment.acceptanceCriteria,
                rubric: generatedAssessment.assessment.rubric,
                integratedAi: false,
                criterionWeights: requestedRubricWeights.weights,
              });
            } catch (error) {
              if (!(error instanceof GeneratedRubricUnavailableError))
                throw error;
              taskRubricSnapshot = null;
            }
          }
        }

        const effectiveDurationSeconds =
          typeof durationSeconds === 'number' &&
          Number.isSafeInteger(durationSeconds)
            ? durationSeconds
            : null;
        const isReservationTemplate =
          validatedVersion?.scenarioId === 'reservation-moves' &&
          validatedVersion.scenarioVersion === 'v3' &&
          (sourceScenario as unknown as Record<string, unknown> | null)
            ?.templateId === 'reservation-moves-v3';
        const snapshotScenario = sourceScenario
          ? {
              ...sourceScenario,
              ...(isReservationTemplate && validatedVersion
                ? {
                    validatedVersionId: validatedVersion.id,
                    validatedContentDigest: validatedVersion.contentDigest,
                  }
                : {}),
              durationSeconds:
                effectiveDurationSeconds ?? sourceScenario.durationSeconds,
            }
          : null;
        const scenarioSnapshotEnvelope =
          snapshotScenario && workspaceFiles
            ? { scenario: snapshotScenario, workspaceFiles }
            : null;

        const suppliedTitle =
          body.scenarioTitle === undefined
            ? (sourceScenario?.title ?? null)
            : body.scenarioTitle;
        const suppliedVersion =
          body.scenarioVersion === undefined
            ? (sourceScenario?.version ?? null)
            : body.scenarioVersion;
        const rubricIntent = requestedRubricWeights.valid
          ? requestedRubricWeights.weights
          : { invalid: body.rubricWeights };
        const canonicalIntent = {
          contract: 'r25-assessment-issuance-v1',
          mode,
          validatedVersionId: validatedVersion ? validatedVersion.id : null,
          contentDigest: validatedVersion
            ? validatedVersion.contentDigest
            : null,
          generatedAssessmentId: generatedIdPresent
            ? typeof body.generatedAssessmentId === 'string'
              ? generatedAssessmentId
              : body.generatedAssessmentId
            : null,
          scenarioId:
            typeof scenarioIdInput === 'string'
              ? scenarioIdInput.trim()
              : scenarioIdInput,
          scenarioTitle: suppliedTitle,
          scenarioVersion: suppliedVersion,
          scenarioSnapshot: scenarioSnapshotEnvelope,
          taskRubricSnapshot,
          durationSeconds: effectiveDurationSeconds,
          durationInputs:
            durationInputsValid &&
            ((!rawDurationMinutes.present && !rawDurationSeconds.present) ||
              effectiveDurationSeconds !== null)
              ? null
              : {
                  minutes: rawDurationMinutes.value,
                  seconds: rawDurationSeconds.value,
                },
          terminalEnabled: terminalEnabled.value,
          integratedAi: isAiEnabled,
          aiCapabilitySnapshot: effectiveAiCapabilitySnapshot,
          rubricWeights: requestedRubricWeights.valid ? null : rubricIntent,
          requestedSessionId:
            body.sessionId === undefined ? null : body.sessionId,
        };
        const requestHash = idempotencyKey
          ? hashCanonicalPayload(canonicalIntent)
          : null;

        // This authorization and replay check deliberately precedes metadata
        // validation so a changed invalid retry conflicts without disclosing
        // whether another issuer has a matching key.
        await authz.validateIssuanceIntent(identity, orgIdLower, {
          idempotencyKey,
          requestHash,
        });

        if (
          bodyIdempotencyKey !== null &&
          headerIdempotencyKey !== null &&
          bodyIdempotencyKey.trim() !== headerIdempotencyKey.trim()
        ) {
          throw new R23BadRequest();
        }
        if (
          !useCuratedBlueprint.valid ||
          (body.useCuratedBlueprint !== undefined &&
            body.useCuratedBlueprint !== true &&
            body.useCuratedBlueprint !== false)
        ) {
          throw new R23BadRequest();
        }
        if (!sourceScenario || !workspaceFiles) {
          if (mode === 'generated') throw new R25AssessmentNotReady();
          throw new R23BadRequest();
        }
        if (
          (body.scenarioTitle !== undefined &&
            body.scenarioTitle !== sourceScenario.title) ||
          (body.scenarioVersion !== undefined &&
            body.scenarioVersion !== sourceScenario.version) ||
          (!validatedVersion && scenarioId !== sourceScenario.id) ||
          (validatedVersion &&
            scenarioId !== sourceScenario.id &&
            scenarioId !== validatedVersion.id &&
            scenarioId !== validatedVersion.scenarioId) ||
          (!validatedVersion && mode === 'curated' && generatedIdPresent) ||
          (!validatedVersion &&
            mode === 'generated' &&
            (!generatedIdPresent ||
              generatedAssessmentId !== sourceScenario.id))
        ) {
          throw new R23BadRequest();
        }
        if (
          !durationInputsValid ||
          ![1800, 2700, 3600, 5400].includes(effectiveDurationSeconds ?? -1)
        ) {
          throw new R23BadRequest();
        }
        if (!terminalEnabled.valid || !integratedAi.valid) {
          throw new R23BadRequest();
        }
        if (
          isReservationTemplate &&
          validatedVersion &&
          (effectiveDurationSeconds !== validatedVersion.durationSeconds ||
            terminalEnabled.value !== validatedVersion.terminalEnabled ||
            integratedAi.value !== validatedVersion.integratedAi ||
            body.rubricWeights !== undefined)
        ) {
          throw new R23BadRequest();
        }
        if (
          terminalEnabled.value === false ||
          (integratedAi.value === true &&
            (!validatedVersion || validatedVersion.integratedAi !== true))
        ) {
          throw new R25CapabilityUnsupported();
        }
        if (!requestedRubricWeights.valid || !taskRubricSnapshot) {
          throw new R23BadRequest();
        }

        const requestedSessionId = body.sessionId;
        if (
          requestedSessionId !== undefined &&
          (typeof requestedSessionId !== 'string' ||
            !/^sess_[A-Za-z0-9_-]{1,128}$/.test(requestedSessionId))
        ) {
          throw new R23BadRequest();
        }
        const sessionId =
          typeof requestedSessionId === 'string'
            ? requestedSessionId
            : `sess_${randomUUID()}`;
        const scenarioTitle = sourceScenario.title;
        const scenarioVersion = sourceScenario.version;
        const payloadHash = hashCanonicalPayload({
          scenarioSnapshot: scenarioSnapshotEnvelope,
          taskRubricSnapshot,
          durationSeconds: effectiveDurationSeconds,
          terminalEnabled: terminalEnabled.value,
          aiCapabilitySnapshot: effectiveAiCapabilitySnapshot,
        });

        const encKey = loadCandidateTokenEncryptionKey();
        await authz.assertCandidateTokenStorage(identity, orgIdLower, encKey);
        const rawCandidateToken = randomBytes(32).toString('base64url');
        const tokenHash = createHash('sha256')
          .update(rawCandidateToken)
          .digest('hex');
        const ciphertext = encryptCandidateToken(
          rawCandidateToken,
          sessionId,
          encKey,
        );

        const result = await authz.issueAssessment(identity, orgIdLower, {
          sessionId,
          scenarioId: sourceScenario.id,
          scenarioVersion,
          scenarioTitle,
          durationSeconds: effectiveDurationSeconds,
          candidateTokenHash: tokenHash,
          candidateTokenCiphertext: ciphertext,
          idempotencyKey,
          requestHash,
          payloadHash,
          terminalEnabled: terminalEnabled.value,
          taskRubricSnapshot,
          aiCapabilitySnapshot: effectiveAiCapabilitySnapshot,
          scenarioSnapshot: canonicalIssuanceJson(scenarioSnapshotEnvelope),
        });

        const status = result.isReplay ? 200 : 201;
        return Response.json(
          {
            sessionId: result.sessionId,
            organizationId: result.organizationId,
            issuerPrincipalId: result.issuerPrincipalId,
            scenarioId: result.scenarioId,
            scenarioVersion: result.scenarioVersion,
            scenarioTitle: result.scenarioTitle,
            status: result.status,
            createdAt:
              result.createdAt instanceof Date
                ? result.createdAt.toISOString()
                : result.createdAt,
            durationSeconds: result.durationSeconds,
            isReplay: result.isReplay,
            candidateBearerAvailabilityStatus: r26IsEnabled()
              ? 'isolated_editing_only'
              : 'runtime_not_activated',
            candidatePath: r26IsEnabled()
              ? `/r26/candidate/${encodeURIComponent(result.sessionId)}`
              : null,
          },
          {
            status,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function r25CandidateTokenRecoveryApiGet(
  request: Request,
  organizationId: string,
  sessionId: string,
): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  try {
    const active = getRuntime();
    if (!active) return disabledResponse(request);

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrfCookieVal = requiredCookie(request, R23_CSRF_COOKIE);

    if (!UUID.test(organizationId)) throw new R23BadRequest();
    const orgIdLower = organizationId.toLowerCase();

    return await withVerifiedSession(
      active,
      handle,
      digest(csrfCookieVal),
      async (session, identity, authz) => {
        if (session.selectedOrganizationId !== orgIdLower) {
          throw new R23ScopeDenied();
        }

        const membership = await authz.authorizeOrganization(
          identity,
          orgIdLower,
        );
        if (membership.role !== 'recruiter') throw new R23ScopeDenied();
        const encKey = loadCandidateTokenEncryptionKey();
        await authz.assertCandidateTokenStorage(identity, orgIdLower, encKey);

        const recovery = await authz.recoverCandidateToken(
          identity,
          orgIdLower,
          sessionId,
        );
        if (!recovery) {
          return Response.json(
            {
              error: {
                code: 'NOT_FOUND',
                message: 'Candidate token not found or not accessible.',
              },
            },
            {
              status: 404,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          );
        }

        const candidateToken = decryptCandidateToken(
          recovery.candidateTokenCiphertext,
          recovery.sessionId,
          encKey,
        );

        return Response.json(
          {
            sessionId: recovery.sessionId,
            candidateToken,
            candidateBearerAvailabilityStatus: r26IsEnabled()
              ? 'isolated_editing_only'
              : 'runtime_not_activated',
            candidatePath: r26IsEnabled()
              ? `/r26/candidate/${encodeURIComponent(recovery.sessionId)}#${candidateToken}`
              : null,
            notice: r26IsEnabled()
              ? 'Synthetic isolated editing workflow only. Terminal execution and AI are unavailable. Do not distribute real invitations.'
              : 'Synthetic candidate link issued for evaluation prototype. Workspace runtime is not activated for this assessment session.',
          },
          {
            status: 200,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function r25OrganizationReviewersApiGet(
  request: Request,
  organizationId: string,
): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  try {
    const active = getRuntime();
    if (!active) return disabledResponse(request);

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrfCookieVal = requiredCookie(request, R23_CSRF_COOKIE);

    if (!UUID.test(organizationId)) throw new R23BadRequest();
    const orgIdLower = organizationId.toLowerCase();

    return await withVerifiedSession(
      active,
      handle,
      digest(csrfCookieVal),
      async (session, identity, authz) => {
        if (session.selectedOrganizationId !== orgIdLower) {
          throw new R23ScopeDenied();
        }

        const rows = await authz.listOrganizationReviewers(
          identity,
          orgIdLower,
        );

        return Response.json(
          {
            organizationId: orgIdLower,
            reviewers: (rows || []).map((r) => ({
              principalId: r.principalId,
              role: r.role,
              joinedAt:
                r.joinedAt instanceof Date
                  ? r.joinedAt.toISOString()
                  : r.joinedAt,
            })),
          },
          {
            status: 200,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function r25SessionAssignmentsApiGet(
  request: Request,
  organizationId: string,
  sessionId: string,
): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  try {
    const active = getRuntime();
    if (!active) return disabledResponse(request);

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrfCookieVal = requiredCookie(request, R23_CSRF_COOKIE);

    if (!UUID.test(organizationId)) throw new R23BadRequest();
    const orgIdLower = organizationId.toLowerCase();

    return await withVerifiedSession(
      active,
      handle,
      digest(csrfCookieVal),
      async (session, identity, authz) => {
        if (session.selectedOrganizationId !== orgIdLower) {
          throw new R23ScopeDenied();
        }

        const rows = await authz.listSessionReviewerAssignments(
          identity,
          orgIdLower,
          sessionId,
        );

        return Response.json(
          {
            organizationId: orgIdLower,
            sessionId,
            assignments: (rows || []).map((a) => ({
              assignmentId: a.assignmentId,
              sessionId: a.sessionId,
              organizationId: a.organizationId,
              reviewerPrincipalId: a.reviewerPrincipalId,
              assignedByPrincipalId: a.assignedByPrincipalId,
              assignedAt:
                a.assignedAt instanceof Date
                  ? a.assignedAt.toISOString()
                  : a.assignedAt,
              revokedAt:
                a.revokedAt instanceof Date
                  ? a.revokedAt.toISOString()
                  : a.revokedAt,
              version: a.version,
              isActive: a.isActive,
            })),
          },
          {
            status: 200,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function r25SessionAssignmentsApiPost(
  request: Request,
  organizationId: string,
  sessionId: string,
): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  try {
    const active = getRuntime();
    if (!active) return disabledResponse(request);

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrfCookieVal = requiredCookie(request, R23_CSRF_COOKIE);

    requireSameOrigin(request, active.config);
    const body = await requestBody(request);
    requireOriginAndCsrf(request, active.config, body);

    if (!UUID.test(organizationId)) throw new R23BadRequest();
    const orgIdLower = organizationId.toLowerCase();

    const reviewerPrincipalId = requiredText(body, 'reviewerPrincipalId', 128);
    const assignmentId =
      typeof body.assignmentId === 'string' && body.assignmentId.trim()
        ? body.assignmentId.trim()
        : `asgn_${randomUUID()}`;

    return await withVerifiedSession(
      active,
      handle,
      digest(csrfCookieVal),
      async (session, identity, authz) => {
        if (session.selectedOrganizationId !== orgIdLower) {
          throw new R23ScopeDenied();
        }

        const result = await authz.assignReviewer(identity, orgIdLower, {
          sessionId,
          reviewerPrincipalId,
          assignmentId,
        });

        const status = result.isReplay ? 200 : 201;
        return Response.json(
          {
            assignmentId: result.assignmentId,
            sessionId: result.sessionId,
            organizationId: result.organizationId,
            reviewerPrincipalId: result.reviewerPrincipalId,
            assignedByPrincipalId: result.assignedByPrincipalId,
            assignedAt:
              result.assignedAt instanceof Date
                ? result.assignedAt.toISOString()
                : result.assignedAt,
            revokedAt:
              result.revokedAt instanceof Date
                ? result.revokedAt.toISOString()
                : result.revokedAt,
            version: result.version,
            isReplay: result.isReplay,
          },
          {
            status,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function r25SessionAssignmentRevocationApi(
  request: Request,
  organizationId: string,
  sessionId: string,
  assignmentId: string,
): Promise<Response> {
  if (!r23IsEnabled()) return disabledResponse(request);
  try {
    const active = getRuntime();
    if (!active) return disabledResponse(request);

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrfCookieVal = requiredCookie(request, R23_CSRF_COOKIE);

    requireSameOrigin(request, active.config);
    const body = await optionalRequestBody(request);
    requireOriginAndCsrf(request, active.config, body);

    if (!UUID.test(organizationId)) throw new R23BadRequest();
    const orgIdLower = organizationId.toLowerCase();

    return await withVerifiedSession(
      active,
      handle,
      digest(csrfCookieVal),
      async (session, identity, authz) => {
        if (session.selectedOrganizationId !== orgIdLower) {
          throw new R23ScopeDenied();
        }

        const result = await authz.revokeReviewerAssignment(
          identity,
          orgIdLower,
          {
            sessionId,
            assignmentId,
          },
        );

        return Response.json(
          {
            revoked: result.revoked ?? true,
            assignmentId: result.assignmentId,
            sessionId: result.sessionId,
            revokedAt:
              result.revokedAt instanceof Date
                ? result.revokedAt.toISOString()
                : result.revokedAt,
          },
          {
            status: 200,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      },
    );
  } catch (error) {
    return failureResponse(request, error);
  }
}

export async function r29ObservationsApiGet(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<Response> {
  const jsonRequest = asR27JsonRequest(request);
  if (!r29IsEnabled()) return disabledResponse(jsonRequest);

  try {
    const active = getRuntime();
    if (!active) throw new R23AuthUnavailable();
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ) {
      throw new R23BadRequest();
    }

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrf = requiredCookie(request, R23_CSRF_COOKIE);

    return await withVerifiedSession(
      active,
      handle,
      digest(csrf),
      async (session, identity, authz) => {
        const organizationId = targetOrganizationId.toLowerCase();
        if (session.selectedOrganizationId !== organizationId) {
          throw new R23ScopeDenied();
        }

        const observations = await authz.listObservations(
          identity,
          organizationId,
          sessionId,
        );

        return Response.json(
          { observations },
          {
            status: 200,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function r29ObservationApiGet(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
  observationId: string,
): Promise<Response> {
  const jsonRequest = asR27JsonRequest(request);
  if (!r29IsEnabled()) return disabledResponse(jsonRequest);

  try {
    const active = getRuntime();
    if (!active) throw new R23AuthUnavailable();
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      !UUID.test(observationId)
    ) {
      throw new R23BadRequest();
    }

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrf = requiredCookie(request, R23_CSRF_COOKIE);

    return await withVerifiedSession(
      active,
      handle,
      digest(csrf),
      async (session, identity, authz) => {
        const organizationId = targetOrganizationId.toLowerCase();
        if (session.selectedOrganizationId !== organizationId) {
          throw new R23ScopeDenied();
        }

        const observation = await authz.getObservation(
          identity,
          organizationId,
          sessionId,
          observationId,
        );

        if (!observation) {
          return Response.json(
            { error: { code: 'NOT_FOUND', message: 'Observation not found.' } },
            {
              status: 404,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          );
        }

        return Response.json(
          { observation },
          {
            status: 200,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function r29ObservationApiPost(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<Response> {
  const jsonRequest = asR27JsonRequest(request);
  if (!r29IsEnabled()) return disabledResponse(jsonRequest);

  try {
    const active = getRuntime();
    if (!active) throw new R23AuthUnavailable();
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ) {
      throw new R23BadRequest();
    }

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrfCookieVal = requiredCookie(request, R23_CSRF_COOKIE);

    requireSameOrigin(request, active.config);
    const body = await requestBody(request, 65536);
    requireOriginAndCsrf(request, active.config, body);

    const validation = validateCreateObservationInput(body);
    if (!validation.valid || !validation.value) {
      throw new R23BadRequest();
    }

    return await withVerifiedSession(
      active,
      handle,
      digest(csrfCookieVal),
      async (session, identity, authz) => {
        const organizationId = targetOrganizationId.toLowerCase();
        if (session.selectedOrganizationId !== organizationId) {
          throw new R23ScopeDenied();
        }

        const observation = await authz.createObservation(
          identity,
          organizationId,
          sessionId,
          validation.value!,
        );

        return Response.json(
          { observation },
          {
            status: 201,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function r29ObservationApiPatch(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
  observationId: string,
): Promise<Response> {
  const jsonRequest = asR27JsonRequest(request);
  if (!r29IsEnabled()) return disabledResponse(jsonRequest);

  try {
    const active = getRuntime();
    if (!active) throw new R23AuthUnavailable();
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      !UUID.test(observationId)
    ) {
      throw new R23BadRequest();
    }

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrfCookieVal = requiredCookie(request, R23_CSRF_COOKIE);

    requireSameOrigin(request, active.config);
    const body = await requestBody(request, 65536);
    requireOriginAndCsrf(request, active.config, body);

    const validation = validateUpdateObservationInput(body);
    if (!validation.valid || !validation.value) {
      throw new R23BadRequest();
    }

    return await withVerifiedSession(
      active,
      handle,
      digest(csrfCookieVal),
      async (session, identity, authz) => {
        const organizationId = targetOrganizationId.toLowerCase();
        if (session.selectedOrganizationId !== organizationId) {
          throw new R23ScopeDenied();
        }

        try {
          const observation = await authz.updateObservation(
            identity,
            organizationId,
            sessionId,
            observationId,
            validation.value!,
          );

          return Response.json(
            { observation },
            {
              status: 200,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          );
        } catch (updateError) {
          const errCode = getErrorCode(updateError);
          const isConflict =
            errCode === 'CONCURRENCY_CONFLICT' ||
            errCode === 'VERSION_CONFLICT' ||
            (typeof updateError === 'object' &&
              updateError !== null &&
              'status' in updateError &&
              (updateError as { status: unknown }).status === 409) ||
            (updateError instanceof Error &&
              (updateError.message.includes('concurrency') ||
                updateError.message.includes('version conflict') ||
                updateError.message.includes('concurrently')));

          if (isConflict) {
            return Response.json(
              {
                error: {
                  code: 'CONCURRENCY_CONFLICT',
                  message:
                    'Edit conflict: this observation was updated concurrently. Please refresh.',
                },
              },
              {
                status: 409,
                headers: {
                  'Cache-Control': 'private, no-store, max-age=0',
                  'Content-Type': 'application/json; charset=utf-8',
                },
              },
            );
          }
          throw updateError;
        }
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function r210ReviewPacketApiGet(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<Response> {
  const jsonRequest = asR27JsonRequest(request);
  if (!r210IsEnabled()) return disabledResponse(jsonRequest);

  try {
    const active = getRuntime();
    if (!active) throw new R23AuthUnavailable();
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ) {
      throw new R23BadRequest();
    }

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrf = requiredCookie(request, R23_CSRF_COOKIE);

    return await withVerifiedSession(
      active,
      handle,
      digest(csrf),
      async (session, identity, authz) => {
        const organizationId = targetOrganizationId.toLowerCase();
        if (session.selectedOrganizationId !== organizationId) {
          throw new R23ScopeDenied();
        }

        const reviewPacket = await authz.getReviewPacket(
          identity,
          organizationId,
          sessionId,
        );

        return Response.json(
          { reviewPacket: reviewPacket ?? null },
          {
            status: 200,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function r210ReviewPacketApiPut(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<Response> {
  const jsonRequest = asR27JsonRequest(request);
  if (!r210IsEnabled()) return disabledResponse(jsonRequest);

  try {
    const active = getRuntime();
    if (!active) throw new R23AuthUnavailable();
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ) {
      throw new R23BadRequest();
    }

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrfCookieVal = requiredCookie(request, R23_CSRF_COOKIE);

    requireSameOrigin(request, active.config);
    const body = await requestBody(request, 131072);
    requireOriginAndCsrf(request, active.config, body);

    const validation = validateSaveDraftInput(body);
    if (!validation.valid || !validation.value) {
      return Response.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message:
              validation.errors?.join(' ') ??
              'Invalid review packet draft input.',
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

    return await withVerifiedSession(
      active,
      handle,
      digest(csrfCookieVal),
      async (session, identity, authz) => {
        const organizationId = targetOrganizationId.toLowerCase();
        if (session.selectedOrganizationId !== organizationId) {
          throw new R23ScopeDenied();
        }

        try {
          const reviewPacket = await authz.saveReviewPacketDraft(
            identity,
            organizationId,
            sessionId,
            validation.value!,
          );

          return Response.json(
            { reviewPacket },
            {
              status: 200,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          );
        } catch (saveError: unknown) {
          const errCode = getErrorCode(saveError);
          const saveErrorObj =
            typeof saveError === 'object' && saveError !== null
              ? (saveError as Record<string, unknown>)
              : null;
          const sqlState = saveErrorObj?.code ?? saveErrorObj?.sqlState;
          const isConflict =
            errCode === 'CONCURRENCY_CONFLICT' ||
            errCode === 'VERSION_CONFLICT' ||
            sqlState === 'R2104' ||
            saveErrorObj?.status === 409 ||
            (saveError instanceof Error &&
              (saveError.name === 'R210ConcurrencyConflict' ||
                saveError.message.includes('concurrency') ||
                saveError.message.includes('version conflict') ||
                saveError.message.includes('concurrently')));

          if (isConflict) {
            return Response.json(
              {
                error: {
                  code: 'CONCURRENCY_CONFLICT',
                  message: CONCURRENCY_CONFLICT_MESSAGE,
                },
              },
              {
                status: 409,
                headers: {
                  'Cache-Control': 'private, no-store, max-age=0',
                  'Content-Type': 'application/json; charset=utf-8',
                },
              },
            );
          }

          const isImmutable =
            errCode === 'FINALIZED_PACKET_IMMUTABLE' ||
            sqlState === 'R2103' ||
            (saveError instanceof Error &&
              (saveError.name === 'R210FinalizedPacketImmutable' ||
                saveError.message.includes('finalized')));

          if (isImmutable) {
            return Response.json(
              {
                error: {
                  code: 'FINALIZED_PACKET_IMMUTABLE',
                  message: REVIEW_PACKET_FINALIZED_NOTICE,
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

          const isEvidenceMismatch =
            errCode === 'EVIDENCE_MISMATCH' ||
            errCode === 'INVALID_ANCHOR' ||
            sqlState === 'R2102' ||
            (saveError instanceof Error &&
              (saveError.name === 'R210EvidenceMismatch' ||
                saveError.message.includes('evidence mismatch') ||
                saveError.message.includes(
                  'referenced evidence does not exist',
                ) ||
                saveError.message.includes(
                  'referenced observation does not exist',
                )));

          if (isEvidenceMismatch) {
            return Response.json(
              {
                error: {
                  code: 'EVIDENCE_MISMATCH',
                  message:
                    'The referenced observation or evidence does not exist in this session.',
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

          throw saveError;
        }
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function r210ReviewPacketFinalizeApiPost(
  request: Request,
  targetOrganizationId: string,
  sessionId: string,
): Promise<Response> {
  const jsonRequest = asR27JsonRequest(request);
  if (!r210IsEnabled()) return disabledResponse(jsonRequest);

  try {
    const active = getRuntime();
    if (!active) throw new R23AuthUnavailable();
    if (
      !UUID.test(targetOrganizationId) ||
      !/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ) {
      throw new R23BadRequest();
    }

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrfCookieVal = requiredCookie(request, R23_CSRF_COOKIE);

    requireSameOrigin(request, active.config);
    const body = await requestBody(request, 65536);
    requireOriginAndCsrf(request, active.config, body);

    const validation = validateFinalizePacketInput(body);
    if (!validation.valid || !validation.value) {
      return Response.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: validation.errors?.join(' ') ?? 'Invalid finalize input.',
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

    return await withVerifiedSession(
      active,
      handle,
      digest(csrfCookieVal),
      async (session, identity, authz) => {
        const organizationId = targetOrganizationId.toLowerCase();
        if (session.selectedOrganizationId !== organizationId) {
          throw new R23ScopeDenied();
        }

        try {
          const reviewPacket = await authz.finalizeReviewPacket(
            identity,
            organizationId,
            sessionId,
            validation.value!,
          );

          return Response.json(
            { reviewPacket },
            {
              status: 200,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          );
        } catch (finalizeError: unknown) {
          const errCode = getErrorCode(finalizeError);
          const finalizeErrorObj =
            typeof finalizeError === 'object' && finalizeError !== null
              ? (finalizeError as Record<string, unknown>)
              : null;
          const sqlState = finalizeErrorObj?.code ?? finalizeErrorObj?.sqlState;
          const isConflict =
            errCode === 'CONCURRENCY_CONFLICT' ||
            errCode === 'VERSION_CONFLICT' ||
            sqlState === 'R2104' ||
            finalizeErrorObj?.status === 409 ||
            (finalizeError instanceof Error &&
              (finalizeError.name === 'R210ConcurrencyConflict' ||
                finalizeError.message.includes('concurrency') ||
                finalizeError.message.includes('version conflict') ||
                finalizeError.message.includes('concurrently')));

          if (isConflict) {
            return Response.json(
              {
                error: {
                  code: 'CONCURRENCY_CONFLICT',
                  message: CONCURRENCY_CONFLICT_MESSAGE,
                },
              },
              {
                status: 409,
                headers: {
                  'Cache-Control': 'private, no-store, max-age=0',
                  'Content-Type': 'application/json; charset=utf-8',
                },
              },
            );
          }

          const isImmutable =
            errCode === 'FINALIZED_PACKET_IMMUTABLE' ||
            sqlState === 'R2103' ||
            (finalizeError instanceof Error &&
              (finalizeError.name === 'R210FinalizedPacketImmutable' ||
                finalizeError.message.includes('finalized')));

          if (isImmutable) {
            return Response.json(
              {
                error: {
                  code: 'FINALIZED_PACKET_IMMUTABLE',
                  message: REVIEW_PACKET_FINALIZED_NOTICE,
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

          const isNotReady =
            errCode === 'PACKET_NOT_FINALIZABLE' ||
            errCode === 'INVALID_REQUEST' ||
            sqlState === 'R2105' ||
            (finalizeError instanceof Error &&
              (finalizeError.name === 'R210PacketNotFinalizable' ||
                finalizeError.message.includes('summary') ||
                finalizeError.message.includes('citation') ||
                finalizeError.message.includes('reference')));

          if (isNotReady) {
            return Response.json(
              {
                error: {
                  code: 'INVALID_REQUEST',
                  message:
                    finalizeError instanceof Error
                      ? finalizeError.message
                      : 'Review packet cannot be finalized without a summary and at least one citation.',
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

          throw finalizeError;
        }
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function r211AssessmentDraftApiGet(
  request: Request,
  targetOrganizationId: string,
): Promise<Response> {
  const jsonRequest = asR27JsonRequest(request);
  try {
    const active = getRuntime();
    if (!active) throw new R23AuthUnavailable();
    if (!UUID.test(targetOrganizationId)) throw new R23BadRequest();

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrf = requiredCookie(request, R23_CSRF_COOKIE);

    return await withVerifiedSession(
      active,
      handle,
      digest(csrf),
      async (session, identity, authz) => {
        const organizationId = targetOrganizationId.toLowerCase();
        if (session.selectedOrganizationId !== organizationId) {
          throw new R23ScopeDenied();
        }

        const draft = await authz.getAssessmentDraft(identity, organizationId);
        return Response.json(
          { draft: draft ?? null },
          {
            status: 200,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function r211AssessmentDraftApiPut(
  request: Request,
  targetOrganizationId: string,
): Promise<Response> {
  const jsonRequest = asR27JsonRequest(request);
  try {
    const active = getRuntime();
    if (!active) throw new R23AuthUnavailable();
    if (!UUID.test(targetOrganizationId)) throw new R23BadRequest();

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrfCookieVal = requiredCookie(request, R23_CSRF_COOKIE);

    requireSameOrigin(request, active.config);
    const body = await requestBody(request, 262144);
    requireOriginAndCsrf(request, active.config, body);

    return await withVerifiedSession(
      active,
      handle,
      digest(csrfCookieVal),
      async (session, identity, authz) => {
        const organizationId = targetOrganizationId.toLowerCase();
        if (session.selectedOrganizationId !== organizationId) {
          throw new R23ScopeDenied();
        }

        try {
          if (
            body.templateId !== undefined &&
            body.templateId !== 'custom' &&
            body.templateId !== 'reservation-moves-v3'
          )
            throw new R23BadRequest();
          const draft = await authz.saveAssessmentDraft(
            identity,
            organizationId,
            body as unknown as R211AssessmentDraftInput,
          );
          return Response.json(
            { draft },
            {
              status: 200,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          );
        } catch (saveError: unknown) {
          const errCode = getErrorCode(saveError);
          const saveErrorObj =
            typeof saveError === 'object' && saveError !== null
              ? (saveError as Record<string, unknown>)
              : null;
          const isConflict =
            errCode === 'DRAFT_CONCURRENCY_CONFLICT' ||
            errCode === 'CONCURRENCY_CONFLICT' ||
            saveErrorObj?.code === '23505' ||
            saveErrorObj?.sqlState === '23505' ||
            saveErrorObj?.status === 409 ||
            (saveError instanceof Error &&
              (saveError.name === 'R211ConcurrencyConflict' ||
                saveError.message.includes('DRAFT_CONCURRENCY_CONFLICT') ||
                saveError.message.includes('concurrently')));

          if (isConflict) {
            return Response.json(
              {
                error: {
                  code: 'DRAFT_CONCURRENCY_CONFLICT',
                  message:
                    'Edit conflict: this assessment draft was updated concurrently.',
                },
              },
              {
                status: 409,
                headers: {
                  'Cache-Control': 'private, no-store, max-age=0',
                  'Content-Type': 'application/json; charset=utf-8',
                },
              },
            );
          }

          throw saveError;
        }
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function r211AssessmentValidateApiPost(
  request: Request,
  targetOrganizationId: string,
): Promise<Response> {
  const jsonRequest = asR27JsonRequest(request);
  try {
    const active = getRuntime();
    if (!active) throw new R23AuthUnavailable();
    if (!UUID.test(targetOrganizationId)) throw new R23BadRequest();

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrfCookieVal = requiredCookie(request, R23_CSRF_COOKIE);

    requireSameOrigin(request, active.config);
    const body = await requestBody(request, 262144);
    requireOriginAndCsrf(request, active.config, body);

    return await withVerifiedSession(
      active,
      handle,
      digest(csrfCookieVal),
      async (session, identity, authz) => {
        const organizationId = targetOrganizationId.toLowerCase();
        if (session.selectedOrganizationId !== organizationId) {
          throw new R23ScopeDenied();
        }

        let draftToValidate: R211AssessmentDraftInput =
          body as unknown as R211AssessmentDraftInput;
        if (
          typeof body.definitionId === 'string' &&
          UUID.test(body.definitionId) &&
          !body.starterFiles
        ) {
          const loadedDraft = await authz.getAssessmentDraft(
            identity,
            organizationId,
            body.definitionId,
          );
          if (!loadedDraft) throw new R23BadRequest();
          draftToValidate = loadedDraft;
        }

        if (
          draftToValidate.templateId !== undefined &&
          draftToValidate.templateId !== 'custom' &&
          draftToValidate.templateId !== 'reservation-moves-v3'
        )
          throw new R23BadRequest();
        draftToValidate = normalizeAssessmentTemplate(draftToValidate);
        const validationResult = validateAssessmentDraft(draftToValidate);
        if (!validationResult.valid) {
          return Response.json(
            {
              valid: false,
              issues: validationResult.issues,
              executionValidationAvailable: false,
              executionValidationNotice:
                validationResult.executionValidationNotice,
            },
            {
              status: 422,
              headers: {
                'Cache-Control': 'private, no-store, max-age=0',
                'Content-Type': 'application/json; charset=utf-8',
              },
            },
          );
        }

        // Save current draft first if input was provided directly
        const savedDraft = await authz.saveAssessmentDraft(
          identity,
          organizationId,
          draftToValidate,
        );

        const validatedVersion = await authz.createValidatedVersion(
          identity,
          organizationId,
          savedDraft.definitionId,
          savedDraft.version,
        );

        return Response.json(
          { valid: true, version: validatedVersion, draft: savedDraft },
          {
            status: 200,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}

export async function r211AssessmentVersionApiGet(
  request: Request,
  targetOrganizationId: string,
  versionId: string,
): Promise<Response> {
  const jsonRequest = asR27JsonRequest(request);
  try {
    const active = getRuntime();
    if (!active) throw new R23AuthUnavailable();
    if (!UUID.test(targetOrganizationId) || !UUID.test(versionId)) {
      throw new R23BadRequest();
    }

    const handle = requiredCookie(request, R23_SESSION_COOKIE);
    const csrf = requiredCookie(request, R23_CSRF_COOKIE);

    return await withVerifiedSession(
      active,
      handle,
      digest(csrf),
      async (session, identity, authz) => {
        const organizationId = targetOrganizationId.toLowerCase();
        if (session.selectedOrganizationId !== organizationId) {
          throw new R23ScopeDenied();
        }

        const version = await authz.getValidatedVersion(
          identity,
          organizationId,
          versionId,
        );
        if (!version) {
          return Response.json(
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
          );
        }

        return Response.json(
          { version },
          {
            status: 200,
            headers: {
              'Cache-Control': 'private, no-store, max-age=0',
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        );
      },
    );
  } catch (error) {
    return failureResponse(jsonRequest, error);
  }
}
