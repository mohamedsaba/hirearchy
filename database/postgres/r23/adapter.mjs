import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { Pool } from 'pg';
import { mapR27Evidence, R27EvidenceIntegrityError } from '../r27/adapter.mjs';
import {
  installR211AuthoringFixture,
  saveAssessmentDraft as r211SaveAssessmentDraft,
  getAssessmentDraft as r211GetAssessmentDraft,
  listAssessmentDefinitions as r211ListAssessmentDefinitions,
  createValidatedVersion as r211CreateValidatedVersion,
  getValidatedVersion as r211GetValidatedVersion,
  R211ConcurrencyConflict,
} from '../r211/adapter.mjs';

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^sess_[A-Za-z0-9_-]{1,128}$/;
const SEQUENCE = /^(0|[1-9][0-9]{0,18})$/;
const MAX_INT8 = 9_223_372_036_854_775_807n;
const CANDIDATE_TOKEN_KEY_VARIABLE = 'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY';
const STORAGE_MARKER_VERSION = 1;

export class R23SessionDenied extends Error {
  constructor() {
    super('Authentication session denied');
    this.name = 'R23SessionDenied';
    this.code = 'SESSION_DENIED';
  }
}

export class R23ScopeDenied extends Error {
  constructor() {
    super('Organization scope denied');
    this.name = 'R23ScopeDenied';
    this.code = 'SCOPE_DENIED';
  }
}

export class R23PersistenceError extends Error {
  constructor() {
    super('Authentication session storage unavailable');
    this.name = 'R23PersistenceError';
    this.code = 'SESSION_STORAGE_UNAVAILABLE';
  }
}

export class R25IdempotencyConflict extends Error {
  constructor(
    message = 'Idempotency key already exists with different request parameters',
  ) {
    super(message);
    this.name = 'R25IdempotencyConflict';
    this.code = 'IDEMPOTENCY_KEY_CONFLICT';
  }
}

export class R29ConcurrencyConflict extends Error {
  constructor(
    message = 'Edit conflict: this observation was updated concurrently.',
  ) {
    super(message);
    this.name = 'R29ConcurrencyConflict';
    this.code = 'CONCURRENCY_CONFLICT';
    this.sqlState = 'R2904';
    this.status = 409;
  }
}

export class R29EvidenceMismatch extends Error {
  constructor(
    message = 'The referenced evidence does not exist in this session.',
  ) {
    super(message);
    this.name = 'R29EvidenceMismatch';
    this.code = 'INVALID_ANCHOR';
    this.sqlState = 'R2902';
    this.status = 400;
  }
}

export class R210ConcurrencyConflict extends Error {
  constructor(
    message = 'Edit conflict: this review packet was updated concurrently.',
  ) {
    super(message);
    this.name = 'R210ConcurrencyConflict';
    this.code = 'CONCURRENCY_CONFLICT';
    this.sqlState = 'R2104';
    this.status = 409;
  }
}

export class R210EvidenceMismatch extends Error {
  constructor(
    message = 'The referenced evidence or observation does not exist in this session.',
  ) {
    super(message);
    this.name = 'R210EvidenceMismatch';
    this.code = 'INVALID_REFERENCE';
    this.sqlState = 'R2102';
    this.status = 400;
  }
}

export class R210FinalizedPacketImmutable extends Error {
  constructor(
    message = 'This review packet is finalized and cannot be modified.',
  ) {
    super(message);
    this.name = 'R210FinalizedPacketImmutable';
    this.code = 'PACKET_FINALIZED';
    this.sqlState = 'R2105';
    this.status = 400;
  }
}

export function loadCandidateTokenEncryptionKey(
  value = process.env[CANDIDATE_TOKEN_KEY_VARIABLE],
) {
  if (!value) {
    const error = new Error(
      `${CANDIDATE_TOKEN_KEY_VARIABLE} must be configured before candidate links can be issued or recovered.`,
    );
    error.code = 'CANDIDATE_TOKEN_KEY_MISSING';
    throw error;
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    const error = new Error(
      `${CANDIDATE_TOKEN_KEY_VARIABLE} must be canonical base64 for exactly 32 bytes.`,
    );
    error.code = 'CANDIDATE_TOKEN_KEY_INVALID';
    throw error;
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    const error = new Error(
      `${CANDIDATE_TOKEN_KEY_VARIABLE} must be canonical base64 for exactly 32 bytes.`,
    );
    error.code = 'CANDIDATE_TOKEN_KEY_INVALID';
    throw error;
  }
  return key;
}

export function candidateTokenKeyCheck(databaseId, key) {
  return createHmac('sha256', key)
    .update(`hirearchy:candidate-token-storage:v${STORAGE_MARKER_VERSION}:`)
    .update(databaseId)
    .digest('base64url');
}

export async function readCandidateTokenStorageMeta(clientOrPool) {
  try {
    const { rows } = await clientOrPool.query(
      'SELECT slot, version, database_id, key_check FROM hirearchy.candidate_token_storage_meta WHERE slot = 1',
    );
    if (rows.length === 0) return null;
    return rows[0];
  } catch {
    const { rows } = await clientOrPool.query(
      'SELECT slot, version, database_id, key_check FROM r25.get_candidate_token_storage_meta()',
    );
    if (rows.length === 0) return null;
    return rows[0];
  }
}

export async function assertCandidateTokenStorage(
  clientOrPool,
  { key = loadCandidateTokenEncryptionKey() } = {},
) {
  const marker = await readCandidateTokenStorageMeta(clientOrPool);
  if (!marker) {
    const error = new Error(
      'This database needs explicit candidate-link storage adoption.',
    );
    error.code = 'CANDIDATE_TOKEN_STORAGE_UNBOUND';
    throw error;
  }
  if (
    marker.version !== STORAGE_MARKER_VERSION ||
    typeof marker.database_id !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(marker.database_id) ||
    typeof marker.key_check !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(marker.key_check)
  ) {
    const error = new Error(
      'Candidate-link storage metadata is invalid or unsupported.',
    );
    error.code = 'CANDIDATE_TOKEN_STORAGE_MARKER_INVALID';
    throw error;
  }
  const expected = Buffer.from(candidateTokenKeyCheck(marker.database_id, key));
  const actual = Buffer.from(marker.key_check);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    const error = new Error(
      'The configured candidate-link key does not match this database.',
    );
    error.code = 'CANDIDATE_TOKEN_KEY_MISMATCH';
    throw error;
  }
  return marker;
}

export async function initializeCandidateTokenStorage(
  clientOrPool,
  { key = loadCandidateTokenEncryptionKey(), databaseId = null } = {},
) {
  const existing = await readCandidateTokenStorageMeta(clientOrPool);
  if (existing) {
    const error = new Error('Candidate-link storage metadata already exists.');
    error.code = 'CANDIDATE_TOKEN_STORAGE_EXISTS';
    throw error;
  }
  const id = databaseId ?? randomBytes(16).toString('base64url');
  const check = candidateTokenKeyCheck(id, key);
  await clientOrPool.query(
    `INSERT INTO hirearchy.candidate_token_storage_meta (slot, version, database_id, key_check)
     VALUES (1, $1, $2, $3)`,
    [STORAGE_MARKER_VERSION, id, check],
  );
  return { version: STORAGE_MARKER_VERSION, databaseId: id, keyCheck: check };
}

function requiredHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new TypeError(`A valid ${label} digest is required`);
  }
  return value;
}

function requiredUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError(`A valid ${label} is required`);
  }
  return value.toLowerCase();
}

function requiredDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`A valid ${label} is required`);
  }
  const copy = new Date(value.getTime());
  if (copy.getTime() <= Date.now())
    throw new TypeError(`${label} must be in the future`);
  return copy;
}

function requiredEnvelope(value) {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > 65536) {
    throw new TypeError('A valid encrypted credential envelope is required');
  }
  return Buffer.from(value);
}

function sameDigest(left, right) {
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function assertPool(pool) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A restricted R2.3 PostgreSQL pool is required');
  }
}

function verifiedIdentity(assertVerifiedIdentity, value) {
  let identity;
  try {
    identity = assertVerifiedIdentity(value);
  } catch {
    throw new R23SessionDenied();
  }
  if (
    !identity ||
    typeof identity !== 'object' ||
    !UUID.test(identity.subjectId ?? '') ||
    !UUID.test(identity.sessionId ?? '') ||
    (identity.assurance !== 'aal1' && identity.assurance !== 'aal2')
  ) {
    throw new R23SessionDenied();
  }
  return {
    subjectId: identity.subjectId.toLowerCase(),
    sessionId: identity.sessionId.toLowerCase(),
    assurance: identity.assurance,
  };
}

