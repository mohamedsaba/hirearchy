import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { WorkspaceFileChange } from '../events/session-event';
import { BoundedStreamAccumulator } from './bounded-stream-accumulator';
import {
  type CommandExecResult,
  type ProcessOptions,
  type SandboxAdapter,
  type SandboxCreateOptions,
  type TreeDiffResult,
  type WorkspaceFileInfo,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_WORKSPACE_FILE_READ_BYTES,
  SandboxError,
} from './sandbox';

export type DockerSandboxOptions = Readonly<{
  imageName?: string;
  defaultTimeoutMs?: number;
}>;

const isMissingDockerVolumeError = (error: unknown): boolean => {
  const parts = [
    error instanceof Error ? error.message : String(error),
    error instanceof SandboxError && error.cause instanceof Error
      ? error.cause.message
      : '',
  ].join('\n');
  return /No such volume/i.test(parts);
};

const workspacePathRejectedMarker = 'HIREARCHY_WORKSPACE_PATH_REJECTED';

const readWorkspaceFileScript = [
  'set -eu',
  `reject() { echo ${workspacePathRejectedMarker} >&2; exit 64; }`,
  'root="$(realpath /workspace)" || reject',
  'exec 3< "$1" || reject',
  'resolved="$(readlink -f /proc/self/fd/3)" || reject',
  'case "$resolved" in "$root"/*) ;; *) reject ;; esac',
  '[ -f /proc/self/fd/3 ] || reject',
  'cat <&3',
].join('; ');

const writeWorkspaceFileScript = [
  'set -eu',
  `reject() { echo ${workspacePathRejectedMarker} >&2; exit 64; }`,
  'root="$(realpath /workspace)" || reject',
  'relative="$1"',
  'temporaryName="$2"',
  'exec 3< "$root" || reject',
  'remaining="$relative"',
  'while [ "$remaining" != "${remaining#*/}" ]; do',
  '  component="${remaining%%/*}"',
  '  remaining="${remaining#*/}"',
  '  next="/proc/self/fd/3/$component"',
  '  if [ ! -e "$next" ]; then mkdir "$next" || reject; fi',
  '  exec 4<&3',
  '  exec 3< "/proc/self/fd/4/$component" || reject',
  '  exec 4<&-',
  '  resolved="$(readlink -f /proc/self/fd/3)" || reject',
  '  case "$resolved" in "$root"|"$root"/*) ;; *) reject ;; esac',
  '  [ -d /proc/self/fd/3 ] || reject',
  'done',
  'entry="/proc/self/fd/3/$remaining"',
  '[ -L "$entry" ] && reject',
  '[ -d "$entry" ] && reject',
  'temporary="/proc/self/fd/3/.hirearchy-write-$temporaryName"',
  'set -C',
  'exec 4> "$temporary" || reject',
  'set +C',
  'trap \'rm -f "$temporary"\' EXIT HUP INT TERM',
  'cat >&4',
  'exec 4>&-',
  'rm -f "$entry" || reject',
  'ln "$temporary" "$entry" || reject',
  'rm -f "$temporary" || reject',
  'trap - EXIT',
].join('\n');

