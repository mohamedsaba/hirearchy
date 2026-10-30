import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

export class R212AiSecurityError extends Error {
  constructor(message, code = 'AI_SECURITY_ERROR') {
    super(message);
    this.name = 'R212AiSecurityError';
    this.code = code;
  }
}

export class R212AiConflictError extends Error {
  constructor(message = 'R2.12 request ID reused with different prompt') {
    super(message);
    this.name = 'R212AiConflictError';
    this.code = 'CONFLICT_CHANGED_INTENT';
  }
}

export async function installR212AiFixture(clientOrPool) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL fixture client or pool is required');
  }
  const sql = readFileSync(new URL('./fixture.sql', import.meta.url), 'utf8');
  await clientOrPool.query(sql);
}

export async function admitCandidateAiInteraction(
  clientOrPool,
  { tokenHash, sessionId, requestId, prompt, candidatePrompt },
) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  const promptText = candidatePrompt ?? prompt;

  try {
    const { rows } = await clientOrPool.query(
      `SELECT hirearchy.r212_admit_ai_interaction($1, $2, $3, $4) AS result`,
      [tokenHash, sessionId, requestId, promptText],
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

export const admitAiInteraction = admitCandidateAiInteraction;

export async function completeCandidateAiInteraction(
  clientOrPool,
  {
    tokenHash,
    sessionId,
    requestId,
    assistantResponse,
    response,
    durationMs = null,
  },
) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  const responseText = assistantResponse ?? response;

  const { rows } = await clientOrPool.query(
    `SELECT hirearchy.r212_complete_ai_interaction($1, $2, $3, $4, $5) AS result`,
    [tokenHash, sessionId, requestId, responseText, durationMs],
  );
  return rows[0]?.result;
}

export const completeAiInteraction = completeCandidateAiInteraction;

export async function failCandidateAiInteraction(
  clientOrPool,
  {
    tokenHash,
    sessionId,
    requestId,
    failureReason,
    reason,
    errorMessage,
    durationMs = null,
  },
) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  const failReason = failureReason ?? reason;

  const { rows } = await clientOrPool.query(
    `SELECT hirearchy.r212_fail_ai_interaction($1, $2, $3, $4, $5, $6) AS result`,
    [tokenHash, sessionId, requestId, failReason, errorMessage, durationMs],
  );
  return rows[0]?.result;
}

export const failAiInteraction = failCandidateAiInteraction;

export async function getCandidateAiView(
  clientOrPool,
  { tokenHash, sessionId },
) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  const { rows } = await clientOrPool.query(
    `SELECT hirearchy.r212_get_candidate_ai_view($1, $2) AS result`,
    [tokenHash, sessionId],
  );
  return rows[0]?.result;
}

export async function getEvaluatorAiInteractions(
  clientOrPool,
  { organizationId, sessionId, reviewerPrincipalId = null },
) {
  if (!clientOrPool || typeof clientOrPool.query !== 'function') {
    throw new TypeError('A PostgreSQL client or pool is required');
  }

  const { rows } = await clientOrPool.query(
    `SELECT hirearchy.r212_get_evaluator_ai_interactions($1, $2, $3) AS result`,
    [organizationId, sessionId, reviewerPrincipalId],
  );
  return rows[0]?.result ?? [];
}

export function createR212AiAdapter(options = {}) {
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
      'A pool or connectionString is required for createR212AiAdapter',
    );
  }

  return {
    pool,
    getCandidateAiView: (params) => getCandidateAiView(pool, params),
    admitAiInteraction: (params) => admitCandidateAiInteraction(pool, params),
    admitCandidateAiInteraction: (params) =>
      admitCandidateAiInteraction(pool, params),
    completeAiInteraction: (params) =>
      completeCandidateAiInteraction(pool, params),
    completeCandidateAiInteraction: (params) =>
      completeCandidateAiInteraction(pool, params),
    failAiInteraction: (params) => failCandidateAiInteraction(pool, params),
    failCandidateAiInteraction: (params) =>
      failCandidateAiInteraction(pool, params),
    getEvaluatorAiInteractions: (params) =>
      getEvaluatorAiInteractions(pool, params),
    async close() {
      if (owned && pool) {
        await pool.end();
      }
    },
  };
}
