import { createHash, createHmac } from 'node:crypto';

export const R214_PROTOCOL_VERSION = 'r214-execution-v1' as const;
export const RESTRICTED_DISPATCH_VERSION = 'executor-dispatch-v1' as const;
export const RESTRICTED_DISPATCH_ENVELOPE_VERSION = 1 as const;
export const RESTRICTED_ADMISSION_ENVELOPE_VERSION = 1 as const;

export const SYNTHETIC_RECIPE_ID = 'recipe-python-check-v1' as const;
export const SYNTHETIC_RECIPE_VERSION = '1.0.0' as const;
export const SYNTHETIC_RECIPE_DIGEST =
  '0760fc4197b0b1654be37456fc70f7c1a9159520ca78cd5b3115e7a5affd6fd2' as const;
export const SYNTHETIC_PROVENANCE = 'synthetic-execution-adapter' as const;

export const RESTRICTED_RECIPE_ID = 'reservation-moves.pytest' as const;
export const RESTRICTED_RECIPE_VERSION = '3' as const;
export const RESTRICTED_RECIPE_DIGEST =
  'eeac2baaf62ce107c7511268e862657ae24bb171cd1dec6ca01797c16ffbaad8' as const;
export const RESTRICTED_APPROVED_SCENARIO_REF = 'reservation-moves' as const;
export const RESTRICTED_APPROVED_SCENARIO_VERSION = 'v3' as const;
export const RESTRICTED_EXECUTOR_PROVENANCE =
  'restricted-executor-service' as const;

export const R214_DEFAULT_TIMEOUT_MS = 10_000;
export const R214_MAX_STDOUT_BYTES = 64_000;
export const R214_MAX_STDERR_BYTES = 64_000;
export const R214_MAX_EXECUTIONS = 10;

export const MAX_SNAPSHOT_FILES = 128;
export const MAX_FILE_PATH_BYTES = 256;
export const MAX_FILE_CONTENT_BYTES = 512 * 1024;
export const MAX_TOTAL_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export type ExecutionBackend =
  'deterministic-synthetic' | 'restricted-executor';

export type R214ExecutionStatus =
  'ADMITTED' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'UNKNOWN';

export type R214CleanupStatus = 'CLEAN' | 'RESOURCE_LEAK' | 'UNKNOWN';

export class ScenarioIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioIncompatibleError';
  }
}

export class InvalidSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSnapshotError';
  }
}

export function isScenarioCompatibleWithBackend(
  scenarioRef: string,
  scenarioVersion: string,
  backend: ExecutionBackend,
): boolean {
  if (backend === 'restricted-executor') {
    return (
      scenarioRef === RESTRICTED_APPROVED_SCENARIO_REF &&
      scenarioVersion === RESTRICTED_APPROVED_SCENARIO_VERSION
    );
  }
  return true;
}

export function assertScenarioCompatible(
  scenarioRef: string,
  scenarioVersion: string,
  backend: ExecutionBackend,
): void {
  if (!isScenarioCompatibleWithBackend(scenarioRef, scenarioVersion, backend)) {
    throw new ScenarioIncompatibleError(
      `Restricted executor backend requires scenario '${RESTRICTED_APPROVED_SCENARIO_REF}' version '${RESTRICTED_APPROVED_SCENARIO_VERSION}', but received scenario '${scenarioRef}' version '${scenarioVersion}'.`,
    );
  }
}

export type R214ExecutionRecipe = Readonly<{
  id: string;
  version: string;
  description: string;
  command: readonly string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}>;

export const DEFAULT_PYTHON_CHECK_RECIPE: R214ExecutionRecipe = Object.freeze({
  id: SYNTHETIC_RECIPE_ID,
  version: SYNTHETIC_RECIPE_VERSION,
  description:
    'Approved synthetic pytest test runner recipe for Python assessment tasks',
  command: ['pytest', '-v'],
  timeoutMs: R214_DEFAULT_TIMEOUT_MS,
  maxStdoutBytes: R214_MAX_STDOUT_BYTES,
  maxStderrBytes: R214_MAX_STDERR_BYTES,
});

