import { createHash } from 'node:crypto';
import { Pool } from 'pg';

import {
  admitCandidateExecution,
  completeCandidateExecution,
  failCandidateExecution,
  getCandidateExecutionsView,
} from '../../../../database/postgres/r213/adapter.mjs';
import type {
  R213AdmissionParams,
  R213ExecutionAdmissionResult,
  R213RecordedOperation,
} from '../../../../database/postgres/r213/contract.d.mts';
import { createR26CandidateAdapter } from '../../../../database/postgres/r26/adapter.mjs';
import { readR26Config, r26IsEnabled } from '../r26-candidate/config';
import { isFounderUatEnabled } from '../runtime/founder-uat';
import { isHiringPlatformEnabled, isStagingLockdown } from '../runtime/profile';
import { runHiringWorkspaceChecks } from './hiring-runner';
import {
  DEFAULT_PYTHON_CHECK_RECIPE,
  RESTRICTED_EXECUTOR_PROVENANCE,
  RESTRICTED_RECIPE_DIGEST,
  RESTRICTED_RECIPE_ID,
  RESTRICTED_RECIPE_VERSION,
  SYNTHETIC_PROVENANCE,
  SYNTHETIC_RECIPE_DIGEST,
  type ExecutionBackend,
  type R214CandidateExecutionView,
  type R214ExecutionIntent,
  type R214RecordedOperation,
} from './contract';
import {
  configuredRestrictedKey,
  getExecutionAdapter,
  type ExecutionAdapter,
} from './adapter';

const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9_-]{1,128}$/;
const TOKEN_PATTERN = /^(?:[A-Za-z0-9_-]{32}|[A-Za-z0-9_-]{43})$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 64_000;

export class R214RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'R214RequestError';
  }
}

const responseHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Authorization',
};

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: responseHeaders },
  );
}

let cachedPool: Pool | null = null;
let cachedDatabaseUrl: string | null = null;

function getClientPool(databaseUrl: string): Pool {
  if (cachedPool && cachedDatabaseUrl === databaseUrl) {
    return cachedPool;
  }
  if (cachedPool) {
    cachedPool.end().catch(() => undefined);
  }
  cachedPool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  cachedDatabaseUrl = databaseUrl;
  return cachedPool;
}

function requireSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new R214RequestError(
      404,
      'ASSESSMENT_NOT_FOUND',
      'This assessment is not available.',
    );
  }
}

function requireBearer(request: Request): string {
  const authorization = request.headers.get('authorization');
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  const token = match?.[1];
  if (!token || !TOKEN_PATTERN.test(token)) {
    throw new R214RequestError(
      401,
      'CANDIDATE_ACCESS_DENIED',
      'A valid candidate link is required.',
    );
  }
  const bytes = Buffer.from(token, 'base64url');
  if (
    ![24, 32].includes(bytes.length) ||
    bytes.toString('base64url') !== token
  ) {
    throw new R214RequestError(
      401,
      'CANDIDATE_ACCESS_DENIED',
      'A valid candidate link is required.',
    );
  }
  return token;
}

function requireEnabledConfig() {
  if (!isHiringPlatformEnabled() && !r26IsEnabled()) {
    throw new R214RequestError(
      404,
      'ASSESSMENT_NOT_FOUND',
      'This assessment is not available.',
    );
  }
  const config = readR26Config();
  if (!config) {
    throw new R214RequestError(
      404,
      'ASSESSMENT_NOT_FOUND',
      'This assessment is not available.',
    );
  }
  return config;
}

async function hiringGetExecutionsView(
  pool: Pool,
  params: { tokenHash: string; sessionId: string },
): Promise<R214CandidateExecutionView> {
  const { rows } = await pool.query<{ result: R214CandidateExecutionView }>(
    'SELECT staging.hiring_r213_get_view($1, $2) AS result',
    [params.tokenHash, params.sessionId],
  );
  return rows[0]?.result;
}