export class DockerSandboxAdapter implements SandboxAdapter {
  private readonly imageName: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: DockerSandboxOptions = {}) {
    this.imageName = options.imageName ?? 'alpine:3.20';
    this.defaultTimeoutMs =
      options.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  getContainerName(sessionId: string): string {
    const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `hirearchy-sandbox-${sanitized}`;
  }

  /**
   * Derives a deterministic, validated Docker volume name for the session
   * workspace. Uses the same sanitization as getContainerName so the name
   * is safe for Docker and cannot encode untrusted path/name data.
   * One volume per session; never shared across sessions.
   */
  getVolumeName(sessionId: string): string {
    const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `hirearchy-ws-${sanitized}`;
  }

  /**
   * Derives a deterministic Docker volume name for session evidence.
   * Persists baseline and evidence records across container restarts.
   */
  getEvidenceVolumeName(sessionId: string): string {
    const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `hirearchy-ev-${sanitized}`;
  }

  async inspectResources(sessionId: string): Promise<{
    containerStatus: 'running' | 'paused' | 'exited' | 'missing';
    volumeExists: boolean;
  }> {
    const containerName = this.getContainerName(sessionId);
    const volumeName = this.getVolumeName(sessionId);

    let containerStatus: 'running' | 'paused' | 'exited' | 'missing' =
      'missing';
    try {
      const inspect = await this.runProcess(
        'docker',
        ['inspect', '-f', '{{.State.Status}}', containerName],
        { timeoutMs: 10000, maxStdoutBytes: 4096, maxStderrBytes: 4096 },
      );
      const status = inspect.stdout.trim().toLowerCase();
      if (status === 'running') containerStatus = 'running';
      else if (status === 'paused') containerStatus = 'paused';
      else containerStatus = 'exited';
    } catch (e) {
      const err = e as { message?: string; cause?: { message?: string } };
      const combined =
        `${err.message ?? ''} ${err.cause?.message ?? ''}`.toLowerCase();
      if (
        combined.includes('no such object') ||
        combined.includes('no such container')
      ) {
        containerStatus = 'missing';
      } else {
        throw e;
      }
    }

    let volumeExists = false;
    try {
      await this.runProcess('docker', ['volume', 'inspect', volumeName], {
        timeoutMs: 10000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
      });
      volumeExists = true;
    } catch (e) {
      const err = e as { message?: string; cause?: { message?: string } };
      const combined =
        `${err.message ?? ''} ${err.cause?.message ?? ''}`.toLowerCase();
      if (combined.includes('no such volume')) {
        volumeExists = false;
      } else {
        throw e;
      }
    }

    return { containerStatus, volumeExists };
  }

  async createAndVerify(
    sessionId: string,
    options?: SandboxCreateOptions | Readonly<Record<string, string>>,
  ): Promise<void> {
    const containerName = this.getContainerName(sessionId);
    const volumeName = this.getVolumeName(sessionId);
    const evidenceVolumeName = this.getEvidenceVolumeName(sessionId);

    // Clean up any stale container with the same name first
    await this.runProcess('docker', ['rm', '-f', containerName], {
      timeoutMs: 15_000,
      maxStdoutBytes: 4 * 1024,
      maxStderrBytes: 64 * 1024,
    }).catch(() => {});

    const isOptionsObject =
      options !== undefined &&
      (('scenarioType' in options && options.scenarioType !== undefined) ||
        ('imageName' in options && options.imageName !== undefined) ||
        ('initialFiles' in options && options.initialFiles !== undefined) ||
        ('generatedWorkspace' in options && options.generatedWorkspace));

    const initialFiles: Readonly<Record<string, string>> = isOptionsObject
      ? ((options as SandboxCreateOptions).initialFiles ?? {})
      : ((options as Readonly<Record<string, string>>) ?? {});

    const imageName =
      isOptionsObject && (options as SandboxCreateOptions).imageName
        ? (options as SandboxCreateOptions).imageName!
        : this.imageName;
    const usesBookingNotificationReadiness =
      imageName === 'hirearchy-scenario-002:v1.0.0';
    const isGeneratedWorkspace =
      isOptionsObject &&
      (options as SandboxCreateOptions).generatedWorkspace === true;

    const isMultiFile =
      (isOptionsObject &&
        (options as SandboxCreateOptions).scenarioType === 'multi_file') ||
      imageName.includes('scenario-001');

    // Step 1: Create dedicated session workspace volume.
    // This volume replaces /workspace tmpfs so that the workspace is
    // independently addressable for out-of-band capture via a helper
    // container after the primary sandbox is paused (docker pause).
    // tmpfs cannot be read from outside a running container; a named
    // volume persists independently of the sandbox container lifecycle
    // and can be mounted read-only into an ephemeral trusted helper.
    try {
      await this.runProcess('docker', ['volume', 'create', volumeName], {
        timeoutMs: 15_000,
        maxStdoutBytes: 4 * 1024,
        maxStderrBytes: 64 * 1024,
      });
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        'SANDBOX_CREATION_FAILED',
        'Failed to create session workspace volume.',
        error,
      );
    }

    if (isGeneratedWorkspace) {
      try {
        await this.runProcess(
          'docker',
          ['volume', 'create', evidenceVolumeName],
          {
            timeoutMs: 15_000,
            maxStdoutBytes: 4 * 1024,
            maxStderrBytes: 64 * 1024,
          },
        );
      } catch (error) {
        await this.runProcess('docker', ['volume', 'rm', volumeName], {
          timeoutMs: 15_000,
          maxStdoutBytes: 4 * 1024,
          maxStderrBytes: 64 * 1024,
        }).catch(() => {});
        if (error instanceof SandboxError) throw error;
        throw new SandboxError(
          'SANDBOX_CREATION_FAILED',
          'Failed to create session evidence volume.',
          error,
        );
      }
    }

    // Step 2: Start sandbox with volume mounted at /workspace (rw).
    // All other security constraints (read-only rootfs, network none,
    // resource limits, cap-drop, no-new-privileges) are preserved.
    try {
      if (isMultiFile) {
        await this.runProcess(
          'docker',
          [
            'run',
            '-d',
            '--name',
            containerName,
            ...(isGeneratedWorkspace
              ? ['--label', 'hirearchy.workspace.type=generated']
              : []),
            '--read-only',
            '--tmpfs',
            '/tmp:rw,exec,nosuid,size=256m,uid=1000,gid=1000',
            '--mount',
            `type=volume,source=${volumeName},target=/workspace`,
            ...(isGeneratedWorkspace
              ? [
                  '--mount',
                  `type=volume,source=${evidenceVolumeName},target=/run/hirearchy-evidence`,
                ]
              : [
                  '--tmpfs',
                  '/run/hirearchy-evidence:rw,noexec,nosuid,size=64m,mode=0700,uid=0,gid=0',
                ]),
            '--network',
            'none',
            '--memory=1024m',
            '--cpus=1.0',
            '--pids-limit=128',
            '--cap-drop=ALL',
            '--cap-add=SETUID',
            '--cap-add=SETGID',
            '--security-opt=no-new-privileges:true',
            '--user',
            '1000:1000',
            '-w',
            '/workspace',
            imageName,
            'sleep',
            'infinity',
          ],
          {
            timeoutMs: 30_000,
            maxStdoutBytes: 4 * 1024,
            maxStderrBytes: 64 * 1024,
          },
        );
      } else {
        await this.runProcess(
          'docker',
          [
            'run',
            '-d',
            '--name',
            containerName,
            '--read-only',
            '--tmpfs',
            '/tmp:rw,noexec,nosuid,size=64m',
            '--mount',
            `type=volume,source=${volumeName},target=/workspace`,
            '--network',
            'none',
            '--memory=512m',
            '--cpus=1.0',
            '--pids-limit=64',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges:true',
            '--user',
            '1000:1000',
            '-w',
            '/workspace',
            imageName,
            'sleep',
            'infinity',
          ],
          {
            timeoutMs: 30_000,
            maxStdoutBytes: 4 * 1024,
            maxStderrBytes: 64 * 1024,
          },
        );
      }
    } catch (error) {
      // docker run can leave a created container behind when startup fails.
      // Remove it before removing its attached volume.
      await this.teardown(sessionId).catch(() => {});
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        'SANDBOX_CREATION_FAILED',
        'Failed to create sandbox container.',
        error,
      );
    }

    // Named volumes default to root ownership on first mount. The candidate
    // runs as UID 1000 (and the primary drops CAP_CHOWN), so a trusted
    // helper must set ownership after the primary has mounted the volume.
    // Pre-start chown is insufficient: ownership can reset on first mount.
    try {
      await this.runProcess(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--mount',
          `type=volume,source=${volumeName},target=/workspace`,
          'alpine:3.20',
          'sh',
          '-c',
          'chown -R 1000:1000 /workspace && chmod 775 /workspace',
        ],
        {
          timeoutMs: 15_000,
          maxStdoutBytes: 4 * 1024,
          maxStderrBytes: 64 * 1024,
        },
      );
    } catch (error) {
      await this.teardown(sessionId).catch(() => {});
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        'SANDBOX_CREATION_FAILED',
        'Failed to initialize session workspace volume ownership.',
        error,
      );
    }
    // Ensure evidence volume permissions are restricted to root (0700)
    // before seeding initial files or permitting any candidate access.
    if (isGeneratedWorkspace) {
      try {
        await this.runProcess(
          'docker',
          [
            'exec',
            '-u',
            '0:0',
            containerName,
            'chmod',
            '700',
            '/run/hirearchy-evidence',
          ],
          {
            timeoutMs: 10_000,
            maxStdoutBytes: 4 * 1024,
            maxStderrBytes: 16 * 1024,
          },
        );
      } catch (error) {
        await this.teardown(sessionId).catch(() => {});
        if (error instanceof SandboxError) throw error;
        throw new SandboxError(
          'SANDBOX_CREATION_FAILED',
          'Failed to initialize evidence volume permissions.',
          error,
        );
      }
    }

    // Populate initial files if any
    try {
      for (const [filePath, content] of Object.entries(initialFiles)) {
        const dir = filePath.includes('/')
          ? filePath.slice(0, filePath.lastIndexOf('/'))
          : '';
        if (dir) {
          await this.runProcess(
            'docker',
            [
              'exec',
              containerName,
              'sh',
              '-c',
              'mkdir -p "$1"',
              '_',
              `/workspace/${dir}`,
            ],
            {
              timeoutMs: 10_000,
              maxStdoutBytes: 4 * 1024,
              maxStderrBytes: 64 * 1024,
            },
          );
        }

        await this.runProcessWithInput(
          'docker',
          [
            'exec',
            '-i',
            containerName,
            'sh',
            '-c',
            'cat > "$1"',
            '_',
            `/workspace/${filePath}`,
          ],
          content,
          {
            timeoutMs: 15_000,
            maxStdoutBytes: 4 * 1024,
            maxStderrBytes: 64 * 1024,
          },
        );
      }

      if (isMultiFile && !isGeneratedWorkspace) {
        await this.runProcess(
          'docker',
          [
            'exec',
            '-d',
            containerName,
            'sh',
            '-c',
            '/usr/local/bin/start_services.sh > /tmp/scenario-startup.log 2>&1',
          ],
          {
            timeoutMs: 10_000,
            maxStdoutBytes: 4 * 1024,
            maxStderrBytes: 16 * 1024,
          },
        );
      }

      // Readiness check
      if (isGeneratedWorkspace) {
        const baseline = await this.runProcess(
          'docker',
          [
            'exec',
            '-u',
            '0:0',
            containerName,
            'sh',
            '-c',
            'chmod 700 /run/hirearchy-evidence && HIREARCHY_CAPTURE_WORK_TREE=/workspace /usr/local/bin/hirearchy-capture-tree.sh > /run/hirearchy-evidence/generated-baseline && chmod 600 /run/hirearchy-evidence/generated-baseline && cat /run/hirearchy-evidence/generated-baseline',
          ],
          {
            timeoutMs: 30_000,
            maxStdoutBytes: 4 * 1024,
            maxStderrBytes: 64 * 1024,
          },
        );
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})\n?$/.test(baseline.stdout)) {
          throw new Error('Generated starter baseline capture failed.');
        }
      }

      if (isGeneratedWorkspace) {
        const readyCheck = await this.runProcess(
          'docker',
          ['exec', containerName, 'sh', '-c', 'echo hirearchy-ready'],
          {
            timeoutMs: 10_000,
            maxStdoutBytes: 4 * 1024,
            maxStderrBytes: 64 * 1024,
          },
        );
        if (!readyCheck.stdout.includes('hirearchy-ready')) {
          throw new Error('Generated workspace readiness check failed.');
        }
      } else if (isMultiFile && !usesBookingNotificationReadiness) {
        const readyCheck = await this.runProcess(
          'docker',
          [
            'exec',
            containerName,
            'sh',
            '-c',
            'for i in $(seq 1 100); do if [ -f /tmp/scenario_ready ] && pg_isready -h 127.0.0.1 -p 5432 -U hirearchy -q && redis-cli ping | grep -q PONG; then echo hirearchy-ready; exit 0; fi; sleep 0.1; done; echo not-ready; exit 1',
          ],
          {
            timeoutMs: 25_000,
            maxStdoutBytes: 16 * 1024,
            maxStderrBytes: 64 * 1024,
          },
        );

        if (!readyCheck.stdout.includes('hirearchy-ready')) {
          throw new Error(
            `Multi-service readiness probe returned unexpected output: ${readyCheck.stdout}`,
          );
        }
      } else if (isMultiFile) {
        const readyCheck = await this.runProcess(
          'docker',
          [
            'exec',
            containerName,
            'sh',
            '-c',
            'for i in $(seq 1 100); do if [ -f /tmp/scenario_ready ]; then echo hirearchy-ready; exit 0; fi; sleep 0.1; done; echo not-ready; exit 1',
          ],
          {
            timeoutMs: 25_000,
            maxStdoutBytes: 16 * 1024,
            maxStderrBytes: 16 * 1024,
          },
        );

        if (!readyCheck.stdout.includes('hirearchy-ready')) {
          throw new Error(
            `Multi-file readiness probe returned unexpected output: ${readyCheck.stdout}`,
          );
        }
      } else {
        const readyCheck = await this.runProcess(
          'docker',
          ['exec', containerName, 'sh', '-c', 'echo hirearchy-ready'],
          {
            timeoutMs: 10_000,
            maxStdoutBytes: 4 * 1024,
            maxStderrBytes: 64 * 1024,
          },
        );

        if (!readyCheck.stdout.includes('hirearchy-ready')) {
          throw new Error(
            `Readiness probe returned unexpected output: ${readyCheck.stdout}`,
          );
        }
      }
    } catch (error) {
      await this.teardown(sessionId).catch(() => {});
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        'SANDBOX_READINESS_FAILED',
        'Sandbox readiness check failed.',
        error,
      );
    }
  }

  async exec(
    sessionId: string,
    commandId: string,
    command: string,
    cwd = '/workspace',
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<CommandExecResult> {
    const containerName = this.getContainerName(sessionId);

    // Verify container exists and is running
    try {
      const inspect = await this.runProcess(
        'docker',
        ['inspect', '-f', '{{.State.Running}}', containerName],
        {
          timeoutMs: 10_000,
          maxStdoutBytes: 4 * 1024,
          maxStderrBytes: 64 * 1024,
        },
      );
      if (inspect.stdout.trim() !== 'true') {
        throw new SandboxError(
          'SANDBOX_NOT_FOUND',
          'Sandbox container is not running.',
        );
      }
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        'SANDBOX_NOT_FOUND',
        'Sandbox container was not found.',
        error,
      );
    }

    const hasSupervisor = await this.runProcess(
      'docker',
      [
        'exec',
        containerName,
        'test',
        '-x',
        '/usr/local/bin/hirearchy-exec-supervisor',
      ],
      {
        timeoutMs: 10_000,
        maxStdoutBytes: 4 * 1024,
        maxStderrBytes: 64 * 1024,
      },
    ).then(
      () => true,
      () => false,
    );
    if (!hasSupervisor) {
      return this.execLegacy(containerName, commandId, command, cwd, timeoutMs);
    }

    const stdoutAccumulator = new BoundedStreamAccumulator();
    const stderrAccumulator = new BoundedStreamAccumulator();
    const startTime = Date.now();

    return new Promise<CommandExecResult>((resolve, reject) => {
      let watchdogTimer: NodeJS.Timeout | null = null;
      let processSettled = false;
      const statusToken = randomUUID();
      const statusPath = `/run/hirearchy-evidence/command-${statusToken}.status`;

      const child = spawn('docker', [
        'exec',
        '-u',
        '0:0',
        containerName,
        '/usr/local/bin/hirearchy-exec-supervisor',
        String(timeoutMs),
        cwd,
        statusToken,
        command,
      ]);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutAccumulator.append(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrAccumulator.append(chunk);
      });

      if (timeoutMs > 0) {
        watchdogTimer = setTimeout(() => {
          if (processSettled) return;
          processSettled = true;
          child.kill('SIGKILL');
          reject(
            new SandboxError(
              'SANDBOX_EXECUTION_FAILED',
              'Command supervisor exceeded its bounded containment deadline.',
            ),
          );
        }, timeoutMs + 10_000);
      }

      child.on('error', (err) => {
        if (processSettled) return;
        processSettled = true;
        if (watchdogTimer) clearTimeout(watchdogTimer);
        reject(
          new SandboxError(
            'SANDBOX_EXECUTION_FAILED',
            `Execution transport error: ${err.message}`,
            err,
          ),
        );
      });

      child.on('close', (code) => {
        if (processSettled) return;
        processSettled = true;
        if (watchdogTimer) clearTimeout(watchdogTimer);

        void (async () => {
          try {
            const statusResult = await this.runProcess(
              'docker',
              [
                'exec',
                '-u',
                '0:0',
                containerName,
                'sh',
                '-c',
                'cat "$1" && rm -f "$1"',
                '_',
                statusPath,
              ],
              {
                timeoutMs: 10_000,
                maxStdoutBytes: 4 * 1024,
                maxStderrBytes: 64 * 1024,
              },
            );
            const status = statusResult.stdout.trim();
            const exitMatch = /^exit:(\d+)$/.exec(status);
            const timedOut = status === 'timeout';
            const trustedExitCode = exitMatch
              ? Number.parseInt(exitMatch[1], 10)
              : null;

            if (
              (!timedOut && trustedExitCode === null) ||
              (timedOut && code !== 124) ||
              (trustedExitCode !== null && code !== trustedExitCode)
            ) {
              throw new SandboxError(
                'SANDBOX_EXECUTION_FAILED',
                'Command supervisor returned an invalid or inconsistent result.',
              );
            }

            const stdoutRes = stdoutAccumulator.result;
            const stderrRes = stderrAccumulator.result;
            resolve({
              commandId,
              exitCode: timedOut ? null : trustedExitCode,
              timedOut,
              durationMs: Date.now() - startTime,
              stdoutPreview: stdoutRes.preview,
              stdoutBytes: stdoutRes.bytes,
              stdoutTruncated: stdoutRes.truncated,
              stderrPreview: stderrRes.preview,
              stderrBytes: stderrRes.bytes,
              stderrTruncated: stderrRes.truncated,
            });
          } catch (error) {
            reject(
              error instanceof SandboxError
                ? error
                : new SandboxError(
                    'SANDBOX_EXECUTION_FAILED',
                    'Failed to read the command supervisor result.',
                    error,
                  ),
            );
          }
        })();
      });
    });
  }

  private execLegacy(
    containerName: string,
    commandId: string,
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<CommandExecResult> {
    const stdoutAccumulator = new BoundedStreamAccumulator();
    const stderrAccumulator = new BoundedStreamAccumulator();
    const startTime = Date.now();

    return new Promise<CommandExecResult>((resolve, reject) => {
      let timedOut = false;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let processSettled = false;
      const wrapperScript = [
        'echo $$ > "/tmp/cmd_$1.pgid"',
        'cd "$2"',
        'eval "$3"',
        'code=$?',
        'rm -f "/tmp/cmd_$1.pgid"',
        'exit $code',
      ].join('\n');
      const child = spawn('docker', [
        'exec',
        containerName,
        'sh',
        '-c',
        wrapperScript,
        'hirearchy-exec',
        commandId,
        cwd,
        command,
      ]);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutAccumulator.append(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrAccumulator.append(chunk);
      });

      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(async () => {
          if (processSettled) return;
          timedOut = true;
          const killCmd = [
            `pgid=$(cat "/tmp/cmd_${commandId}.pgid" 2>/dev/null)`,
            `if [ -n "$pgid" ]; then kill -KILL -$pgid 2>/dev/null; rm -f "/tmp/cmd_${commandId}.pgid"; fi`,
            `for dir in /proc/[0-9]*; do`,
            `  p=\${dir##*/}`,
            `  if [ "$p" != "1" ] && [ "$p" != "$$" ]; then`,
            `    comm=$(cat /proc/$p/comm 2>/dev/null)`,
            `    cmdline=$(cat /proc/$p/cmdline 2>/dev/null)`,
            `    case "$comm" in postgres|redis-server|postmaster) continue ;; esac`,
            `    case "$cmdline" in *app.py*|*start_services.sh*) continue ;; esac`,
            `    kill -9 "$p" 2>/dev/null`,
            `  fi`,
            `done`,
            `sleep 0.1`,
          ].join('\n');
          try {
            await this.runProcess(
              'docker',
              ['exec', containerName, 'sh', '-c', killCmd],
              {
                timeoutMs: 10_000,
                maxStdoutBytes: 4 * 1024,
                maxStderrBytes: 64 * 1024,
              },
            ).catch(() => {});
          } finally {
            child.kill('SIGKILL');
          }
        }, timeoutMs);
      }

      child.on('error', (error) => {
        if (processSettled) return;
        processSettled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        reject(
          new SandboxError(
            'SANDBOX_EXECUTION_FAILED',
            `Execution transport error: ${error.message}`,
            error,
          ),
        );
      });
      child.on('close', (code) => {
        if (processSettled) return;
        processSettled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const stdout = stdoutAccumulator.result;
        const stderr = stderrAccumulator.result;
        resolve({
          commandId,
          exitCode: timedOut ? null : (code ?? 0),
          timedOut,
          durationMs: Date.now() - startTime,
          stdoutPreview: stdout.preview,
          stdoutBytes: stdout.bytes,
          stdoutTruncated: stdout.truncated,
          stderrPreview: stderr.preview,
          stderrBytes: stderr.bytes,
          stderrTruncated: stderr.truncated,
        });
      });
    });
  }

  async writeFile(
    sessionId: string,
    filePath: string,
    content: string,
  ): Promise<void> {
    const containerName = this.getContainerName(sessionId);
    const normalized = this.workspaceRelativePath(filePath);

    try {
      await this.runProcessWithInput(
        'docker',
        [
          'exec',
          '-i',
          containerName,
          'sh',
          '-c',
          writeWorkspaceFileScript,
          '_',
          normalized,
          randomUUID(),
        ],
        content,
        {
          timeoutMs: 15_000,
          maxStdoutBytes: 4 * 1024,
          maxStderrBytes: 64 * 1024,
        },
      );
    } catch (error) {
      if (this.isWorkspacePathRejected(error)) {
        throw this.workspacePathError(filePath, error);
      }
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        `Failed to write file ${filePath}.`,
        error,
      );
    }
  }

  async readFile(sessionId: string, filePath: string): Promise<string> {
    const containerName = this.getContainerName(sessionId);
    const normalized = this.workspaceRelativePath(filePath);

    try {
      const res = await this.runProcess(
        'docker',
        [
          'exec',
          containerName,
          'sh',
          '-c',
          readWorkspaceFileScript,
          '_',
          `/workspace/${normalized}`,
        ],
        {
          timeoutMs: 15_000,
          maxStdoutBytes: MAX_WORKSPACE_FILE_READ_BYTES,
          maxStderrBytes: 64 * 1024,
        },
      );
      return res.stdout;
    } catch (error) {
      if (this.isWorkspacePathRejected(error)) {
        throw this.workspacePathError(filePath, error);
      }
      if (error instanceof SandboxError) {
        if (error.message.includes('stdout exceeded limit')) {
          throw new SandboxError(
            'SANDBOX_EXECUTION_FAILED',
            `File ${filePath} exceeds the maximum supported read size of 100 KB.`,
            error,
          );
        }
        throw error;
      }
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        `Failed to read file ${filePath}.`,
        error,
      );
    }
  }

  private workspaceRelativePath(filePath: string): string {
    if (
      !filePath ||
      filePath.startsWith('/') ||
      filePath.includes('\\') ||
      filePath.includes('..')
    ) {
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        `Invalid workspace-relative file path: ${filePath}`,
      );
    }
    return filePath;
  }

  private isWorkspacePathRejected(error: unknown): boolean {
    return (
      error instanceof SandboxError &&
      error.cause instanceof Error &&
      error.cause.message.includes(workspacePathRejectedMarker)
    );
  }

  private workspacePathError(filePath: string, cause: unknown): SandboxError {
    return new SandboxError(
      'SANDBOX_EXECUTION_FAILED',
      `Workspace file path resolves outside /workspace or is not a regular file: ${filePath}`,
      cause,
    );
  }

  async listFiles(sessionId: string): Promise<readonly WorkspaceFileInfo[]> {
    const containerName = this.getContainerName(sessionId);
    try {
      const res = await this.runProcess(
        'docker',
        [
          'exec',
          containerName,
          'sh',
          '-c',
          'cd /workspace && find . -mindepth 1 -not -path "*/.*" -not -path "*/__pycache__*" -not -path "*/.pytest_cache*" -exec stat -c "%n|%s|%F" {} + 2>/dev/null || true',
        ],
        {
          timeoutMs: 20_000,
          maxStdoutBytes: 512 * 1024,
          maxStderrBytes: 64 * 1024,
        },
      );
      const lines = res.stdout.trim().split('\n').filter(Boolean);
      const files: WorkspaceFileInfo[] = [];
      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length < 3) continue;
        const rawPath = parts[0];
        const size = parseInt(parts[1], 10) || 0;
        const fileType = parts[2];
        const relPath = rawPath.replace(/^\.\//, '');
        files.push({
          path: relPath,
          size,
          isDirectory: fileType === 'directory',
        });
      }
      return files.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.path.localeCompare(b.path);
      });
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        'Failed to list files.',
        error,
      );
    }
  }

  private async isGeneratedWorkspaceContainer(
    sessionId: string,
  ): Promise<boolean> {
    const containerName = this.getContainerName(sessionId);
    const inspect = await this.runProcess(
      'docker',
      [
        'inspect',
        '-f',
        '{{index .Config.Labels "hirearchy.workspace.type"}}',
        containerName,
      ],
      {
        timeoutMs: 10_000,
        maxStdoutBytes: 4 * 1024,
        maxStderrBytes: 16 * 1024,
      },
    );
    return inspect.stdout.trim() === 'generated';
  }

  async getBaselineTree(sessionId: string): Promise<string> {
    const containerName = this.getContainerName(sessionId);
    try {
      const generated = await this.runProcess(
        'docker',
        [
          'exec',
          '-u',
          '0:0',
          containerName,
          'sh',
          '-c',
          'if [ -f /run/hirearchy-evidence/generated-baseline ]; then cat /run/hirearchy-evidence/generated-baseline; else exit 1; fi',
        ],
        {
          timeoutMs: 10_000,
          maxStdoutBytes: 4 * 1024,
          maxStderrBytes: 16 * 1024,
        },
      ).catch(() => null);
      if (generated) {
        const raw = generated.stdout.trim();
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw)) {
          throw new SandboxError(
            'SANDBOX_EXECUTION_FAILED',
            'Persisted generated baseline format is invalid or corrupt.',
          );
        }
        return raw;
      }

      const isGenerated = await this.isGeneratedWorkspaceContainer(sessionId);
      if (isGenerated) {
        throw new SandboxError(
          'SANDBOX_EXECUTION_FAILED',
          'Generated starter baseline is unavailable and cannot fall back to static template baseline.',
        );
      }

      const res = await this.runProcess(
        'docker',
        [
          'exec',
          '-u',
          '0:0',
          containerName,
          '/usr/local/bin/hirearchy-baseline-tree.sh',
        ],
        {
          timeoutMs: 30_000,
          maxStdoutBytes: 1024 * 1024,
          maxStderrBytes: 64 * 1024,
        },
      );
      return res.stdout.trim();
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        'Failed to get baseline tree.',
        error,
      );
    }
  }

  async captureWorkspaceTree(sessionId: string): Promise<string> {
    const containerName = this.getContainerName(sessionId);
    try {
      const res = await this.runProcess(
        'docker',
        [
          'exec',
          '-u',
          '0:0',
          containerName,
          '/usr/local/bin/hirearchy-capture-tree.sh',
        ],
        {
          timeoutMs: 30_000,
          maxStdoutBytes: 1024 * 1024,
          maxStderrBytes: 64 * 1024,
        },
      );
      return res.stdout.trim();
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        'Failed to capture workspace tree.',
        error,
      );
    }
  }

  async captureTreeDiff(
    sessionId: string,
    beforeTree: string,
    afterTree: string,
  ): Promise<TreeDiffResult> {
    const containerName = this.getContainerName(sessionId);
    try {
      const res = await this.runProcess(
        'docker',
        [
          'exec',
          '-u',
          '0:0',
          containerName,
          '/usr/local/bin/hirearchy-diff-trees.sh',
          beforeTree,
          afterTree,
        ],
        {
          timeoutMs: 30_000,
          maxStdoutBytes: 2 * 1024 * 1024,
          maxStderrBytes: 64 * 1024,
        },
      );
      return parseTreeDiffOutput(res.stdout);
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        'Failed to capture tree diff.',
        error,
      );
    }
  }

  /**
   * Pause the primary sandbox container and confirm the paused state via
   * docker inspect. This is the authoritative freeze boundary:
   *
   *   logical deadline / manual submission admitted
   *       -> freeze initiated (docker pause)
   *       -> freeze confirmed (docker inspect State.Paused == true)
   *
   * The sandbox must never be unpaused after finalization starts.
   * A successful docker pause process exit alone is not sufficient —
   * we verify via inspect to ensure the kernel cgroup freeze is in effect.
   *
   * Note: freeze latency is not additional candidate time. T1A.2 already
   * prevents new mutations after the deadline. The frozen workspace is
   * authoritative once freeze is confirmed.
   */
  async freeze(sessionId: string): Promise<void> {
    const containerName = this.getContainerName(sessionId);

    if (await this.isFrozen(sessionId)) {
      return;
    }

    // Step 1: Pause the primary sandbox.
    try {
      await this.runProcess('docker', ['pause', containerName], {
        timeoutMs: 15_000,
        maxStdoutBytes: 4 * 1024,
        maxStderrBytes: 64 * 1024,
      });
    } catch (error) {
      if (error instanceof SandboxError) {
        throw new SandboxError(
          'SANDBOX_FREEZE_FAILED',
          'Failed to pause sandbox container.',
          error,
        );
      }
      throw new SandboxError(
        'SANDBOX_FREEZE_FAILED',
        'Failed to pause sandbox container.',
        error,
      );
    }

    // Step 2: Verify via docker inspect that State.Paused is actually true.
    // A successful docker pause exit alone is not sufficient — we require
    // kernel-confirmed paused state before proceeding to evidence capture.
    let isPaused: boolean;
    try {
      const inspect = await this.runProcess(
        'docker',
        ['inspect', '-f', '{{.State.Paused}}', containerName],
        {
          timeoutMs: 10_000,
          maxStdoutBytes: 4 * 1024,
          maxStderrBytes: 64 * 1024,
        },
      );
      isPaused = inspect.stdout.trim() === 'true';
    } catch (error) {
      throw new SandboxError(
        'SANDBOX_FREEZE_FAILED',
        'Failed to verify sandbox paused state after pause command.',
        error,
      );
    }

    if (!isPaused) {
      throw new SandboxError(
        'SANDBOX_FREEZE_FAILED',
        'Sandbox pause command completed but paused state could not be confirmed.',
      );
    }
  }

  async isFrozen(sessionId: string): Promise<boolean> {
    const containerName = this.getContainerName(sessionId);
    try {
      const inspect = await this.runProcess(
        'docker',
        ['inspect', '-f', '{{.State.Paused}}', containerName],
        {
          timeoutMs: 10_000,
          maxStdoutBytes: 4 * 1024,
          maxStderrBytes: 64 * 1024,
        },
      );
      return inspect.stdout.trim() === 'true';
    } catch (error) {
      throw new SandboxError(
        'SANDBOX_FREEZE_FAILED',
        'Failed to inspect sandbox paused state.',
        error,
      );
    }
  }

  /**
   * Resolve the helper image from the existing primary sandbox container.
   * This is restart-recoverable: T1B can rebuild an adapter with empty
   * process memory and still capture frozen evidence as long as the paused
   * primary container remains discoverable via docker inspect.
   */
  private async resolveHelperImageFromPrimary(
    sessionId: string,
  ): Promise<string> {
    const containerName = this.getContainerName(sessionId);
    try {
      const inspect = await this.runProcess(
        'docker',
        ['inspect', '-f', '{{.Config.Image}}', containerName],
        {
          timeoutMs: 10_000,
          maxStdoutBytes: 4 * 1024,
          maxStderrBytes: 64 * 1024,
        },
      );
      const imageName = inspect.stdout.trim();
      if (!imageName) {
        throw new SandboxError(
          'SANDBOX_EXECUTION_FAILED',
          'Primary sandbox image identity was empty; cannot launch frozen helper.',
        );
      }
      return imageName;
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        'Failed to resolve helper image from primary sandbox container.',
        error,
      );
    }
  }

  /**
   * Capture the authoritative workspace tree and diff via an ephemeral
   * trusted helper container that mounts the session workspace volume
   * read-only. The primary sandbox MUST be paused before calling this
   * method and must remain paused for the entire duration.
   *
   * Security properties of the helper:
   *   - workspace volume mounted kernel-enforced read-only
   *   - no Docker socket
   *   - no host directory bind mounts
   *   - network none
   *   - read-only rootfs
   *   - cap-drop ALL, no-new-privileges
   *   - runs as root (uid 0) only for evidence script access to /run/hirearchy-evidence
   *   - candidate-created symlinks cannot resolve to host filesystem
   *   - ephemeral: --rm, gone after capture
   *
   * Helper image identity is resolved from the primary container via
   * `docker inspect Config.Image` so capture remains restart-recoverable
   * without any in-process image map.
   */
  async captureFrozenEvidence(
    sessionId: string,
    baselineTree?: string,
    generatedStarterFiles?: Readonly<Record<string, string>>,
  ): Promise<{ currentTree: string; rawDiff: string }> {
    const containerName = this.getContainerName(sessionId);
    const helperName = `${containerName}-frozen-capture`;
    const volumeName = this.getVolumeName(sessionId);
    const imageName = await this.resolveHelperImageFromPrimary(sessionId);

    // Pre-condition check: primary sandbox must still be paused.
    // This guards against race conditions and ensures capture integrity.
    let isPaused: boolean;
    try {
      const inspect = await this.runProcess(
        'docker',
        ['inspect', '-f', '{{.State.Paused}}', containerName],
        {
          timeoutMs: 10_000,
          maxStdoutBytes: 4 * 1024,
          maxStderrBytes: 64 * 1024,
        },
      );
      isPaused = inspect.stdout.trim() === 'true';
    } catch (error) {
      throw new SandboxError(
        'SANDBOX_FREEZE_FAILED',
        'Could not verify primary sandbox is paused before evidence capture.',
        error,
      );
    }

    if (!isPaused) {
      throw new SandboxError(
        'SANDBOX_FREEZE_FAILED',
        'Primary sandbox is not paused; refusing to capture evidence.',
      );
    }

    // Capture tree + diff in ONE helper invocation.
    // Tree objects are written to the helper's ephemeral evidence tmpfs;
    // a second --rm helper would lose those objects and cannot diff.
    // Baseline objects remain available from the image's repo-template
    // via GIT_ALTERNATE_OBJECT_DIRECTORIES inside the evidence scripts.
    let currentTree: string;
    let rawDiff: string;
    try {
      await this.runProcess('docker', ['rm', '-f', helperName], {
        timeoutMs: 15_000,
        maxStdoutBytes: 4 * 1024,
        maxStderrBytes: 64 * 1024,
      }).catch(() => {});
      const helperScript = [
        'set -e',
        'BASELINE="$1"',
        'if [ "$2" = generated ]; then',
        '  mkdir -p /tmp/generated-baseline',
        '  python3 -c \'import json,pathlib,sys; data=json.load(sys.stdin); root=pathlib.Path("/tmp/generated-baseline"); assert all(p and not pathlib.PurePosixPath(p).is_absolute() and ".." not in pathlib.PurePosixPath(p).parts and isinstance(c,str) for p,c in data.items()); [(root.joinpath(*pathlib.PurePosixPath(p).parts).parent.mkdir(parents=True, exist_ok=True), root.joinpath(*pathlib.PurePosixPath(p).parts).write_text(c, encoding="utf-8")) for p,c in data.items()]\'',
        '  EVIDENCE_DIR="/run/hirearchy-evidence"',
        '  export GIT_DIR="/opt/hirearchy/repo-template/.git" GIT_WORK_TREE="/tmp/generated-baseline" GIT_OBJECT_DIRECTORY="${EVIDENCE_DIR}/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="/opt/hirearchy/repo-template/.git/objects" GIT_INDEX_FILE="${EVIDENCE_DIR}/generated-baseline-index"',
        '  mkdir -p "${EVIDENCE_DIR}/objects"',
        '  git -c safe.directory="*" -C /tmp/generated-baseline add -f -A -- . ":(exclude,top).git" ":(exclude)**/__pycache__/**" ":(exclude)__pycache__/**" ":(exclude)**/*.pyc" ":(exclude)*.pyc" ":(exclude)**/.pytest_cache/**" ":(exclude).pytest_cache/**" ":(exclude)**/*.log" ":(exclude)*.log"',
        '  TREE_BASELINE="$(git -c safe.directory="*" -C /tmp/generated-baseline write-tree)"',
        '  TEMPLATE_BASELINE="$(/usr/local/bin/hirearchy-baseline-tree.sh 2>/dev/null || true)"',
        '  if [ -n "$BASELINE" ] && [ "$BASELINE" != "$TEMPLATE_BASELINE" ]; then',
        '    [ "$TREE_BASELINE" = "$BASELINE" ] || { echo generated-baseline-mismatch >&2; exit 1; }',
        '  else',
        '    BASELINE="$TREE_BASELINE"',
        '  fi',
        '  unset GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_WORK_TREE GIT_DIR',
        'else',
        '  [ -n "$BASELINE" ] || BASELINE="$(/usr/local/bin/hirearchy-baseline-tree.sh)"',
        'fi',
        'TREE="$(/usr/local/bin/hirearchy-capture-tree.sh)"',
        'printf \'%s\\n\' "$TREE"',
        "printf '%s\\n' '---HIREARCHY_FROZEN_BOUNDARY---'",
        '/usr/local/bin/hirearchy-diff-trees.sh "$BASELINE" "$TREE"',
      ].join('\n');
      const captureArgs = [
        'run',
        ...(generatedStarterFiles ? ['-i'] : []),
        '--rm',
        '--name',
        helperName,
        '--network',
        'none',
        '--read-only',
        '--mount',
        `type=volume,source=${volumeName},target=/workspace,readonly`,
        '--tmpfs',
        '/tmp:rw,exec,nosuid,size=64m',
        '--tmpfs',
        '/run/hirearchy-evidence:rw,noexec,nosuid,size=64m,mode=0700,uid=0,gid=0',
        '--memory=512m',
        '--cpus=1.0',
        '--pids-limit=64',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges:true',
        '-u',
        '0:0',
        imageName,
        'sh',
        '-c',
        helperScript,
        '_',
        baselineTree ?? '',
        generatedStarterFiles ? 'generated' : 'template',
      ];
      const captureResult = generatedStarterFiles
        ? await this.runProcessWithInput(
            'docker',
            captureArgs,
            JSON.stringify(generatedStarterFiles),
            {
              timeoutMs: 90_000,
              maxStdoutBytes: 3 * 1024 * 1024,
              maxStderrBytes: 64 * 1024,
            },
          )
        : await this.runProcess('docker', captureArgs, {
            timeoutMs: 90_000,
            maxStdoutBytes: 3 * 1024 * 1024,
            maxStderrBytes: 64 * 1024,
          });

      const boundary = '---HIREARCHY_FROZEN_BOUNDARY---';
      const boundaryIndex = captureResult.stdout.indexOf(boundary);
      if (boundaryIndex === -1) {
        throw new SandboxError(
          'SANDBOX_EXECUTION_FAILED',
          'Frozen workspace capture returned malformed output (missing boundary).',
        );
      }

      currentTree = captureResult.stdout.slice(0, boundaryIndex).trim();
      rawDiff = captureResult.stdout
        .slice(boundaryIndex + boundary.length)
        .replace(/^\r?\n/, '');
    } catch (error) {
      await this.runProcess('docker', ['rm', '-f', helperName], {
        timeoutMs: 15_000,
        maxStdoutBytes: 4 * 1024,
        maxStderrBytes: 64 * 1024,
      }).catch(() => {});
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        'Failed to capture frozen workspace evidence via helper.',
        error,
      );
    }

    if (!currentTree) {
      throw new SandboxError(
        'SANDBOX_EXECUTION_FAILED',
        'Frozen workspace tree capture returned an empty result.',
      );
    }

    return { currentTree, rawDiff };
  }

  async teardown(sessionId: string): Promise<void> {
    const containerName = this.getContainerName(sessionId);
    const volumeName = this.getVolumeName(sessionId);

    // Remove the primary sandbox container. '-f' handles already-stopped or
    // missing containers idempotently. This is also safe to call on a paused
    // container — docker rm -f removes it without resuming candidate execution.
    await this.runProcess('docker', ['rm', '-f', containerName], {
      timeoutMs: 15_000,
      maxStdoutBytes: 4 * 1024,
      maxStderrBytes: 64 * 1024,
    });

    // Remove the dedicated session workspace volume AFTER the container is
    // gone (Docker refuses to remove an in-use volume). Missing-volume is
    // treated as idempotent success; any other failure must surface so
    // SessionService can record SANDBOX_CLEANUP_FAILED without reopening
    // the SUBMITTED session. Volume removal only happens after successful
    // SQLite finalization (or create-time orphan cleanup).
    try {
      await this.runProcess('docker', ['volume', 'rm', volumeName], {
        timeoutMs: 15_000,
        maxStdoutBytes: 4 * 1024,
        maxStderrBytes: 64 * 1024,
      });
    } catch (error) {
      if (!isMissingDockerVolumeError(error)) {
        throw error;
      }
    }

    const evidenceVolumeName = this.getEvidenceVolumeName(sessionId);
    try {
      await this.runProcess('docker', ['volume', 'rm', evidenceVolumeName], {
        timeoutMs: 15_000,
        maxStdoutBytes: 4 * 1024,
        maxStderrBytes: 64 * 1024,
      });
    } catch (error) {
      if (!isMissingDockerVolumeError(error)) {
        throw error;
      }
    }
  }

  private executeSubprocess(
    command: string,
    args: string[],
    input?: string,
    options: ProcessOptions = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxStdoutBytes = options.maxStdoutBytes ?? 1024 * 1024;
    const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;

    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args);
      } catch (spawnError) {
        return reject(
          new SandboxError(
            'SANDBOX_EXECUTION_FAILED',
            'Subprocess spawn failed.',
            spawnError,
          ),
        );
      }

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timeoutTimer: NodeJS.Timeout | null = null;

      const terminate = () => {
        try {
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.destroy();
          }
        } catch {
          // ignore
        }
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      };

      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          terminate();
          reject(
            new SandboxError(
              'SANDBOX_EXECUTION_FAILED',
              `Subprocess timed out after ${timeoutMs}ms.`,
            ),
          );
        }, timeoutMs);
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          settled = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          terminate();
          reject(
            new SandboxError(
              'SANDBOX_EXECUTION_FAILED',
              `Subprocess stdout exceeded limit of ${maxStdoutBytes} bytes.`,
            ),
          );
          return;
        }
        stdout += chunk.toString('utf8');
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (settled) return;
        stderrBytes += chunk.length;
        if (stderrBytes > maxStderrBytes) {
          settled = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          terminate();
          reject(
            new SandboxError(
              'SANDBOX_EXECUTION_FAILED',
              `Subprocess stderr exceeded limit of ${maxStderrBytes} bytes.`,
            ),
          );
          return;
        }
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        reject(
          new SandboxError(
            'SANDBOX_EXECUTION_FAILED',
            `Subprocess transport error: ${err.message}`,
            err,
          ),
        );
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);

        if (code === 0) {
          resolve({ stdout, stderr, exitCode: 0 });
        } else {
          reject(
            new SandboxError(
              'SANDBOX_EXECUTION_FAILED',
              `Subprocess exited with code ${code}.`,
              new Error(
                `Command '${command} ${args.join(' ')}' exited with code ${code}: ${stderr}`,
              ),
            ),
          );
        }
      });

      if (input !== undefined && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.write(input);
        child.stdin.end();
      }
    });
  }

  runProcess(
    command: string,
    args: string[],
    options?: ProcessOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.executeSubprocess(command, args, undefined, options);
  }

  runProcessWithInput(
    command: string,
    args: string[],
    input: string,
    options?: ProcessOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.executeSubprocess(command, args, input, options);
  }
}

