import { createHash, randomBytes } from 'node:crypto';
import {
  RESTRICTED_APPROVED_SCENARIO_REF,
  RESTRICTED_APPROVED_SCENARIO_VERSION,
  RESTRICTED_EXECUTOR_PROVENANCE,
  RESTRICTED_RECIPE_DIGEST,
  RESTRICTED_RECIPE_ID,
  RESTRICTED_RECIPE_VERSION,
  SYNTHETIC_PROVENANCE,
  assertScenarioCompatible,
  computeCanonicalSnapshotDigest,
  signAdmissionEnvelope,
  signDispatchEnvelope,
  type ExecutionBackend,
  type R214CleanupStatus,
  type R214ExecutionIntent,
  type R214ExecutionOutcome,
  type R214ExecutionStatus,
} from './contract';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export type ExecutionAdapterOptions = Readonly<{
  timeoutOverrideMs?: number;
  dispatcher?: { handle: (input: unknown) => Promise<unknown> };
  serviceUrl?: string;
  admissionKey?: RestrictedKeyConfig;
  dispatchKey?: RestrictedKeyConfig;
}>;

export interface ExecutionAdapter {
  readonly provenance: string;
  readonly isSynthetic: boolean;
  execute(
    intent: R214ExecutionIntent,
    workspaceFiles:
      | Readonly<Record<string, string>>
      | readonly { path: string; content: string }[],
    options?: ExecutionAdapterOptions,
  ): Promise<R214ExecutionOutcome>;
}

export class SyntheticExecutionAdapter implements ExecutionAdapter {
  readonly provenance = SYNTHETIC_PROVENANCE;
  readonly isSynthetic = true;

