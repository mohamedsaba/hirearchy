import { createHash } from 'node:crypto';

import {
  R26CandidateError,
  createR26CandidateAdapter,
  type R26CandidateCommand,
  type R26CandidateSaveInput,
  type R26CandidateSubmitInput,
  type R26CandidateView,
} from '../../../../database/postgres/r26/adapter.mjs';
import { readR26Config, r26IsEnabled } from './config';

const MAX_BODY_BYTES = 650_000;
const MAX_FILE_BYTES = 100_000;
const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9_-]{1,128}$/;
const TOKEN_PATTERN = /^(?:[A-Za-z0-9_-]{32}|[A-Za-z0-9_-]{43})$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const VERSION_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

type R26ErrorBody = Readonly<{
  error: Readonly<{ code: string; message: string }>;
}>;

class R26RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'R26RequestError';
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
  const body: R26ErrorBody = { error: { code, message } };
  return Response.json(body, { status, headers: responseHeaders });
}

function responseForError(error: unknown): Response {
  if (error instanceof R26RequestError) {
    return errorResponse(error.status, error.code, error.message);
  }
  if (error instanceof R26CandidateError) {
    if (error.status === 401 || error.status === 403) {
      return errorResponse(
        error.status,
        'CANDIDATE_ACCESS_DENIED',
        'This candidate link is not available for this assessment.',
      );
    }
    if (error.status === 404) {
      return errorResponse(
        404,
        'ASSESSMENT_NOT_FOUND',
        'This assessment is not available.',
      );
    }
    if (error.status === 409) {
      return errorResponse(
        409,
        'ASSESSMENT_CONFLICT',
        'The saved assessment state changed. Review the latest saved version and try again.',
      );
    }
    if (error.status === 400 || error.status === 413) {
      return errorResponse(
        error.status,
        error.status === 413 ? 'REQUEST_TOO_LARGE' : 'INVALID_REQUEST',
        error.status === 413
          ? 'This request is larger than the supported limit.'
          : 'The request could not be accepted.',
      );
    }
  }
  return errorResponse(
    503,
    'CANDIDATE_WORKSPACE_UNAVAILABLE',
    'The isolated candidate workspace is temporarily unavailable.',
  );
}

function requireSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new R26RequestError(
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
    throw new R26RequestError(
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
    throw new R26RequestError(
      401,
      'CANDIDATE_ACCESS_DENIED',
      'A valid candidate link is required.',
    );
  }
  return token;
}

function requireEnabledConfig() {
  if (!r26IsEnabled()) {
    throw new R26RequestError(
      404,
      'ASSESSMENT_NOT_FOUND',
      'This assessment is not available.',
    );
  }
  const config = readR26Config();
  if (!config) {
    throw new R26RequestError(
      404,
      'ASSESSMENT_NOT_FOUND',
      'This assessment is not available.',
    );
  }
  return config;
}

