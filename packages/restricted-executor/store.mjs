import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

const SCHEMA = 'restricted_executor';
const OWNER = 'restricted_executor_owner';
const RUNTIME = 'restricted_executor_runtime';
const SENTINEL = new Error('executor PostgreSQL session is invalid');
const handles = new WeakMap();

export class ExecutionStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExecutionStoreError';
    this.code = code;
  }
}

function storeError(code, message) {
  return new ExecutionStoreError(code, message);
}

function unavailable() {
  return storeError(
    'EXECUTION_STORE_UNAVAILABLE',
    'The PostgreSQL execution store is unavailable or does not match its required schema and role.',
  );
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function json(value) {
  return value === null ? null : JSON.stringify(value);
}

function readEntry(row) {
  return {
    requestId: row.request_id,
    operationId: row.operation_id,
    intent: row.intent,
    intentDigest: row.intent_digest,
    generation: Number(row.generation),
    fence: Number(row.fence),
    state: row.state,
    owner: row.owner,
    ownerToken: row.owner_token,
    attempt: row.attempt,
    cleanup: row.cleanup,
    receipt: row.receipt,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function sameIntent(existing, intent, intentDigest) {
  return (
    existing.operation_id === intent.operationId &&
    existing.intent_digest === intentDigest
  );
}

async function ownerAlive(ownerIsAlive, owner) {
  if (typeof ownerIsAlive !== 'function') return null;
  try {
    const result = await ownerIsAlive(owner);
    return result === true || result === false ? result : null;
  } catch {
    return null;
  }
}

function requireHandle(handle) {
  const state = handle && handles.get(handle);
  if (!state || state.closed || state.broken) {
    throw storeError(
      'EXECUTION_UNKNOWN',
      'The database owner session is no longer valid; the execution will not be retried.',
    );
  }
  return state;
}

async function releaseConnection(client, keys, broken = false) {
  if (broken) {
    client.release(SENTINEL);
    return;
  }

  try {
    for (const key of [...keys].reverse()) {
      const result = await client.query(
        'SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS released',
        [key],
      );
      if (result.rows[0]?.released !== true)
        throw new Error('lock was not held');
    }
    client.release();
  } catch {
    client.release(SENTINEL);
    throw unavailable();
  }
}

export function createPostgresExecutionStore({ pool } = {}) {
  if (
    !(pool instanceof Pool) ||
    typeof pool.options?.password !== 'string' ||
    pool.options.password.length === 0
  ) {
    throw storeError(
      'INVALID_CONFIG',
      'A pg.Pool configured with an explicit nonempty password is required.',
    );
  }

  async function assertReady(checkedOutClient = null) {
    let client;
    let ownsClient = false;
    try {
      client = checkedOutClient ?? (await pool.connect());
      ownsClient = checkedOutClient === null;
      const { rows } = await client.query(`
        SELECT
          current_user AS current_user,
          session_user AS session_user,
          runtime.rolcanlogin,
          runtime.rolinherit,
          runtime.rolsuper,
          runtime.rolcreatedb,
          runtime.rolcreaterole,
          runtime.rolreplication,
          runtime.rolbypassrls,
          pg_catalog.current_setting('fsync') AS fsync,
          pg_catalog.current_setting('synchronous_commit') AS synchronous_commit,
          namespace_owner.rolname AS schema_owner,
          namespace_owner.rolcanlogin AS schema_owner_can_login,
          namespace_owner.rolinherit AS schema_owner_inherit,
          namespace_owner.rolsuper AS schema_owner_super,
          namespace_owner.rolcreatedb AS schema_owner_createdb,
          namespace_owner.rolcreaterole AS schema_owner_createrole,
          namespace_owner.rolreplication AS schema_owner_replication,
          namespace_owner.rolbypassrls AS schema_owner_bypassrls,
          NOT pg_catalog.pg_has_role(namespace_owner.oid, runtime.oid, 'MEMBER') AS schema_owner_not_runtime_member,
          requests_owner.rolname AS requests_owner,
          operations_owner.rolname AS operations_owner,
          events_owner.rolname AS events_owner,
          metadata_owner.rolname AS metadata_owner,
          owners_owner.rolname AS owners_owner,
          namespace.nspname IS NOT NULL AS schema_exists,
          pg_catalog.has_schema_privilege(current_user, namespace.oid, 'USAGE') AS schema_usage,
          pg_catalog.has_schema_privilege(current_user, namespace.oid, 'CREATE') AS schema_create,
          pg_catalog.has_table_privilege(current_user, requests.oid, 'SELECT') AS requests_select,
          pg_catalog.has_table_privilege(current_user, requests.oid, 'INSERT') AS requests_insert,
          pg_catalog.has_table_privilege(current_user, requests.oid, 'UPDATE') AS requests_update,
          pg_catalog.has_table_privilege(current_user, requests.oid, 'DELETE') AS requests_delete,
          pg_catalog.has_table_privilege(current_user, requests.oid, 'TRUNCATE') AS requests_truncate,
          pg_catalog.has_table_privilege(current_user, requests.oid, 'REFERENCES') AS requests_references,
          pg_catalog.has_any_column_privilege(current_user, requests.oid, 'REFERENCES') AS requests_column_references,
          pg_catalog.has_table_privilege(current_user, requests.oid, 'TRIGGER') AS requests_trigger,
          pg_catalog.has_table_privilege(current_user, operations.oid, 'REFERENCES') AS operations_references,
          pg_catalog.has_any_column_privilege(current_user, operations.oid, 'REFERENCES') AS operations_column_references,
          pg_catalog.has_table_privilege(current_user, operations.oid, 'TRIGGER') AS operations_trigger,
          pg_catalog.has_table_privilege(current_user, operations.oid, 'SELECT') AS operations_select,
          pg_catalog.has_table_privilege(current_user, operations.oid, 'INSERT') AS operations_insert,
          pg_catalog.has_table_privilege(current_user, operations.oid, 'UPDATE') AS operations_update,
          pg_catalog.has_table_privilege(current_user, operations.oid, 'DELETE') AS operations_delete,
          pg_catalog.has_table_privilege(current_user, operations.oid, 'TRUNCATE') AS operations_truncate,
          pg_catalog.has_table_privilege(current_user, events.oid, 'SELECT') AS events_select,
          pg_catalog.has_table_privilege(current_user, events.oid, 'INSERT') AS events_insert,
          pg_catalog.has_table_privilege(current_user, events.oid, 'UPDATE') AS events_update,
          pg_catalog.has_table_privilege(current_user, events.oid, 'DELETE') AS events_delete,
          pg_catalog.has_table_privilege(current_user, events.oid, 'TRUNCATE') AS events_truncate,
          pg_catalog.has_table_privilege(current_user, events.oid, 'REFERENCES') AS events_references,
          pg_catalog.has_any_column_privilege(current_user, events.oid, 'INSERT') AS events_column_insert,
          pg_catalog.has_any_column_privilege(current_user, events.oid, 'UPDATE') AS events_column_update,
          pg_catalog.has_any_column_privilege(current_user, events.oid, 'REFERENCES') AS events_column_references,
          pg_catalog.has_table_privilege(current_user, events.oid, 'TRIGGER') AS events_trigger,
          pg_catalog.has_table_privilege(current_user, schema_meta_table.oid, 'SELECT') AS metadata_select,
          pg_catalog.has_table_privilege(current_user, schema_meta_table.oid, 'INSERT') AS metadata_insert,
          pg_catalog.has_table_privilege(current_user, schema_meta_table.oid, 'UPDATE') AS metadata_update,
          pg_catalog.has_table_privilege(current_user, schema_meta_table.oid, 'DELETE') AS metadata_delete,
          pg_catalog.has_table_privilege(current_user, schema_meta_table.oid, 'TRUNCATE') AS metadata_truncate,
          pg_catalog.has_table_privilege(current_user, schema_meta_table.oid, 'REFERENCES') AS metadata_references,
          pg_catalog.has_any_column_privilege(current_user, schema_meta_table.oid, 'INSERT') AS metadata_column_insert,
          pg_catalog.has_any_column_privilege(current_user, schema_meta_table.oid, 'UPDATE') AS metadata_column_update,
          pg_catalog.has_any_column_privilege(current_user, schema_meta_table.oid, 'REFERENCES') AS metadata_column_references,
          pg_catalog.has_table_privilege(current_user, schema_meta_table.oid, 'TRIGGER') AS metadata_trigger,
          pg_catalog.has_table_privilege(current_user, owners.oid, 'SELECT') AS owners_select,
          pg_catalog.has_table_privilege(current_user, owners.oid, 'INSERT') AS owners_insert,
          pg_catalog.has_table_privilege(current_user, owners.oid, 'UPDATE') AS owners_update,
          pg_catalog.has_table_privilege(current_user, owners.oid, 'DELETE') AS owners_delete,
          pg_catalog.has_table_privilege(current_user, owners.oid, 'TRUNCATE') AS owners_truncate,
          pg_catalog.has_table_privilege(current_user, owners.oid, 'REFERENCES') AS owners_references,
          pg_catalog.has_any_column_privilege(current_user, owners.oid, 'INSERT') AS owners_column_insert,
          pg_catalog.has_any_column_privilege(current_user, owners.oid, 'UPDATE') AS owners_column_update,
          pg_catalog.has_any_column_privilege(current_user, owners.oid, 'REFERENCES') AS owners_column_references,
          pg_catalog.has_table_privilege(current_user, owners.oid, 'TRIGGER') AS owners_trigger,
          pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
          pg_catalog.has_database_privilege(current_user, current_database(), 'TEMPORARY') AS database_temporary,
          NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_namespace AS other_namespace
             WHERE other_namespace.nspname NOT IN ('${SCHEMA}', 'public', 'information_schema')
               AND pg_catalog.left(other_namespace.nspname, 3) <> 'pg_'
               AND (
                 pg_catalog.has_schema_privilege(current_user, other_namespace.oid, 'USAGE')
                 OR pg_catalog.has_schema_privilege(current_user, other_namespace.oid, 'CREATE')
               )
          ) AS no_other_user_schema_access,
          NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_namespace AS public_namespace
             WHERE public_namespace.nspname = 'public'
               AND pg_catalog.has_schema_privilege(current_user, public_namespace.oid, 'CREATE')
          ) AS no_public_schema_create,
          NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS relation_namespace ON relation_namespace.oid = relation.relnamespace
             WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
               AND relation_namespace.nspname <> 'information_schema'
               AND pg_catalog.left(relation_namespace.nspname, 3) <> 'pg_'
               AND (
                 relation_namespace.nspname <> '${SCHEMA}'
                 OR relation.relname NOT IN ('requests', 'operations', 'request_events', 'schema_meta', 'request_owners')
               )
               AND (
                 pg_catalog.has_table_privilege(current_user, relation.oid, 'SELECT')
                 OR pg_catalog.has_table_privilege(current_user, relation.oid, 'INSERT')
                 OR pg_catalog.has_table_privilege(current_user, relation.oid, 'UPDATE')
                 OR pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE')
                 OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRUNCATE')
                 OR pg_catalog.has_table_privilege(current_user, relation.oid, 'REFERENCES')
                 OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRIGGER')
                 OR pg_catalog.has_any_column_privilege(current_user, relation.oid, 'SELECT')
                 OR pg_catalog.has_any_column_privilege(current_user, relation.oid, 'INSERT')
                 OR pg_catalog.has_any_column_privilege(current_user, relation.oid, 'UPDATE')
                 OR pg_catalog.has_any_column_privilege(current_user, relation.oid, 'REFERENCES')
               )
          ) AS no_other_user_relation_privileges,
          NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_class AS seq
              JOIN pg_catalog.pg_namespace AS sequence_namespace ON sequence_namespace.oid = seq.relnamespace
             WHERE seq.relkind = 'S'
               AND sequence_namespace.nspname <> 'information_schema'
               AND pg_catalog.left(sequence_namespace.nspname, 3) <> 'pg_'
               AND (
                 pg_catalog.has_sequence_privilege(current_user, seq.oid, 'USAGE')
                 OR pg_catalog.has_sequence_privilege(current_user, seq.oid, 'SELECT')
                 OR pg_catalog.has_sequence_privilege(current_user, seq.oid, 'UPDATE')
               )
          ) AS no_user_sequence_privileges,
          NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_roles AS granted_role
             WHERE granted_role.oid <> runtime.oid
               AND pg_catalog.pg_has_role(current_user, granted_role.oid, 'MEMBER')
          ) AS no_role_membership,
          metadata_state.schema_version,
          metadata_state.schema_meta_count,
          metadata_state.guard_fingerprint AS expected_guard_fingerprint,
          (SELECT pg_catalog.md5(
             COALESCE((SELECT pg_catalog.string_agg(
               procedure.proname::text || ':'::text || procedure.prosrc || ':'::text || procedure.prosecdef::text || ':'::text ||
               COALESCE(pg_catalog.array_to_string(procedure.proconfig, ','), '') || ':'::text || owner.rolname::text,
               E'\\n'::text ORDER BY procedure.proname)
               FROM pg_catalog.pg_proc AS procedure
               JOIN pg_catalog.pg_namespace AS function_namespace ON function_namespace.oid = procedure.pronamespace
               JOIN pg_catalog.pg_roles AS owner ON owner.oid = procedure.proowner
              WHERE function_namespace.nspname = '${SCHEMA}'
                AND procedure.proname IN ('check_request_head', 'guard_operation_write', 'guard_request_write', 'record_request_event')), '')
             || E'\\n-- triggers --\\n' ||
             COALESCE((SELECT pg_catalog.string_agg(
               trigger.tgname::text || ':'::text || procedure.proname::text || ':'::text || trigger.tgtype::text || ':'::text ||
               trigger.tgenabled::text || ':'::text || trigger.tgdeferrable::text || ':'::text || trigger.tginitdeferred::text || ':'::text ||
               pg_catalog.pg_get_triggerdef(trigger.oid, true),
               E'\\n'::text ORDER BY trigger.tgname)
               FROM pg_catalog.pg_trigger AS trigger
               JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
               JOIN pg_catalog.pg_namespace AS trigger_namespace ON trigger_namespace.oid = relation.relnamespace
               JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = trigger.tgfoid
              WHERE trigger_namespace.nspname = '${SCHEMA}'
                AND NOT trigger.tgisinternal), '')
           )) AS actual_guard_fingerprint,
          NOT requests.relrowsecurity AND NOT requests.relforcerowsecurity AS requests_no_rls,
          NOT operations.relrowsecurity AND NOT operations.relforcerowsecurity AS operations_no_rls,
          NOT events.relrowsecurity AND NOT events.relforcerowsecurity AS events_no_rls,
          NOT schema_meta_table.relrowsecurity AND NOT schema_meta_table.relforcerowsecurity AS metadata_no_rls,
          NOT owners.relrowsecurity AND NOT owners.relforcerowsecurity AS owners_no_rls
        FROM pg_catalog.pg_roles AS runtime
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.nspname = '${SCHEMA}'
        JOIN pg_catalog.pg_roles AS namespace_owner ON namespace_owner.oid = namespace.nspowner
        JOIN pg_catalog.pg_class AS requests ON requests.relnamespace = namespace.oid AND requests.relname = 'requests'
        JOIN pg_catalog.pg_class AS operations ON operations.relnamespace = namespace.oid AND operations.relname = 'operations'
        JOIN pg_catalog.pg_class AS events ON events.relnamespace = namespace.oid AND events.relname = 'request_events'
        JOIN pg_catalog.pg_class AS schema_meta_table ON schema_meta_table.relnamespace = namespace.oid AND schema_meta_table.relname = 'schema_meta'
        JOIN pg_catalog.pg_class AS owners ON owners.relnamespace = namespace.oid AND owners.relname = 'request_owners'
        JOIN pg_catalog.pg_roles AS requests_owner ON requests_owner.oid = requests.relowner
        JOIN pg_catalog.pg_roles AS operations_owner ON operations_owner.oid = operations.relowner
        JOIN pg_catalog.pg_roles AS events_owner ON events_owner.oid = events.relowner
        JOIN pg_catalog.pg_roles AS metadata_owner ON metadata_owner.oid = schema_meta_table.relowner
        JOIN pg_catalog.pg_roles AS owners_owner ON owners_owner.oid = owners.relowner
        CROSS JOIN LATERAL (
          SELECT
            (SELECT version FROM restricted_executor.schema_meta WHERE singleton) AS schema_version,
            (SELECT pg_catalog.count(*) FROM restricted_executor.schema_meta) AS schema_meta_count,
            (SELECT guard_fingerprint FROM restricted_executor.schema_meta WHERE singleton) AS guard_fingerprint
        ) AS metadata_state
        WHERE runtime.rolname = current_user
      `);
      const row = rows[0];
      const { rows: triggerRows } = await client.query(`
        SELECT
          trg.tgname,
          relation.relname AS table_name,
          trg.tgenabled,
          trg.tgtype,
          trg.tgdeferrable,
          trg.tginitdeferred,
          proc.proname AS function_name,
          proc.prosecdef,
          pg_catalog.array_to_string(proc.proconfig, ',') AS function_config,
          function_owner.rolname AS function_owner
        FROM pg_catalog.pg_trigger AS trg
        JOIN pg_catalog.pg_class AS relation ON relation.oid = trg.tgrelid
        JOIN pg_catalog.pg_namespace AS trigger_namespace ON trigger_namespace.oid = relation.relnamespace
        JOIN pg_catalog.pg_proc AS proc ON proc.oid = trg.tgfoid
        JOIN pg_catalog.pg_roles AS function_owner ON function_owner.oid = proc.proowner
        WHERE trigger_namespace.nspname = '${SCHEMA}' AND NOT trg.tgisinternal
        ORDER BY trg.tgname
      `);
      const expectedTriggers = {
        operations_guard_write: [
          'operations',
          'guard_operation_write',
          23,
          false,
          false,
        ],
        requests_guard_write: [
          'requests',
          'guard_request_write',
          23,
          false,
          false,
        ],
        requests_head_consistent: [
          'requests',
          'check_request_head',
          21,
          true,
          true,
        ],
        requests_record_event: [
          'requests',
          'record_request_event',
          21,
          false,
          false,
        ],
      };
      const validTriggers =
        triggerRows.length === Object.keys(expectedTriggers).length &&
        triggerRows.every((trigger) => {
          const expected = expectedTriggers[trigger.tgname];
          return (
            expected &&
            trigger.table_name === expected[0] &&
            trigger.function_name === expected[1] &&
            trigger.tgtype === expected[2] &&
            trigger.tgenabled === 'O' &&
            trigger.tgdeferrable === expected[3] &&
            trigger.tginitdeferred === expected[4] &&
            trigger.prosecdef === true &&
            trigger.function_config ===
              'search_path=pg_catalog, restricted_executor' &&
            trigger.function_owner === OWNER
          );
        });
      if (
        !row ||
        row.current_user !== RUNTIME ||
        row.session_user !== RUNTIME ||
        row.current_user !== row.session_user ||
        !row.rolcanlogin ||
        row.rolinherit ||
        row.rolsuper ||
        row.rolcreatedb ||
        row.rolcreaterole ||
        row.rolreplication ||
        row.rolbypassrls ||
        row.fsync !== 'on' ||
        row.synchronous_commit !== 'on' ||
        row.schema_owner !== OWNER ||
        row.schema_owner_can_login ||
        row.schema_owner_inherit ||
        row.schema_owner_super ||
        row.schema_owner_createdb ||
        row.schema_owner_createrole ||
        row.schema_owner_replication ||
        row.schema_owner_bypassrls ||
        !row.schema_owner_not_runtime_member ||
        row.requests_owner !== OWNER ||
        row.operations_owner !== OWNER ||
        row.events_owner !== OWNER ||
        row.metadata_owner !== OWNER ||
        row.owners_owner !== OWNER ||
        !row.schema_exists ||
        !row.schema_usage ||
        row.schema_create ||
        !row.requests_select ||
        !row.requests_insert ||
        !row.requests_update ||
        row.requests_delete ||
        row.requests_truncate ||
        row.requests_references ||
        row.requests_column_references ||
        row.requests_trigger ||
        !row.operations_select ||
        !row.operations_insert ||
        !row.operations_update ||
        row.operations_references ||
        row.operations_column_references ||
        row.operations_trigger ||
        row.operations_delete ||
        row.operations_truncate ||
        !row.events_select ||
        row.events_insert ||
        row.events_update ||
        row.events_delete ||
        row.events_truncate ||
        row.events_references ||
        row.events_column_insert ||
        row.events_column_update ||
        row.events_column_references ||
        row.events_trigger ||
        !row.metadata_select ||
        row.metadata_insert ||
        row.metadata_update ||
        row.metadata_delete ||
        row.metadata_truncate ||
        row.metadata_references ||
        row.metadata_column_insert ||
        row.metadata_column_update ||
        row.metadata_column_references ||
        row.metadata_trigger ||
        !row.owners_select ||
        row.owners_insert ||
        row.owners_update ||
        row.owners_delete ||
        row.owners_truncate ||
        row.owners_references ||
        row.owners_column_insert ||
        row.owners_column_update ||
        row.owners_column_references ||
        row.owners_trigger ||
        row.database_create ||
        row.database_temporary ||
        !row.no_other_user_schema_access ||
        !row.no_public_schema_create ||
        !row.no_other_user_relation_privileges ||
        !row.no_user_sequence_privileges ||
        !row.no_role_membership ||
        row.schema_version !== 1 ||
        Number(row.schema_meta_count) !== 1 ||
        row.expected_guard_fingerprint !== row.actual_guard_fingerprint ||
        !validTriggers ||
        !row.requests_no_rls ||
        !row.operations_no_rls ||
        !row.events_no_rls ||
        !row.metadata_no_rls ||
        !row.owners_no_rls
      ) {
        throw unavailable();
      }
    } catch (error) {
      if (error instanceof ExecutionStoreError) throw error;
      throw unavailable();
    } finally {
      if (ownsClient) client?.release();
    }
  }

  async function acquireHandle(lockNames) {
    let client;
    let acquired = [];
    let onError;
    try {
      client = await pool.connect();
      const state = {
        client,
        keys: [],
        broken: false,
        closed: false,
        entry: null,
      };
      onError = () => {
        state.broken = true;
      };
      client.on('error', onError);
      state.onError = onError;
      const lockResult = await client.query(
        `SELECT pg_catalog.hashtextextended(lock_name, 0)::text AS lock_key
           FROM pg_catalog.unnest($1::text[]) AS lock_names(lock_name)
          ORDER BY pg_catalog.hashtextextended(lock_name, 0)`,
        [lockNames],
      );
      const keys = [...new Set(lockResult.rows.map((row) => row.lock_key))];
      for (const key of keys) {
        const result = await client.query(
          'SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS acquired',
          [key],
        );
        if (result.rows[0]?.acquired !== true) {
          client.removeListener('error', onError);
          try {
            await releaseConnection(client, acquired);
          } finally {
            client = null;
            acquired = [];
          }
          throw storeError(
            'EXECUTION_IN_PROGRESS',
            'Another executor currently owns this request or operation.',
          );
        }
        acquired.push(key);
      }
      state.keys = acquired;
      // Validate the exact session that will retain the advisory locks and
      // perform every durable write. Pool-level readiness alone is insufficient
      // because another checked-out session may have different settings.
      await assertReady(client);
      const handle = {};
      handles.set(handle, state);
      return handle;
    } catch (error) {
      if (client) {
        if (onError) client.removeListener('error', onError);
        client.release(SENTINEL);
      }
      if (error instanceof ExecutionStoreError) throw error;
      throw unavailable();
    }
  }

  async function transaction(handle, callback) {
    const state = requireHandle(handle);
    let began = false;
    try {
      await state.client.query('BEGIN');
      began = true;
      await state.client.query('SET LOCAL synchronous_commit = on');
      await assertTransactionDurability(state);
      const result = await callback(state);
      await assertTransactionDurability(state);
      await state.client.query('COMMIT');
      return result;
    } catch (error) {
      if (began && !state.broken) {
        try {
          await state.client.query('ROLLBACK');
        } catch {
          state.broken = true;
        }
      }
      if (state.broken || !(error instanceof ExecutionStoreError)) {
        state.broken = true;
        throw unavailable();
      }
      throw error;
    }
  }

  async function assertTransactionDurability(state) {
    let rows;
    try {
      ({ rows } = await state.client.query(`
      SELECT pg_catalog.current_setting('fsync') AS fsync,
             pg_catalog.current_setting('synchronous_commit') AS synchronous_commit
      `));
    } catch {
      state.broken = true;
      throw unavailable();
    }
    if (rows[0]?.fsync !== 'on' || rows[0]?.synchronous_commit !== 'on') {
      state.broken = true;
      throw unavailable();
    }
  }

  function ensureOwner(state, row, expectedState) {
    if (
      !row ||
      row.state !== expectedState ||
      row.owner_token !== state.ownerToken ||
      row.operation_id !== state.operationId ||
      row.request_id !== state.requestId
    ) {
      throw storeError(
        'EXECUTION_UNKNOWN',
        'The persisted owner or operation state changed; the execution will not continue.',
      );
    }
  }

  async function updateHead(state, entry, priorEntry) {
    if (
      !priorEntry ||
      priorEntry.operationId !== entry.operationId ||
      priorEntry.requestId !== entry.requestId ||
      priorEntry.generation !== entry.generation ||
      priorEntry.fence !== entry.fence ||
      !['active', 'reconciling', 'unknown', 'complete'].includes(
        priorEntry.state,
      )
    ) {
      throw storeError(
        'EXECUTION_UNKNOWN',
        'The persisted operation head changed; the execution will not continue.',
      );
    }
    const result = await state.client.query(
      `UPDATE restricted_executor.operations
          SET state = $5, updated_at = pg_catalog.clock_timestamp()
        WHERE operation_id = $1 AND request_id = $2 AND generation = $3
          AND fence = $4 AND state = $6`,
      [
        priorEntry.operationId,
        priorEntry.requestId,
        priorEntry.generation,
        priorEntry.fence,
        entry.state,
        priorEntry.state,
      ],
    );
    if (result.rowCount !== 1) {
      throw storeError(
        'EXECUTION_UNKNOWN',
        'The persisted operation head changed; the execution will not continue.',
      );
    }
  }

  async function mutate(handle, expectedState, values) {
    const state = requireHandle(handle);
    return transaction(handle, async () => {
      const currentResult = await state.client.query(
        'SELECT * FROM restricted_executor.requests WHERE request_id = $1 FOR UPDATE',
        [state.requestId],
      );
      const currentRow = currentResult.rows[0];
      ensureOwner(state, currentRow, expectedState);
      const current = readEntry(currentRow);
      const next = {
        ...current,
        ...values,
        updatedAt: new Date().toISOString(),
      };
      const updateResult = await state.client.query(
        `UPDATE restricted_executor.requests
            SET state = $3,
                owner = $4::jsonb,
                owner_token = $5::uuid,
                attempt = $6::jsonb,
                cleanup = $7::jsonb,
                receipt = $8::jsonb,
                updated_at = pg_catalog.clock_timestamp()
          WHERE request_id = $1 AND owner_token = $2::uuid AND state = $9
          RETURNING *`,
        [
          state.requestId,
          state.ownerToken,
          next.state,
          json(next.owner),
          next.ownerToken,
          json(next.attempt),
          json(next.cleanup),
          json(next.receipt),
          expectedState,
        ],
      );
      if (updateResult.rowCount !== 1) {
        throw storeError(
          'EXECUTION_UNKNOWN',
          'The persisted owner or operation state changed; the execution will not continue.',
        );
      }
      const entry = readEntry(updateResult.rows[0]);
      await updateHead(state, entry, current);
      state.entry = entry;
      return structuredClone(entry);
    });
  }

  async function reserve({
    intent,
    intentDigest,
    owner,
    attempt,
    ownerIsAlive,
  }) {
    if (
      !isPlainObject(intent) ||
      typeof intent.requestId !== 'string' ||
      typeof intent.operationId !== 'string' ||
      typeof intentDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(intentDigest) ||
      !isPlainObject(owner) ||
      !isPlainObject(attempt)
    ) {
      throw storeError(
        'INVALID_REQUEST',
        'The execution reservation is invalid.',
      );
    }
    await assertReady();
    const handle = await acquireHandle([
      `request:${intent.requestId}`,
      `operation:${intent.operationId}`,
    ]);
    const state = requireHandle(handle);
    try {
      const result = await transaction(handle, async () => {
        const requestResult = await state.client.query(
          'SELECT * FROM restricted_executor.requests WHERE request_id = $1 FOR UPDATE',
          [intent.requestId],
        );
        const prior = requestResult.rows[0];
        if (prior) {
          if (!sameIntent(prior, intent, intentDigest)) {
            throw storeError(
              'IDEMPOTENCY_CONFLICT',
              'requestId is already bound to different execution intent.',
            );
          }
          const entry = readEntry(prior);
          if (entry.state === 'complete' && entry.receipt) {
            return { receipt: entry.receipt };
          }
          if (entry.state === 'active' || entry.state === 'reconciling') {
            if ((await ownerAlive(ownerIsAlive, entry.owner)) === true) {
              throw storeError(
                'EXECUTION_IN_PROGRESS',
                'This request has a live owner and will not be rerun.',
              );
            }
          }
          throw storeError(
            'EXECUTION_UNKNOWN',
            'This request is active, unknown, or owned elsewhere and will not be rerun.',
          );
        }

        const operationResult = await state.client.query(
          'SELECT * FROM restricted_executor.operations WHERE operation_id = $1 FOR UPDATE',
          [intent.operationId],
        );
        const previousOperation = operationResult.rows[0];
        if (previousOperation) {
          if (previousOperation.state !== 'complete') {
            const currentResult = await state.client.query(
              'SELECT owner FROM restricted_executor.requests WHERE request_id = $1',
              [previousOperation.request_id],
            );
            const alive = await ownerAlive(
              ownerIsAlive,
              currentResult.rows[0]?.owner,
            );
            throw storeError(
              alive === true ? 'EXECUTION_IN_PROGRESS' : 'EXECUTION_UNKNOWN',
              'The prior operation is active or unknown and blocks a higher generation.',
            );
          }
          if (
            intent.generation === Number(previousOperation.generation) &&
            intent.fence === Number(previousOperation.fence)
          ) {
            throw storeError(
              'IDEMPOTENCY_CONFLICT',
              'A generation and fence are bound to one request identity.',
            );
          }
          if (
            intent.generation <= Number(previousOperation.generation) ||
            intent.fence <= Number(previousOperation.fence)
          ) {
            throw storeError(
              'STALE_FENCE',
              'The operation generation or fence is stale.',
            );
          }
        }

        const ownerToken = randomUUID();
        state.requestId = intent.requestId;
        state.operationId = intent.operationId;
        state.ownerToken = ownerToken;
        const insertResult = await state.client.query(
          `INSERT INTO restricted_executor.requests (
             request_id, operation_id, generation, fence, intent_digest, intent,
             state, owner, owner_token, attempt
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active', $7::jsonb, $8::uuid, $9::jsonb)
           RETURNING *`,
          [
            intent.requestId,
            intent.operationId,
            intent.generation,
            intent.fence,
            intentDigest,
            json(intent),
            json(owner),
            ownerToken,
            json(attempt),
          ],
        );
        const entry = readEntry(insertResult.rows[0]);
        if (previousOperation) {
          await state.client.query(
            `UPDATE restricted_executor.operations
                SET generation = $2, fence = $3, request_id = $4,
                    state = 'active', updated_at = pg_catalog.clock_timestamp()
              WHERE operation_id = $1`,
            [
              intent.operationId,
              intent.generation,
              intent.fence,
              intent.requestId,
            ],
          );
        } else {
          await state.client.query(
            `INSERT INTO restricted_executor.operations
               (operation_id, generation, fence, request_id, state)
             VALUES ($1, $2, $3, $4, 'active')`,
            [
              intent.operationId,
              intent.generation,
              intent.fence,
              intent.requestId,
            ],
          );
        }
        state.entry = entry;
        return { entry };
      });
      if (result.receipt) {
        await release(handle);
        return { receipt: structuredClone(result.receipt) };
      }
      return { entry: structuredClone(result.entry), handle };
    } catch (error) {
      await release(handle).catch(() => undefined);
      if (error instanceof ExecutionStoreError) throw error;
      throw unavailable();
    }
  }

  async function updateAttempt(handle, patch) {
    if (
      !isPlainObject(patch) ||
      Object.keys(patch).some(
        (key) => !['stage', 'createAmbiguous', 'containerId'].includes(key),
      )
    ) {
      throw storeError(
        'INVALID_REQUEST',
        'The container attempt update is invalid.',
      );
    }
    const state = requireHandle(handle);
    const attempt = { ...state.entry.attempt, ...patch };
    return mutate(handle, 'active', { attempt });
  }

  async function complete(handle, { attempt, cleanup, receipt } = {}) {
    if (
      !isPlainObject(attempt) ||
      !isPlainObject(cleanup) ||
      !isPlainObject(receipt)
    ) {
      throw storeError(
        'INVALID_REQUEST',
        'The completed execution record is invalid.',
      );
    }
    return mutate(handle, 'active', {
      state: 'complete',
      owner: null,
      ownerToken: null,
      attempt,
      cleanup,
      receipt,
    });
  }

  async function markUnknown(handle, { attempt, cleanup } = {}) {
    if (!isPlainObject(attempt) || !isPlainObject(cleanup)) {
      throw storeError(
        'INVALID_REQUEST',
        'The unknown execution record is invalid.',
      );
    }
    return mutate(handle, 'active', {
      state: 'unknown',
      owner: null,
      ownerToken: null,
      attempt,
      cleanup,
      receipt: null,
    });
  }

  async function claimReconciliation({ requestId, owner, ownerIsAlive }) {
    if (typeof requestId !== 'string' || !isPlainObject(owner)) {
      throw storeError(
        'INVALID_REQUEST',
        'The reconciliation request is invalid.',
      );
    }
    await assertReady();
    let client;
    try {
      client = await pool.connect();
      const lookup = await client.query(
        'SELECT operation_id FROM restricted_executor.requests WHERE request_id = $1',
        [requestId],
      );
      if (!lookup.rows[0]) {
        throw storeError(
          'UNKNOWN_REQUEST',
          'No durable execution has this request identity.',
        );
      }
      const operationId = lookup.rows[0].operation_id;
      client.release();
      client = null;
      const handle = await acquireHandle([
        `request:${requestId}`,
        `operation:${operationId}`,
      ]);
      const state = requireHandle(handle);
      try {
        const result = await transaction(handle, async () => {
          const requestResult = await state.client.query(
            'SELECT * FROM restricted_executor.requests WHERE request_id = $1 FOR UPDATE',
            [requestId],
          );
          const row = requestResult.rows[0];
          if (!row) {
            throw storeError(
              'UNKNOWN_REQUEST',
              'No durable execution has this request identity.',
            );
          }
          const entry = readEntry(row);
          if (entry.state === 'complete') {
            return {
              completed: true,
              entry: structuredClone(entry),
              operationId,
            };
          }
          if (entry.state === 'active' || entry.state === 'reconciling') {
            const alive = await ownerAlive(ownerIsAlive, entry.owner);
            if (alive === true) {
              throw storeError(
                'EXECUTION_IN_PROGRESS',
                'The recorded owner is still active; reconciliation will not race it.',
              );
            }
            if (alive !== false) {
              throw storeError(
                'EXECUTION_UNKNOWN',
                'The recorded owner cannot be safely located; reconciliation will not proceed.',
              );
            }
          }

          const ownerToken = randomUUID();
          state.requestId = requestId;
          state.operationId = operationId;
          state.ownerToken = ownerToken;
          const claim = await state.client.query(
            `UPDATE restricted_executor.requests
                SET state = 'reconciling', owner = $2::jsonb, owner_token = $3::uuid,
                    updated_at = pg_catalog.clock_timestamp()
              WHERE request_id = $1 AND state = $4
              RETURNING *`,
            [requestId, json(owner), ownerToken, entry.state],
          );
          if (claim.rowCount !== 1) {
            throw storeError(
              'EXECUTION_UNKNOWN',
              'The execution changed before reconciliation could claim it.',
            );
          }
          const claimed = readEntry(claim.rows[0]);
          await updateHead(state, claimed, entry);
          state.entry = claimed;
          return {
            completed: false,
            entry: structuredClone(claimed),
            operationId,
          };
        });
        if (result.completed) {
          await release(handle);
          return result;
        }
        return { ...result, handle };
      } catch (error) {
        await release(handle).catch(() => undefined);
        if (error instanceof ExecutionStoreError) throw error;
        throw unavailable();
      }
    } catch (error) {
      if (client) client.release(SENTINEL);
      if (error instanceof ExecutionStoreError) throw error;
      throw unavailable();
    }
  }

  async function finishReconciliation(handle, { attempt, cleanup } = {}) {
    if (!isPlainObject(attempt) || !isPlainObject(cleanup)) {
      throw storeError(
        'INVALID_REQUEST',
        'The reconciliation result is invalid.',
      );
    }
    return mutate(handle, 'reconciling', {
      state: 'unknown',
      owner: null,
      ownerToken: null,
      attempt,
      cleanup,
      receipt: null,
    });
  }

  async function release(handle) {
    const state = handle && handles.get(handle);
    if (!state || state.closed) return;
    state.closed = true;
    handles.delete(handle);
    state.client.removeListener('error', state.onError);
    await releaseConnection(state.client, state.keys, state.broken);
  }

  return Object.freeze({
    assertReady,
    reserve,
    updateAttempt,
    complete,
    markUnknown,
    claimReconciliation,
    finishReconciliation,
    release,
  });
}
