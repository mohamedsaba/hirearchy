import { Client } from 'pg';

const CONTEXT_KEYS = [
  'principalId',
  'authSubjectId',
  'authSessionId',
  'assurance',
  'organizationId',
  'correlationId',
];
const SORTED_CONTEXT_KEYS = [...CONTEXT_KEYS].sort();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONNECTION_FAILURE =
  /^(08|57P0[123])|^(ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|ENOTCONN)$/;
const CANCELLATION_TIMEOUT_MS = 2_000;

export class PostgresTransactionError extends Error {
  constructor() {
    super('PostgreSQL transaction failed');
    this.name = 'PostgresTransactionError';
  }
}

export class PostgresTransactionOutcomeUnknown extends Error {
  constructor() {
    super('PostgreSQL transaction outcome is unknown; inspect before retrying');
    this.name = 'PostgresTransactionOutcomeUnknown';
  }
}

function validateContext(context) {
  if (!context || Object.getPrototypeOf(context) !== Object.prototype) {
    throw new TypeError('A verified server authorization context is required');
  }
  const keys = Reflect.ownKeys(context);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Authorization context has an invalid shape');
  }
  keys.sort();
  if (
    keys.length !== SORTED_CONTEXT_KEYS.length ||
    keys.some((key, index) => key !== SORTED_CONTEXT_KEYS[index])
  ) {
    throw new TypeError('Authorization context has an invalid shape');
  }
  const trustedContext = Object.create(null);
  for (const key of CONTEXT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(context, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Authorization context has an invalid shape');
    }
    trustedContext[key] = descriptor.value;
  }
  for (const key of [
    'principalId',
    'authSubjectId',
    'authSessionId',
    'organizationId',
    'correlationId',
  ]) {
    if (
      typeof trustedContext[key] !== 'string' ||
      !UUID.test(trustedContext[key])
    ) {
      throw new TypeError(
        'Authorization context contains an invalid identifier',
      );
    }
  }
  if (
    trustedContext.assurance !== 'aal1' &&
    trustedContext.assurance !== 'aal2'
  ) {
    throw new TypeError('Authorization context contains invalid assurance');
  }
  return Object.freeze(trustedContext);
}

function isDatabaseError(error) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    /^[0-9A-Z]{5}$/.test(error.code ?? ''),
  );
}

function isConnectionFailure(error) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (CONNECTION_FAILURE.test(error.code ?? '') ||
      /connection terminated|connection reset|socket hang up|timeout expired/i.test(
        error.message ?? '',
      )),
  );
}

function abortError() {
  const error = new Error('PostgreSQL transaction aborted');
  error.name = 'AbortError';
  return error;
}

async function verifyRuntimeRole(query) {
  const { rows } = await query(`
    SELECT current_user::text AS role_name,
           session_user::text AS login_name,
           r.rolcanlogin,
           r.rolsuper,
           r.rolbypassrls,
           r.rolcreatedb,
           r.rolcreaterole,
           r.rolreplication,
           r.rolinherit,
           n.nspowner = r.oid AS owns_schema,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_class AS c
             WHERE c.relnamespace = n.oid AND c.relowner = r.oid
           ) AS owns_table,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_auth_members AS m
             WHERE m.roleid = r.oid OR m.member = r.oid
           ) AS has_role_membership
    FROM pg_catalog.pg_roles AS r
    JOIN pg_catalog.pg_namespace AS n ON n.nspname = 'hirearchy'
    WHERE r.rolname = current_user
  `);
  const role = rows[0];
  if (
    !role ||
    role.role_name !== 'app_evaluator' ||
    role.login_name !== 'app_evaluator' ||
    !role.rolcanlogin ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.rolinherit ||
    role.owns_schema ||
    role.owns_table ||
    role.has_role_membership
  ) {
    throw new Error(
      'PostgreSQL transactions require the restricted app_evaluator identity',
    );
  }
}

async function cancelBackend(pool, backendPid) {
  if (!pool.options || typeof pool.options !== 'object') {
    throw new PostgresTransactionError();
  }
  const options = {
    ...pool.options,
    connectionTimeoutMillis: CANCELLATION_TIMEOUT_MS,
    query_timeout: CANCELLATION_TIMEOUT_MS,
    statement_timeout: CANCELLATION_TIMEOUT_MS,
  };
  if (Object.hasOwn(pool.options, 'password'))
    options.password = pool.options.password;
  const client = new Client(options);
  let cancelled = false;
  let failed = false;
  const onClientError = () => {
    failed = true;
  };
  client.on('error', onClientError);
  try {
    await client.connect();
    const { rows } = await client.query(
      'SELECT pg_catalog.pg_cancel_backend($1) AS cancelled',
      [backendPid],
    );
    cancelled = rows[0]?.cancelled === true;
  } catch {
    failed = true;
  }
  try {
    await client.end();
  } catch {
    failed = true;
  }
  client.removeListener('error', onClientError);
  if (failed) throw new PostgresTransactionError();
  return cancelled;
}