async function query(client, sql, values) {
  try {
    return values === undefined
      ? await client.query(sql)
      : await client.query(sql, values);
  } catch (error) {
    if (error?.code === 'R2301') throw new R23SessionDenied();
    if (error?.code === 'R2401') throw new R23ScopeDenied();
    if (error?.code === 'R2904') {
      throw new R29ConcurrencyConflict();
    }
    if (error?.code === 'R2902') {
      throw new R29EvidenceMismatch(error.message);
    }
    if (error?.code === 'R2104') {
      throw new R210ConcurrencyConflict(error.message);
    }
    if (error?.code === 'R2102') {
      throw new R210EvidenceMismatch(error.message);
    }
    if (error?.code === 'R2105') {
      throw new R210FinalizedPacketImmutable(error.message);
    }
    if (
      error?.code === '23505' ||
      (typeof error?.code === 'string' &&
        (error.code.startsWith('R25') ||
          error.code.startsWith('R28') ||
          error.code.startsWith('R29') ||
          error.code.startsWith('R210'))) ||
      error?.message === 'IDEMPOTENCY_KEY_CONFLICT'
    ) {
      throw error;
    }
    throw new R23PersistenceError();
  }
}

async function verifyRuntimeRole(client) {
  const { rows } = await query(
    client,
    `SELECT current_user::pg_catalog.text AS role_name,
            session_user::pg_catalog.text AS login_name,
            role.rolcanlogin, role.rolsuper, role.rolbypassrls,
            role.rolcreatedb, role.rolcreaterole, role.rolreplication,
            role.rolinherit,
            EXISTS (
              SELECT 1 FROM pg_catalog.pg_auth_members AS membership
              WHERE membership.roleid = role.oid OR membership.member = role.oid
            ) AS has_role_membership,
            namespace.nspowner = role.oid AS owns_schema,
            EXISTS (
              SELECT 1 FROM pg_catalog.pg_class AS relation
              WHERE relation.relnamespace = namespace.oid
                AND relation.relowner = role.oid
            ) AS owns_table
       FROM pg_catalog.pg_roles AS role
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = 'r23'
      WHERE role.rolname = current_user`,
  );
  const role = rows[0];
  if (
    !role ||
    role.role_name !== 'r23_gateway' ||
    role.login_name !== 'r23_gateway' ||
    !role.rolcanlogin ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.rolinherit ||
    role.has_role_membership ||
    role.owns_schema ||
    role.owns_table
  ) {
    throw new R23PersistenceError();
  }
}

async function inTransaction(pool, work) {
  let client;
  try {
    client = await pool.connect();
  } catch {
    throw new R23PersistenceError();
  }
  let transactionStarted = false;
  let discard = false;
  const onClientError = () => {
    discard = true;
  };
  client.on?.('error', onClientError);
  try {
    await verifyRuntimeRole(client);
    await query(client, 'BEGIN');
    transactionStarted = true;
    const result = await work(client);
    await query(client, 'COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await query(client, 'ROLLBACK');
      } catch {
        discard = true;
      }
    }
    throw error;
  } finally {
    client.removeListener?.('error', onClientError);
    client.release(discard);
  }
}

function membershipRow(row) {
  return {
    organizationId: row.organization_id,
    role: row.role,
    membershipVersion: row.membership_version,
  };
}

function isLoopback(hostname) {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  if (host === '::1') return true;
  if (isIP(host) !== 4) return false;
  return Number(host.split('.')[0]) === 127;
}

function validateConnectionString(connectionString) {
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new TypeError('An explicit PostgreSQL connection string is required');
  }
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new TypeError('A valid PostgreSQL connection URL is required');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new TypeError(
      'A postgres: or postgresql: connection URL is required',
    );
  }
  if (!isLoopback(url.hostname)) {
    throw new TypeError('PostgreSQL connection host must be loopback');
  }
  if (!url.port) {
    throw new TypeError('PostgreSQL connection port is required');
  }
  if (url.username !== 'r23_gateway') {
    throw new TypeError('PostgreSQL connection user must be r23_gateway');
  }
  if (!url.password) {
    throw new TypeError('PostgreSQL connection password is required');
  }
  if (url.pathname !== '/postgres') {
    throw new TypeError('PostgreSQL connection database must be /postgres');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TypeError(
      'PostgreSQL connection URL must not contain query parameters or hash',
    );
  }
  return url;
}