  async execute(
    intent: R214ExecutionIntent,
    workspaceFiles:
      | Readonly<Record<string, string>>
      | readonly { path: string; content: string }[],
  ): Promise<R214ExecutionOutcome> {
    const attemptId = `att_${randomBytes(8).toString('hex')}`;
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    const filesArray = Array.isArray(workspaceFiles)
      ? workspaceFiles
      : Object.entries(workspaceFiles).map(([path, content]) => ({
          path,
          content,
        }));

    let combinedContent = '';
    for (const file of filesArray) {
      combinedContent += '\n' + (file.content ?? '');
    }

    if (combinedContent.includes('SIMULATE_EXECUTION_TIMEOUT')) {
      const durationMs = intent.budgets.timeoutMs || 10_000;
      const stderr = `Execution timed out after ${durationMs}ms [COMMAND_TIMEOUT]`;
      const completedAt = new Date().toISOString();
      return {
        operationId: intent.operationId,
        attemptId,
        generation: intent.generation,
        fence: intent.fence,
        snapshotDigest: intent.canonicalWorkspaceSnapshotDigest,
        recipeId: intent.approvedRecipeId,
        recipeDigest: intent.approvedRecipeDigest,
        status: 'TIMED_OUT',
        startedAt,
        completedAt,
        exitCode: null,
        stdout: '',
        stderr,
        stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(stderr, 'utf8'),
        outputHashes: {
          stdoutDigest: sha256(''),
          stderrDigest: sha256(stderr),
        },
        truncated: { stdout: false, stderr: false },
        resourceUsage: { durationMs },
        cleanupStatus: 'CLEAN',
        isUnknown: false,
        provenance: this.provenance,
        isSynthetic: true,
      };
    }

    if (combinedContent.includes('SIMULATE_EXECUTION_UNKNOWN')) {
      const durationMs = 1500;
      const stderr =
        'Executor communication lost: connection reset by peer [UNKNOWN_STATE]';
      const completedAt = new Date().toISOString();
      return {
        operationId: intent.operationId,
        attemptId,
        generation: intent.generation,
        fence: intent.fence,
        snapshotDigest: intent.canonicalWorkspaceSnapshotDigest,
        recipeId: intent.approvedRecipeId,
        recipeDigest: intent.approvedRecipeDigest,
        status: 'UNKNOWN',
        startedAt,
        completedAt,
        exitCode: null,
        stdout: '',
        stderr,
        stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(stderr, 'utf8'),
        outputHashes: {
          stdoutDigest: sha256(''),
          stderrDigest: sha256(stderr),
        },
        truncated: { stdout: false, stderr: false },
        resourceUsage: { durationMs },
        cleanupStatus: 'UNKNOWN',
        isUnknown: true,
        provenance: this.provenance,
        isSynthetic: true,
      };
    }

    if (combinedContent.includes('SIMULATE_EXECUTION_FAILURE')) {
      const durationMs = 320;
      const stderr = 'Internal runner failure: container runtime error';
      const completedAt = new Date().toISOString();
      return {
        operationId: intent.operationId,
        attemptId,
        generation: intent.generation,
        fence: intent.fence,
        snapshotDigest: intent.canonicalWorkspaceSnapshotDigest,
        recipeId: intent.approvedRecipeId,
        recipeDigest: intent.approvedRecipeDigest,
        status: 'FAILED',
        startedAt,
        completedAt,
        exitCode: 1,
        stdout: '',
        stderr,
        stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(stderr, 'utf8'),
        outputHashes: {
          stdoutDigest: sha256(''),
          stderrDigest: sha256(stderr),
        },
        truncated: { stdout: false, stderr: false },
        resourceUsage: { durationMs },
        cleanupStatus: 'CLEAN',
        isUnknown: false,
        provenance: this.provenance,
        isSynthetic: true,
      };
    }

    const lowerContent = combinedContent.toLowerCase();
    const hasRetry =
      lowerContent.includes('retry') ||
      lowerContent.includes('backoff') ||
      lowerContent.includes('attempt');
    const hasBackoff =
      lowerContent.includes('sleep') || lowerContent.includes('jitter');

    let exitCode = 0;
    let stdout = '';
    let stderr = '';

    if (hasRetry && hasBackoff) {
      exitCode = 0;
      stdout = [
        '============================= test session starts ==============================',
        'platform linux -- Python 3.11.8, pytest-8.1.1, pluggy-1.4.0',
        'rootdir: /workspace',
        'collected 3 items',
        '',
        'tests/test_bookings.py::test_booking_immediate_success PASSED            [ 33%]',
        'tests/test_bookings.py::test_booking_retry_success PASSED                [ 66%]',
        'tests/test_bookings.py::test_booking_retry_exhausted PASSED              [100%]',
        '',
        '============================== 3 passed in 0.42s ===============================',
      ].join('\n');
    } else if (hasRetry) {
      exitCode = 1;
      stdout = [
        '============================= test session starts ==============================',
        'platform linux -- Python 3.11.8, pytest-8.1.1, pluggy-1.4.0',
        'rootdir: /workspace',
        'collected 3 items',
        '',
        'tests/test_bookings.py::test_booking_immediate_success PASSED            [ 33%]',
        'tests/test_bookings.py::test_booking_retry_success FAILED                [ 66%]',
        'tests/test_bookings.py::test_booking_retry_exhausted PASSED              [100%]',
        '',
        '=================================== FAILURES ===================================',
        '__________________________ test_booking_retry_success __________________________',
        'AssertionError: Expected backoff delay with sleep/jitter was not observed',
        '=========================== 1 failed, 2 passed in 0.38s ===========================',
      ].join('\n');
      stderr =
        'FAILED tests/test_bookings.py::test_booking_retry_success - AssertionError: Expected backoff delay with sleep/jitter was not observed\n';
    } else {
      exitCode = 1;
      stdout = [
        '============================= test session starts ==============================',
        'platform linux -- Python 3.11.8, pytest-8.1.1, pluggy-1.4.0',
        'rootdir: /workspace',
        'collected 3 items',
        '',
        'tests/test_bookings.py::test_booking_immediate_success PASSED            [ 33%]',
        'tests/test_bookings.py::test_booking_retry_success FAILED                [ 66%]',
        'tests/test_bookings.py::test_booking_retry_exhausted FAILED              [100%]',
        '',
        '=================================== FAILURES ===================================',
        '__________________________ test_booking_retry_success __________________________',
        'AssertionError: Expected retry loop logic not implemented in service.py',
        '=========================== 2 failed, 1 passed in 0.31s ===========================',
      ].join('\n');
      stderr =
        'FAILED tests/test_bookings.py::test_booking_retry_success - AssertionError: Expected retry loop logic not implemented in service.py\nFAILED tests/test_bookings.py::test_booking_retry_exhausted - AssertionError\n';
    }

    const durationMs = Math.max(50, Date.now() - startTime + 350);
    const completedAt = new Date().toISOString();

    const maxStdout = intent.budgets.maxStdoutBytes || 64_000;
    const maxStderr = intent.budgets.maxStderrBytes || 64_000;

    const truncatedStdout = Buffer.byteLength(stdout, 'utf8') > maxStdout;
    const truncatedStderr = Buffer.byteLength(stderr, 'utf8') > maxStderr;

    if (truncatedStdout) {
      stdout = stdout.slice(0, maxStdout);
    }
    if (truncatedStderr) {
      stderr = stderr.slice(0, maxStderr);
    }

    return {
      operationId: intent.operationId,
      attemptId,
      generation: intent.generation,
      fence: intent.fence,
      snapshotDigest: intent.canonicalWorkspaceSnapshotDigest,
      recipeId: intent.approvedRecipeId,
      recipeDigest: intent.approvedRecipeDigest,
      status: exitCode === 0 ? 'COMPLETED' : 'FAILED',
      startedAt,
      completedAt,
      exitCode,
      stdout,
      stderr,
      stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
      stderrBytes: Buffer.byteLength(stderr, 'utf8'),
      outputHashes: {
        stdoutDigest: sha256(stdout),
        stderrDigest: sha256(stderr),
      },
      truncated: {
        stdout: truncatedStdout,
        stderr: truncatedStderr,
      },
      resourceUsage: { durationMs },
      cleanupStatus: 'CLEAN',
      isUnknown: false,
      provenance: this.provenance,
      isSynthetic: true,
    };
  }
}

