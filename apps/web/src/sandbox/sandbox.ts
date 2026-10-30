export type CommandExecResult = Readonly<{
  commandId: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutPreview: string;
  stdoutBytes: number;
  stdoutTruncated: boolean;
  stderrPreview: string;
  stderrBytes: number;
  stderrTruncated: boolean;
}>;

export const MAX_WORKSPACE_FILE_READ_BYTES = 100_000;
export const MAX_COMMAND_LENGTH = 4096;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export type ProcessOptions = Readonly<{
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}>;

export class SandboxError extends Error {
  constructor(
    readonly code:
      | 'SANDBOX_CREATION_FAILED'
      | 'SANDBOX_READINESS_FAILED'
      | 'SANDBOX_NOT_FOUND'
      | 'SANDBOX_EXECUTION_FAILED'
      | 'SANDBOX_FREEZE_FAILED',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export type WorkspaceFileInfo = Readonly<{
  path: string;
  size: number;
  isDirectory: boolean;
}>;

export type SandboxCreateOptions = Readonly<{
  imageName?: string;
  initialFiles?: Readonly<Record<string, string>>;
  scenarioType?: 'single_file' | 'multi_file';
  generatedWorkspace?: boolean;
}>;

import type { WorkspaceFileChange } from '../events/session-event';

export type TreeDiffResult = Readonly<{
  files: readonly WorkspaceFileChange[];
  totalAdditions: number;
  totalDeletions: number;
  rawDiff: string;
}>;

export interface SandboxAdapter {
  inspectResources?(sessionId: string): Promise<{
    containerStatus: 'running' | 'paused' | 'exited' | 'missing';
    volumeExists: boolean;
  }>;

  createAndVerify(
    sessionId: string,
    options?: SandboxCreateOptions | Readonly<Record<string, string>>,
  ): Promise<void>;

  exec(
    sessionId: string,
    commandId: string,
    command: string,
    cwd?: string,
    timeoutMs?: number,
  ): Promise<CommandExecResult>;

  writeFile(
    sessionId: string,
    filePath: string,
    content: string,
  ): Promise<void>;

  readFile(sessionId: string, filePath: string): Promise<string>;

  listFiles(sessionId: string): Promise<readonly WorkspaceFileInfo[]>;

  captureWorkspaceTree(sessionId: string): Promise<string>;

  captureTreeDiff(
    sessionId: string,
    beforeTree: string,
    afterTree: string,
  ): Promise<TreeDiffResult>;

  getBaselineTree(sessionId: string): Promise<string>;

  teardown(sessionId: string): Promise<void>;

  /**
   * Pause the primary sandbox container via docker pause and confirm the
   * paused state via docker inspect. Returns only after freeze is verified.
   * Throws SandboxError('SANDBOX_FREEZE_FAILED') if confirmation fails.
   */
  freeze(sessionId: string): Promise<void>;

  /** Return the kernel-confirmed paused state of the primary sandbox. */
  isFrozen(sessionId: string): boolean | Promise<boolean>;

  /**
   * Capture the authoritative workspace tree and diff using a trusted
   * ephemeral helper container that mounts the session workspace volume
   * read-only. The primary sandbox MUST already be paused before calling
   * this method, and MUST remain paused for the duration of capture.
   *
   * Returns the current tree hash and raw diff relative to baselineTree.
   */
  captureFrozenEvidence(
    sessionId: string,
    baselineTree?: string,
    generatedStarterFiles?: Readonly<Record<string, string>>,
  ): Promise<{ currentTree: string; rawDiff: string }>;
}
