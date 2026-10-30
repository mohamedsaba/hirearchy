import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

export const R214_PROTOCOL_VERSION = 'r214-execution-v1';
export const EXECUTOR_DISPATCH_PROTOCOL_VERSION = 'executor-dispatch-v1';

export const R214_SYNTHETIC_RECIPE_ID = 'recipe-python-check-v1';
export const R214_SYNTHETIC_RECIPE_VERSION = '1.0.0';
export const R214_SYNTHETIC_RECIPE_DIGEST =
  '0760fc4197b0b1654be37456fc70f7c1a9159520ca78cd5b3115e7a5affd6fd2';
export const R214_SYNTHETIC_PROVENANCE = 'synthetic-execution-adapter';

export const R214_RESTRICTED_RECIPE_ID = 'reservation-moves.pytest';
export const R214_RESTRICTED_RECIPE_VERSION = '3';
export const R214_RESTRICTED_RECIPE_DIGEST =
  'eeac2baaf62ce107c7511268e862657ae24bb171cd1dec6ca01797c16ffbaad8';
export const R214_RESTRICTED_SCENARIO_REF = 'reservation-moves';
export const R214_RESTRICTED_SCENARIO_VERSION = 'v3';
export const R214_RESTRICTED_PROVENANCE = 'restricted-executor-service';

export function computeCanonicalSnapshotDigest(files) {
  const normalized = Array.isArray(files)
    ? files
    : Object.entries(files).map(([path, content]) => ({ path, content }));

  const pairs = normalized
    .map((file) => [
      file.path,
      createHash('sha256')
        .update(file.content ?? '', 'utf8')
        .digest('hex'),
    ])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return createHash('sha256')
    .update(Buffer.from(JSON.stringify(pairs), 'utf8'))
    .digest('hex');
}

export function signAdmissionEnvelope(fields, secret) {
  const actualSecret = secret ?? fields.secret;
  const issuedAtMs = fields.issuedAtMs ?? Date.now();
  const expiresAtMs = fields.expiresAtMs ?? issuedAtMs + 60_000;

  const signed = {
    version: 1,
    callerId: fields.callerId,
    keyId: fields.keyId,
    sessionRef: fields.sessionRef,
    operationId: fields.operationId,
    requestId: fields.requestId,
    generation: fields.generation,
    fence: fields.fence,
    scenarioRef: fields.scenarioRef,
    scenarioVersion: fields.scenarioVersion,
    snapshotDigest: fields.snapshotDigest,
    recipeId: fields.recipeId,
    recipeVersion: fields.recipeVersion,
    recipeDigest: fields.recipeDigest,
    timeoutMs: fields.timeoutMs,
    resources: {
      memoryBytes: fields.resources.memoryBytes,
      cpus: fields.resources.cpus,
      pids: fields.resources.pids,
    },
    outputBytes: fields.outputBytes,
    issuedAtMs,
    expiresAtMs,
  };

  const tag = createHmac('sha256', actualSecret)
    .update(JSON.stringify(signed), 'utf8')
    .digest('hex');

  return { ...signed, tag };
}

export function signDispatchEnvelope(
  actionOrParams,
  payloadOrOptions,
  options,
) {
  let action;
  let callerId;
  let keyId;
  let sessionRef;
  let requestId;
  let secret;
  let requestPayload;
  let issuedAtMs;
  let expiresAtMs;

  if (typeof actionOrParams === 'object' && actionOrParams !== null) {
    action = actionOrParams.action;
    callerId = actionOrParams.callerId;
    keyId = actionOrParams.keyId;
    sessionRef = actionOrParams.sessionRef;
    requestId = actionOrParams.requestId;
    secret = actionOrParams.secret;
    requestPayload = actionOrParams.requestPayload;
    issuedAtMs = actionOrParams.issuedAtMs ?? Date.now();
    expiresAtMs = actionOrParams.expiresAtMs ?? issuedAtMs + 60_000;
  } else {
    action = actionOrParams;
    requestPayload = payloadOrOptions;
    const opts = options;
    callerId = opts.callerId;
    keyId = opts.keyId;
    sessionRef = opts.sessionRef;
    requestId = opts.requestId;
    secret = opts.secret;
    issuedAtMs = opts.issuedAtMs ?? Date.now();
    expiresAtMs = opts.expiresAtMs ?? issuedAtMs + 60_000;
  }

  const payloadDigest = createHash('sha256')
    .update(
      requestPayload === null ? 'null' : JSON.stringify(requestPayload),
      'utf8',
    )
    .digest('hex');

  const signed = {
    version: 1,
    action,
    callerId,
    keyId,
    sessionRef,
    requestId,
    issuedAtMs,
    expiresAtMs,
    payloadDigest,
  };

  const tag = createHmac('sha256', secret)
    .update(JSON.stringify(signed), 'utf8')
    .digest('hex');

  return {
    version: 1,
    callerId,
    keyId,
    sessionRef,
    requestId,
    issuedAtMs,
    expiresAtMs,
    payloadDigest,
    tag,
  };
}

export class R214ExecutionSecurityError extends Error {
  constructor(message, code = 'EXECUTION_SECURITY_ERROR') {
    super(message);
    this.name = 'R214ExecutionSecurityError';
    this.code = code;
  }
}

export class R214ExecutionConflictError extends Error {
  constructor(message = 'R2.14 request ID reused with different intent') {
    super(message);
    this.name = 'R214ExecutionConflictError';
    this.code = 'CONFLICT_CHANGED_INTENT';
  }
}