export type RestrictedKeyConfig = Readonly<{
  callerId: string;
  keyId: string;
  secret: string;
}>;

export type RestrictedBridgeConfig = Readonly<{
  dispatcher?: { handle: (input: unknown) => Promise<unknown> };
  serviceUrl?: string;
  admissionKey?: RestrictedKeyConfig;
  dispatchKey?: RestrictedKeyConfig;
}>;

export function configuredRestrictedKey(name: string): RestrictedKeyConfig {
  const value: unknown = JSON.parse(process.env[name] || 'null');
  if (!value || typeof value !== 'object')
    throw new TypeError('Execution key is unavailable');
  const key = value as Partial<RestrictedKeyConfig>;
  if (
    typeof key.callerId !== 'string' ||
    !key.callerId ||
    typeof key.keyId !== 'string' ||
    !key.keyId ||
    typeof key.secret !== 'string' ||
    key.secret.length < 32
  ) {
    throw new TypeError('Execution key is invalid');
  }
  return key as RestrictedKeyConfig;
}

export class RestrictedExecutorBridgeAdapter implements ExecutionAdapter {
  readonly provenance = RESTRICTED_EXECUTOR_PROVENANCE;
  readonly isSynthetic = false;

  private readonly config: RestrictedBridgeConfig;

  constructor(config: RestrictedBridgeConfig = {}) {
    this.config = config;
  }

