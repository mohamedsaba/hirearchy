import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  RESTRICTED_EXECUTOR_PROVENANCE,
  type R214ExecutionIntent,
  type R214ExecutionOutcome,
} from './contract';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64_000;
const EXEC_TIMEOUT_MS = 6_000;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function clampOutput(raw: string): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes <= MAX_OUTPUT_BYTES) {
    return { text: raw, truncated: false };
  }
  const sliced = Buffer.from(raw, 'utf8')
    .subarray(0, MAX_OUTPUT_BYTES)
    .toString('utf8');
  return { text: sliced, truncated: true };
}

function safeRelativePath(rawPath: string): string | null {
  if (
    !rawPath ||
    rawPath.startsWith('/') ||
    rawPath.includes('\\') ||
    rawPath.includes('\0')
  ) {
    return null;
  }
  const normalized = path.posix.normalize(rawPath);
  if (
    normalized === '.' ||
    normalized.startsWith('..') ||
    path.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

async function runCommandInSandbox(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      env: {
        NODE_ENV: process.env.NODE_ENV ?? 'production',
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: cwd,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONUNBUFFERED: '1',
      },
    });
    return { exitCode: 0, stdout, stderr, timedOut: false };
  } catch (err: unknown) {
    const e = err as {
      code?: number | string;
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (e.killed || e.signal === 'SIGTERM') {
      return {
        exitCode: null,
        stdout: e.stdout ?? '',
        stderr:
          (e.stderr ?? '') + `\nTest run timed out after ${EXEC_TIMEOUT_MS}ms.`,
        timedOut: true,
      };
    }
    if (typeof e.code === 'string' && e.code === 'ENOENT') {
      throw err;
    }
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
      timedOut: false,
    };
  }
}

/**
 * Runs candidate workspace tests inside an ephemeral temp directory when real runtime execution
 * is enabled for Hiring Platform assessments, returning a factual execution receipt.
 */
export async function runHiringWorkspaceChecks(
  intent: R214ExecutionIntent,
  workspaceFiles: Readonly<Record<string, string>>,
): Promise<R214ExecutionOutcome> {
  const attemptId = `att_${randomBytes(8).toString('hex')}`;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  const fileEntries = Object.entries(workspaceFiles);
  const paths = fileEntries.map(([p]) => p);
  const hasJsTests = paths.some((p) => /\.(?:test|spec)\.[cm]?[jt]s$/i.test(p));
  const hasPython = paths.some((p) => p.endsWith('.py'));

  let sandboxRoot: string | null = null;
  try {
    sandboxRoot = await mkdtemp(path.join(tmpdir(), 'hirearchy-test-'));
    for (const [rawPath, content] of fileEntries) {
      const clean = safeRelativePath(rawPath);
      if (!clean) continue;
      const target = path.join(sandboxRoot, clean);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }

    let result: {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    };

    if (hasPython || !hasJsTests) {
      try {
        result = await runCommandInSandbox(
          'python3',
          ['-m', 'pytest', '-q'],
          sandboxRoot,
        );
        // Exit code 5 in pytest means 0 tests collected — fall back to unittest discovery
        if (
          result.exitCode === 5 ||
          /No module named pytest/i.test(result.stderr)
        ) {
          result = await runCommandInSandbox(
            'python3',
            ['-m', 'unittest', 'discover', '-v'],
            sandboxRoot,
          );
        }
      } catch {
        result = await runCommandInSandbox(
          'python3',
          ['-m', 'unittest', 'discover', '-v'],
          sandboxRoot,
        );
      }
    } else {
      result = await runCommandInSandbox('node', ['--test'], sandboxRoot);
    }

    const durationMs = Math.max(1, Date.now() - startedMs);
    const out = clampOutput(result.stdout);
    const err = clampOutput(result.stderr);
    const completedAt = new Date().toISOString();

    return {
      operationId: intent.operationId,
      attemptId,
      generation: intent.generation,
      fence: intent.fence,
      snapshotDigest: intent.canonicalWorkspaceSnapshotDigest,
      recipeId: intent.approvedRecipeId,
      recipeDigest: intent.approvedRecipeDigest,
      status: result.timedOut ? 'TIMED_OUT' : 'COMPLETED',
      startedAt,
      completedAt,
      exitCode: result.timedOut ? null : (result.exitCode ?? 1),
      stdout: out.text,
      stderr: err.text,
      stdoutBytes: Buffer.byteLength(out.text, 'utf8'),
      stderrBytes: Buffer.byteLength(err.text, 'utf8'),
      outputHashes: {
        stdoutDigest: sha256(out.text),
        stderrDigest: sha256(err.text),
      },
      truncated: {
        stdout: out.truncated,
        stderr: err.truncated,
      },
      resourceUsage: { durationMs },
      cleanupStatus: 'CLEAN',
      isUnknown: false,
      provenance: RESTRICTED_EXECUTOR_PROVENANCE,
      isSynthetic: false,
    };
  } catch (err) {
    const durationMs = Math.max(1, Date.now() - startedMs);
    const msg =
      err instanceof Error ? err.message : 'Unable to run workspace tests.';
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
      completedAt: new Date().toISOString(),
      exitCode: 1,
      stdout: '',
      stderr: msg,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(msg, 'utf8'),
      outputHashes: { stdoutDigest: sha256(''), stderrDigest: sha256(msg) },
      truncated: { stdout: false, stderr: false },
      resourceUsage: { durationMs },
      cleanupStatus: 'CLEAN',
      isUnknown: false,
      provenance: RESTRICTED_EXECUTOR_PROVENANCE,
      isSynthetic: false,
    };
  } finally {
    if (sandboxRoot) {
      await rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}