export const RESTRICTED_EXECUTOR_RECIPE = Object.freeze({
  recipeId: RESTRICTED_RECIPE_ID,
  recipeVersion: RESTRICTED_RECIPE_VERSION,
  scenarioRef: RESTRICTED_APPROVED_SCENARIO_REF,
  scenarioVersion: RESTRICTED_APPROVED_SCENARIO_VERSION,
  image:
    'ghcr.io/mohamedsaba/hirearchy-executor@sha256:c7b3f6e5c953e95b6e3fbb57c52ef4e1185705edc7a43aee5b5bfb2bc096840f',
  bootstrap: Object.freeze(['/bin/sleep', 'infinity']),
  argv: Object.freeze([
    'python3',
    '-B',
    '-m',
    'pytest',
    '-q',
    '-p',
    'no:cacheprovider',
  ]),
  environment: Object.freeze([
    'HOME=/tmp',
    'TMPDIR=/tmp',
    'PYTHONDONTWRITEBYTECODE=1',
    'PYTEST_DISABLE_PLUGIN_AUTOLOAD=1',
  ]),
  snapshotLoaderSha256:
    '97955c6db00562ac6080ad27ad4ef2cc29559b76b54fe918afdba64f21b205c1',
  user: '65534:65534',
  workingDirectory: '/workspace',
});

export function computeRecipeDigest(
  recipe:
    | R214ExecutionRecipe
    | typeof RESTRICTED_EXECUTOR_RECIPE
    | Record<string, unknown>,
): string {
  if ('id' in recipe && 'command' in recipe) {
    const payload = JSON.stringify({
      id: recipe.id,
      version: recipe.version,
      command: recipe.command,
      timeoutMs: recipe.timeoutMs,
      maxStdoutBytes: recipe.maxStdoutBytes,
      maxStderrBytes: recipe.maxStderrBytes,
    });
    return createHash('sha256').update(payload, 'utf8').digest('hex');
  }
  return createHash('sha256')
    .update(JSON.stringify(recipe), 'utf8')
    .digest('hex');
}

export type R214ExecutionBudgets = Readonly<{
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxExecutionCount: number;
}>;

export type R214ExecutionIntent = Readonly<{
  organizationId: string;
  sessionId: string;
  operationId: string;
  requestId: string;
  assessmentVersion: string;
  persistedWorkspaceVersion: string;
  canonicalWorkspaceSnapshotDigest: string;
  approvedRecipeId: string;
  approvedRecipeVersion: string;
  approvedRecipeDigest: string;
  admittedAt: string;
  sessionDeadline: string;
  budgets: R214ExecutionBudgets;
  generation: number;
  fence: number;
  protocolVersion: typeof R214_PROTOCOL_VERSION;
}>;

export type R214ExecutionOutcome = Readonly<{
  operationId: string;
  attemptId: string;
  generation: number;
  fence: number;
  snapshotDigest: string;
  recipeId: string;
  recipeDigest: string;
  status: R214ExecutionStatus;
  startedAt: string;
  completedAt: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputHashes: Readonly<{
    stdoutDigest: string;
    stderrDigest: string;
  }>;
  truncated: Readonly<{
    stdout: boolean;
    stderr: boolean;
  }>;
  resourceUsage: Readonly<{
    durationMs: number;
  }>;
  cleanupStatus: R214CleanupStatus;
  isUnknown: boolean;
  provenance:
    typeof SYNTHETIC_PROVENANCE | typeof RESTRICTED_EXECUTOR_PROVENANCE;
  isSynthetic: boolean;
}>;

export type R214RecordedOperation = Readonly<{
  organizationId: string;
  sessionId: string;
  operationId: string;
  requestId: string;
  sequenceStart: number;
  sequenceCompleted: number | null;
  workspaceDigest: string;
  workspaceVersion: string;
  recipeId: string;
  recipeVersion: string;
  recipeDigest: string;
  generation: number;
  fence: number;
  status: R214ExecutionStatus;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  stdoutDigest: string | null;
  stderrDigest: string | null;
  truncatedStdout: boolean;
  truncatedStderr: boolean;
  durationMs: number | null;
  failureReason: string | null;
  errorMessage: string | null;
  cleanupStatus: R214CleanupStatus;
  isUnknown: boolean;
  provenance: string;
  isSynthetic: boolean;
  createdAt: string;
  completedAt: string | null;
}>;

