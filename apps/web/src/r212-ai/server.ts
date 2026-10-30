import { createHash } from 'node:crypto';
import { Pool } from 'pg';

import {
  admitCandidateAiInteraction,
  completeCandidateAiInteraction,
  failCandidateAiInteraction,
  getCandidateAiView,
  type R212AdmissionResult,
  type R212RecordedInteraction,
} from '../../../../database/postgres/r212/adapter.mjs';
import { readR26Config, r26IsEnabled } from '../r26-candidate/config';
import {
  R212_MAX_PROMPT_CHARS,
  R212_SYNTHETIC_MODEL_ID,
  R212_SYNTHETIC_PROVIDER_ID,
  defaultSyntheticAiSnapshot,
} from './contract';
import { defaultSyntheticProvider } from './synthetic-provider';

const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9_-]{1,128}$/;
const TOKEN_PATTERN = /^(?:[A-Za-z0-9_-]{32}|[A-Za-z0-9_-]{43})$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BODY_BYTES = 64_000;

export class R212RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'R212RequestError';
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
    throw new R212RequestError(
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
    throw new R212RequestError(
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
    throw new R212RequestError(
      401,
      'CANDIDATE_ACCESS_DENIED',
      'A valid candidate link is required.',
    );
  }
  return token;
}

function requireEnabledConfig() {
  if (!r26IsEnabled()) {
    throw new R212RequestError(
      404,
      'ASSESSMENT_NOT_FOUND',
      'This assessment is not available.',
    );
  }
  const config = readR26Config();
  if (!config) {
    throw new R212RequestError(
      404,
      'ASSESSMENT_NOT_FOUND',
      'This assessment is not available.',
    );
  }
  return config;
}

function requireSameOrigin(request: Request, expectedOrigin: string): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== expectedOrigin) {
    throw new R212RequestError(
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
    contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
  ) {
    throw new R212RequestError(
      400,
      'INVALID_REQUEST',
      'The request must contain JSON.',
    );
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new R212RequestError(
        400,
        'INVALID_REQUEST',
        'The request could not be accepted.',
      );
    }
    if (Number(contentLength) > MAX_BODY_BYTES) {
      throw new R212RequestError(
        413,
        'REQUEST_TOO_LARGE',
        'This request is larger than the supported limit.',
      );
    }
  }

  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new R212RequestError(
      413,
      'REQUEST_TOO_LARGE',
      'This request is larger than the supported limit.',
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new R212RequestError(
      400,
      'INVALID_REQUEST',
      'The request could not be accepted.',
    );
  }
}

export type CandidateAiPromptPayload = Readonly<{
  requestId: string;
  candidatePrompt: string;
}>;

function parsePromptPayload(value: unknown): CandidateAiPromptPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new R212RequestError(
      400,
      'INVALID_REQUEST',
      'The request body must be an object.',
    );
  }
  const obj = value as Record<string, unknown>;
  const { requestId, candidatePrompt } = obj;

  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new R212RequestError(
      400,
      'INVALID_REQUEST',
      'A valid requestId is required.',
    );
  }

  if (
    typeof candidatePrompt !== 'string' ||
    candidatePrompt.trim().length === 0
  ) {
    throw new R212RequestError(
      400,
      'INVALID_REQUEST',
      'Candidate prompt cannot be empty.',
    );
  }

  if (candidatePrompt.length > R212_MAX_PROMPT_CHARS) {
    throw new R212RequestError(
      413,
      'REQUEST_TOO_LARGE',
      `Candidate prompt exceeds maximum limit of ${R212_MAX_PROMPT_CHARS} characters.`,
    );
  }

  return {
    requestId,
    candidatePrompt,
  };
}

function buildFactualResponse(
  interaction: R212RecordedInteraction,
  isReplay = false,
) {
  return {
    interactionId: interaction.interactionId,
    requestId: interaction.requestId,
    sequenceStart: interaction.sequenceStart,
    sequenceCompleted: interaction.sequenceCompleted,
    candidatePrompt: interaction.candidatePrompt,
    assistantResponse: interaction.assistantResponse,
    status: interaction.status,
    admissionStatus: isReplay ? 'REPLAY_COMPLETED' : 'ADMITTED',
    failureReason: interaction.failureReason,
    errorMessage: interaction.errorMessage,
    providerId: interaction.providerId || R212_SYNTHETIC_PROVIDER_ID,
    modelId: interaction.modelId || R212_SYNTHETIC_MODEL_ID,
    serverTimestamp: interaction.completedAt || interaction.createdAt,
    createdAt: interaction.createdAt,
    completedAt: interaction.completedAt,
    isReplay,
    usage: {
      promptChars: interaction.candidatePrompt.length,
      responseChars: interaction.assistantResponse?.length ?? 0,
      synthetic: true as const,
    },
  };
}

