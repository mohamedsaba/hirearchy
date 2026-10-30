import { createHash } from 'node:crypto';

import type { WorkspaceFileChange } from '../events/session-event';
import { BoundedStreamAccumulator } from './bounded-stream-accumulator';
import {
  type CommandExecResult,
  type SandboxAdapter,
  type SandboxCreateOptions,
  type TreeDiffResult,
  type WorkspaceFileInfo,
  SandboxError,
} from './sandbox';

export type MockExecHandler = (
  command: string,
  state: {
    files: Map<string, string>;
    cwd: string;
  },
) => {
  exitCode?: number | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
};

export class MockSandboxAdapter implements SandboxAdapter {
  private readonly activeSandboxes = new Map<
    string,
    {
      files: Map<string, string>;
      cwd: string;
      baselineTree: string;
    }
  >();

  private readonly treeSnapshots = new Map<string, Map<string, string>>();

  /** Session IDs that have been frozen via freeze(). */
  private readonly frozenSessions = new Set<string>();

  public failCreationForSessionId: string | null = null;
  public customExecHandler: MockExecHandler | null = null;
  public defaultTimeoutMs = 30_000;
  public failCaptureTree = false;
  public failCaptureDiff = false;
  public failTeardown = false;
  public failWrite = false;
  /** If true, freeze() throws SandboxError('SANDBOX_FREEZE_FAILED'). */
  public failFreeze = false;
  /** If true, captureFrozenEvidence() throws SandboxError('SANDBOX_EXECUTION_FAILED'). */
  public failCaptureFrozenEvidence = false;

  private computeTreeHash(files: Map<string, string>): string {
    const sortedEntries = Array.from(files.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const h = createHash('sha1');
    for (const [p, c] of sortedEntries) {
      h.update(`${p}\0${c}\0`);
    }
    return h.digest('hex');
  }

  async createAndVerify(
    sessionId: string,
    options?: SandboxCreateOptions | Readonly<Record<string, string>>,
  ): Promise<void> {
    if (this.failCreationForSessionId === sessionId) {
      throw new SandboxError(
        'SANDBOX_READINESS_FAILED',
        `Mock sandbox readiness failed for session ${sessionId}`,
      );
    }

    const files = new Map<string, string>();
    let initialFiles: Readonly<Record<string, string>> | undefined;

    if (options) {
      if (
        'imageName' in options ||
        'scenarioType' in options ||
        'initialFiles' in options
      ) {
        initialFiles = (options as SandboxCreateOptions).initialFiles;
      } else {
        initialFiles = options as Record<string, string>;
      }
    }

    if (initialFiles) {
      for (const [path, content] of Object.entries(initialFiles)) {
        files.set(path, content);
      }
    } else if (
      options &&
      'scenarioType' in options &&
      options.scenarioType === 'multi_file'
    ) {
      files.set('inventory/service.py', '# inventory service\n');
      files.set('tests/test_storefront.py', '# storefront tests\n');
    }

    const baselineTree = this.computeTreeHash(files);
    this.treeSnapshots.set(baselineTree, new Map(files));

    this.activeSandboxes.set(sessionId, {
      files,
      cwd: '/workspace',
      baselineTree,
    });
  }

  async readFile(sessionId: string, filePath: string): Promise<string> {
    const sandbox = this.activeSandboxes.get(sessionId);
    if (!sandbox) {
      throw new SandboxError(
        'SANDBOX_NOT_FOUND',
        `No active sandbox found for session ${sessionId}`,
      );
    }
    const normalized = filePath.replace(/^\/workspace\/?/, '');
    const content = sandbox.files.get(normalized);
    if (content === undefined) {
      throw new SandboxError('SANDBOX_NOT_FOUND', `File ${filePath} not found`);
    }
    return content;
  }

  async listFiles(sessionId: string): Promise<readonly WorkspaceFileInfo[]> {
    const sandbox = this.activeSandboxes.get(sessionId);
    if (!sandbox) {
      throw new SandboxError(
        'SANDBOX_NOT_FOUND',
        `No active sandbox found for session ${sessionId}`,
      );
    }
    const result: WorkspaceFileInfo[] = [];
    for (const [path, content] of sandbox.files.entries()) {
      result.push({
        path,
        size: Buffer.byteLength(content, 'utf8'),
        isDirectory: false,
      });
    }
    return result;
  }

  async getBaselineTree(sessionId: string): Promise<string> {
    const sandbox = this.activeSandboxes.get(sessionId);
    if (!sandbox) {
      throw new SandboxError(
        'SANDBOX_NOT_FOUND',
        `No active sandbox found for session ${sessionId}`,
      );
    }
    return sandbox.baselineTree;
  }

  async captureWorkspaceTree(sessionId: string): Promise<string> {
    if (this.failCaptureTree) {
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        'Simulated capture tree failure',
      );
    }
    const sandbox = this.activeSandboxes.get(sessionId);
    if (!sandbox) {
      throw new SandboxError(
        'SANDBOX_NOT_FOUND',
        `No active sandbox found for session ${sessionId}`,
      );
    }
    const hash = this.computeTreeHash(sandbox.files);
    this.treeSnapshots.set(hash, new Map(sandbox.files));
    return hash;
  }