export function encodeSessionCursor({ createdAt, sessionId } = {}) {
  if (!createdAt || !sessionId || typeof sessionId !== 'string') return null;
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  const payload = JSON.stringify({
    c: date.toISOString(),
    s: sessionId,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeSessionCursor(cursorToken) {
  if (typeof cursorToken !== 'string' || !cursorToken.trim()) return null;
  try {
    const json = JSON.parse(
      Buffer.from(cursorToken, 'base64url').toString('utf8'),
    );
    if (!json || typeof json !== 'object') return null;
    if (typeof json.s !== 'string' || !json.s.trim()) return null;
    const date = new Date(json.c);
    if (!Number.isFinite(date.getTime())) return null;
    return {
      createdAt: date.toISOString(),
      sessionId: json.s,
    };
  } catch {
    return null;
  }
}

function mapSessionRow(row) {
  return {
    sessionId: row.session_id,
    organizationId: row.organization_id,
    issuerPrincipalId: row.issuer_principal_id,
    scenarioId: row.scenario_id,
    scenarioVersion: row.scenario_version,
    scenarioTitle: row.scenario_title,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    activatedAt: row.activated_at
      ? new Date(row.activated_at).toISOString()
      : null,
    submittedAt: row.submitted_at
      ? new Date(row.submitted_at).toISOString()
      : null,
    durationSeconds: row.duration_seconds,
    closureReason: row.closure_reason,
    reviewProcessStatus: row.review_process_status,
    visibilityScope: row.visibility_scope,
  };
}

export function createR23PostgresAdapter({
  connectionString,
  pool: suppliedPool,
  assertVerifiedIdentity,
} = {}) {
  const ownsPool = !suppliedPool;
  if (ownsPool) {
    validateConnectionString(connectionString);
  } else if (connectionString !== undefined) {
    validateConnectionString(connectionString);
  }
  if (typeof assertVerifiedIdentity !== 'function') {
    throw new TypeError('A verified Auth identity assertion is required');
  }
  const pool = suppliedPool ?? new Pool({ connectionString });
  assertPool(pool);
  const onIdleClientError = () => {
    console.error('R2.3 PostgreSQL idle connection failed');
  };
  if (ownsPool) pool.on('error', onIdleClientError);

  return Object.freeze({
    async createSession({
      handleHash,
      csrfHash,
      callbackHash,
      credentialEnvelope,
      identity: identityInput,
      expiresAt,
      accessExpiresAt,
    } = {}) {
      const identity = verifiedIdentity(assertVerifiedIdentity, identityInput);
      const values = [
        requiredHash(handleHash, 'session handle'),
        requiredHash(csrfHash, 'CSRF'),
        requiredHash(callbackHash, 'callback'),
        requiredEnvelope(credentialEnvelope),
        identity.subjectId,
        identity.sessionId,
        identity.assurance,
        requiredDate(expiresAt, 'session expiry'),
        requiredDate(accessExpiresAt, 'access token expiry'),
      ];
      return inTransaction(pool, async (client) => {
        const { rows } = await query(
          client,
          `SELECT principal_id
             FROM r23.create_session(
               $1::pg_catalog.text, $2::pg_catalog.text, $3::pg_catalog.text,
               $4::pg_catalog.bytea, $5::pg_catalog.uuid, $6::pg_catalog.uuid,
               $7::pg_catalog.text, $8::pg_catalog.timestamptz,
               $9::pg_catalog.timestamptz
             )`,
          values,
        );
        if (rows.length !== 1) throw new R23PersistenceError();
        return { principalId: rows[0].principal_id };
      });
    },

    async withActiveSession({ handleHash, csrfHash } = {}, callback) {
      const handle = requiredHash(handleHash, 'session handle');
      if (typeof callback !== 'function') {
        throw new TypeError('An active-session operation is required');
      }
      const csrf =
        csrfHash === undefined ? undefined : requiredHash(csrfHash, 'CSRF');

      return inTransaction(pool, async (client) => {
        const { rows } = await query(
          client,
          'SELECT * FROM r23.lock_active_session($1::pg_catalog.text)',
          [handle],
        );
        const row = rows[0];
        if (!row) throw new R23SessionDenied();
        if (csrf !== undefined && !sameDigest(row.csrf_hash, csrf)) {
          throw new R23ScopeDenied();
        }
        let callbackPending = row.callback_hash !== null;
        const session = Object.freeze({
          handleHash: row.handle_hash,
          subjectId: row.subject_id,
          authSessionId: row.auth_session_id,
          principalId: row.principal_id,
          assurance: row.assurance,
          selectedOrganizationId: row.selected_organization_id,
          get callbackPending() {
            return callbackPending;
          },
          credentialEnvelope: Buffer.from(row.credential_envelope),
          expiresAt: row.expires_at,
          accessExpiresAt: row.access_expires_at,
        });
        let active = true;
        const ensureOpen = () => {
          if (!active) throw new R23SessionDenied();
          if (callbackPending) throw new R23SessionDenied();
        };
        const verifiedForSession = (identityInput) => {
          ensureOpen();
          const identity = verifiedIdentity(
            assertVerifiedIdentity,
            identityInput,
          );
          if (
            identity.subjectId !== session.subjectId ||
            identity.sessionId !== session.authSessionId ||
            identity.assurance !== session.assurance
          ) {
            throw new R23SessionDenied();
          }
          return identity;
        };
        const authz = Object.freeze({
          async saveCredentialEnvelope(envelope, newAccessExpiresAt) {
            ensureOpen();
            const values = [
              requiredEnvelope(envelope),
              requiredDate(newAccessExpiresAt, 'access token expiry'),
            ];
            const { rows: saved } = await query(
              client,
              'SELECT r23.save_credential_envelope($1::pg_catalog.bytea, $2::pg_catalog.timestamptz) AS saved',
              values,
            );
            if (saved[0]?.saved !== true) throw new R23SessionDenied();
          },

          async consumeCallback(callbackHash) {
            if (!active || !callbackPending) throw new R23SessionDenied();
            const digest = requiredHash(callbackHash, 'callback');
            if (!sameDigest(row.callback_hash, digest))
              throw new R23SessionDenied();
            const { rows: consumed } = await query(
              client,
              'SELECT r23.consume_callback() AS consumed',
            );
            if (consumed[0]?.consumed !== true) throw new R23SessionDenied();
            callbackPending = false;
          },

          async listMemberships(identityInput) {
            const identity = verifiedForSession(identityInput);
            const { rows: memberships } = await query(
              client,
              `SELECT * FROM r23.list_memberships(
                 $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text
               )`,
              [identity.subjectId, identity.sessionId, identity.assurance],
            );
            return memberships.map(membershipRow);
          },

          async selectOrganization(identityInput, organizationId) {
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            const { rows: selected } = await query(
              client,
              `SELECT * FROM r23.select_organization(
                 $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                 $4::pg_catalog.uuid
               )`,
              [
                identity.subjectId,
                identity.sessionId,
                identity.assurance,
                organization,
              ],
            );
            if (selected.length !== 1) throw new R23ScopeDenied();
            return membershipRow(selected[0]);
          },

          async authorizeOrganization(identityInput, organizationId) {
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            const { rows: authorized } = await query(
              client,
              `SELECT * FROM r23.authorize_organization(
                 $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                 $4::pg_catalog.uuid
               )`,
              [
                identity.subjectId,
                identity.sessionId,
                identity.assurance,
                organization,
              ],
            );
            if (authorized.length !== 1) throw new R23ScopeDenied();
            return membershipRow(authorized[0]);
          },

          async listOrganizationSessions(
            identityInput,
            organizationId,
            {
              lifecycleFilter = 'all',
              reviewStatusFilter = 'all',
              search = '',
              cursor = null,
              limit = 20,
            } = {},
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            const clampedLimit = Math.max(
              1,
              Math.min(Number.isInteger(limit) ? limit : 20, 50),
            );
            const decodedCursor = cursor ? decodeSessionCursor(cursor) : null;
            const cursorCreatedAt = decodedCursor
              ? new Date(decodedCursor.createdAt)
              : null;
            const cursorId = decodedCursor ? decodedCursor.sessionId : null;
            const searchFilter =
              typeof search === 'string' ? search.trim() : '';

            const { rows } = await query(
              client,
              `SELECT * FROM r24.list_organization_sessions(
                 $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                 $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.text,
                 $7::pg_catalog.text, $8::pg_catalog.timestamptz, $9::pg_catalog.text,
                 $10::pg_catalog.int4
               )`,
              [
                identity.subjectId,
                identity.sessionId,
                identity.assurance,
                organization,
                lifecycleFilter || 'all',
                reviewStatusFilter || 'all',
                searchFilter,
                cursorCreatedAt,
                cursorId,
                clampedLimit + 1,
              ],
            );

            const hasMore = rows.length > clampedLimit;
            const returnedRows = hasMore ? rows.slice(0, clampedLimit) : rows;
            const sessions = returnedRows.map(mapSessionRow);

            let totalAuthorizedCount = 0;
            let filteredAuthorizedCount = 0;

            if (rows.length > 0) {
              totalAuthorizedCount = Number(rows[0].total_authorized_count);
              filteredAuthorizedCount = Number(
                rows[0].filtered_authorized_count,
              );
            } else if (
              lifecycleFilter !== 'all' ||
              reviewStatusFilter !== 'all' ||
              searchFilter !== ''
            ) {
              const { rows: countRows } = await query(
                client,
                `SELECT r24.count_organization_sessions(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid
                 ) AS total_count`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                ],
              );
              totalAuthorizedCount = Number(countRows[0]?.total_count ?? 0);
              filteredAuthorizedCount = 0;
            }

            const visibilityScope =
              membership.role === 'recruiter'
                ? 'issued_by_recruiter'
                : membership.role === 'reviewer'
                  ? 'assigned_to_reviewer'
                  : 'restricted_role';

            let nextCursor = null;
            if (hasMore && returnedRows.length > 0) {
              const last = returnedRows[returnedRows.length - 1];
              nextCursor = encodeSessionCursor({
                createdAt: last.created_at,
                sessionId: last.session_id,
              });
            }

            return {
              organizationId: organization,
              role: membership.role,
              membershipVersion: membership.membershipVersion,
              visibilityScope,
              sessions,
              totalAuthorizedCount,
              filteredAuthorizedCount,
              nextCursor,
            };
          },

          async getOrganizationSessionSummary(
            identityInput,
            organizationId,
            sessionId,
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            if (typeof sessionId !== 'string' || !sessionId.trim()) {
              throw new TypeError('A valid session ID is required');
            }
            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            const visibilityScope =
              membership.role === 'recruiter'
                ? 'issued_by_recruiter'
                : membership.role === 'reviewer'
                  ? 'assigned_to_reviewer'
                  : 'restricted_role';

            const { rows } = await query(
              client,
              `SELECT * FROM r24.get_organization_session_summary(
                 $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                 $4::pg_catalog.uuid, $5::pg_catalog.text
               )`,
              [
                identity.subjectId,
                identity.sessionId,
                identity.assurance,
                organization,
                sessionId.trim(),
              ],
            );

            return {
              organizationId: organization,
              role: membership.role,
              membershipVersion: membership.membershipVersion,
              visibilityScope,
              session: rows.length > 0 ? mapSessionRow(rows[0]) : null,
            };
          },

          async getSubmittedEvidence(
            identityInput,
            organizationId,
            sessionId,
            queryOptions = {},
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            if (
              typeof sessionId !== 'string' ||
              sessionId.trim() !== sessionId ||
              !SESSION_ID.test(sessionId)
            ) {
              throw new TypeError('A valid session ID is required');
            }
            if (
              !queryOptions ||
              typeof queryOptions !== 'object' ||
              Array.isArray(queryOptions) ||
              Object.keys(queryOptions).some(
                (key) => key !== 'afterSequence' && key !== 'limit',
              )
            ) {
              throw new TypeError('A valid evidence query is required');
            }
            const afterSequence = queryOptions.afterSequence ?? '0';
            if (
              typeof afterSequence !== 'string' ||
              !SEQUENCE.test(afterSequence) ||
              BigInt(afterSequence) > MAX_INT8
            ) {
              throw new TypeError('A valid evidence sequence is required');
            }
            const limit = Math.max(
              1,
              Math.min(
                Number.isInteger(queryOptions.limit) ? queryOptions.limit : 50,
                100,
              ),
            );
            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            if (membership.role !== 'reviewer') return null;

            try {
              const { rows } = await query(
                client,
                `SELECT r27.get_submitted_evidence(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.text,
                   $7::pg_catalog.int4
                 ) AS evidence`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId,
                  afterSequence,
                  limit,
                ],
              );
              return mapR27Evidence(rows[0]?.evidence ?? null, {
                afterSequence,
                limit,
              });
            } catch (error) {
              if (error instanceof R27EvidenceIntegrityError) {
                throw new R23PersistenceError();
              }
              throw error;
            }
          },

          async getFileRevision(
            identityInput,
            organizationId,
            sessionId,
            sequence,
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            if (
              typeof sessionId !== 'string' ||
              sessionId.trim() !== sessionId ||
              !SESSION_ID.test(sessionId)
            ) {
              throw new TypeError('A valid session ID is required');
            }
            if (
              typeof sequence !== 'string' ||
              !SEQUENCE.test(sequence) ||
              BigInt(sequence) > MAX_INT8 ||
              BigInt(sequence) < 1n
            ) {
              throw new TypeError('A valid event sequence is required');
            }
            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            if (membership.role !== 'reviewer') return null;

            try {
              const { rows } = await query(
                client,
                `SELECT r28.get_file_revision(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.text
                 ) AS revision`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId,
                  sequence,
                ],
              );
              return rows[0]?.revision ?? null;
            } catch (error) {
              throw error;
            }
          },

          async createObservation(
            identityInput,
            organizationId,
            sessionId,
            input,
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            if (
              typeof sessionId !== 'string' ||
              sessionId.trim() !== sessionId ||
              !SESSION_ID.test(sessionId)
            ) {
              throw new TypeError('A valid session ID is required');
            }
            if (!input || typeof input !== 'object') {
              throw new TypeError('Valid observation input is required');
            }
            if (
              input.evidenceSourceType !== 'timeline_event' &&
              input.evidenceSourceType !== 'file_revision'
            ) {
              throw new TypeError('A valid evidenceSourceType is required');
            }
            if (
              typeof input.eventSequence !== 'string' ||
              !SEQUENCE.test(input.eventSequence) ||
              BigInt(input.eventSequence) < 1n ||
              BigInt(input.eventSequence) > MAX_INT8
            ) {
              throw new TypeError('A valid event sequence is required');
            }
            if (
              typeof input.evidenceDigest !== 'string' ||
              !HASH.test(input.evidenceDigest)
            ) {
              throw new TypeError('A valid evidence digest is required');
            }
            if (
              typeof input.body !== 'string' ||
              Buffer.byteLength(input.body, 'utf8') < 1 ||
              Buffer.byteLength(input.body, 'utf8') > 20000
            ) {
              throw new TypeError(
                'A valid observation body (1-20000 bytes) is required',
              );
            }
            if (input.evidenceSourceType === 'file_revision') {
              if (
                typeof input.filePath !== 'string' ||
                !input.filePath.trim()
              ) {
                throw new TypeError(
                  'A valid filePath is required for file revision observations',
                );
              }
              if (
                typeof input.fileVersion !== 'string' ||
                !SEQUENCE.test(input.fileVersion) ||
                BigInt(input.fileVersion) < 1n ||
                BigInt(input.fileVersion) > MAX_INT8
              ) {
                throw new TypeError(
                  'A valid fileVersion is required for file revision observations',
                );
              }
            } else if (input.evidenceSourceType === 'timeline_event') {
              if (input.filePath !== undefined && input.filePath !== null) {
                throw new TypeError(
                  'filePath must not be provided for timeline event observations',
                );
              }
              if (
                input.fileVersion !== undefined &&
                input.fileVersion !== null
              ) {
                throw new TypeError(
                  'fileVersion must not be provided for timeline event observations',
                );
              }
            }
            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            if (membership.role !== 'reviewer') throw new R23ScopeDenied();

            try {
              const { rows } = await query(
                client,
                `SELECT r29.create_observation(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.jsonb
                 ) AS observation`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId,
                  JSON.stringify({
                    evidenceSourceType: input.evidenceSourceType,
                    eventSequence: input.eventSequence,
                    filePath: input.filePath ?? null,
                    fileVersion: input.fileVersion ?? null,
                    evidenceDigest: input.evidenceDigest,
                    body: input.body,
                  }),
                ],
              );
              if (!rows[0]?.observation) {
                throw new R23ScopeDenied();
              }
              return rows[0].observation;
            } catch (error) {
              throw error;
            }
          },

          async updateObservation(
            identityInput,
            organizationId,
            sessionId,
            observationId,
            input,
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            if (
              typeof sessionId !== 'string' ||
              sessionId.trim() !== sessionId ||
              !SESSION_ID.test(sessionId)
            ) {
              throw new TypeError('A valid session ID is required');
            }
            const obsId = requiredUuid(observationId, 'observation ID');
            if (!input || typeof input !== 'object') {
              throw new TypeError('Valid observation update input is required');
            }
            if (
              typeof input.expectedVersion !== 'number' ||
              !Number.isInteger(input.expectedVersion) ||
              input.expectedVersion < 1
            ) {
              throw new TypeError('A valid expectedVersion is required');
            }
            if (
              typeof input.body !== 'string' ||
              Buffer.byteLength(input.body, 'utf8') < 1 ||
              Buffer.byteLength(input.body, 'utf8') > 20000
            ) {
              throw new TypeError(
                'A valid observation body (1-20000 bytes) is required',
              );
            }
            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            if (membership.role !== 'reviewer') throw new R23ScopeDenied();

            try {
              const { rows } = await query(
                client,
                `SELECT r29.update_observation(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.uuid,
                   $7::pg_catalog.jsonb
                 ) AS observation`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId,
                  obsId,
                  JSON.stringify({
                    expectedVersion: input.expectedVersion,
                    body: input.body,
                  }),
                ],
              );
              if (!rows[0]?.observation) {
                throw new R23ScopeDenied();
              }
              return rows[0].observation;
            } catch (error) {
              throw error;
            }
          },

          async listObservations(identityInput, organizationId, sessionId) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            if (
              typeof sessionId !== 'string' ||
              sessionId.trim() !== sessionId ||
              !SESSION_ID.test(sessionId)
            ) {
              throw new TypeError('A valid session ID is required');
            }
            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            if (membership.role !== 'reviewer') throw new R23ScopeDenied();

            try {
              const { rows } = await query(
                client,
                `SELECT r29.list_observations(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text
                 ) AS observations`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId,
                ],
              );
              if (!rows[0]?.observations) {
                throw new R23ScopeDenied();
              }
              return rows[0].observations;
            } catch (error) {
              throw error;
            }
          },

          async getObservation(
            identityInput,
            organizationId,
            sessionId,
            observationId,
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            if (
              typeof sessionId !== 'string' ||
              sessionId.trim() !== sessionId ||
              !SESSION_ID.test(sessionId)
            ) {
              throw new TypeError('A valid session ID is required');
            }
            const obsId = requiredUuid(observationId, 'observation ID');
            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            if (membership.role !== 'reviewer') throw new R23ScopeDenied();

            try {
              const { rows } = await query(
                client,
                `SELECT r29.get_observation(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.uuid
                 ) AS observation`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId,
                  obsId,
                ],
              );
              return rows[0]?.observation ?? null;
            } catch (error) {
              throw error;
            }
          },

          async getReviewPacket(identityInput, organizationId, sessionId) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            if (
              typeof sessionId !== 'string' ||
              sessionId.trim() !== sessionId ||
              !SESSION_ID.test(sessionId)
            ) {
              throw new TypeError('A valid session ID is required');
            }
            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            if (membership.role !== 'reviewer') throw new R23ScopeDenied();

            try {
              const { rows } = await query(
                client,
                `SELECT r210.get_review_packet(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text
                 ) AS packet`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId,
                ],
              );
              return rows[0]?.packet ?? null;
            } catch (error) {
              throw error;
            }
          },

          async saveReviewPacketDraft(
            identityInput,
            organizationId,
            sessionId,
            input,
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            if (
              typeof sessionId !== 'string' ||
              sessionId.trim() !== sessionId ||
              !SESSION_ID.test(sessionId)
            ) {
              throw new TypeError('A valid session ID is required');
            }
            if (!input || typeof input !== 'object') {
              throw new TypeError('Valid draft input is required');
            }
            if (typeof input.summary !== 'string') {
              throw new TypeError('A valid summary string is required');
            }
            if (
              !Array.isArray(input.strengths) ||
              input.strengths.some((s) => typeof s !== 'string')
            ) {
              throw new TypeError('strengths must be an array of strings');
            }
            if (
              !Array.isArray(input.concerns) ||
              input.concerns.some((c) => typeof c !== 'string')
            ) {
              throw new TypeError('concerns must be an array of strings');
            }
            if (
              !Array.isArray(input.unresolvedQuestions) ||
              input.unresolvedQuestions.some((q) => typeof q !== 'string')
            ) {
              throw new TypeError(
                'unresolvedQuestions must be an array of strings',
              );
            }
            if (
              !Array.isArray(input.referencedObservationIds) ||
              input.referencedObservationIds.some(
                (id) => typeof id !== 'string',
              )
            ) {
              throw new TypeError(
                'referencedObservationIds must be an array of strings',
              );
            }
            if (!Array.isArray(input.referencedEvidence)) {
              throw new TypeError('referencedEvidence must be an array');
            }
            if (
              input.expectedVersion !== undefined &&
              input.expectedVersion !== null
            ) {
              if (
                typeof input.expectedVersion !== 'number' ||
                !Number.isInteger(input.expectedVersion) ||
                input.expectedVersion < 0
              ) {
                throw new TypeError(
                  'expectedVersion must be a non-negative integer',
                );
              }
            }

            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            if (membership.role !== 'reviewer') throw new R23ScopeDenied();

            try {
              const { rows } = await query(
                client,
                `SELECT r210.save_review_packet_draft(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.jsonb
                 ) AS packet`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId,
                  JSON.stringify({
                    summary: input.summary,
                    strengths: input.strengths,
                    concerns: input.concerns,
                    unresolvedQuestions: input.unresolvedQuestions,
                    referencedObservationIds: input.referencedObservationIds,
                    referencedEvidence: input.referencedEvidence,
                    expectedVersion: input.expectedVersion ?? null,
                  }),
                ],
              );
              if (!rows[0]?.packet) {
                throw new R23ScopeDenied();
              }
              return rows[0].packet;
            } catch (error) {
              throw error;
            }
          },

          async finalizeReviewPacket(
            identityInput,
            organizationId,
            sessionId,
            input,
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            if (
              typeof sessionId !== 'string' ||
              sessionId.trim() !== sessionId ||
              !SESSION_ID.test(sessionId)
            ) {
              throw new TypeError('A valid session ID is required');
            }
            if (!input || typeof input !== 'object') {
              throw new TypeError('Valid finalize input is required');
            }
            if (
              typeof input.expectedVersion !== 'number' ||
              !Number.isInteger(input.expectedVersion) ||
              input.expectedVersion < 1
            ) {
              throw new TypeError('expectedVersion must be a positive integer');
            }

            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            if (membership.role !== 'reviewer') throw new R23ScopeDenied();

            try {
              const { rows } = await query(
                client,
                `SELECT r210.finalize_review_packet(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.jsonb
                 ) AS packet`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId,
                  JSON.stringify({
                    expectedVersion: input.expectedVersion,
                  }),
                ],
              );
              if (!rows[0]?.packet) {
                throw new R23ScopeDenied();
              }
              return rows[0].packet;
            } catch (error) {
              throw error;
            }
          },

          async saveAssessmentDraft(identityInput, organizationId, input) {
            ensureOpen();
            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            if (membership.role !== 'recruiter') throw new R23ScopeDenied();
            return r211SaveAssessmentDraft(
              client,
              identityInput,
              organizationId,
              input,
              verifiedForSession,
            );
          },

          async getAssessmentDraft(
            identityInput,
            organizationId,
            definitionId,
          ) {
            ensureOpen();
            await this.authorizeOrganization(identityInput, organizationId);
            return r211GetAssessmentDraft(
              client,
              identityInput,
              organizationId,
              definitionId,
              verifiedForSession,
            );
          },

          async listAssessmentDefinitions(identityInput, organizationId) {
            ensureOpen();
            await this.authorizeOrganization(identityInput, organizationId);
            return r211ListAssessmentDefinitions(
              client,
              identityInput,
              organizationId,
              verifiedForSession,
            );
          },

          async createValidatedVersion(
            identityInput,
            organizationId,
            definitionId,
            expectedDraftVersion,
          ) {
            ensureOpen();
            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            if (membership.role !== 'recruiter') throw new R23ScopeDenied();
            return r211CreateValidatedVersion(
              client,
              identityInput,
              organizationId,
              definitionId,
              expectedDraftVersion,
              verifiedForSession,
            );
          },

          async getValidatedVersion(identityInput, organizationId, versionId) {
            ensureOpen();
            await this.authorizeOrganization(identityInput, organizationId);
            return r211GetValidatedVersion(
              client,
              identityInput,
              organizationId,
              versionId,
              verifiedForSession,
            );
          },

          async validateIssuanceIntent(
            identityInput,
            organizationId,
            { idempotencyKey, requestHash },
          ) {
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(organizationId, 'organization');
            try {
              await query(
                client,
                'SELECT r25.validate_issuance_intent($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::text)',
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  idempotencyKey,
                  requestHash,
                ],
              );
            } catch (error) {
              if (error?.code === 'R2501') throw new R23ScopeDenied();
              if (error?.message?.includes('IDEMPOTENCY_KEY_CONFLICT'))
                throw new R25IdempotencyConflict();
              throw error;
            }
          },
          async assertCandidateTokenStorage(
            identityInput,
            organizationId,
            key,
          ) {
            const membership = await this.authorizeOrganization(
              identityInput,
              organizationId,
            );
            if (membership.role !== 'recruiter') throw new R23ScopeDenied();
            return assertCandidateTokenStorage(
              {
                query: () =>
                  query(
                    client,
                    'SELECT * FROM r25.get_candidate_token_storage_meta()',
                  ),
              },
              { key },
            );
          },

          async issueAssessment(
            identityInput,
            organizationId,
            {
              sessionId,
              scenarioId,
              scenarioVersion,
              scenarioTitle,
              durationSeconds = null,
              candidateTokenHash,
              candidateTokenCiphertext,
              idempotencyKey = null,
              requestHash = null,
              payloadHash = null,
              terminalEnabled = true,
              taskRubricSnapshot = null,
              aiCapabilitySnapshot = null,
              scenarioSnapshot = null,
            } = {},
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            await this.authorizeOrganization(identityInput, organizationId);

            try {
              const { rows } = await query(
                client,
                `SELECT * FROM r25.issue_assessment(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.text,
                   $7::pg_catalog.text, $8::pg_catalog.text, $9::pg_catalog.int4,
                   $10::pg_catalog.text, $11::pg_catalog.text, $12::pg_catalog.text,
                   $13::pg_catalog.text, $14::pg_catalog.text, $15::pg_catalog.bool,
                   $16::pg_catalog.jsonb, $17::pg_catalog.jsonb, $18::pg_catalog.text
                 )`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId,
                  scenarioId,
                  scenarioVersion,
                  scenarioTitle,
                  durationSeconds,
                  candidateTokenHash,
                  candidateTokenCiphertext,
                  idempotencyKey,
                  requestHash,
                  payloadHash,
                  terminalEnabled ?? true,
                  taskRubricSnapshot
                    ? JSON.stringify(taskRubricSnapshot)
                    : null,
                  aiCapabilitySnapshot
                    ? JSON.stringify(aiCapabilitySnapshot)
                    : null,
                  scenarioSnapshot,
                ],
              );

              const row = rows[0];
              return {
                sessionId: row.session_id,
                organizationId: row.organization_id,
                issuerPrincipalId: row.issuer_principal_id,
                scenarioId: row.scenario_id,
                scenarioVersion: row.scenario_version,
                scenarioTitle: row.scenario_title,
                status: row.status,
                createdAt: row.created_at,
                durationSeconds: row.duration_seconds,
                isReplay: row.is_replay,
              };
            } catch (error) {
              if (
                error?.message === 'IDEMPOTENCY_KEY_CONFLICT' ||
                (error?.code === '23505' &&
                  error?.message?.includes('IDEMPOTENCY_KEY_CONFLICT'))
              ) {
                throw new R25IdempotencyConflict();
              }
              if (error?.code === 'R2501') throw new R23ScopeDenied();
              if (error?.code === 'R2503') {
                const err = new Error(error.message);
                err.code = 'ROLE_DENIED';
                throw err;
              }
              throw error;
            }
          },

          async recoverCandidateToken(
            identityInput,
            organizationId,
            sessionId,
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            if (typeof sessionId !== 'string' || !sessionId.trim()) {
              throw new TypeError('A valid session ID is required');
            }
            await this.authorizeOrganization(identityInput, organizationId);

            try {
              const { rows } = await query(
                client,
                `SELECT * FROM r25.recover_candidate_token(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text
                 )`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId.trim(),
                ],
              );
              if (rows.length === 0) return null;
              const row = rows[0];
              return {
                candidateTokenCiphertext: row.candidate_token_ciphertext,
                candidateTokenHash: row.candidate_token_hash,
                sessionId: row.session_id,
                organizationId: row.organization_id,
                issuerPrincipalId: row.issuer_principal_id,
              };
            } catch (error) {
              if (error?.code === 'R2501') throw new R23ScopeDenied();
              if (error?.code === 'R2503') {
                const err = new Error(error.message);
                err.code = 'PERMISSION_DENIED';
                throw err;
              }
              if (error?.code === 'R2504') {
                const err = new Error(error.message);
                err.code = 'SESSION_NOT_FOUND';
                throw err;
              }
              throw error;
            }
          },

          async listOrganizationReviewers(identityInput, organizationId) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            await this.authorizeOrganization(identityInput, organizationId);

            try {
              const { rows } = await query(
                client,
                `SELECT * FROM r25.list_organization_reviewers(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid
                 )`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                ],
              );
              return rows.map((r) => ({
                principalId: r.principal_id,
                role: r.role,
                joinedAt: r.joined_at,
              }));
            } catch (error) {
              if (error?.code === 'R2501') throw new R23ScopeDenied();
              throw error;
            }
          },

          async assignReviewer(
            identityInput,
            organizationId,
            { sessionId, reviewerPrincipalId, assignmentId },
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            const reviewer = requiredUuid(
              reviewerPrincipalId,
              'reviewer principal ID',
            );
            if (typeof sessionId !== 'string' || !sessionId.trim()) {
              throw new TypeError('A valid session ID is required');
            }
            if (typeof assignmentId !== 'string' || !assignmentId.trim()) {
              throw new TypeError('A valid assignment ID is required');
            }
            await this.authorizeOrganization(identityInput, organizationId);

            try {
              const { rows } = await query(
                client,
                `SELECT * FROM r25.assign_reviewer(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.uuid,
                   $7::pg_catalog.text
                 )`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId.trim(),
                  reviewer,
                  assignmentId.trim(),
                ],
              );
              const row = rows[0];
              return {
                assignmentId: row.assignment_id,
                sessionId: row.session_id,
                organizationId: row.organization_id,
                reviewerPrincipalId: row.reviewer_principal_id,
                assignedByPrincipalId: row.assigned_by_principal_id,
                assignedAt: row.assigned_at,
                revokedAt: row.revoked_at,
                version: Number(row.version),
                isReplay: row.is_replay,
              };
            } catch (error) {
              if (error?.code === 'R2501') throw new R23ScopeDenied();
              if (error?.code === 'R2503') {
                const err = new Error(error.message);
                err.code = 'ROLE_DENIED';
                throw err;
              }
              if (error?.code === 'R2504') {
                const err = new Error(error.message);
                err.code = 'SESSION_NOT_FOUND';
                throw err;
              }
              if (error?.code === 'R2505') {
                const err = new Error(error.message);
                err.code = 'INVALID_REVIEWER';
                throw err;
              }
              throw error;
            }
          },

          async revokeReviewerAssignment(
            identityInput,
            organizationId,
            { sessionId, assignmentId = null, reviewerPrincipalId = null },
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            if (typeof sessionId !== 'string' || !sessionId.trim()) {
              throw new TypeError('A valid session ID is required');
            }
            await this.authorizeOrganization(identityInput, organizationId);

            try {
              const { rows } = await query(
                client,
                `SELECT * FROM r25.revoke_reviewer_assignment(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.text,
                   $7::pg_catalog.uuid
                 )`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId.trim(),
                  assignmentId ? assignmentId.trim() : null,
                  reviewerPrincipalId ? reviewerPrincipalId.trim() : null,
                ],
              );
              const row = rows[0];
              return {
                assignmentId: row.assignment_id,
                sessionId: row.session_id,
                organizationId: row.organization_id,
                reviewerPrincipalId: row.reviewer_principal_id,
                assignedByPrincipalId: row.assigned_by_principal_id,
                assignedAt: row.assigned_at,
                revokedAt: row.revoked_at,
                version: Number(row.version),
                revoked: row.revoked,
              };
            } catch (error) {
              if (error?.code === 'R2501') throw new R23ScopeDenied();
              if (error?.code === 'R2503') {
                const err = new Error(error.message);
                err.code = 'ROLE_DENIED';
                throw err;
              }
              if (error?.code === 'R2504') {
                const err = new Error(error.message);
                err.code = 'SESSION_NOT_FOUND';
                throw err;
              }
              if (error?.code === 'R2506') {
                const err = new Error(error.message);
                err.code = 'ASSIGNMENT_NOT_FOUND';
                throw err;
              }
              throw error;
            }
          },

          async listSessionReviewerAssignments(
            identityInput,
            organizationId,
            sessionId,
          ) {
            ensureOpen();
            const identity = verifiedForSession(identityInput);
            const organization = requiredUuid(
              organizationId,
              'organization selection',
            );
            if (typeof sessionId !== 'string' || !sessionId.trim()) {
              throw new TypeError('A valid session ID is required');
            }
            await this.authorizeOrganization(identityInput, organizationId);

            try {
              const { rows } = await query(
                client,
                `SELECT * FROM r25.list_session_reviewer_assignments(
                   $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
                   $4::pg_catalog.uuid, $5::pg_catalog.text
                 )`,
                [
                  identity.subjectId,
                  identity.sessionId,
                  identity.assurance,
                  organization,
                  sessionId.trim(),
                ],
              );
              return rows.map((r) => ({
                assignmentId: r.assignment_id,
                sessionId: r.session_id,
                organizationId: r.organization_id,
                reviewerPrincipalId: r.reviewer_principal_id,
                assignedByPrincipalId: r.assigned_by_principal_id,
                assignedAt: r.assigned_at,
                revokedAt: r.revoked_at,
                version: Number(r.version),
                isActive: r.is_active,
              }));
            } catch (error) {
              if (error?.code === 'R2501') throw new R23ScopeDenied();
              throw error;
            }
          },
        });

        let result;
        let scopeDenied;
        try {
          result = await callback(session, authz);
        } catch (error) {
          // Commit a successful refresh envelope before returning a later scope denial.
          if (error instanceof R23ScopeDenied) scopeDenied = error;
          else throw error;
        } finally {
          active = false;
        }
        return { result, scopeDenied };
      }).then(({ result, scopeDenied }) => {
        if (scopeDenied) throw scopeDenied;
        return result;
      });
    },

    async closeSession(handleHash, csrfHash) {
      const handle = requiredHash(handleHash, 'session handle');
      const csrf = requiredHash(csrfHash, 'CSRF');
      return inTransaction(pool, async (client) => {
        const { rows } = await query(
          client,
          'SELECT * FROM r23.lock_session_for_logout($1::pg_catalog.text)',
          [handle],
        );
        const row = rows[0];
        if (!row) return null;
        if (!sameDigest(row.csrf_hash, csrf)) throw new R23ScopeDenied();
        const { rows: revoked } = await query(
          client,
          'SELECT r23.revoke_session() AS revoked',
        );
        if (revoked[0]?.revoked !== true) throw new R23PersistenceError();
        return {
          credentialEnvelope: Buffer.from(row.credential_envelope),
          subjectId: row.subject_id,
          authSessionId: row.auth_session_id,
        };
      });
    },

    async close() {
      if (ownsPool) {
        try {
          await pool.end();
        } catch {
          throw new R23PersistenceError();
        }
      }
    },
  });
}