export type R214CandidateExecutionView = Readonly<{
  terminalEnabled: boolean;
  remainingExecutions: number;
  maxExecutions: number;
  currentWorkspaceDigest: string;
  operations: readonly R214RecordedOperation[];
}>;

export type R214ExecutionAdmissionResult =
  | Readonly<{
      status: 'ADMITTED';
      intent: R214ExecutionIntent;
      operation: R214RecordedOperation;
      remainingExecutions?: number;
    }>
  | Readonly<{
      status: 'REPLAY';
      intent: R214ExecutionIntent;
      operation: R214RecordedOperation;
      remainingExecutions?: number;
    }>
  | Readonly<{
      status: 'CONFLICT';
      reason: string;
    }>
  | Readonly<{
      status: 'DENIED';
      reason:
        | 'TERMINAL_DISABLED'
        | 'BUDGET_EXHAUSTED'
        | 'SESSION_CLOSED'
        | 'DEADLINE_EXCEEDED'
        | 'INVALID_RECIPE'
        | 'SCENARIO_INCOMPATIBLE'
        | 'STALE_WORKSPACE'
        | 'FORBIDDEN';
      message: string;
    }>;

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export type SnapshotFileRecord = Readonly<{
  path: string;
  content: string;
}>;

export function validateSnapshotFiles(
  files: ReadonlyArray<SnapshotFileRecord> | Record<string, string>,
): Array<{ path: string; content: string; bytes: Buffer }> {
  let entries: SnapshotFileRecord[];
  if (Array.isArray(files)) {
    entries = [...files];
  } else if (files && typeof files === 'object') {
    entries = Object.entries(files).map(([path, content]) => ({
      path,
      content,
    }));
  } else {
    throw new InvalidSnapshotError('Files must be an array or record object.');
  }

  if (entries.length < 1 || entries.length > MAX_SNAPSHOT_FILES) {
    throw new InvalidSnapshotError(
      `Snapshot file count must be between 1 and ${MAX_SNAPSHOT_FILES}, received ${entries.length}.`,
    );
  }

  const paths = new Set<string>();
  const normalized: Array<{ path: string; content: string; bytes: Buffer }> =
    [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      typeof entry.content !== 'string'
    ) {
      throw new InvalidSnapshotError('Each file must have a path and content.');
    }
    const { path, content } = entry;
    const parts = path.split('/');

    if (
      !path ||
      Buffer.byteLength(path, 'utf8') > MAX_FILE_PATH_BYTES ||
      path.startsWith('/') ||
      (path.length >= 2 && path[0]?.match(/[A-Za-z]/) && path[1] === ':') ||
      path.includes('\\') ||
      path.includes('\0') ||
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          Buffer.byteLength(part, 'utf8') > 255,
      )
    ) {
      throw new InvalidSnapshotError(`Snapshot path '${path}' is invalid.`);
    }

    if (paths.has(path)) {
      throw new InvalidSnapshotError(
        `Snapshot paths must be unique: '${path}' repeated.`,
      );
    }

    if (hasLoneSurrogate(content)) {
      throw new InvalidSnapshotError(
        `Snapshot content for '${path}' must be valid UTF-8 without lone surrogates.`,
      );
    }

    const bytes = Buffer.from(content, 'utf8');
    if (bytes.byteLength > MAX_FILE_CONTENT_BYTES) {
      throw new InvalidSnapshotError(
        `Snapshot file '${path}' exceeds limit of ${MAX_FILE_CONTENT_BYTES} bytes.`,
      );
    }

    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_SNAPSHOT_BYTES) {
      throw new InvalidSnapshotError(
        `Snapshot total size exceeds limit of ${MAX_TOTAL_SNAPSHOT_BYTES} bytes.`,
      );
    }

    paths.add(path);
    normalized.push({ path, content, bytes });
  }

  for (const { path } of normalized) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      if (paths.has(parts.slice(0, index).join('/'))) {
        throw new InvalidSnapshotError(
          `Snapshot path '${path}' conflicts with directory path.`,
        );
      }
    }
  }

  return normalized;
}

