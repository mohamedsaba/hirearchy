import { createHash, randomBytes } from 'node:crypto';
import {
  R213_SYNTHETIC_PROVENANCE,
  type R213ExecutionIntent,
  type R213ExecutionOutcome,
} from './contract';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export class SyntheticExecutionAdapter {
  readonly provenance = R213_SYNTHETIC_PROVENANCE;

  async execute(
    intent: R213ExecutionIntent,
    workspaceFiles: Readonly<Record<string, string>>,
  ): Promise<R213ExecutionOutcome> {
    const attemptId = `att_${randomBytes(8).toString('hex')}`;
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    // Check files for simulated states
    let combinedContent = '';
    for (const content of Object.values(workspaceFiles)) {
      combinedContent += '\n' + content;
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

    // Realistic Python checks simulation
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
      stdout = stdout.slice(0, maxStdout) + '\n[... STDOUT TRUNCATED ...]';
    }
    if (truncatedStderr) {
      stderr = stderr.slice(0, maxStderr) + '\n[... STDERR TRUNCATED ...]';
    }

    const cleanupStatus = combinedContent.includes('SIMULATE_RESOURCE_LEAK')
      ? 'RESOURCE_LEAK'
      : 'CLEAN';

    return {
      operationId: intent.operationId,
      attemptId,
      generation: intent.generation,
      fence: intent.fence,
      snapshotDigest: intent.canonicalWorkspaceSnapshotDigest,
      recipeId: intent.approvedRecipeId,
      recipeDigest: intent.approvedRecipeDigest,
      status: 'COMPLETED',
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
      cleanupStatus,
      isUnknown: false,
      provenance: this.provenance,
      isSynthetic: true,
    };
  }
}

export const defaultSyntheticExecutionAdapter = new SyntheticExecutionAdapter();