export const FIXTURE_IDS = Object.freeze({
  orgA: '11111111-1111-4111-8111-111111111111',
  orgB: '22222222-2222-4222-8222-222222222222',
  userA: {
    principalId: 'aaaaaaaa-1111-4111-8111-111111111111',
    subjectId: '10000000-0000-4000-8000-0000000000a1',
    email: 'evaluator-a@acme.example',
  },
  userB: {
    principalId: 'bbbbbbbb-2222-4222-8222-222222222222',
    subjectId: '20000000-0000-4000-8000-0000000000b1',
    email: 'reviewer-b@beta.example',
  },
  userAB: {
    principalId: 'abababab-1111-4111-8111-111111111111',
    subjectId: '30000000-0000-4000-8000-0000000000ab',
    email: 'evaluator-ab@shared.example',
  },
  userRevoked: {
    principalId: 'cccccccc-1111-4111-8111-111111111111',
    subjectId: '40000000-0000-4000-8000-0000000000cc',
    email: 'revoked-a@acme.example',
  },
  recruiterA2: {
    principalId: 'aaaaaaaa-2222-4111-8111-111111111111',
    subjectId: '10000000-0000-4000-8000-0000000000a2',
    email: 'recruiter-a2@acme.example',
  },
  recruiterAEmpty: {
    principalId: 'aaaaaaaa-3333-4111-8111-111111111111',
    subjectId: '10000000-0000-4000-8000-0000000000a3',
    email: 'recruiter-empty@acme.example',
  },
  adminA: {
    principalId: 'aaaaaaaa-4444-4111-8111-111111111111',
    subjectId: '10000000-0000-4000-8000-0000000000a4',
    email: 'admin-a@acme.example',
  },
  recruiterB: {
    principalId: 'bbbbbbbb-1111-4222-8222-222222222222',
    subjectId: '20000000-0000-4000-8000-0000000000b2',
    email: 'recruiter-b@beta.example',
  },
  sessions: Object.freeze({
    a001Created: 'sess-a-001-created',
    a002Active: 'sess-a-002-active',
    a003SubmittedAssigned: 'sess-a-003-submitted-assigned',
    a004TimeoutAssigned: 'sess-a-004-timeout-assigned',
    a005SubmittedUnassigned: 'sess-a-005-submitted-unassigned',
    a006OtherRecruiter: 'sess-a-006-other-recruiter',
    b001Created: 'sess-b-001-created',
    b002Active: 'sess-b-002-active',
    b003SubmittedAssigned: 'sess-b-003-submitted-assigned',
    b004SubmittedUnassigned: 'sess-b-004-submitted-unassigned',
  }),
  assignments: Object.freeze({
    a001: 'assign-a-001',
    a002: 'assign-a-002',
    a003: 'assign-a-003',
    a004Revoked: 'assign-a-004-revoked',
    b001: 'assign-b-001',
    b002: 'assign-b-002',
  }),
});

