import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { proxy } from '../../apps/web/proxy';
import { getHealthStatus } from '../../apps/web/src/health';
import { register } from '../../apps/web/instrumentation';

afterEach(() => vi.unstubAllEnvs());

describe('staging lockdown', () => {
  it('denies direct product and execution routes even with development flags', async () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-lockdown');
    vi.stubEnv('HIREARCHY_R23_DISPOSABLE', '1');
    vi.stubEnv('HIREARCHY_R26_DISPOSABLE', '1');
    for (const path of [
      '/api/sessions',
      '/api/candidate/sessions/example/terminal/exec',
      '/api/evaluator/assessments/generate',
      '/r26/api/candidate/example/execution',
      '/r26/api/candidate/example/ai',
      '/r23/api/organizations/example/assessments/draft',
      '/r27/api/organizations/example/sessions/example/evidence',
      '/',
    ]) {
      const response = proxy(
        new NextRequest(`http://localhost${path}`, { method: 'POST' }),
      );
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe(
        'STAGING_CAPABILITY_DISABLED',
      );
    }
    expect(
      proxy(new NextRequest('http://localhost/api/health')).headers.get(
        'x-middleware-next',
      ),
    ).toBe('1');
    expect(getHealthStatus()).toMatchObject({
      capabilities: {
        application: 'disabled',
        execution: 'disabled',
        ai: 'disabled',
      },
    });
  });

  it('does not initialize storage or reconciliation on startup', async () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-lockdown');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('HIREARCHY_DB_PATH', '/this/path/must/not/be/created/db.sqlite');
    await expect(register()).resolves.toBeUndefined();
  });

  it('leaves the existing runtime unchanged when not selected', () => {
    vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', '');
    expect(
      proxy(
        new NextRequest('http://localhost/api/sessions', { method: 'POST' }),
      ).headers.get('x-middleware-next'),
    ).toBe('1');
    expect(getHealthStatus().capabilities).toBeUndefined();
  });
});