  async captureTreeDiff(
    sessionId: string,
    beforeTree: string,
    afterTree: string,
  ): Promise<TreeDiffResult> {
    if (this.failCaptureDiff) {
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        'Simulated capture tree diff failure',
      );
    }
    const beforeFiles =
      this.treeSnapshots.get(beforeTree) ?? new Map<string, string>();
    const afterFiles =
      this.treeSnapshots.get(afterTree) ?? new Map<string, string>();

    const allPaths = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
    const files: WorkspaceFileChange[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    const diffChunks: string[] = [];

    for (const p of Array.from(allPaths).sort()) {
      const beforeContent = beforeFiles.get(p);
      const afterContent = afterFiles.get(p);

      if (beforeContent === afterContent) continue;

      let status: 'modified' | 'added' | 'deleted' = 'modified';
      if (beforeContent === undefined) {
        status = 'added';
      } else if (afterContent === undefined) {
        status = 'deleted';
      }

      const beforeLines = beforeContent ? beforeContent.split('\n') : [];
      const afterLines = afterContent ? afterContent.split('\n') : [];
      const adds =
        status === 'deleted'
          ? 0
          : Math.max(
              0,
              afterLines.length - (status === 'added' ? 0 : beforeLines.length),
            );
      const dels =
        status === 'added'
          ? 0
          : Math.max(
              0,
              beforeLines.length -
                (status === 'deleted' ? 0 : afterLines.length),
            );

      totalAdditions += adds;
      totalDeletions += dels;

      const patch = `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n+${afterContent ?? ''}`;
      const patchBytes = Buffer.byteLength(patch, 'utf8');
      const patchTruncated = false;

      files.push({
        path: p,
        status,
        additions: adds,
        deletions: dels,
        patchPreview: patch,
        patchPreviewBytes: patchBytes,
        patchBytes,
        patchTruncated,
      });

      diffChunks.push(patch);
    }

    return {
      files,
      totalAdditions,
      totalDeletions,
      rawDiff: diffChunks.join('\n'),
    };
  }