export async function applyR23DisposableSchema(clientOrPool) {
  const sql = readFileSync(new URL('./fixture.sql', import.meta.url), 'utf8');
  await clientOrPool.query(sql);
}

export async function resolveAuthenticatedMemberships(
  pool,
  { supabaseUserId },
) {
  assertPool(pool);
  const subjectId = requiredUuid(supabaseUserId, 'Supabase user ID');
  const { rows } = await pool.query(
    `SELECT organization_id, role, membership_version
       FROM r24.resolve_authenticated_memberships($1::pg_catalog.uuid)`,
    [subjectId],
  );
  return rows.map(membershipRow);
}

export async function resolveScopedOrganizationMembership(
  pool,
  { supabaseUserId, organizationId },
) {
  assertPool(pool);
  const subjectId = requiredUuid(supabaseUserId, 'Supabase user ID');
  const orgId = requiredUuid(organizationId, 'organization ID');
  const { rows } = await pool.query(
    `SELECT organization_id, principal_id, role, status, joined_at, membership_version
       FROM r24.resolve_scoped_organization_membership($1::pg_catalog.uuid, $2::pg_catalog.uuid)`,
    [subjectId, orgId],
  );
  if (rows.length === 0) return null;
  return {
    organizationId: rows[0].organization_id,
    principalId: rows[0].principal_id,
    role: rows[0].role,
    status: rows[0].status,
    joinedAt: rows[0].joined_at,
    membershipVersion: rows[0].membership_version,
  };
}