export function parseTreeDiffOutput(stdout: string): TreeDiffResult {
  const boundary = '---HIREARCHY_DIFF_BOUNDARY---';
  const boundaryIndex = stdout.indexOf(boundary);
  const numstatPart =
    boundaryIndex !== -1 ? stdout.slice(0, boundaryIndex) : '';
  const rawDiff =
    boundaryIndex !== -1
      ? stdout.slice(boundaryIndex + boundary.length).replace(/^\r?\n/, '')
      : stdout;

  const numstatLines = numstatPart.trim().split('\n').filter(Boolean);
  const numstatMap = new Map<
    string,
    { additions: number; deletions: number }
  >();
  for (const line of numstatLines) {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const adds = parseInt(parts[0], 10) || 0;
      const dels = parseInt(parts[1], 10) || 0;
      const filePath = parts.slice(2).join('\t').trim();
      numstatMap.set(filePath, { additions: adds, deletions: dels });
    }
  }

  // Split rawDiff by "diff --git "
  const diffChunks = rawDiff
    .split(/(?=^diff --git )/m)
    .filter((chunk) => chunk.trim().length > 0);
  const files: WorkspaceFileChange[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  const MAX_PREVIEW_BYTES = 65536; // 64 KB

  for (const chunk of diffChunks) {
    const headerMatch = chunk.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    const filePath = headerMatch ? headerMatch[2] : '';
    if (!filePath) continue;

    const numstat = numstatMap.get(filePath) ?? { additions: 0, deletions: 0 };
    totalAdditions += numstat.additions;
    totalDeletions += numstat.deletions;

    let status: 'modified' | 'added' | 'deleted' = 'modified';
    if (chunk.includes('new file mode')) {
      status = 'added';
    } else if (chunk.includes('deleted file mode')) {
      status = 'deleted';
    }

    const patchBytes = Buffer.byteLength(chunk, 'utf8');
    const patchTruncated = patchBytes > MAX_PREVIEW_BYTES;
    const patchPreview = patchTruncated
      ? Buffer.from(chunk, 'utf8')
          .subarray(0, MAX_PREVIEW_BYTES)
          .toString('utf8')
      : chunk;
    const patchPreviewBytes = Buffer.byteLength(patchPreview, 'utf8');

    files.push({
      path: filePath,
      status,
      additions: numstat.additions,
      deletions: numstat.deletions,
      patchPreview,
      patchPreviewBytes,
      patchBytes,
      patchTruncated,
    });
  }

  for (const [filePath, stats] of numstatMap.entries()) {
    if (!files.some((f) => f.path === filePath)) {
      totalAdditions += stats.additions;
      totalDeletions += stats.deletions;
      files.push({
        path: filePath,
        status: 'modified',
        additions: stats.additions,
        deletions: stats.deletions,
        patchPreview: '',
        patchPreviewBytes: 0,
        patchBytes: 0,
        patchTruncated: false,
      });
    }
  }

  return {
    files,
    totalAdditions,
    totalDeletions,
    rawDiff,
  };
}
