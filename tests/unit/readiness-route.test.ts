import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getCookie, readinessProbe } = vi.hoisted(() => ({
  getCookie: vi.fn(),
  readinessProbe: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: getCookie }),
}));
vi.mock('../../apps/web/src/readiness', () => ({
  inspectApplicationReadiness: readinessProbe,
}));

import { GET } from '../../apps/web/app/api/evaluator/readiness/route';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';

describe('authenticated evaluator readiness route', () => {
  beforeEach(() => {
    vi.stubEnv('HIREARCHY_EVALUATOR_KEY', 'readiness-test-key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    getCookie.mockReturnValue(undefined);
  });

  it('authenticates before running operational probes', async () => {
    getCookie.mockReturnValue(undefined);
    const response = await GET();

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(readinessProbe).not.toHaveBeenCalled();
  });

  it('returns separate sanitized checks with private no-store caching', async () => {
    getCookie.mockReturnValue({
      value: createSignedEvaluatorToken('readiness-test-key'),
    });
    readinessProbe.mockResolvedValue({
      service: 'hirearchy-web',
      status: 'not_ready',
      checks: {
        startup: 'failed',
        keyConfiguration: 'ready',
        keyAssociation: 'not_ready',
        database: 'ready',
        schema: 'not_checked',
        docker: 'ready',
        images: { scenario001: 'ready', scenario002: 'not_ready' },
        reconciliation: 'not_ready',
        provisioning: 'not_checked',
        ai: 'not_checked',
      },
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      status: 'not_ready',
      checks: {
        keyAssociation: 'not_ready',
        images: { scenario002: 'not_ready' },
        provisioning: 'not_checked',
        ai: 'not_checked',
      },
    });
  });

  it('sanitizes unexpected probe exceptions without logging their contents', async () => {
    getCookie.mockReturnValue({
      value: createSignedEvaluatorToken('readiness-test-key'),
    });
    const secretDetails =
      'sqlite:///private/path?key=synthetic-secret; marker=synthetic-marker';
    readinessProbe.mockRejectedValue(new Error(secretDetails));
    const log = vi.spyOn(console, 'error');

    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).not.toContain(secretDetails);
    expect(log).not.toHaveBeenCalled();
  });
});