export async function r212CandidateAiRead(
  request: Request,
  sessionId: string,
): Promise<Response> {
  try {
    requireSessionId(sessionId);
    const config = requireEnabledConfig();
    const token = requireBearer(request);
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const pool = getClientPool(config.databaseUrl);

    const view = await getCandidateAiView(pool, { tokenHash, sessionId });
    return Response.json(view, { status: 200, headers: responseHeaders });
  } catch (error) {
    if (error instanceof R212RequestError) {
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
      'AI_ASSISTANCE_UNAVAILABLE',
      'Candidate AI assistance is temporarily unavailable.',
    );
  }
}

export async function r212CandidateAiAction(
  request: Request,
  sessionId: string,
): Promise<Response> {
  try {
    requireSessionId(sessionId);
    const config = requireEnabledConfig();
    requireSameOrigin(request, config.publicOrigin);
    const token = requireBearer(request);
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    const payload = parsePromptPayload(await readBoundedJson(request));

    const pool = getClientPool(config.databaseUrl);

    // 1. Admission reservation in PostgreSQL
    const admission: R212AdmissionResult = await admitCandidateAiInteraction(
      pool,
      {
        tokenHash,
        sessionId,
        requestId: payload.requestId,
        prompt: payload.candidatePrompt,
      },
    );

    if (admission.status === 'CONFLICT') {
      return errorResponse(
        409,
        'REQUEST_CONFLICT',
        'Request identifier was already used with different input.',
      );
    }

    if (admission.status === 'REPLAY' && admission.interaction) {
      const response = buildFactualResponse(admission.interaction, true);
      return Response.json(response, { status: 200, headers: responseHeaders });
    }

    if (admission.status === 'DENIED') {
      const reason = admission.reason;
      if (reason === 'BUDGET_EXHAUSTED') {
        return errorResponse(
          429,
          'BUDGET_EXHAUSTED',
          'AI interaction budget has been exhausted for this assessment.',
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
      if (reason === 'NOT_ENABLED') {
        return errorResponse(
          403,
          'AI_NOT_ENABLED',
          'AI assistance is disabled for this assessment.',
        );
      }
      if (reason === 'PROMPT_TOO_LARGE') {
        return errorResponse(
          413,
          'REQUEST_TOO_LARGE',
          `Prompt exceeds maximum limit of ${R212_MAX_PROMPT_CHARS} characters.`,
        );
      }
      return errorResponse(
        400,
        'ADMISSION_DENIED',
        `AI interaction admission was denied: ${reason || 'unspecified'}.`,
      );
    }

    if (admission.status !== 'ADMITTED' || !admission.interaction) {
      return errorResponse(
        500,
        'ADMISSION_FAILED',
        'Failed to admit AI interaction.',
      );
    }

    // 2. Call synthetic provider
    const startTime = Date.now();
    try {
      const providerOutput = await defaultSyntheticProvider.generateResponse({
        organizationId: '',
        sessionId,
        requestId: payload.requestId,
        candidatePrompt: payload.candidatePrompt,
        capabilitySnapshot: defaultSyntheticAiSnapshot,
      });

      const durationMs = Date.now() - startTime;

      // 3. Complete interaction in PostgreSQL
      const completedInteraction = await completeCandidateAiInteraction(pool, {
        tokenHash,
        sessionId,
        requestId: payload.requestId,
        assistantResponse: providerOutput.response,
        durationMs,
      });

      const response = buildFactualResponse(completedInteraction, false);
      return Response.json(response, { status: 200, headers: responseHeaders });
    } catch (providerError) {
      const durationMs = Date.now() - startTime;
      const failureReason =
        (providerError as { code?: string })?.code ||
        'SYNTHETIC_PROVIDER_FAILURE';
      const errorMessage =
        (providerError as Error)?.message || 'Synthetic AI provider failed';

      // Record failure in PostgreSQL
      const failedInteraction = await failCandidateAiInteraction(pool, {
        tokenHash,
        sessionId,
        requestId: payload.requestId,
        failureReason,
        errorMessage,
        durationMs,
      });

      return Response.json(
        {
          error: {
            code: failureReason,
            message: errorMessage,
          },
          interaction: buildFactualResponse(failedInteraction, false),
        },
        { status: 502, headers: responseHeaders },
      );
    }
  } catch (error) {
    if (error instanceof R212RequestError) {
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
      'AI_ASSISTANCE_UNAVAILABLE',
      'Candidate AI assistance is temporarily unavailable.',
    );
  }
}