async function hiringAdmitExecution(
  pool: Pool,
  params: R213AdmissionParams,
): Promise<R213ExecutionAdmissionResult> {
  try {
    const { rows } = await pool.query<{ result: R213ExecutionAdmissionResult }>(
      'SELECT staging.hiring_r213_admit($1, $2, $3, $4, $5, $6, $7, $8) AS result',
      [
        params.tokenHash,
        params.sessionId,
        params.requestId,
        params.expectedWorkspaceDigest,
        params.recipeId ?? 'recipe-python-check-v1',
        params.recipeVersion ?? '1.0.0',
        params.recipeDigest ??
          '0760fc4197b0b1654be37456fc70f7c1a9159520ca78cd5b3115e7a5affd6fd2',
        params.provenance ?? 'hiring-workspace-runner',
      ],
    );
    return rows[0]?.result;
  } catch (error) {
    const pgErr = error as { code?: string; message?: string };
    if (
      pgErr?.code === '23514' &&
      pgErr?.message?.includes('different intent')
    ) {
      return { status: 'CONFLICT', reason: pgErr.message };
    }
    throw error;
  }
}

async function hiringCompleteExecution(
  pool: Pool,
  params: Parameters<typeof completeCandidateExecution>[1],
): Promise<R213RecordedOperation> {
  const { rows } = await pool.query<{ result: R213RecordedOperation }>(
    'SELECT staging.hiring_r213_complete($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) AS result',
    [
      params.tokenHash,
      params.sessionId,
      params.operationId,
      params.fence,
      params.generation ?? 1,
      params.exitCode ?? 0,
      params.stdout ?? '',
      params.stderr ?? '',
      params.stdoutDigest ?? null,
      params.stderrDigest ?? null,
      params.truncatedStdout ?? false,
      params.truncatedStderr ?? false,
      params.durationMs ?? null,
      params.cleanupStatus ?? 'CLEAN',
      params.provenance ?? null,
    ],
  );
  return rows[0]?.result;
}

async function hiringFailExecution(
  pool: Pool,
  params: Parameters<typeof failCandidateExecution>[1],
): Promise<R213RecordedOperation> {
  const { rows } = await pool.query<{ result: R213RecordedOperation }>(
    'SELECT staging.hiring_r213_fail($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) AS result',
    [
      params.tokenHash,
      params.sessionId,
      params.operationId,
      params.fence,
      params.generation ?? 1,
      params.status ?? 'FAILED',
      params.failureReason ?? 'RUNNER_FAILURE',
      params.errorMessage ?? 'Execution failed',
      params.stdout ?? '',
      params.stderr ?? '',
      params.durationMs ?? null,
      params.cleanupStatus ?? 'CLEAN',
      params.isUnknown ?? false,
      params.provenance ?? null,
    ],
  );
  return rows[0]?.result;
}

function requireSameOrigin(request: Request, expectedOrigin: string): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== expectedOrigin) {
    throw new R214RequestError(
      403,
      'ORIGIN_DENIED',
      'This request did not come from the candidate workspace.',
    );
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type');
  if (
    !contentType ||
    contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    throw new R214RequestError(
      400,
      'INVALID_REQUEST',
      'The request must contain JSON.',
    );
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new R214RequestError(
        400,
        'INVALID_REQUEST',
        'The request could not be accepted.',
      );
    }
    if (Number(contentLength) > MAX_BODY_BYTES) {
      throw new R214RequestError(
        413,
        'REQUEST_TOO_LARGE',
        'This request is larger than the supported limit.',
      );
    }
  }

  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new R214RequestError(
      413,
      'REQUEST_TOO_LARGE',
      'This request is larger than the supported limit.',
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new R214RequestError(
      400,
      'INVALID_REQUEST',
      'The request could not be accepted.',
    );
  }
}

export type CandidateExecutionActionPayload = Readonly<{
  requestId: string;
  expectedWorkspaceDigest: string;
  recipeId?: string;
}>;