export async function installR214ExecutionFixture(clientOrPool) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL fixture client or pool is required');
  }
  const migration0011 = readFileSync(
    new URL(
      '../migrations/0011_execution_bridge_recipe_identifier.sql',
      import.meta.url,
    ),
    'utf8',
  );
  await clientOrPool.query(migration0011);
  const sql = readFileSync(new URL('./fixture.sql', import.meta.url), 'utf8');
  await clientOrPool.query(sql);
}

export async function admitCandidateExecution(
  clientOrPool,
  {
    tokenHash,
    sessionId,
    requestId,
    expectedWorkspaceDigest,
    recipeId = R214_SYNTHETIC_RECIPE_ID,
    recipeVersion = R214_SYNTHETIC_RECIPE_VERSION,
    recipeDigest = R214_SYNTHETIC_RECIPE_DIGEST,
    provenance = R214_SYNTHETIC_PROVENANCE,
  },
) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  try {
    const { rows } = await clientOrPool.query(
      `SELECT hirearchy.r214_admit_execution_operation($1, $2, $3, $4, $5, $6, $7, $8) AS result`,
      [
        tokenHash,
        sessionId,
        requestId,
        expectedWorkspaceDigest,
        recipeId,
        recipeVersion,
        recipeDigest,
        provenance,
      ],
    );
    return rows[0]?.result;
  } catch (error) {
    if (
      error?.code === '23514' &&
      error?.message?.includes('different intent')
    ) {
      return {
        status: 'CONFLICT',
        reason: error.message,
      };
    }
    throw error;
  }
}

export const admitExecution = admitCandidateExecution;

export async function completeCandidateExecution(
  clientOrPool,
  {
    tokenHash,
    sessionId,
    operationId,
    fence,
    generation = 1,
    exitCode = 0,
    stdout = '',
    stderr = '',
    stdoutDigest = null,
    stderrDigest = null,
    truncatedStdout = false,
    truncatedStderr = false,
    durationMs = null,
    cleanupStatus = 'CLEAN',
  },
) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  const { rows } = await clientOrPool.query(
    `SELECT hirearchy.r214_complete_execution_operation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) AS result`,
    [
      tokenHash,
      sessionId,
      operationId,
      fence,
      generation,
      exitCode,
      stdout,
      stderr,
      stdoutDigest,
      stderrDigest,
      truncatedStdout,
      truncatedStderr,
      durationMs,
      cleanupStatus,
    ],
  );
  return rows[0]?.result;
}

export const completeExecution = completeCandidateExecution;

export async function failCandidateExecution(
  clientOrPool,
  {
    tokenHash,
    sessionId,
    operationId,
    fence,
    generation = 1,
    status = 'FAILED',
    failureReason = 'RUNNER_FAILURE',
    errorMessage = 'Execution failed',
    stdout = '',
    stderr = '',
    stdoutDigest = null,
    stderrDigest = null,
    truncatedStdout = false,
    truncatedStderr = false,
    durationMs = null,
    cleanupStatus = 'CLEAN',
    isUnknown = false,
  },
) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  const { rows } = await clientOrPool.query(
    `SELECT hirearchy.r214_fail_execution_operation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) AS result`,
    [
      tokenHash,
      sessionId,
      operationId,
      fence,
      generation,
      status,
      failureReason,
      errorMessage,
      stdout,
      stderr,
      stdoutDigest,
      stderrDigest,
      truncatedStdout,
      truncatedStderr,
      durationMs,
      cleanupStatus,
      isUnknown,
    ],
  );
  return rows[0]?.result;
}

export const failExecution = failCandidateExecution;

export async function getCandidateExecutionsView(
  clientOrPool,
  { tokenHash, sessionId },
) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  const { rows } = await clientOrPool.query(
    `SELECT hirearchy.r214_get_candidate_executions($1, $2) AS result`,
    [tokenHash, sessionId],
  );
  return rows[0]?.result;
}

export async function getEvaluatorExecutions(clientOrPool, { sessionId }) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  const { rows } = await clientOrPool.query(
    `SELECT hirearchy.r214_get_evaluator_executions($1) AS result`,
    [sessionId],
  );
  return rows[0]?.result ?? { sessionId, operations: [] };
}

export function createR214ExecutionAdapter(options = {}) {
  let pool;
  let owned = false;

  if (options && typeof options.query === 'function') {
    pool = options;
  } else if (options?.pool) {
    pool = options.pool;
  } else if (options?.connectionString) {
    pool = new Pool({
      connectionString: options.connectionString,
      max: 5,
      idleTimeoutMillis: 5000,
    });
    owned = true;
  } else {
    throw new Error('connectionString or pool required');
  }

  return {
    pool,
    async installFixture() {
      await installR214ExecutionFixture(pool);
    },
    async admit(params) {
      return admitCandidateExecution(pool, params);
    },
    async admitCandidateExecution(params) {
      return admitCandidateExecution(pool, params);
    },
    async complete(params) {
      return completeCandidateExecution(pool, params);
    },
    async completeCandidateExecution(params) {
      return completeCandidateExecution(pool, params);
    },
    async fail(params) {
      return failCandidateExecution(pool, params);
    },
    async failCandidateExecution(params) {
      return failCandidateExecution(pool, params);
    },
    async candidateView(params) {
      return getCandidateExecutionsView(pool, params);
    },
    async getCandidateExecutionsView(params) {
      return getCandidateExecutionsView(pool, params);
    },
    async evaluatorView(params) {
      return getEvaluatorExecutions(pool, params);
    },
    async getEvaluatorExecutions(params) {
      return getEvaluatorExecutions(pool, params);
    },
    async close() {
      if (owned && pool) {
        await pool.end();
      }
    },
  };
}