export function computeCanonicalSnapshotDigest(
  files: ReadonlyArray<SnapshotFileRecord> | Record<string, string>,
): string {
  const normalized = validateSnapshotFiles(files);
  const pairs = normalized
    .map(({ path, bytes }) => [path, sha256(bytes)])
    .sort(([left], [right]) => {
      const l = left as string;
      const r = right as string;
      return l < r ? -1 : l > r ? 1 : 0;
    });
  return sha256(Buffer.from(JSON.stringify(pairs), 'utf8'));
}

export type AdmissionEnvelope = Readonly<{
  version: 1;
  callerId: string;
  keyId: string;
  sessionRef: string;
  operationId: string;
  requestId: string;
  generation: number;
  fence: number;
  scenarioRef: string;
  scenarioVersion: string;
  snapshotDigest: string;
  recipeId: string;
  recipeVersion: string;
  recipeDigest: string;
  timeoutMs: number;
  resources: Readonly<{
    memoryBytes: number;
    cpus: number;
    pids: number;
  }>;
  outputBytes: number;
  issuedAtMs: number;
  expiresAtMs: number;
  tag: string;
}>;

export type SignAdmissionEnvelopeParams = Readonly<{
  callerId: string;
  keyId: string;
  secret: string | Buffer;
  sessionRef: string;
  operationId: string;
  requestId: string;
  generation: number;
  fence: number;
  scenarioRef: string;
  scenarioVersion: string;
  snapshotDigest: string;
  recipeId: string;
  recipeVersion: string;
  recipeDigest: string;
  timeoutMs: number;
  resources: Readonly<{
    memoryBytes: number;
    cpus: number;
    pids: number;
  }>;
  outputBytes: number;
  issuedAtMs?: number;
  ttlMs?: number;
}>;

export function signAdmissionEnvelope(
  paramsOrFields:
    | SignAdmissionEnvelopeParams
    | (Omit<SignAdmissionEnvelopeParams, 'secret'> & {
        secret?: string | Buffer;
      }),
  optionalSecret?: string | Buffer,
): AdmissionEnvelope {
  const secret =
    optionalSecret ?? (paramsOrFields as { secret?: string | Buffer }).secret;
  if (!secret) {
    throw new TypeError('Secret is required for signAdmissionEnvelope');
  }
  const issuedAtMs = paramsOrFields.issuedAtMs ?? Date.now();
  const ttlMs = Math.min(paramsOrFields.ttlMs ?? 120_000, 300_000);
  const expiresAtMs =
    (paramsOrFields as { expiresAtMs?: number }).expiresAtMs ??
    issuedAtMs + ttlMs;

  const canonicalPayload = {
    version: 1 as const,
    callerId: paramsOrFields.callerId,
    keyId: paramsOrFields.keyId,
    sessionRef: paramsOrFields.sessionRef,
    operationId: paramsOrFields.operationId,
    requestId: paramsOrFields.requestId,
    generation: paramsOrFields.generation,
    fence: paramsOrFields.fence,
    scenarioRef: paramsOrFields.scenarioRef,
    scenarioVersion: paramsOrFields.scenarioVersion,
    snapshotDigest: paramsOrFields.snapshotDigest,
    recipeId: paramsOrFields.recipeId,
    recipeVersion: paramsOrFields.recipeVersion,
    recipeDigest: paramsOrFields.recipeDigest,
    timeoutMs: paramsOrFields.timeoutMs,
    resources: {
      memoryBytes: paramsOrFields.resources.memoryBytes,
      cpus: paramsOrFields.resources.cpus,
      pids: paramsOrFields.resources.pids,
    },
    outputBytes: paramsOrFields.outputBytes,
    issuedAtMs,
    expiresAtMs,
  };

  const tag = createHmac('sha256', secret)
    .update(JSON.stringify(canonicalPayload), 'utf8')
    .digest('hex');

  return Object.freeze({
    ...canonicalPayload,
    tag,
  });
}