export async function revokeOrganizationMembership(
  adminPool,
  { organizationId, principalId },
) {
  const org = requiredUuid(organizationId, 'organization');
  const principal = requiredUuid(principalId, 'principal');
  const { rowCount } = await adminPool.query(
    `UPDATE hirearchy.organization_memberships
        SET status = 'revoked',
            revoked_at = pg_catalog.clock_timestamp(),
            version = version + 1
      WHERE organization_id = $1 AND principal_id = $2 AND status = 'active'`,
    [org, principal],
  );
  return rowCount > 0;
}

export async function restoreOrganizationMembership(
  adminPool,
  { organizationId, principalId },
) {
  const org = requiredUuid(organizationId, 'organization');
  const principal = requiredUuid(principalId, 'principal');
  const { rowCount } = await adminPool.query(
    `UPDATE hirearchy.organization_memberships
        SET status = 'active',
            revoked_at = NULL,
            version = version + 1
      WHERE organization_id = $1 AND principal_id = $2`,
    [org, principal],
  );
  return rowCount > 0;
}

export async function revokeReviewerAssignment(
  pool,
  {
    supabaseUserId,
    organizationId,
    sessionId,
    assignmentId = null,
    reviewerPrincipalId = null,
  } = {},
) {
  assertPool(pool);
  const org = requiredUuid(organizationId, 'organization');
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new TypeError('A valid session ID is required');
  }

  if (supabaseUserId) {
    const subjectId = requiredUuid(supabaseUserId, 'Supabase user ID');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT * FROM r25.revoke_reviewer_assignment(
           $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
           $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.text,
           $7::pg_catalog.uuid
         )`,
        [
          subjectId,
          '00000000-0000-4000-8000-000000000000',
          'aal1',
          org,
          sessionId.trim(),
          assignmentId ? assignmentId.trim() : null,
          reviewerPrincipalId ? reviewerPrincipalId.trim() : null,
        ],
      );
      await client.query('COMMIT');
      return rows[0]?.revoked ?? false;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error?.code === 'R2501') throw new R23ScopeDenied();
      if (error?.code === 'R2503') {
        const err = new Error(error.message);
        err.code = 'ROLE_DENIED';
        throw err;
      }
      if (error?.code === 'R2504') {
        const err = new Error(error.message);
        err.code = 'SESSION_NOT_FOUND';
        throw err;
      }
      if (error?.code === 'R2506') {
        const err = new Error(error.message);
        err.code = 'ASSIGNMENT_NOT_FOUND';
        throw err;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  const principal = requiredUuid(reviewerPrincipalId, 'reviewer principal');
  const { rowCount } = await pool.query(
    `UPDATE hirearchy.reviewer_assignments
        SET revoked_at = pg_catalog.clock_timestamp(),
            version = version + 1
      WHERE organization_id = $1 AND session_id = $2 AND reviewer_principal_id = $3 AND revoked_at IS NULL`,
    [org, sessionId.trim(), principal],
  );
  return rowCount > 0;
}

export async function restoreReviewerAssignment(
  adminPool,
  { organizationId, sessionId, reviewerPrincipalId },
) {
  const org = requiredUuid(organizationId, 'organization');
  const principal = requiredUuid(reviewerPrincipalId, 'reviewer principal');
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new TypeError('A valid session ID is required');
  }
  const { rowCount } = await adminPool.query(
    `UPDATE hirearchy.reviewer_assignments
        SET revoked_at = NULL,
            version = version + 1
      WHERE organization_id = $1 AND session_id = $2 AND reviewer_principal_id = $3`,
    [org, sessionId.trim(), principal],
  );
  return rowCount > 0;
}

export async function listOrganizationSessions(
  pool,
  {
    supabaseUserId,
    organizationId,
    lifecycleFilter = 'all',
    reviewStatusFilter = 'all',
    search = '',
    cursor = null,
    limit = 20,
  } = {},
) {
  assertPool(pool);
  const subjectId = requiredUuid(supabaseUserId, 'Supabase user ID');
  const orgId = requiredUuid(organizationId, 'organization ID');
  const clampedLimit = Math.max(
    1,
    Math.min(Number.isInteger(limit) ? limit : 20, 50),
  );
  const decodedCursor = cursor ? decodeSessionCursor(cursor) : null;
  const cursorCreatedAt = decodedCursor
    ? new Date(decodedCursor.createdAt)
    : null;
  const cursorId = decodedCursor ? decodedCursor.sessionId : null;
  const searchFilter = typeof search === 'string' ? search.trim() : '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: membershipRows } = await client.query(
      `SELECT organization_id, principal_id, role, status, joined_at, membership_version
         FROM r24.resolve_scoped_organization_membership($1::pg_catalog.uuid, $2::pg_catalog.uuid)`,
      [subjectId, orgId],
    );

    if (membershipRows.length === 0) {
      await client.query('ROLLBACK');
      return {
        authorized: false,
        membership: null,
        visibilityScope: null,
        sessions: [],
        totalAuthorizedCount: 0,
        filteredAuthorizedCount: 0,
        nextCursor: null,
      };
    }

    const membershipRowData = membershipRows[0];
    const membership = {
      organizationId: membershipRowData.organization_id,
      principalId: membershipRowData.principal_id,
      role: membershipRowData.role,
      status: membershipRowData.status,
      joinedAt: membershipRowData.joined_at,
      membershipVersion: membershipRowData.membership_version,
    };

    const visibilityScope =
      membership.role === 'recruiter'
        ? 'issued_by_recruiter'
        : membership.role === 'reviewer'
          ? 'assigned_to_reviewer'
          : 'restricted_role';

    const { rows } = await client.query(
      `SELECT * FROM r24.list_organization_sessions(
         $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
         $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.text,
         $7::pg_catalog.text, $8::pg_catalog.timestamptz, $9::pg_catalog.text,
         $10::pg_catalog.int4
       )`,
      [
        subjectId,
        '00000000-0000-4000-8000-000000000000',
        'aal1',
        orgId,
        lifecycleFilter || 'all',
        reviewStatusFilter || 'all',
        searchFilter,
        cursorCreatedAt,
        cursorId,
        clampedLimit + 1,
      ],
    );

    const hasMore = rows.length > clampedLimit;
    const returnedRows = hasMore ? rows.slice(0, clampedLimit) : rows;
    const sessions = returnedRows.map(mapSessionRow);

    let totalAuthorizedCount = 0;
    let filteredAuthorizedCount = 0;

    if (rows.length > 0) {
      totalAuthorizedCount = Number(rows[0].total_authorized_count);
      filteredAuthorizedCount = Number(rows[0].filtered_authorized_count);
    } else if (
      lifecycleFilter !== 'all' ||
      reviewStatusFilter !== 'all' ||
      searchFilter !== ''
    ) {
      const { rows: countRows } = await client.query(
        `SELECT r24.count_organization_sessions(
           $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
           $4::pg_catalog.uuid
         ) AS total_count`,
        [subjectId, '00000000-0000-4000-8000-000000000000', 'aal1', orgId],
      );
      totalAuthorizedCount = Number(countRows[0]?.total_count ?? 0);
      filteredAuthorizedCount = 0;
    }

    let nextCursor = null;
    if (hasMore && returnedRows.length > 0) {
      const last = returnedRows[returnedRows.length - 1];
      nextCursor = encodeSessionCursor({
        createdAt: last.created_at,
        sessionId: last.session_id,
      });
    }

    await client.query('COMMIT');
    return {
      authorized: true,
      membership,
      visibilityScope,
      sessions,
      totalAuthorizedCount,
      filteredAuthorizedCount,
      nextCursor,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === 'R2401') {
      return {
        authorized: false,
        membership: null,
        visibilityScope: null,
        sessions: [],
        totalAuthorizedCount: 0,
        filteredAuthorizedCount: 0,
        nextCursor: null,
      };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getOrganizationSessionSummary(
  pool,
  { supabaseUserId, organizationId, sessionId } = {},
) {
  assertPool(pool);
  const subjectId = requiredUuid(supabaseUserId, 'Supabase user ID');
  const orgId = requiredUuid(organizationId, 'organization ID');
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new TypeError('A valid session ID is required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: membershipRows } = await client.query(
      `SELECT organization_id, principal_id, role, status, joined_at, membership_version
         FROM r24.resolve_scoped_organization_membership($1::pg_catalog.uuid, $2::pg_catalog.uuid)`,
      [subjectId, orgId],
    );

    if (membershipRows.length === 0) {
      await client.query('ROLLBACK');
      return {
        authorized: false,
        membership: null,
        visibilityScope: null,
        session: null,
      };
    }

    const membershipRowData = membershipRows[0];
    const membership = {
      organizationId: membershipRowData.organization_id,
      principalId: membershipRowData.principal_id,
      role: membershipRowData.role,
      status: membershipRowData.status,
      joinedAt: membershipRowData.joined_at,
      membershipVersion: membershipRowData.membership_version,
    };

    const visibilityScope =
      membership.role === 'recruiter'
        ? 'issued_by_recruiter'
        : membership.role === 'reviewer'
          ? 'assigned_to_reviewer'
          : 'restricted_role';

    const { rows } = await client.query(
      `SELECT * FROM r24.get_organization_session_summary(
         $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
         $4::pg_catalog.uuid, $5::pg_catalog.text
       )`,
      [
        subjectId,
        '00000000-0000-4000-8000-000000000000',
        'aal1',
        orgId,
        sessionId.trim(),
      ],
    );

    await client.query('COMMIT');
    return {
      authorized: true,
      membership,
      visibilityScope,
      session: rows.length > 0 ? mapSessionRow(rows[0]) : null,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === 'R2401') {
      return {
        authorized: false,
        membership: null,
        visibilityScope: null,
        session: null,
      };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function issueAssessment(
  pool,
  {
    supabaseUserId,
    organizationId,
    sessionId,
    scenarioId,
    scenarioVersion,
    scenarioTitle,
    durationSeconds = null,
    candidateTokenHash,
    candidateTokenCiphertext,
    idempotencyKey = null,
    requestHash = null,
    payloadHash = null,
    terminalEnabled = true,
    taskRubricSnapshot = null,
    aiCapabilitySnapshot = null,
  } = {},
) {
  assertPool(pool);
  const subjectId = requiredUuid(supabaseUserId, 'Supabase user ID');
  const orgId = requiredUuid(organizationId, 'organization ID');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM r25.issue_assessment(
         $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
         $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.text,
         $7::pg_catalog.text, $8::pg_catalog.text, $9::pg_catalog.int4,
         $10::pg_catalog.text, $11::pg_catalog.text, $12::pg_catalog.text,
         $13::pg_catalog.text, $14::pg_catalog.text, $15::pg_catalog.bool,
         $16::pg_catalog.jsonb, $17::pg_catalog.jsonb
       )`,
      [
        subjectId,
        '00000000-0000-4000-8000-000000000000',
        'aal1',
        orgId,
        sessionId,
        scenarioId,
        scenarioVersion,
        scenarioTitle,
        durationSeconds,
        candidateTokenHash,
        candidateTokenCiphertext,
        idempotencyKey,
        requestHash,
        payloadHash,
        terminalEnabled ?? true,
        taskRubricSnapshot ? JSON.stringify(taskRubricSnapshot) : null,
        aiCapabilitySnapshot ? JSON.stringify(aiCapabilitySnapshot) : null,
      ],
    );
    await client.query('COMMIT');
    const row = rows[0];
    return {
      sessionId: row.session_id,
      organizationId: row.organization_id,
      issuerPrincipalId: row.issuer_principal_id,
      scenarioId: row.scenario_id,
      scenarioVersion: row.scenario_version,
      scenarioTitle: row.scenario_title,
      status: row.status,
      createdAt: row.created_at,
      durationSeconds: row.duration_seconds,
      isReplay: row.is_replay,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (
      error?.message === 'IDEMPOTENCY_KEY_CONFLICT' ||
      (error?.code === '23505' &&
        error?.message?.includes('IDEMPOTENCY_KEY_CONFLICT'))
    ) {
      throw new R25IdempotencyConflict();
    }
    if (error?.code === 'R2501') throw new R23ScopeDenied();
    if (error?.code === 'R2503') {
      const err = new Error(error.message);
      err.code = 'ROLE_DENIED';
      throw err;
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverCandidateToken(
  pool,
  { supabaseUserId, organizationId, sessionId } = {},
) {
  assertPool(pool);
  const subjectId = requiredUuid(supabaseUserId, 'Supabase user ID');
  const orgId = requiredUuid(organizationId, 'organization ID');
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new TypeError('A valid session ID is required');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM r25.recover_candidate_token(
         $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
         $4::pg_catalog.uuid, $5::pg_catalog.text
       )`,
      [
        subjectId,
        '00000000-0000-4000-8000-000000000000',
        'aal1',
        orgId,
        sessionId.trim(),
      ],
    );
    await client.query('COMMIT');
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      candidateTokenCiphertext: row.candidate_token_ciphertext,
      candidateTokenHash: row.candidate_token_hash,
      sessionId: row.session_id,
      organizationId: row.organization_id,
      issuerPrincipalId: row.issuer_principal_id,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === 'R2501') throw new R23ScopeDenied();
    if (error?.code === 'R2503') {
      const err = new Error(error.message);
      err.code = 'PERMISSION_DENIED';
      throw err;
    }
    if (error?.code === 'R2504') {
      const err = new Error(error.message);
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listOrganizationReviewers(
  pool,
  { supabaseUserId, organizationId } = {},
) {
  assertPool(pool);
  const subjectId = requiredUuid(supabaseUserId, 'Supabase user ID');
  const orgId = requiredUuid(organizationId, 'organization ID');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM r25.list_organization_reviewers(
         $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
         $4::pg_catalog.uuid
       )`,
      [subjectId, '00000000-0000-4000-8000-000000000000', 'aal1', orgId],
    );
    await client.query('COMMIT');
    return rows.map((r) => ({
      principalId: r.principal_id,
      role: r.role,
      joinedAt: r.joined_at,
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === 'R2501') throw new R23ScopeDenied();
    throw error;
  } finally {
    client.release();
  }
}

export async function assignReviewer(
  pool,
  {
    supabaseUserId,
    organizationId,
    sessionId,
    reviewerPrincipalId,
    assignmentId,
  } = {},
) {
  assertPool(pool);
  const subjectId = requiredUuid(supabaseUserId, 'Supabase user ID');
  const orgId = requiredUuid(organizationId, 'organization ID');
  const reviewer = requiredUuid(reviewerPrincipalId, 'reviewer principal ID');
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new TypeError('A valid session ID is required');
  }
  if (typeof assignmentId !== 'string' || !assignmentId.trim()) {
    throw new TypeError('A valid assignment ID is required');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM r25.assign_reviewer(
         $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
         $4::pg_catalog.uuid, $5::pg_catalog.text, $6::pg_catalog.uuid,
         $7::pg_catalog.text
       )`,
      [
        subjectId,
        '00000000-0000-4000-8000-000000000000',
        'aal1',
        orgId,
        sessionId.trim(),
        reviewer,
        assignmentId.trim(),
      ],
    );
    await client.query('COMMIT');
    const row = rows[0];
    return {
      assignmentId: row.assignment_id,
      sessionId: row.session_id,
      organizationId: row.organization_id,
      reviewerPrincipalId: row.reviewer_principal_id,
      assignedByPrincipalId: row.assigned_by_principal_id,
      assignedAt: row.assigned_at,
      revokedAt: row.revoked_at,
      version: Number(row.version),
      isReplay: row.is_replay,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === 'R2501') throw new R23ScopeDenied();
    if (error?.code === 'R2503') {
      const err = new Error(error.message);
      err.code = 'ROLE_DENIED';
      throw err;
    }
    if (error?.code === 'R2504') {
      const err = new Error(error.message);
      err.code = 'SESSION_NOT_FOUND';
      throw err;
    }
    if (error?.code === 'R2505') {
      const err = new Error(error.message);
      err.code = 'INVALID_REVIEWER';
      throw err;
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listSessionReviewerAssignments(
  pool,
  { supabaseUserId, organizationId, sessionId } = {},
) {
  assertPool(pool);
  const subjectId = requiredUuid(supabaseUserId, 'Supabase user ID');
  const orgId = requiredUuid(organizationId, 'organization ID');
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new TypeError('A valid session ID is required');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM r25.list_session_reviewer_assignments(
         $1::pg_catalog.uuid, $2::pg_catalog.uuid, $3::pg_catalog.text,
         $4::pg_catalog.uuid, $5::pg_catalog.text
       )`,
      [
        subjectId,
        '00000000-0000-4000-8000-000000000000',
        'aal1',
        orgId,
        sessionId.trim(),
      ],
    );
    await client.query('COMMIT');
    return rows.map((r) => ({
      assignmentId: r.assignment_id,
      sessionId: r.session_id,
      organizationId: r.organization_id,
      reviewerPrincipalId: r.reviewer_principal_id,
      assignedByPrincipalId: r.assigned_by_principal_id,
      assignedAt: r.assigned_at,
      revokedAt: r.revoked_at,
      version: Number(r.version),
      isActive: r.is_active,
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === 'R2501') throw new R23ScopeDenied();
    throw error;
  } finally {
    client.release();
  }
}

export {
  installR211AuthoringFixture,
  r211SaveAssessmentDraft as saveAssessmentDraft,
  r211GetAssessmentDraft as getAssessmentDraft,
  r211ListAssessmentDefinitions as listAssessmentDefinitions,
  r211CreateValidatedVersion as createValidatedVersion,
  r211GetValidatedVersion as getValidatedVersion,
  R211ConcurrencyConflict,
};
