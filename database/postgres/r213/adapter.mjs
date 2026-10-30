import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

export class R213ExecutionSecurityError extends Error {
  constructor(message, code = 'EXECUTION_SECURITY_ERROR') {
    super(message);
    this.name = 'R213ExecutionSecurityError';
    this.code = code;
  }
}

export class R213ExecutionConflictError extends Error {
  constructor(message = 'R2.13 request ID reused with different intent') {
    super(message);
    this.name = 'R213ExecutionConflictError';
    this.code = 'CONFLICT_CHANGED_INTENT';
  }
}

export async function installR213ExecutionFixture(clientOrPool) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL fixture client or pool is required');
  }
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
    recipeId = 'recipe-python-check-v1',
    recipeVersion = '1.0.0',
    recipeDigest = '0760fc4197b0b1654be37456fc70f7c1a9159520ca78cd5b3115e7a5affd6fd2',
    provenance = 'synthetic-execution-adapter',
  },
) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  try {
    const { rows } = await clientOrPool.query(
      `SELECT hirearchy.r213_admit_execution_operation($1, $2, $3, $4, $5, $6, $7, $8) AS result`,
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
    provenance = null,
  },
) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  const { rows } = await clientOrPool.query(
    `SELECT hirearchy.r213_complete_execution_operation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) AS result`,
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
      provenance,
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
    durationMs = null,
    cleanupStatus = 'CLEAN',
    isUnknown = false,
    provenance = null,
  },
) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  const { rows } = await clientOrPool.query(
    `SELECT hirearchy.r213_fail_execution_operation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) AS result`,
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
      durationMs,
      cleanupStatus,
      isUnknown,
      provenance,
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
    `SELECT hirearchy.r213_get_candidate_executions($1, $2) AS result`,
    [tokenHash, sessionId],
  );
  return rows[0]?.result;
}

export async function getEvaluatorExecutions(
  clientOrPool,
  { organizationId, sessionId, reviewerPrincipalId = null },
) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  const { rows } = await clientOrPool.query(
    `SELECT hirearchy.r213_get_evaluator_executions($1, $2, $3) AS result`,
    [organizationId, sessionId, reviewerPrincipalId],
  );
  return rows[0]?.result ?? [];
}

export function createR213ExecutionAdapter(options = {}) {
  let pool;
  let owned = false;

  if (options && typeof options.query === 'function') {
    pool = options;
  } else if (options?.pool) {
    pool = options.pool;
  } else if (options?.connectionString) {
    pool = new Pool({ connectionString: options.connectionString });
    owned = true;
  } else {
    throw new TypeError(
      'A pool or connectionString is required for createR213ExecutionAdapter',
    );
  }

  return {
    pool,
    getCandidateExecutionsView: (params) =>
      getCandidateExecutionsView(pool, params),
    admitCandidateExecution: (params) => admitCandidateExecution(pool, params),
    admitExecution: (params) => admitCandidateExecution(pool, params),
    completeCandidateExecution: (params) =>
      completeCandidateExecution(pool, params),
    completeExecution: (params) => completeCandidateExecution(pool, params),
    failCandidateExecution: (params) => failCandidateExecution(pool, params),
    failExecution: (params) => failCandidateExecution(pool, params),
    getEvaluatorExecutions: (params) => getEvaluatorExecutions(pool, params),
    async close() {
      if (owned && pool) {
        await pool.end();
      }
    },
  };
}