export type DispatchEnvelope = Readonly<{
  version: 1;
  callerId: string;
  keyId: string;
  sessionRef: string;
  requestId: string;
  issuedAtMs: number;
  expiresAtMs: number;
  payloadDigest: string;
  tag: string;
}>;

export type SignDispatchEnvelopeParams = Readonly<{
  action: 'run' | 'lookup' | 'reconcile';
  callerId: string;
  keyId: string;
  secret: string | Buffer;
  sessionRef: string;
  requestId: string;
  requestPayload: unknown;
  issuedAtMs?: number;
  ttlMs?: number;
  expiresAtMs?: number;
}>;

export function signDispatchEnvelope(
  actionOrParams: 'run' | 'lookup' | 'reconcile' | SignDispatchEnvelopeParams,
  payloadOrOptions?: unknown,
  options?: {
    callerId: string;
    keyId: string;
    sessionRef: string;
    requestId: string;
    secret: string | Buffer;
    issuedAtMs?: number;
    ttlMs?: number;
    expiresAtMs?: number;
  },
): DispatchEnvelope {
  let action: 'run' | 'lookup' | 'reconcile';
  let callerId: string;
  let keyId: string;
  let sessionRef: string;
  let requestId: string;
  let secret: string | Buffer;
  let requestPayload: unknown;
  let issuedAtMs: number;
  let expiresAtMs: number;

  if (typeof actionOrParams === 'object' && actionOrParams !== null) {
    const params = actionOrParams as SignDispatchEnvelopeParams;
    action = params.action;
    callerId = params.callerId;
    keyId = params.keyId;
    sessionRef = params.sessionRef;
    requestId = params.requestId;
    secret = params.secret;
    requestPayload = params.requestPayload;
    issuedAtMs = params.issuedAtMs ?? Date.now();
    const ttlMs = Math.min(params.ttlMs ?? 120_000, 300_000);
    expiresAtMs = params.expiresAtMs ?? issuedAtMs + ttlMs;
  } else {
    action = actionOrParams;
    requestPayload = payloadOrOptions;
    const opts = options!;
    callerId = opts.callerId;
    keyId = opts.keyId;
    sessionRef = opts.sessionRef;
    requestId = opts.requestId;
    secret = opts.secret;
    issuedAtMs = opts.issuedAtMs ?? Date.now();
    const ttlMs = Math.min(opts.ttlMs ?? 120_000, 300_000);
    expiresAtMs = opts.expiresAtMs ?? issuedAtMs + ttlMs;
  }

  const payloadDigest =
    requestPayload === null
      ? sha256('null')
      : sha256(JSON.stringify(requestPayload));

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

  return Object.freeze({
    version: 1 as const,
    callerId,
    keyId,
    sessionRef,
    requestId,
    issuedAtMs,
    expiresAtMs,
    payloadDigest,
    tag,
  });
}

export const R214_SYNTHETIC_RECIPE_ID = SYNTHETIC_RECIPE_ID;
export const R214_SYNTHETIC_RECIPE_VERSION = SYNTHETIC_RECIPE_VERSION;
export const R214_SYNTHETIC_RECIPE_DIGEST = SYNTHETIC_RECIPE_DIGEST;
export const R214_SYNTHETIC_PROVENANCE = SYNTHETIC_PROVENANCE;

export const R214_RESTRICTED_RECIPE_ID = RESTRICTED_RECIPE_ID;
export const R214_RESTRICTED_RECIPE_VERSION = RESTRICTED_RECIPE_VERSION;
export const R214_RESTRICTED_RECIPE_DIGEST = RESTRICTED_RECIPE_DIGEST;
export const R214_RESTRICTED_SCENARIO_REF = RESTRICTED_APPROVED_SCENARIO_REF;
export const R214_RESTRICTED_SCENARIO_VERSION =
  RESTRICTED_APPROVED_SCENARIO_VERSION;
export const R214_RESTRICTED_PROVENANCE = RESTRICTED_EXECUTOR_PROVENANCE;

export type AdmissionKey = Readonly<{
  callerId: string;
  keyId: string;
  secret: string;
}>;

export type DispatchKey = Readonly<{
  callerId: string;
  keyId: string;
  secret: string;
}>;
