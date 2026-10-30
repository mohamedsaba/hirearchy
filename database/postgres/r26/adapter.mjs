import { Pool } from 'pg';

const HASH = /^[0-9a-f]{64}$/;
const SESSION_ID = /^sess_[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION = /^(0|[1-9][0-9]{0,18})$/;
const MAX_VERSION = 9_223_372_036_854_775_807n;

const ERROR_DETAILS = Object.freeze({
  R2601: [
    'REQUEST_CONFLICT',
    409,
    'Request identifier was already used with different input.',
  ],
  R2602: [
    'WORKSPACE_CONFLICT',
    409,
    'Workspace changed; reload before retrying.',
  ],
  R2603: ['INVALID_REQUEST', 400, 'Candidate request is invalid.'],
  R2604: ['SESSION_NOT_FOUND', 404, 'Candidate session is unavailable.'],
  R2605: [
    'SESSION_CONFLICT',
    409,
    'Candidate session is not available for this action.',
  ],
  R2606: ['SCENARIO_UNAVAILABLE', 503, 'Issued scenario data is unavailable.'],
  R2607: [
    'SESSION_DEADLINE_EXCEEDED',
    409,
    'Candidate session deadline has passed.',
  ],
  R2608: ['CANDIDATE_ROLE_DENIED', 403, 'Candidate storage access is denied.'],
  R2609: ['PAYLOAD_TOO_LARGE', 413, 'Candidate workspace limit exceeded.'],
});

export class R26CandidateError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'R26CandidateError';
    this.code = code;
    this.status = status;
  }
}

function invalidRequest() {
  return new R26CandidateError(
    'INVALID_REQUEST',
    400,
    'Candidate request is invalid.',
  );
}

function validateInput(command) {
  if (
    !command ||
    typeof command !== 'object' ||
    typeof command.tokenHash !== 'string' ||
    !HASH.test(command.tokenHash) ||
    typeof command.sessionId !== 'string' ||
    !SESSION_ID.test(command.sessionId) ||
    !['read', 'activate', 'save', 'submit'].includes(command.action)
  ) {
    throw invalidRequest();
  }

  const input = command.input ?? {};
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw invalidRequest();
  }

  const keys = Object.keys(input).sort();
  if (command.action === 'read' || command.action === 'activate') {
    if (keys.length !== 0) throw invalidRequest();
  } else if (command.action === 'save') {
    if (
      keys.join(',') !== 'content,expectedVersion,path,requestId' ||
      typeof input.requestId !== 'string' ||
      !REQUEST_ID.test(input.requestId) ||
      typeof input.path !== 'string' ||
      typeof input.content !== 'string' ||
      typeof input.expectedVersion !== 'string' ||
      !VERSION.test(input.expectedVersion) ||
      BigInt(input.expectedVersion) > MAX_VERSION
    ) {
      throw invalidRequest();
    }
  } else if (
    keys.join(',') !== 'expectedWorkspaceDigest,requestId' ||
    typeof input.requestId !== 'string' ||
    !REQUEST_ID.test(input.requestId) ||
    typeof input.expectedWorkspaceDigest !== 'string' ||
    !HASH.test(input.expectedWorkspaceDigest)
  ) {
    throw invalidRequest();
  }

  return input;
}

function mapDatabaseError(error) {
  const details = ERROR_DETAILS[error?.code];
  if (details) {
    return new R26CandidateError(details[0], details[1], details[2]);
  }
  if (error?.code === '42501') {
    return new R26CandidateError(
      'CANDIDATE_ROLE_DENIED',
      403,
      'Candidate storage access is denied.',
    );
  }
  if (typeof error?.code === 'string' && error.code.startsWith('22')) {
    return invalidRequest();
  }
  return new R26CandidateError(
    'CANDIDATE_STORAGE_UNAVAILABLE',
    503,
    'Candidate storage is temporarily unavailable.',
  );
}

