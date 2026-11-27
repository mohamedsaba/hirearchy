import { Client } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkOperationalReadiness } from '../../apps/web/src/observability/readiness.mjs';
import { probeStagingReadiness } from '../../scripts/check-staging-readiness.mjs';

const readyPayload = {
  status: 'ready',
  database: {
    migrationVersion: '0022',
    targetMigrationVersion: '0022',
    markers: {
      candidateLifecycle: true,
      onboarding: true,
      candidateTokenStorage: true,
      authoringR211: true,
      executionR214: true,
    },
  },
};

describe('staging readiness operator probe', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports migration 0022 as ready when the database markers are present', async () => {
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'query')
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            readiness: {
              migrationVersion: '0022',
              markers: readyPayload.database.markers,
            },
          },
        ],
      });
    vi.spyOn(Client.prototype, 'end').mockResolvedValue(undefined);
    const readiness = await checkOperationalReadiness(
      'postgres://probe@127.0.0.1:1/synthetic',
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(readiness), { status: 200 }),
      );

    expect(readiness).toMatchObject({
      status: 'ready',
      database: {
        migrationVersion: '0022',
        targetMigrationVersion: '0022',
        isMigrationCurrent: true,
      },
    });
    await expect(
      probeStagingReadiness({ appPort: 53000, fetchImpl }),
    ).resolves.toMatchObject({
      state: 'ready',
      httpStatus: 200,
      migrationVersion: '0022',
      markers: { executionR214: true },
    });
    expect(fetchImpl.mock.calls[0][0].href).toBe(
      'http://127.0.0.1:53000/api/staging/readiness',
    );
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a valid 503 as not ready with a recovery action', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...readyPayload, status: 'not_ready' }), {
        status: 503,
      }),
    );

    const report = await probeStagingReadiness({ appPort: 53000, fetchImpl });
    expect(report.state).toBe('not_ready');
    expect(report.action).toContain('Keep traffic closed');
  });

  it.each([
    ['malformed JSON', new Response('private token value', { status: 503 })],
    [
      'untrusted marker shape',
      new Response(
        JSON.stringify({
          ...readyPayload,
          database: { ...readyPayload.database, markers: { secret: 'leak' } },
        }),
        { status: 200 },
      ),
    ],
    ['oversized body', new Response('x'.repeat(17 * 1024), { status: 200 })],
  ])(
    'fails closed for %s without exposing response content',
    async (_name, response) => {
      const fetchImpl = vi.fn().mockResolvedValue(response);
      const report = await probeStagingReadiness({ appPort: 53000, fetchImpl });

      expect(report.state).toBe('unavailable');
      expect(JSON.stringify(report)).not.toMatch(/private token|secret|leak/);
    },
  );

  it('fails closed when a ready response has incomplete markers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...readyPayload,
          database: {
            ...readyPayload.database,
            markers: { ...readyPayload.database.markers, onboarding: false },
          },
        }),
        { status: 200 },
      ),
    );

    const report = await probeStagingReadiness({ appPort: 53000, fetchImpl });
    expect(report.state).toBe('unavailable');
    expect(report.action).toContain('Keep traffic closed');
  });

  it('fails closed when the loopback request times out', async () => {
    const fetchImpl = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('password=secret')),
            { once: true },
          );
        }),
    );

    const report = await probeStagingReadiness({
      appPort: 53000,
      fetchImpl,
      timeoutMs: 5,
    });
    expect(report.state).toBe('unavailable');
    expect(JSON.stringify(report)).not.toContain('password=secret');
  });

  it('fails closed for an unavailable loopback app', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('password=secret'));

    const report = await probeStagingReadiness({ appPort: 53000, fetchImpl });
    expect(report.state).toBe('unavailable');
    expect(JSON.stringify(report)).not.toContain('password=secret');
  });

  it('does not call fetch when APP_PORT is invalid', async () => {
    const fetchImpl = vi.fn();

    const report = await probeStagingReadiness({ appPort: '65536', fetchImpl });
    expect(report.state).toBe('unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