  async execute(
    intent: R214ExecutionIntent,
    workspaceFiles:
      | Readonly<Record<string, string>>
      | readonly { path: string; content: string }[],
    options?: ExecutionAdapterOptions,
  ): Promise<R214ExecutionOutcome> {
    const scenarioRef =
      intent.assessmentVersion.split('@')[0] ||
      RESTRICTED_APPROVED_SCENARIO_REF;
    const scenarioVersion =
      intent.assessmentVersion.split('@')[1] ||
      RESTRICTED_APPROVED_SCENARIO_VERSION;

    assertScenarioCompatible(
      scenarioRef,
      scenarioVersion,
      'restricted-executor',
    );

    const filesArray = Array.isArray(workspaceFiles)
      ? (workspaceFiles as readonly { path: string; content: string }[])
      : Object.entries(workspaceFiles).map(([path, content]) => ({
          path,
          content,
        }));

    const snapshotDigest = computeCanonicalSnapshotDigest(filesArray);

    const admissionKey =
      options?.admissionKey ??
      this.config.admissionKey ??
      configuredRestrictedKey('HIREARCHY_ADMISSION_KEY');

    const dispatchKey =
      options?.dispatchKey ??
      this.config.dispatchKey ??
      configuredRestrictedKey('HIREARCHY_DISPATCH_KEY');

    const admissionEnvelope = signAdmissionEnvelope({
      callerId: admissionKey.callerId,
      keyId: admissionKey.keyId,
      secret: admissionKey.secret,
      sessionRef: intent.sessionId,
      operationId: intent.operationId,
      requestId: intent.requestId,
      generation: intent.generation,
      fence: intent.fence,
      scenarioRef: RESTRICTED_APPROVED_SCENARIO_REF,
      scenarioVersion: RESTRICTED_APPROVED_SCENARIO_VERSION,
      snapshotDigest,
      recipeId: RESTRICTED_RECIPE_ID,
      recipeVersion: RESTRICTED_RECIPE_VERSION,
      recipeDigest: RESTRICTED_RECIPE_DIGEST,
      timeoutMs: intent.budgets.timeoutMs,
      resources: {
        memoryBytes: 536870912,
        cpus: 1,
        pids: 64,
      },
      outputBytes: Math.min(
        intent.budgets.maxStdoutBytes + intent.budgets.maxStderrBytes,
        262144,
      ),
    });

    const runPayload = {
      requestId: intent.requestId,
      sessionRef: intent.sessionId,
      scenarioRef: RESTRICTED_APPROVED_SCENARIO_REF,
      scenarioVersion: RESTRICTED_APPROVED_SCENARIO_VERSION,
      files: filesArray,
      snapshotDigest,
      recipeId: RESTRICTED_RECIPE_ID,
      recipeVersion: RESTRICTED_RECIPE_VERSION,
      recipeDigest: RESTRICTED_RECIPE_DIGEST,
      timeoutMs: intent.budgets.timeoutMs,
      resources: {
        memoryBytes: 536870912,
        cpus: 1,
        pids: 64,
      },
      outputBytes: Math.min(
        intent.budgets.maxStdoutBytes + intent.budgets.maxStderrBytes,
        262144,
      ),
      authorization: admissionEnvelope,
    };

    const dispatchEnvelope = signDispatchEnvelope({
      action: 'run',
      callerId: dispatchKey.callerId,
      keyId: dispatchKey.keyId,
      secret: dispatchKey.secret,
      sessionRef: intent.sessionId,
      requestId: intent.requestId,
      requestPayload: runPayload,
    });

    const dispatchInput = {
      action: 'run' as const,
      authorization: dispatchEnvelope,
      request: runPayload,
    };

    try {
      let receipt: unknown;
      const dispatcher = options?.dispatcher ?? this.config.dispatcher;

      if (dispatcher) {
        const raw = await dispatcher.handle(dispatchInput);
        if (raw && typeof raw === 'object' && 'ok' in raw) {
          if (!raw.ok) {
            const errorCode =
              (raw as { code?: string }).code || 'DISPATCH_ERROR';
            if (
              errorCode === 'EXECUTION_UNKNOWN' ||
              errorCode === 'CLEANUP_FAILED'
            ) {
              return this.buildUnknownOutcome(
                intent,
                snapshotDigest,
                'Execution outcome could not be verified by restricted executor service.',
              );
            }
            throw new Error(
              `Restricted executor returned error ${errorCode}: ${(raw as { message?: string }).message || errorCode}`,
            );
          }
          receipt = (raw as { result?: unknown }).result;
        } else {
          receipt = raw;
        }
      } else if (
        options?.serviceUrl ||
        this.config.serviceUrl ||
        process.env.HIREARCHY_RESTRICTED_EXECUTOR_URL ||
        process.env.EXECUTOR_SERVICE_URL
      ) {
        const url =
          options?.serviceUrl ??
          this.config.serviceUrl ??
          process.env.HIREARCHY_RESTRICTED_EXECUTOR_URL ??
          process.env.EXECUTOR_SERVICE_URL!;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(dispatchInput),
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
          const errorCode = data?.code || `HTTP_${res.status}`;
          if (
            errorCode === 'EXECUTION_UNKNOWN' ||
            errorCode === 'CLEANUP_FAILED'
          ) {
            return this.buildUnknownOutcome(
              intent,
              snapshotDigest,
              'Execution outcome could not be verified by restricted executor service.',
            );
          }
          throw new Error(
            `Restricted executor returned error ${errorCode}: ${data?.message || 'unknown'}`,
          );
        }
        receipt = data.result;
      } else {
        throw new Error(
          'RestrictedExecutorBridgeAdapter is not configured with an internal dispatcher or serviceUrl.',
        );
      }

      return this.mapReceiptToOutcome(
        intent,
        snapshotDigest,
        admissionKey,
        receipt,
      );
    } catch {
      return this.buildUnknownOutcome(
        intent,
        snapshotDigest,
        'Execution outcome could not be verified by restricted executor service.',
      );
    }
  }

  private mapReceiptToOutcome(
    intent: R214ExecutionIntent,
    snapshotDigest: string,
    admissionKey: RestrictedKeyConfig,
    rawReceipt: unknown,
  ): R214ExecutionOutcome {
    const receipt = (
      rawReceipt && typeof rawReceipt === 'object' ? rawReceipt : {}
    ) as {
      receiptId?: string;
      admission?: { callerId?: string; keyId?: string; verified?: boolean };
      requestId?: string;
      operationId?: string;
      generation?: number;
      fence?: number;
      sessionRef?: string;
      scenarioRef?: string;
      scenarioVersion?: string;
      snapshotDigest?: string;
      recipeId?: string;
      recipeVersion?: string;
      recipeDigest?: string;
      status?: string;
      exitCode?: number | null;
      timedOut?: boolean;
      startedAt?: string;
      endedAt?: string;
      stdout?: {
        base64?: string;
        text?: string;
        byteCount?: number;
        truncated?: boolean;
        sha256?: string;
      };
      stderr?: {
        base64?: string;
        text?: string;
        byteCount?: number;
        truncated?: boolean;
        sha256?: string;
      };
      cleanup?: {
        verified?: boolean;
        containerRemoved?: boolean;
        lateCreatePossible?: boolean;
      };
      resourceUsage?: {
        durationMs?: number;
        memoryBytes?: number;
        userCpuTimeMs?: number;
        systemCpuTimeMs?: number;
      };
    };
    if (
      !receipt.receiptId ||
      receipt.admission?.callerId !== admissionKey.callerId ||
      receipt.admission?.keyId !== admissionKey.keyId ||
      receipt.admission?.verified !== true ||
      receipt.requestId !== intent.requestId ||
      receipt.operationId !== intent.operationId ||
      receipt.generation !== intent.generation ||
      receipt.fence !== intent.fence ||
      receipt.sessionRef !== intent.sessionId ||
      receipt.scenarioRef !== RESTRICTED_APPROVED_SCENARIO_REF ||
      receipt.scenarioVersion !== RESTRICTED_APPROVED_SCENARIO_VERSION ||
      receipt.snapshotDigest !== snapshotDigest ||
      receipt.recipeId !== RESTRICTED_RECIPE_ID ||
      receipt.recipeVersion !== RESTRICTED_RECIPE_VERSION ||
      receipt.recipeDigest !== RESTRICTED_RECIPE_DIGEST ||
      !['completed', 'failed'].includes(receipt.status ?? '') ||
      typeof receipt.timedOut !== 'boolean' ||
      !(receipt.exitCode === null || Number.isInteger(receipt.exitCode)) ||
      (receipt.status === 'completed' &&
        (receipt.exitCode !== 0 || receipt.timedOut)) ||
      !receipt.cleanup?.verified ||
      !receipt.cleanup.containerRemoved ||
      receipt.cleanup.lateCreatePossible !== false ||
      !Number.isFinite(Date.parse(receipt.startedAt ?? '')) ||
      !Number.isFinite(Date.parse(receipt.endedAt ?? '')) ||
      Date.parse(receipt.endedAt!) < Date.parse(receipt.startedAt!)
    ) {
      throw new Error('Invalid executor receipt');
    }
    for (const stream of [receipt.stdout, receipt.stderr]) {
      if (
        !stream ||
        typeof stream.base64 !== 'string' ||
        typeof stream.byteCount !== 'number' ||
        typeof stream.truncated !== 'boolean' ||
        typeof stream.sha256 !== 'string'
      ) {
        throw new Error('Invalid executor output');
      }
      const bytes = Buffer.from(stream.base64, 'base64');
      if (
        bytes.toString('base64') !== stream.base64 ||
        bytes.length !== stream.byteCount ||
        createHash('sha256').update(bytes).digest('hex') !== stream.sha256 ||
        !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)
      ) {
        throw new Error('Invalid executor output');
      }
    }
    let status: R214ExecutionStatus = 'COMPLETED';
    if (receipt.status === 'unknown') {
      status = 'UNKNOWN';
    } else if (receipt.timedOut) {
      status = 'TIMED_OUT';
    } else if (
      receipt.status === 'failed' ||
      (receipt.exitCode !== null && receipt.exitCode !== 0)
    ) {
      status = 'FAILED';
    }

    const stdout = receipt.stdout?.base64
      ? Buffer.from(receipt.stdout.base64, 'base64').toString('utf8')
      : (receipt.stdout?.text ?? '');
    const stderr = receipt.stderr?.base64
      ? Buffer.from(receipt.stderr.base64, 'base64').toString('utf8')
      : (receipt.stderr?.text ?? '');

    const startedAt = receipt.startedAt ?? new Date().toISOString();
    const completedAt = receipt.endedAt ?? new Date().toISOString();
    const durationMs = Math.max(
      0,
      new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    );

    const cleanupStatus: R214CleanupStatus = 'CLEAN';

    const isUnknown = status === 'UNKNOWN';

    return {
      operationId: intent.operationId,
      attemptId: receipt.receiptId ?? `att_${intent.requestId}`,
      generation: intent.generation,
      fence: intent.fence,
      snapshotDigest,
      recipeId: RESTRICTED_RECIPE_ID,
      recipeDigest: RESTRICTED_RECIPE_DIGEST,
      status,
      startedAt,
      completedAt,
      exitCode: receipt.exitCode ?? null,
      stdout,
      stderr,
      stdoutBytes:
        receipt.stdout?.byteCount ?? Buffer.byteLength(stdout, 'utf8'),
      stderrBytes:
        receipt.stderr?.byteCount ?? Buffer.byteLength(stderr, 'utf8'),
      outputHashes: {
        stdoutDigest:
          receipt.stdout?.sha256 ??
          createHash('sha256').update(stdout).digest('hex'),
        stderrDigest:
          receipt.stderr?.sha256 ??
          createHash('sha256').update(stderr).digest('hex'),
      },
      truncated: {
        stdout: Boolean(receipt.stdout?.truncated),
        stderr: Boolean(receipt.stderr?.truncated),
      },
      resourceUsage: { durationMs },
      cleanupStatus,
      isUnknown,
      provenance: this.provenance,
      isSynthetic: false,
    };
  }

  private buildUnknownOutcome(
    intent: R214ExecutionIntent,
    snapshotDigest: string,
    message: string,
  ): R214ExecutionOutcome {
    const now = new Date().toISOString();
    return {
      operationId: intent.operationId,
      attemptId: `att_unknown_${intent.requestId}`,
      generation: intent.generation,
      fence: intent.fence,
      snapshotDigest,
      recipeId: RESTRICTED_RECIPE_ID,
      recipeDigest: RESTRICTED_RECIPE_DIGEST,
      status: 'UNKNOWN',
      startedAt: now,
      completedAt: now,
      exitCode: null,
      stdout: '',
      stderr: message,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(message, 'utf8'),
      outputHashes: {
        stdoutDigest: sha256(''),
        stderrDigest: sha256(message),
      },
      truncated: { stdout: false, stderr: false },
      resourceUsage: { durationMs: 0 },
      cleanupStatus: 'UNKNOWN',
      isUnknown: true,
      provenance: this.provenance,
      isSynthetic: false,
    };
  }
}

export const defaultSyntheticExecutionAdapter = new SyntheticExecutionAdapter();

export function getExecutionAdapter(
  backend?: ExecutionBackend,
  config?: RestrictedBridgeConfig,
): ExecutionAdapter {
  const chosenBackend =
    backend ??
    (process.env.HIREARCHY_EXECUTION_BACKEND as ExecutionBackend) ??
    'deterministic-synthetic';

  if (chosenBackend === 'restricted-executor') {
    return new RestrictedExecutorBridgeAdapter(config);
  }
  return defaultSyntheticExecutionAdapter;
}