function parseExecutionActionPayload(
  value: unknown,
): CandidateExecutionActionPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new R214RequestError(
      400,
      'INVALID_REQUEST',
      'The request body must be an object.',
    );
  }
  const obj = value as Record<string, unknown>;
  const { requestId, expectedWorkspaceDigest, recipeId } = obj;

  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new R214RequestError(
      400,
      'INVALID_REQUEST',
      'A valid requestId is required.',
    );
  }

  if (
    typeof expectedWorkspaceDigest !== 'string' ||
    !DIGEST_PATTERN.test(expectedWorkspaceDigest)
  ) {
    throw new R214RequestError(
      400,
      'INVALID_REQUEST',
      'A valid 64-character expectedWorkspaceDigest is required.',
    );
  }

  if (recipeId !== undefined && typeof recipeId !== 'string') {
    throw new R214RequestError(
      400,
      'INVALID_REQUEST',
      'recipeId must be a string if provided.',
    );
  }

  return {
    requestId,
    expectedWorkspaceDigest,
    recipeId: recipeId as string | undefined,
  };
}

function buildFactualExecutionResponse(
  operation: R214RecordedOperation | R213RecordedOperation,
  isReplay = false,
  remainingExecutions?: number,
) {
  const isSynthetic =
    operation.provenance === SYNTHETIC_PROVENANCE ||
    operation.provenance !== RESTRICTED_EXECUTOR_PROVENANCE;

  return {
    ...operation,
    admissionStatus: isReplay
      ? operation.status === 'COMPLETED'
        ? 'REPLAY_COMPLETED'
        : 'REPLAY'
      : 'ADMITTED',
    isReplay,
    ...(remainingExecutions !== undefined ? { remainingExecutions } : {}),
    provenance: operation.provenance,
    isSynthetic,
  };
}

export async function r214CandidateExecutionRead(
  request: Request,
  sessionId: string,
): Promise<Response> {
  try {
    requireSessionId(sessionId);
    const config = requireEnabledConfig();
    const token = requireBearer(request);
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const pool = getClientPool(config.databaseUrl);

    const view: R214CandidateExecutionView = isHiringPlatformEnabled()
      ? await hiringGetExecutionsView(pool, { tokenHash, sessionId })
      : ((await getCandidateExecutionsView(pool, {
          tokenHash,
          sessionId,
        })) as unknown as R214CandidateExecutionView);

    return Response.json(view, { status: 200, headers: responseHeaders });
  } catch (error) {
    if (error instanceof R214RequestError) {
      return errorResponse(error.status, error.code, error.message);
    }
    const message = (error as Error)?.message || '';
    if (
      message.includes('authentication failed') ||
      message.includes('42501')
    ) {
      return errorResponse(
        401,
        'CANDIDATE_ACCESS_DENIED',
        'This candidate link is not available for this assessment.',
      );
    }
    if (message.includes('unavailable') || message.includes('R2604')) {
      return errorResponse(
        404,
        'ASSESSMENT_NOT_FOUND',
        'This assessment is not available.',
      );
    }
    return errorResponse(
      503,
      'EXECUTION_UNAVAILABLE',
      'Candidate execution is temporarily unavailable.',
    );
  }
}

