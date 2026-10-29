import { expect, it, vi } from 'vitest';
import { DockerSandboxAdapter } from '../../apps/web/src/sandbox/docker-sandbox-adapter';

it('recognizes Docker missing-resource errors regardless of capitalization', async () => {
  const adapter = new DockerSandboxAdapter();
  const process = vi.spyOn(
    adapter as unknown as { runProcess: () => Promise<unknown> },
    'runProcess',
  );
  process
    .mockRejectedValueOnce(
      new Error('failed', { cause: new Error('No such object: sandbox') }),
    )
    .mockRejectedValueOnce(
      new Error('failed', { cause: new Error('No such volume: workspace') }),
    );
  await expect(adapter.inspectResources('session')).resolves.toEqual({
    containerStatus: 'missing',
    volumeExists: false,
  });

  process.mockRejectedValueOnce(new Error('Docker daemon unavailable'));
  await expect(adapter.inspectResources('session')).rejects.toThrow(
    'Docker daemon unavailable',
  );
});