  async exec(
    sessionId: string,
    commandId: string,
    command: string,
    cwd = '/workspace',
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<CommandExecResult> {
    const sandbox = this.activeSandboxes.get(sessionId);
    if (!sandbox) {
      throw new SandboxError(
        'SANDBOX_NOT_FOUND',
        `No active sandbox found for session ${sessionId}`,
      );
    }

    if (this.customExecHandler) {
      const handled = this.customExecHandler(command, sandbox);
      const stdoutAccumulator = new BoundedStreamAccumulator();
      const stderrAccumulator = new BoundedStreamAccumulator();
      if (handled.stdout) stdoutAccumulator.append(handled.stdout);
      if (handled.stderr) stderrAccumulator.append(handled.stderr);

      const stdoutRes = stdoutAccumulator.result;
      const stderrRes = stderrAccumulator.result;

      return {
        commandId,
        exitCode: handled.timedOut ? null : (handled.exitCode ?? 0),
        timedOut: handled.timedOut ?? false,
        durationMs: handled.durationMs ?? 10,
        stdoutPreview: stdoutRes.preview,
        stdoutBytes: stdoutRes.bytes,
        stdoutTruncated: stdoutRes.truncated,
        stderrPreview: stderrRes.preview,
        stderrBytes: stderrRes.bytes,
        stderrTruncated: stderrRes.truncated,
      };
    }

    // Default built-in command simulation
    const stdoutAccumulator = new BoundedStreamAccumulator();
    const stderrAccumulator = new BoundedStreamAccumulator();
    let exitCode: number | null = 0;
    let timedOut = false;
    let durationMs = 5;

    if (command.startsWith('sleep') && timeoutMs <= 100) {
      timedOut = true;
      exitCode = null;
      durationMs = timeoutMs;
    } else if (command === 'false') {
      exitCode = 1;
    } else if (command === 'pwd') {
      stdoutAccumulator.append(`${cwd}\n`);
    } else if (command.startsWith('echo ') && command.includes(' > ')) {
      const match = command.match(/^echo\s+["']?(.*?)["']?\s*>\s*(.+)$/);
      if (match) {
        const [, text, targetPath] = match;
        const normalizedPath = targetPath.trim().replace(/^\/workspace\/?/, '');
        sandbox.files.set(normalizedPath, `${text}\n`);
      }
    } else if (command.startsWith('cat ')) {
      const targetPath = command
        .slice(4)
        .trim()
        .replace(/^\/workspace\/?/, '');
      if (sandbox.files.has(targetPath)) {
        stdoutAccumulator.append(sandbox.files.get(targetPath)!);
      } else {
        exitCode = 1;
        stderrAccumulator.append(
          `cat: can't open '${targetPath}': No such file or directory\n`,
        );
      }
    } else {
      stdoutAccumulator.append(`executed: ${command}\n`);
    }

    const stdoutRes = stdoutAccumulator.result;
    const stderrRes = stderrAccumulator.result;

    return {
      commandId,
      exitCode,
      timedOut,
      durationMs,
      stdoutPreview: stdoutRes.preview,
      stdoutBytes: stdoutRes.bytes,
      stdoutTruncated: stdoutRes.truncated,
      stderrPreview: stderrRes.preview,
      stderrBytes: stderrRes.bytes,
      stderrTruncated: stderrRes.truncated,
    };
  }

  async writeFile(
    sessionId: string,
    filePath: string,
    content: string,
  ): Promise<void> {
    if (this.failWrite) {
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        `Simulated writeFile failure for session ${sessionId}`,
      );
    }
    const sandbox = this.activeSandboxes.get(sessionId);
    if (!sandbox) {
      throw new SandboxError(
        'SANDBOX_NOT_FOUND',
        `No active sandbox found for session ${sessionId}`,
      );
    }
    const normalized = filePath.replace(/^\/workspace\/?/, '');
    sandbox.files.set(normalized, content);
  }

  async teardown(sessionId: string): Promise<void> {
    if (this.failTeardown) {
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        `Simulated teardown failure for session ${sessionId}`,
      );
    }
    this.activeSandboxes.delete(sessionId);
    this.frozenSessions.delete(sessionId);
  }

  async freeze(sessionId: string): Promise<void> {
    if (this.frozenSessions.has(sessionId)) {
      return;
    }
    if (this.failFreeze) {
      throw new SandboxError(
        'SANDBOX_FREEZE_FAILED',
        `Simulated freeze failure for session ${sessionId}`,
      );
    }
    const sandbox = this.activeSandboxes.get(sessionId);
    if (!sandbox) {
      throw new SandboxError(
        'SANDBOX_NOT_FOUND',
        `No active sandbox found for session ${sessionId}`,
      );
    }
    this.frozenSessions.add(sessionId);
  }

  async captureFrozenEvidence(
    sessionId: string,
    baselineTree?: string,
    generatedStarterFiles?: Readonly<Record<string, string>>,
  ): Promise<{ currentTree: string; rawDiff: string }> {
    if (this.failCaptureFrozenEvidence) {
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        `Simulated captureFrozenEvidence failure for session ${sessionId}`,
      );
    }
    if (!this.frozenSessions.has(sessionId)) {
      throw new SandboxError(
        'SANDBOX_FREEZE_FAILED',
        `Session ${sessionId} is not frozen; cannot capture frozen evidence.`,
      );
    }
    const sandbox = this.activeSandboxes.get(sessionId);
    if (!sandbox) {
      throw new SandboxError(
        'SANDBOX_NOT_FOUND',
        `No active sandbox found for session ${sessionId}`,
      );
    }
    const currentTree = this.computeTreeHash(sandbox.files);
    this.treeSnapshots.set(currentTree, new Map(sandbox.files));

    let effectiveBaseline = baselineTree;
    if (!effectiveBaseline && generatedStarterFiles) {
      const genFiles = new Map(Object.entries(generatedStarterFiles));
      effectiveBaseline = this.computeTreeHash(genFiles);
      this.treeSnapshots.set(effectiveBaseline, genFiles);
    }

    // Build raw diff in the same format as the Docker implementation
    const diffResult = await this.captureTreeDiff(
      sessionId,
      effectiveBaseline ?? sandbox.baselineTree,
      currentTree,
    );
    return { currentTree, rawDiff: diffResult.rawDiff };
  }

  /** Test helper: check whether a session has been frozen. */
  isFrozen(sessionId: string): boolean {
    return this.frozenSessions.has(sessionId);
  }

  hasSandbox(sessionId: string): boolean {
    return this.activeSandboxes.has(sessionId);
  }

  getSandboxFiles(sessionId: string): Map<string, string> | undefined {
    return this.activeSandboxes.get(sessionId)?.files;
  }
}