export async function r214CandidateExecutionAction(
  request: Request,
  sessionId: string,
  adapterOverride?: ExecutionAdapter,
): Promise<Response> {
  const hiringActive = isHiringPlatformEnabled();
  if (!hiringActive && isStagingLockdown()) {
    return errorResponse(
      503,
      'EXECUTION_DISABLED',
      'Candidate execution is disabled in staging lockdown.',
    );
  }
  try {
    requireSessionId(sessionId);
    const config = requireEnabledConfig();
    requireSameOrigin(request, config.publicOrigin);
    const token = requireBearer(request);
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const payload = parseExecutionActionPayload(await readBoundedJson(request));

    let backend: ExecutionBackend = 'deterministic-synthetic';
    if (
      !hiringActive &&
      process.env.HIREARCHY_EXECUTION_BACKEND === 'restricted-executor'
    ) {
      const candidateAdapter = createR26CandidateAdapter({
        connectionString: config.databaseUrl,
        requireLifecycleMarker: config.profile === 'durable-staging',
      });
      try {
        const view = await candidateAdapter.command({
          tokenHash,
          sessionId,
          action: 'read',
        });
        const scenario = view?.scenario;
        if (scenario?.id === 'reservation-moves' && scenario.version === 'v3') {
          const recipe = scenario.recipe as
            { id?: unknown; version?: unknown; digest?: unknown } | undefined;
          if (
            scenario.templateId !== 'reservation-moves-v3' ||
            scenario.starterWorkspaceDigest !==
              'c1e172b193fd0c5e78f81ef5bf74ea95a07b6be3215829d5fa8e5116423b0694' ||
            typeof scenario.validatedVersionId !== 'string' ||
            typeof scenario.validatedContentDigest !== 'string' ||
            !/^[0-9a-f]{64}$/.test(scenario.validatedContentDigest) ||
            recipe?.id !== RESTRICTED_RECIPE_ID ||
            recipe.version !== RESTRICTED_RECIPE_VERSION ||
            recipe.digest !== RESTRICTED_RECIPE_DIGEST
          ) {
            return errorResponse(
              409,
              'SCENARIO_INCOMPATIBLE',
              'The approved execution template could not be verified.',
            );
          }
          backend = 'restricted-executor';
        }
      } finally {
        await candidateAdapter.close();
      }
    }

    if (backend === 'restricted-executor' && !adapterOverride) {
      try {
        configuredRestrictedKey('HIREARCHY_ADMISSION_KEY');
        configuredRestrictedKey('HIREARCHY_DISPATCH_KEY');
        if (
          !process.env.HIREARCHY_RESTRICTED_EXECUTOR_URL &&
          !process.env.EXECUTOR_SERVICE_URL
        )
          throw new Error('Execution service is unavailable');
      } catch {
        return errorResponse(
          503,
          'EXECUTION_UNAVAILABLE',
          'Candidate execution is temporarily unavailable.',
        );
      }
    }

    const pool = getClientPool(config.databaseUrl);

    // Determine recipe parameters based on backend and request
    let recipeId: string = payload.recipeId ?? DEFAULT_PYTHON_CHECK_RECIPE.id;
    let recipeVersion: string = DEFAULT_PYTHON_CHECK_RECIPE.version;
    let recipeDigest: string = SYNTHETIC_RECIPE_DIGEST;
    let provenance: string = hiringActive
      ? 'hiring-workspace-runner'
      : SYNTHETIC_PROVENANCE;

    if (backend === 'restricted-executor') {
      recipeId = RESTRICTED_RECIPE_ID;
      recipeVersion = RESTRICTED_RECIPE_VERSION;
      recipeDigest = RESTRICTED_RECIPE_DIGEST;
      provenance = RESTRICTED_EXECUTOR_PROVENANCE;
    }

    const admissionParams: R213AdmissionParams = {
      tokenHash,
      sessionId,
      requestId: payload.requestId,
      expectedWorkspaceDigest: payload.expectedWorkspaceDigest,
      recipeId,
      recipeVersion,
      recipeDigest,
      provenance,
    };

    // 1. Admission reservation in PostgreSQL
    const admission: R213ExecutionAdmissionResult = hiringActive
      ? await hiringAdmitExecution(pool, admissionParams)
      : await admitCandidateExecution(pool, admissionParams);

    if (admission.status === 'CONFLICT') {
      return errorResponse(
        409,
        'REQUEST_CONFLICT',
        admission.reason ||
          'Request identifier was already used with different input.',
      );
    }

    if (admission.status === 'REPLAY' && admission.operation) {
      const remaining = admission.remainingExecutions as number | undefined;
      const response = buildFactualExecutionResponse(
        admission.operation,
        true,
        remaining,
      );
      return Response.json(response, { status: 200, headers: responseHeaders });
    }

    if (admission.status === 'DENIED') {
      const reason = admission.reason;
      if (reason === 'SCENARIO_INCOMPATIBLE') {
        return errorResponse(
          400,
          'SCENARIO_INCOMPATIBLE',
          admission.message ||
            'Restricted executor is only compatible with reservation-moves scenario v3.',
        );
      }
      if (reason === 'TERMINAL_DISABLED') {
        return errorResponse(
          403,
          'TERMINAL_DISABLED',
          'Terminal execution is disabled for this assessment.',
        );
      }
      if (reason === 'BUDGET_EXHAUSTED') {
        return errorResponse(
          429,
          'BUDGET_EXHAUSTED',
          'Candidate execution budget has been exhausted for this assessment.',
        );
      }
      if (reason === 'SESSION_CLOSED') {
        return errorResponse(
          409,
          'SESSION_CLOSED',
          'Assessment is not active or has already been submitted.',
        );
      }
      if (reason === 'DEADLINE_EXCEEDED') {
        return errorResponse(
          409,
          'DEADLINE_EXCEEDED',
          'Assessment deadline has expired.',
        );
      }
      if (reason === 'STALE_WORKSPACE') {
        return errorResponse(
          409,
          'STALE_WORKSPACE',
          'Persisted workspace snapshot changed; reload before retrying execution.',
        );
      }
      if (reason === 'INVALID_RECIPE') {
        return errorResponse(
          400,
          'INVALID_RECIPE',
          admission.message || 'Approved recipe is invalid.',
        );
      }
      if (reason === 'FORBIDDEN') {
        return errorResponse(403, 'FORBIDDEN', 'Execution is not permitted.');
      }
      return errorResponse(
        400,
        'ADMISSION_DENIED',
        `Candidate execution admission was denied: ${reason || 'unspecified'}.`,
      );
    }

    if (admission.status !== 'ADMITTED' || !admission.intent) {
      return errorResponse(
        500,
        'ADMISSION_FAILED',
        'Failed to admit execution request.',
      );
    }

    const intent = admission.intent as unknown as R214ExecutionIntent;

    // 2. Fetch the authenticated workspace and verify it is still the admitted version.
    const candidateAdapter = createR26CandidateAdapter({
      connectionString: config.databaseUrl,
      requireLifecycleMarker: config.profile === 'durable-staging',
    });
    const workspaceFiles: Record<string, string> = {};
    try {
      const candidateView = await candidateAdapter.command({
        tokenHash,
        sessionId,
        action: 'read',
      });
      if (
        candidateView?.workspaceDigest !==
        intent.canonicalWorkspaceSnapshotDigest
      ) {
        const failParams = {
          tokenHash,
          sessionId,
          operationId: intent.operationId,
          fence: intent.fence,
          generation: intent.generation,
          status: 'FAILED' as const,
          failureReason: 'STALE_WORKSPACE',
          errorMessage: 'Workspace changed before execution; reload and retry.',
          provenance,
        };
        if (hiringActive) {
          await hiringFailExecution(pool, failParams);
        } else {
          await failCandidateExecution(pool, failParams);
        }
        return errorResponse(
          409,
          'STALE_WORKSPACE',
          'Persisted workspace snapshot changed; reload before retrying execution.',
        );
      }
      if (Array.isArray(candidateView?.files)) {
        for (const file of candidateView.files) {
          if (file && typeof file.path === 'string') {
            workspaceFiles[file.path] = file.content ?? '';
          }
        }
      }
    } finally {
      await candidateAdapter.close();
    }

    // 3. Run execution through real workspace test runner in UAT Hiring mode or selected adapter
    const adapter = adapterOverride ?? getExecutionAdapter(backend);
    let outcome;
    try {
      outcome =
        hiringActive &&
        !adapterOverride &&
        backend !== 'restricted-executor' &&
        isFounderUatEnabled()
          ? await runHiringWorkspaceChecks(intent, workspaceFiles)
          : await adapter.execute(intent, workspaceFiles);
    } catch {
      const unknownFailParams = {
        tokenHash,
        sessionId,
        operationId: intent.operationId,
        fence: intent.fence,
        generation: intent.generation,
        status: 'UNKNOWN' as const,
        failureReason: 'EXECUTION_UNKNOWN',
        errorMessage: 'Execution outcome could not be verified.',
        cleanupStatus: 'UNKNOWN' as const,
        isUnknown: true,
        provenance,
      };
      const operation = hiringActive
        ? await hiringFailExecution(pool, unknownFailParams)
        : await failCandidateExecution(pool, unknownFailParams);
      return Response.json(
        buildFactualExecutionResponse(
          operation,
          false,
          admission.remainingExecutions,
        ),
        { status: 200, headers: responseHeaders },
      );
    }

    // 4. Record outcome in PostgreSQL
    let recordedOperation: R213RecordedOperation;
    if (outcome.status === 'COMPLETED') {
      const completeParams = {
        tokenHash,
        sessionId,
        operationId: outcome.operationId,
        fence: outcome.fence,
        generation: outcome.generation,
        exitCode: outcome.exitCode ?? 0,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        stdoutDigest: outcome.outputHashes.stdoutDigest,
        stderrDigest: outcome.outputHashes.stderrDigest,
        truncatedStdout: outcome.truncated.stdout,
        truncatedStderr: outcome.truncated.stderr,
        durationMs: outcome.resourceUsage.durationMs,
        cleanupStatus: outcome.cleanupStatus,
        provenance: outcome.provenance,
      };
      recordedOperation = hiringActive
        ? await hiringCompleteExecution(pool, completeParams)
        : await completeCandidateExecution(pool, completeParams);
    } else {
      const failOutcomeParams = {
        tokenHash,
        sessionId,
        operationId: outcome.operationId,
        fence: outcome.fence,
        generation: outcome.generation,
        status: outcome.status as 'FAILED' | 'TIMED_OUT' | 'UNKNOWN',
        failureReason: outcome.status,
        errorMessage:
          outcome.stderr || `Execution finished with status ${outcome.status}`,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        durationMs: outcome.resourceUsage.durationMs,
        cleanupStatus: outcome.cleanupStatus,
        isUnknown: outcome.isUnknown,
        provenance: outcome.provenance,
      };
      recordedOperation = hiringActive
        ? await hiringFailExecution(pool, failOutcomeParams)
        : await failCandidateExecution(pool, failOutcomeParams);
    }

    const remaining = admission.remainingExecutions as number | undefined;
    const response = buildFactualExecutionResponse(
      recordedOperation,
      false,
      remaining,
    );
    return Response.json(response, { status: 200, headers: responseHeaders });
  } catch (error) {
    if (error instanceof R214RequestError) {
      return errorResponse(error.status, error.code, error.message);
    }
    const message = (error as Error)?.message || '';
    if (
      message.includes('authentication failed') ||
      message.includes('42501')
    ) {
      return errorResponse(
        401,
        'CANDIDATE_ACCESS_DENIED',
        'This candidate link is not available for this assessment.',
      );
    }
    if (
      message.includes('reused with different intent') ||
      message.includes('23514')
    ) {
      return errorResponse(
        409,
        'REQUEST_CONFLICT',
        'Request identifier was already used with different input.',
      );
    }
    if (message.includes('unavailable') || message.includes('R2604')) {
      return errorResponse(
        404,
        'ASSESSMENT_NOT_FOUND',
        'This assessment is not available.',
      );
    }
    return errorResponse(
      503,
      'EXECUTION_UNAVAILABLE',
      'Candidate execution is temporarily unavailable.',
    );
  }
}
