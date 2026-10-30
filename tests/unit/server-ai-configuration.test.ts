import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const loadEnvConfigMock = vi.hoisted(() => vi.fn());

vi.mock('@next/env', () => ({ loadEnvConfig: loadEnvConfigMock }));

describe('server AI environment configuration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    loadEnvConfigMock.mockReset();
  });

  it('loads from the repository root for either cwd and keeps runtime precedence', async () => {
    const root = path.resolve('/workspace/hirearchy');
    const cwd = vi.spyOn(process, 'cwd');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NVIDIA_API_KEY', '');
    vi.stubEnv('OPENROUTER_KEY', 'runtime-openrouter-key');
    delete process.env.NVIDIA_API_KEY;
    loadEnvConfigMock.mockImplementation(() => {
      if (!process.env.NVIDIA_API_KEY)
        process.env.NVIDIA_API_KEY = 'loaded-nvidia-key';
      if (!process.env.OPENROUTER_KEY)
        process.env.OPENROUTER_KEY = 'loaded-openrouter-key';
    });

    cwd.mockReturnValue(root);
    let configuration =
      await import('../../apps/web/src/ai/server-ai-configuration');
    expect(configuration.getNvidiaApiKey()).toBe('loaded-nvidia-key');
    expect(configuration.getOpenRouterApiKey()).toBe('runtime-openrouter-key');
    expect(loadEnvConfigMock.mock.calls[0]?.[0]).toBe(root);
    expect(loadEnvConfigMock.mock.calls[0]?.[3]).toBe(true);

    vi.resetModules();
    loadEnvConfigMock.mockClear();
    vi.stubEnv('NVIDIA_API_KEY', '');
    vi.stubEnv('OPENROUTER_KEY', '');
    delete process.env.NVIDIA_API_KEY;
    delete process.env.OPENROUTER_KEY;
    cwd.mockReturnValue(path.join(root, 'apps/web'));
    configuration =
      await import('../../apps/web/src/ai/server-ai-configuration');
    expect(configuration.getNvidiaApiKey()).toBe('loaded-nvidia-key');
    expect(configuration.getOpenRouterApiKey()).toBe('loaded-openrouter-key');
    expect(loadEnvConfigMock.mock.calls[0]?.[0]).toBe(root);
    expect(loadEnvConfigMock.mock.calls[0]?.[3]).toBe(true);

    vi.resetModules();
    loadEnvConfigMock.mockClear();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NVIDIA_API_KEY', '');
    vi.stubEnv('OPENROUTER_KEY', '');
    delete process.env.NVIDIA_API_KEY;
    delete process.env.OPENROUTER_KEY;
    configuration =
      await import('../../apps/web/src/ai/server-ai-configuration');
    expect(configuration.getNvidiaApiKey()).toBeUndefined();
    expect(configuration.getOpenRouterApiKey()).toBeUndefined();
    expect(loadEnvConfigMock).not.toHaveBeenCalled();
  });
});