export function createR26CandidateAdapter({ connectionString } = {}) {
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new TypeError('A PostgreSQL candidate connection string is required');
  }

  const pool = new Pool({
    connectionString,
    application_name: 'hirearchy-r26-candidate',
    connectionTimeoutMillis: 3_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    max: 4,
  });
  let closed = false;
  // node-postgres emits idle-client transport failures on the Pool itself.
  // The pool removes that client; retain no raw error text or connection data.
  pool.on('error', () => {
    closed = true;
  });

  return Object.freeze({
    async command(command) {
      if (closed) {
        throw new R26CandidateError(
          'CANDIDATE_STORAGE_UNAVAILABLE',
          503,
          'Candidate storage is temporarily unavailable.',
        );
      }
      const input = validateInput(command);
      let client;
      let discard = false;
      const onClientError = () => {
        discard = true;
      };
      try {
        client = await pool.connect();
        client.on('error', onClientError);
        const { rows: roleRows } = await client.query(`
          SELECT current_user::pg_catalog.text AS role_name,
                 session_user::pg_catalog.text AS login_name,
                 role.rolcanlogin,
                 role.rolsuper,
                 role.rolbypassrls,
                 role.rolcreatedb,
                 role.rolcreaterole,
                 role.rolreplication,
                 role.rolinherit,
                 EXISTS (
                   SELECT 1 FROM pg_catalog.pg_auth_members AS membership
                   WHERE membership.roleid = role.oid OR membership.member = role.oid
                 ) AS has_role_membership,
                 EXISTS (
                   SELECT 1 FROM pg_catalog.pg_namespace AS owned_namespace
                   WHERE owned_namespace.nspname = 'hirearchy'
                     AND owned_namespace.nspowner = role.oid
                 ) AS owns_schema,
                 EXISTS (
                   SELECT 1 FROM pg_catalog.pg_class AS relation
                   JOIN pg_catalog.pg_namespace AS relation_namespace
                     ON relation_namespace.oid = relation.relnamespace
                   WHERE relation_namespace.nspname = 'hirearchy'
                     AND relation.relowner = role.oid
                 ) AS owns_table,
                 EXISTS (
                   SELECT 1 FROM pg_catalog.pg_proc AS procedure
                   JOIN pg_catalog.pg_namespace AS procedure_namespace
                     ON procedure_namespace.oid = procedure.pronamespace
                   WHERE procedure_namespace.nspname = 'hirearchy'
                     AND procedure.proowner = role.oid
                 ) AS owns_function
            FROM pg_catalog.pg_roles AS role
           WHERE role.rolname = current_user
        `);
        const role = roleRows[0];
        if (
          !role ||
          role.role_name !== 'app_candidate_gateway' ||
          role.login_name !== 'app_candidate_gateway' ||
          !role.rolcanlogin ||
          role.rolsuper ||
          role.rolbypassrls ||
          role.rolcreatedb ||
          role.rolcreaterole ||
          role.rolreplication ||
          role.rolinherit ||
          role.has_role_membership ||
          role.owns_schema ||
          role.owns_table ||
          role.owns_function
        ) {
          throw new R26CandidateError(
            'CANDIDATE_ROLE_DENIED',
            403,
            'Candidate storage access is denied.',
          );
        }

        const { rows } = await client.query(
          `SELECT hirearchy.r26_candidate_command($1, $2, $3, $4::pg_catalog.jsonb) AS view`,
          [
            command.tokenHash,
            command.sessionId,
            command.action,
            JSON.stringify(input),
          ],
        );
        const result = rows[0]?.view;
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('Invalid R2.6 candidate response');
        }
        return result;
      } catch (error) {
        if (error instanceof R26CandidateError) throw error;
        throw mapDatabaseError(error);
      } finally {
        client?.removeListener('error', onClientError);
        client?.release(discard);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await pool.end();
      } catch {
        throw new R26CandidateError(
          'CANDIDATE_STORAGE_UNAVAILABLE',
          503,
          'Candidate storage is temporarily unavailable.',
        );
      }
    },
  });
}