function requireSameOrigin(request: Request, expectedOrigin: string): void {
  if (request.headers.get('origin') !== expectedOrigin) {
    throw new R26RequestError(
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
    throw new R26RequestError(
      400,
      'INVALID_REQUEST',
      'The request must contain JSON.',
    );
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new R26RequestError(
        400,
        'INVALID_REQUEST',
        'The request could not be accepted.',
      );
    }
    if (Number(contentLength) > MAX_BODY_BYTES) {
      throw new R26RequestError(
        413,
        'REQUEST_TOO_LARGE',
        'This request is larger than the supported limit.',
      );
    }
  }
  if (!request.body) {
    throw new R26RequestError(
      400,
      'INVALID_REQUEST',
      'The request could not be accepted.',
    );
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new R26RequestError(
          413,
          'REQUEST_TOO_LARGE',
          'This request is larger than the supported limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    );
  } catch {
    throw new R26RequestError(
      400,
      'INVALID_REQUEST',
      'The request could not be accepted.',
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new R26RequestError(
      400,
      'INVALID_REQUEST',
      'The request could not be accepted.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

type ParsedActionBody =
  | Readonly<{
      action: 'activate';
      input: Readonly<Record<string, never>>;
    }>
  | Readonly<{ action: 'save'; input: R26CandidateSaveInput }>
  | Readonly<{ action: 'submit'; input: R26CandidateSubmitInput }>;

function parseActionBody(value: unknown): ParsedActionBody {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['action', 'input']) ||
    !isRecord(value.input)
  ) {
    throw new R26RequestError(
      400,
      'INVALID_REQUEST',
      'The request could not be accepted.',
    );
  }

  if (value.action === 'activate') {
    if (Object.keys(value.input).length !== 0) {
      throw new R26RequestError(
        400,
        'INVALID_REQUEST',
        'The request could not be accepted.',
      );
    }
    return { action: 'activate', input: {} };
  }

  if (value.action === 'save') {
    const input = value.input;
    if (
      !hasOnlyKeys(input, [
        'requestId',
        'path',
        'content',
        'expectedVersion',
      ]) ||
      typeof input.requestId !== 'string' ||
      !REQUEST_ID_PATTERN.test(input.requestId) ||
      typeof input.path !== 'string' ||
      input.path.length === 0 ||
      input.path.length > 512 ||
      input.path.startsWith('/') ||
      input.path.includes('\\') ||
      input.path.includes('\0') ||
      input.path
        .split('/')
        .some(
          (segment) => segment === '' || segment === '.' || segment === '..',
        ) ||
      typeof input.content !== 'string' ||
      Buffer.byteLength(input.content, 'utf8') > MAX_FILE_BYTES ||
      input.content.includes('\0') ||
      typeof input.expectedVersion !== 'string' ||
      !VERSION_PATTERN.test(input.expectedVersion)
    ) {
      throw new R26RequestError(
        Buffer.byteLength(String(input.content ?? ''), 'utf8') > MAX_FILE_BYTES
          ? 413
          : 400,
        Buffer.byteLength(String(input.content ?? ''), 'utf8') > MAX_FILE_BYTES
          ? 'REQUEST_TOO_LARGE'
          : 'INVALID_REQUEST',
        Buffer.byteLength(String(input.content ?? ''), 'utf8') > MAX_FILE_BYTES
          ? 'This request is larger than the supported limit.'
          : 'The request could not be accepted.',
      );
    }
    return {
      action: 'save',
      input: {
        requestId: input.requestId,
        path: input.path,
        content: input.content,
        expectedVersion: input.expectedVersion,
      },
    };
  }

  if (value.action === 'submit') {
    const input = value.input;
    if (
      !hasOnlyKeys(input, ['requestId', 'expectedWorkspaceDigest']) ||
      typeof input.requestId !== 'string' ||
      !REQUEST_ID_PATTERN.test(input.requestId) ||
      typeof input.expectedWorkspaceDigest !== 'string' ||
      !DIGEST_PATTERN.test(input.expectedWorkspaceDigest)
    ) {
      throw new R26RequestError(
        400,
        'INVALID_REQUEST',
        'The request could not be accepted.',
      );
    }
    return {
      action: 'submit',
      input: {
        requestId: input.requestId,
        expectedWorkspaceDigest: input.expectedWorkspaceDigest,
      },
    };
  }

  throw new R26RequestError(
    400,
    'INVALID_REQUEST',
    'The request could not be accepted.',
  );
}

async function runCommand(
  databaseUrl: string,
  command: R26CandidateCommand,
): Promise<R26CandidateView> {
  const adapter = createR26CandidateAdapter({ connectionString: databaseUrl });
  try {
    return await adapter.command(command);
  } finally {
    await adapter.close();
  }
}

export async function r26CandidateRead(
  request: Request,
  sessionId: string,
): Promise<Response> {
  try {
    requireSessionId(sessionId);
    const config = requireEnabledConfig();
    const token = requireBearer(request);
    const view = await runCommand(config.databaseUrl, {
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      sessionId,
      action: 'read',
    });
    return Response.json(view, { status: 200, headers: responseHeaders });
  } catch (error) {
    return responseForError(error);
  }
}

export async function r26CandidateAction(
  request: Request,
  sessionId: string,
): Promise<Response> {
  try {
    requireSessionId(sessionId);
    const config = requireEnabledConfig();
    requireSameOrigin(request, config.publicOrigin);
    const token = requireBearer(request);
    const body = parseActionBody(await readBoundedJson(request));
    const view = await runCommand(config.databaseUrl, {
      tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      sessionId,
      ...body,
    });
    return Response.json(view, { status: 200, headers: responseHeaders });
  } catch (error) {
    return responseForError(error);
  }
}
