import { EvaluatorAccessError } from '../access/evaluator-evidence';
import { AiInteractionError } from '../ai/ai-interaction';
import { EvidenceReconstructionError } from '../reconstruction/evidence-reconstruction';
import { SandboxError } from '../sandbox/sandbox';
import { GeneratedRubricUnavailableError } from '../assessments/task-rubric';
import { SessionError } from '../sessions/session';
import { CandidateTokenStorageError } from '../sessions/candidate-token-storage.mjs';
import { ApplicationStartupNotReadyError } from '../startup-status';

const sessionStatus: Record<SessionError['code'], number> = {
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_ACTIVE: 409,
  SESSION_FINALIZATION_STARTED: 409,
  SESSION_DEADLINE_EXCEEDED: 409,
  TERMINAL_NOT_ENABLED: 409,
  EVIDENCE_NOT_READY: 409,
  CONTENT_TOO_LARGE: 413,
  COMMAND_TOO_LARGE: 413,
  PLATFORM_CAPTURE_FAILED: 500,
  INVALID_SCENARIO_DURATION: 400,
  SCENARIO_UNAVAILABLE: 503,
};

const aiInteractionStatus: Record<AiInteractionError['code'], number> = {
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_ACTIVE: 409,
  SESSION_FINALIZATION_STARTED: 409,
  SESSION_DEADLINE_EXCEEDED: 409,
  AI_NOT_ENABLED: 409,
  INVALID_INPUT: 400,
  INPUT_TOO_LARGE: 413,
  INVALID_STATE_TRANSITION: 409,
  INTERACTION_NOT_FOUND: 404,
  AMBIGUOUS_DISPATCH: 409,
  PROVIDER_NOT_CONFIGURED: 500,
  PLATFORM_PERSISTENCE_FAILED: 500,
  AI_CONCURRENT_REQUEST_LIMIT: 429,
  AI_INTERACTION_LIMIT_EXCEEDED: 429,
  AI_RATE_LIMIT_EXCEEDED: 429,
};

const safeSandboxMessages: Record<SandboxError['code'], string> = {
  SANDBOX_CREATION_FAILED: 'Sandbox container creation failed.',
  SANDBOX_READINESS_FAILED: 'Sandbox readiness check failed.',
  SANDBOX_NOT_FOUND: 'Sandbox container was not found.',
  SANDBOX_EXECUTION_FAILED: 'Sandbox execution failed.',
  SANDBOX_FREEZE_FAILED: 'Sandbox finalization failed.',
};

const hasInfrastructureDiagnostics = (message: string): boolean => {
  return /docker|hirearchy-sandbox|\/usr\/local\/bin|exited with code|Command\s+'|ENOENT|ECONNREFUSED|SIGKILL|SIGTERM|spawn\s+/i.test(
    message,
  );
};

export const errorResponse = (error: unknown) => {
  if (error instanceof ApplicationStartupNotReadyError) {
    return Response.json(
      {
        error: {
          code: 'APPLICATION_NOT_READY',
          message: 'The application is temporarily unavailable.',
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (error instanceof CandidateTokenStorageError) {
    return Response.json(
      {
        error: {
          code: 'CANDIDATE_TOKEN_STORAGE_UNAVAILABLE',
          message:
            'The request is unavailable until candidate-link storage is verified.',
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (error instanceof GeneratedRubricUnavailableError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message:
            'This generated assessment needs a complete validated rubric. Regenerate the assessment draft.',
        },
      },
      { status: 422 },
    );
  }

  if (error instanceof SessionError) {
    const message =
      error.code === 'PLATFORM_CAPTURE_FAILED' &&
      hasInfrastructureDiagnostics(error.message)
        ? 'Workspace capture failed.'
        : error.message;
    return Response.json(
      { error: { code: error.code, message } },
      { status: sessionStatus[error.code] },
    );
  }

  if (error instanceof AiInteractionError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: aiInteractionStatus[error.code] ?? 400 },
    );
  }

  if (error instanceof SandboxError) {
    console.error('Sandbox infrastructure failure [SANDBOX_INFRASTRUCTURE]');
    const message = hasInfrastructureDiagnostics(error.message)
      ? safeSandboxMessages[error.code]
      : error.message;
    return Response.json(
      { error: { code: error.code, message } },
      { status: 503 },
    );
  }

  if (error instanceof EvaluatorAccessError) {
    return Response.json(
      { error: { code: 'EVALUATOR_ACCESS_REQUIRED', message: error.message } },
      { status: 401 },
    );
  }

  if (error instanceof EvidenceReconstructionError) {
    const status =
      error.code === 'PROVIDER_NOT_CONFIGURED' ||
      error.code === 'PROVIDER_UNAVAILABLE' ||
      error.code === 'PROVIDER_TIMEOUT' ||
      error.code === 'PROVIDER_RATE_LIMITED'
        ? 503
        : 422;
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status },
    );
  }

  console.error('Unexpected request failure [INTERNAL_ERROR]');
  return Response.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
      },
    },
    { status: 500 },
  );
};
