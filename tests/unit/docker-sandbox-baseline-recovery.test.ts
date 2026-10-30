import { describe, expect, it, vi } from 'vitest';

import { DockerSandboxAdapter } from '../../apps/web/src/sandbox/docker-sandbox-adapter';
import { SandboxError } from '../../apps/web/src/sandbox/sandbox';

describe('DockerSandboxAdapter — generated scenario baseline recovery', () => {
  it('creates stable evidence volume, chmods to 0700 before seeding, and labels container descriptor', async () => {
    const adapter = new DockerSandboxAdapter();
    const calls: Array<{ command: string; args: string[] }> = [];

    vi.spyOn(adapter, 'runProcess').mockImplementation(
      async (command, args) => {
        calls.push({ command, args });
        if (args[0] === 'exec' && args.includes('echo hirearchy-ready')) {
          return { stdout: 'hirearchy-ready\n', stderr: '', exitCode: 0 };
        }
        if (
          args[0] === 'exec' &&
          args.some((a) => a.includes('generated-baseline'))
        ) {
          return {
            stdout: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    vi.spyOn(adapter, 'runProcessWithInput').mockImplementation(
      async (command, args) => {
        calls.push({ command, args });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    const sessionId = 'session-gen-001';
    await adapter.createAndVerify(sessionId, {
      scenarioType: 'multi_file',
      generatedWorkspace: true,
      imageName: 'hirearchy-scenario-002:v1.0.0',
      initialFiles: { 'main.py': 'print("hello")' },
    });

    const volumeCreates = calls.filter(
      (c) =>
        c.command === 'docker' &&
        c.args[0] === 'volume' &&
        c.args[1] === 'create',
    );
    expect(volumeCreates).toHaveLength(2);
    expect(volumeCreates[0].args[2]).toBe(adapter.getVolumeName(sessionId));
    expect(volumeCreates[1].args[2]).toBe(
      adapter.getEvidenceVolumeName(sessionId),
    );

    const dockerRun = calls.find(
      (c) =>
        c.command === 'docker' &&
        c.args[0] === 'run' &&
        c.args.includes(adapter.getContainerName(sessionId)),
    );
    expect(dockerRun).toBeDefined();
    expect(dockerRun!.args).toContain('--label');
    expect(dockerRun!.args).toContain('hirearchy.workspace.type=generated');
    expect(dockerRun!.args).toContain(
      `type=volume,source=${adapter.getEvidenceVolumeName(sessionId)},target=/run/hirearchy-evidence`,
    );

    // Verify the root-owned evidence directory is private before file seeding.
    const chmodIndex = calls.findIndex(
      (c) =>
        c.command === 'docker' &&
        c.args[0] === 'exec' &&
        c.args.includes('chmod') &&
        c.args.includes('/run/hirearchy-evidence'),
    );
    expect(chmodIndex).toBeGreaterThan(-1);

    const baselineCapture = calls.find(
      (c) =>
        c.command === 'docker' &&
        c.args[0] === 'exec' &&
        c.args.some((a) => a.includes('generated-baseline')),
    );
    expect(baselineCapture?.args).toContain('-u');
    expect(baselineCapture?.args).toContain('0:0');
    expect(baselineCapture?.args.join(' ')).toContain(
      'chmod 600 /run/hirearchy-evidence/generated-baseline',
    );

    const writeIndex = calls.findIndex(
      (c) =>
        c.command === 'docker' &&
        c.args[0] === 'exec' &&
        c.args.some((a) => a.includes('/workspace/main.py')),
    );
    expect(writeIndex).toBeGreaterThan(chmodIndex);
  });

  it('cleans up only that session workspace volume if evidence volume creation fails', async () => {
    const adapter = new DockerSandboxAdapter();
    const calls: Array<{ command: string; args: string[] }> = [];
    const sessionId = 'session-gen-fail';

    vi.spyOn(adapter, 'runProcess').mockImplementation(
      async (command, args) => {
        calls.push({ command, args });
        if (
          command === 'docker' &&
          args[0] === 'volume' &&
          args[1] === 'create' &&
          args[2] === adapter.getEvidenceVolumeName(sessionId)
        ) {
          throw new Error('Docker daemon disk full');
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    await expect(
      adapter.createAndVerify(sessionId, {
        scenarioType: 'multi_file',
        generatedWorkspace: true,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'SANDBOX_CREATION_FAILED',
        message: 'Failed to create session evidence volume.',
      }),
    );

    const cleanupCall = calls.find(
      (c) =>
        c.command === 'docker' &&
        c.args[0] === 'volume' &&
        c.args[1] === 'rm' &&
        c.args[2] === adapter.getVolumeName(sessionId),
    );
    expect(cleanupCall).toBeDefined();
  });

  it('reads and validates the persisted generated baseline during recovery', async () => {
    const adapter = new DockerSandboxAdapter();
    const sessionId = 'session-gen-002';
    const expectedBaseline = 'a'.repeat(40);

    vi.spyOn(adapter, 'runProcess').mockImplementation(
      async (command, args) => {
        if (
          args[0] === 'exec' &&
          args.some((a) => a.includes('generated-baseline'))
        ) {
          return { stdout: `${expectedBaseline}\n`, stderr: '', exitCode: 0 };
        }
        throw new Error(`Unexpected call: ${command} ${args.join(' ')}`);
      },
    );

    const baseline = await adapter.getBaselineTree(sessionId);
    expect(baseline).toBe(expectedBaseline);
  });

  it('rejects corrupt baseline hash format upon recovery and throws SandboxError', async () => {
    const adapter = new DockerSandboxAdapter();
    const sessionId = 'session-gen-corrupt';

    vi.spyOn(adapter, 'runProcess').mockImplementation(
      async (command, args) => {
        if (
          args[0] === 'exec' &&
          args.some((a) => a.includes('generated-baseline'))
        ) {
          return {
            stdout: 'corrupt-not-a-valid-hex-sha\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    await expect(adapter.getBaselineTree(sessionId)).rejects.toThrowError(
      /Persisted generated baseline format is invalid or corrupt/,
    );
  });

  it('accepts a full-length SHA-256 baseline hash', async () => {
    const adapter = new DockerSandboxAdapter();
    const expectedBaseline = 'a'.repeat(64);
    vi.spyOn(adapter, 'runProcess').mockResolvedValue({
      stdout: `${expectedBaseline}\n`,
      stderr: '',
      exitCode: 0,
    });

    await expect(adapter.getBaselineTree('session-gen-sha256')).resolves.toBe(
      expectedBaseline,
    );
  });

  it('rejects hashes with lengths between supported SHA formats', async () => {
    const adapter = new DockerSandboxAdapter();
    vi.spyOn(adapter, 'runProcess').mockResolvedValue({
      stdout: `${'a'.repeat(41)}\n`,
      stderr: '',
      exitCode: 0,
    });

    await expect(
      adapter.getBaselineTree('session-gen-invalid-length'),
    ).rejects.toThrow(
      /Persisted generated baseline format is invalid or corrupt/,
    );
  });

  it('fails closed and proves static baseline script is never called when generated marker exists but baseline read fails', async () => {
    const adapter = new DockerSandboxAdapter();
    const sessionId = 'session-gen-003';
    let staticScriptCalled = false;

    vi.spyOn(adapter, 'runProcess').mockImplementation(
      async (command, args) => {
        // 1. Reading generated-baseline fails (e.g. wiped file)
        if (
          args[0] === 'exec' &&
          args.some((a) => a.includes('generated-baseline'))
        ) {
          throw new SandboxError('SANDBOX_EXECUTION_FAILED', 'File not found');
        }
        // 2. inspect checks container label
        if (
          args[0] === 'inspect' &&
          args.includes('{{index .Config.Labels "hirearchy.workspace.type"}}')
        ) {
          return { stdout: 'generated\n', stderr: '', exitCode: 0 };
        }
        // 3. Static fallback MUST NOT be invoked
        if (
          args[0] === 'exec' &&
          args.includes('/usr/local/bin/hirearchy-baseline-tree.sh')
        ) {
          staticScriptCalled = true;
          return {
            stdout: 'static-template-baseline-hash\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    await expect(adapter.getBaselineTree(sessionId)).rejects.toThrowError(
      /Generated starter baseline is unavailable and cannot fall back to static template baseline/,
    );
    expect(staticScriptCalled).toBe(false);
  });

  it('propagates inspect transport errors instead of swallowing and falling back to static baseline', async () => {
    const adapter = new DockerSandboxAdapter();
    const sessionId = 'session-inspect-err';

    vi.spyOn(adapter, 'runProcess').mockImplementation(
      async (command, args) => {
        if (
          args[0] === 'exec' &&
          args.some((a) => a.includes('generated-baseline'))
        ) {
          throw new SandboxError('SANDBOX_EXECUTION_FAILED', 'File not found');
        }
        if (args[0] === 'inspect') {
          throw new SandboxError(
            'SANDBOX_EXECUTION_FAILED',
            'Docker daemon connectivity lost',
          );
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    await expect(adapter.getBaselineTree(sessionId)).rejects.toThrowError(
      'Docker daemon connectivity lost',
    );
  });

  it('allows static template fallback for non-generated scenarios when inspect proves no marker', async () => {
    const adapter = new DockerSandboxAdapter();
    const sessionId = 'session-static-001';
    const staticBaseline = 'static-template-baseline-sha';

    vi.spyOn(adapter, 'runProcess').mockImplementation(
      async (command, args) => {
        if (
          args[0] === 'exec' &&
          args.some((a) => a.includes('generated-baseline'))
        ) {
          throw new SandboxError('SANDBOX_EXECUTION_FAILED', 'File not found');
        }
        if (
          args[0] === 'inspect' &&
          args.includes('{{index .Config.Labels "hirearchy.workspace.type"}}')
        ) {
          return { stdout: '\n', stderr: '', exitCode: 0 };
        }
        if (
          args[0] === 'exec' &&
          args.includes('/usr/local/bin/hirearchy-baseline-tree.sh')
        ) {
          return { stdout: `${staticBaseline}\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    const baseline = await adapter.getBaselineTree(sessionId);
    expect(baseline).toBe(staticBaseline);
  });

  it('aligns captureFrozenEvidence with persisted starter snapshot and detects template fallback', async () => {
    const adapter = new DockerSandboxAdapter();
    const sessionId = 'session-gen-004';
    let helperScriptPassed = '';

    vi.spyOn(adapter, 'runProcess').mockImplementation(
      async (command, args) => {
        if (args[0] === 'inspect' && args.includes('{{.State.Paused}}')) {
          return { stdout: 'true\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'inspect' && args.includes('{{.Config.Image}}')) {
          return {
            stdout: 'hirearchy-scenario-002:v1.0.0\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    vi.spyOn(adapter, 'runProcessWithInput').mockImplementation(
      async (command, args) => {
        const scriptIndex = args.indexOf('-c') + 1;
        helperScriptPassed = args[scriptIndex];
        return {
          stdout:
            'current_tree_sha_1234\n---HIREARCHY_FROZEN_BOUNDARY---\ndiff --git a/main.py b/main.py\n',
          stderr: '',
          exitCode: 0,
        };
      },
    );

    const starterFiles = { 'main.py': 'print("hello")' };
    const result = await adapter.captureFrozenEvidence(
      sessionId,
      'static_fallback_baseline_sha',
      starterFiles,
    );

    expect(result.currentTree).toBe('current_tree_sha_1234');
    expect(result.rawDiff).toContain('diff --git');
    expect(helperScriptPassed).toContain('TEMPLATE_BASELINE');
    expect(helperScriptPassed).toContain('BASELINE="$TREE_BASELINE"');
    expect(helperScriptPassed).toContain('echo generated-baseline-mismatch');
  });

  it('removes both workspace and evidence volumes idempotently in teardown', async () => {
    const adapter = new DockerSandboxAdapter();
    const sessionId = 'session-gen-005';
    const volumeRemovals: string[] = [];

    vi.spyOn(adapter, 'runProcess').mockImplementation(
      async (command, args) => {
        if (args[0] === 'volume' && args[1] === 'rm') {
          volumeRemovals.push(args[2]);
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    await adapter.teardown(sessionId);

    expect(volumeRemovals).toContain(adapter.getVolumeName(sessionId));
    expect(volumeRemovals).toContain(adapter.getEvidenceVolumeName(sessionId));
  });
});