async function waitForWork(work) {
  let timer;
  const settled = await Promise.race([
    work.then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), CANCELLATION_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  return settled;
}

// `operation` is trusted server code; never pass request data or retain the raw client.
export async function withTrustedEvaluatorTransaction(
  pool,
  context,
  operation,
  { signal } = {},
) {
  const trustedContext = validateContext(context);
  if (typeof operation !== 'function')
    throw new TypeError('A transaction operation is required');
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new TypeError('A valid AbortSignal is required');
  }
  if (signal?.aborted) throw abortError();

  let client;
  try {
    client = await pool.connect();
  } catch {
    throw new PostgresTransactionError();
  }
  let released = false;
  let transactionStarted = false;
  let queryInFlight = false;
  let operationStarted = false;
  let operationSettled = false;
  let operationWork;
  let commitStarted = false;
  let backendPid;
  let cancellationPromise;
  let cancellationSucceeded = false;
  let rejectAbort;
  let rejectConnectionError;
  const abortPromise = signal
    ? new Promise((_, reject) => {
        rejectAbort = reject;
      })
    : undefined;
  const connectionErrorPromise = new Promise((_, reject) => {
    rejectConnectionError = reject;
  });
  abortPromise?.catch(() => {});
  connectionErrorPromise.catch(() => {});
  const discard = () => {
    if (released) return;
    released = true;
    client.release(true);
  };
  const onClientError = () => {
    const error = commitStarted
      ? new PostgresTransactionOutcomeUnknown()
      : new PostgresTransactionError();
    discard();
    rejectConnectionError(error);
  };
  client.on('error', onClientError);
  const query = async (...args) => {
    queryInFlight = true;
    try {
      return await client.query(...args);
    } finally {
      queryInFlight = false;
    }
  };
  const requestCancellation = () => {
    if (released) return;
    if (cancellationPromise) return;
    if (!queryInFlight && !operationStarted) {
      cancellationSucceeded = true;
      cancellationPromise = Promise.resolve();
      return;
    }
    cancellationPromise = Promise.resolve()
      .then(() => cancelBackend(pool, backendPid))
      .then(
        (succeeded) => {
          cancellationSucceeded = succeeded;
          if (!succeeded) discard();
        },
        () => {
          cancellationSucceeded = false;
          discard();
        },
      );
  };
  const onAbort = () => {
    requestCancellation();
    rejectAbort?.(abortError());
  };

  try {
    if (signal?.aborted) throw abortError();
    await client.query('BEGIN');
    transactionStarted = true;
    const { rows: pidRows } = await client.query(
      'SELECT pg_catalog.pg_backend_pid() AS backend_pid',
    );
    backendPid = Number(pidRows[0]?.backend_pid);
    if (!Number.isInteger(backendPid) || backendPid < 1) {
      throw new Error('PostgreSQL backend identity is unavailable');
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    if (signal?.aborted) throw abortError();

    await query('SET LOCAL search_path = pg_catalog, hirearchy, pg_temp');
    await verifyRuntimeRole(query);
    await query(
      `SELECT
         pg_catalog.set_config('hirearchy.actor_principal_id', $1, true),
         pg_catalog.set_config('hirearchy.auth_subject_id', $2, true),
         pg_catalog.set_config('hirearchy.auth_session_id', $3, true),
         pg_catalog.set_config('hirearchy.auth_assurance', $4, true),
         pg_catalog.set_config('hirearchy.organization_id', $5, true),
         pg_catalog.set_config('hirearchy.correlation_id', $6, true)`,
      [
        trustedContext.principalId,
        trustedContext.authSubjectId,
        trustedContext.authSessionId,
        trustedContext.assurance,
        trustedContext.organizationId,
        trustedContext.correlationId,
      ],
    );
    if (signal?.aborted) throw abortError();
    operationWork = Promise.resolve()
      .then(() => {
        if (signal?.aborted) throw abortError();
        operationStarted = true;
        return operation(client);
      })
      .then(
        (result) => {
          operationSettled = true;
          return result;
        },
        (error) => {
          operationSettled = true;
          throw error;
        },
      );
    operationWork.catch(() => {});
    const operationWaits = [operationWork, connectionErrorPromise];
    if (signal) operationWaits.push(abortPromise);
    const result = await Promise.race(operationWaits);
    if (signal?.aborted) throw abortError();
    commitStarted = true;
    const commitWork = query('COMMIT');
    commitWork.catch(() => {});
    const commitWaits = [commitWork, connectionErrorPromise];
    if (signal) commitWaits.push(abortPromise);
    await Promise.race(commitWaits);
    transactionStarted = false;
    if (signal?.aborted) {
      requestCancellation();
      await cancellationPromise;
      discard();
    }
    return result;
  } catch (error) {
    if (!released) {
      if (signal?.aborted) {
        requestCancellation();
        await cancellationPromise;
        if (commitStarted) {
          discard();
        } else if (
          cancellationSucceeded &&
          operationStarted &&
          !operationSettled
        ) {
          const settled = await waitForWork(operationWork);
          if (!settled) discard();
        }
        if (
          !released &&
          cancellationSucceeded &&
          transactionStarted &&
          (!operationStarted || operationSettled) &&
          !commitStarted
        ) {
          try {
            await query('ROLLBACK');
            transactionStarted = false;
          } catch {
            discard();
          }
        } else if (!cancellationSucceeded) {
          discard();
        }
      } else if (isConnectionFailure(error)) {
        discard();
      } else if (transactionStarted) {
        try {
          await query('ROLLBACK');
          transactionStarted = false;
        } catch {
          discard();
          throw new PostgresTransactionError();
        }
      }
    }
    if (signal?.aborted && commitStarted) {
      throw new PostgresTransactionOutcomeUnknown();
    }
    if (signal?.aborted) throw abortError();
    if (commitStarted && isConnectionFailure(error)) {
      throw new PostgresTransactionOutcomeUnknown();
    }
    if (isDatabaseError(error) || isConnectionFailure(error)) {
      throw new PostgresTransactionError();
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!released) {
      released = true;
      client.removeListener('error', onClientError);
      client.release();
    } else {
      client.removeListener('error', onClientError);
    }
  }
}
