import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runDockerProcess } = vi.hoisted(() => ({
  runDockerProcess: vi.fn(),
}));

vi.mock('../../apps/web/src/sandbox/docker-sandbox-adapter', () => ({
  DockerSandboxAdapter: class {
    runProcess(command: string, args: string[]) {
      return runDockerProcess(command, args);
    }
  },
}));

import { inspectApplicationReadiness } from '../../apps/web/src/readiness';
import { getHealthStatus } from '../../apps/web/src/health';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';
import { markApplicationStartupReady } from '../../apps/web/src/startup-status';

describe('application readiness probes', () => {
  let directory = '';
  const originalDatabasePath = process.env.HIREARCHY_DB_PATH;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hirearchy-readiness-'));
    process.env.HIREARCHY_DB_PATH = path.join(directory, 'sessions.sqlite');
    markApplicationStartupReady();
    runDockerProcess.mockImplementation(async (_command, args) => ({
      exitCode: 0,
      stdout:
        args[0] === 'info' ? 'synthetic-docker-version' : 'sha256:synthetic',
      stderr: '',
      durationMs: 0,
      timedOut: false,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    if (originalDatabasePath === undefined) {
      delete process.env.HIREARCHY_DB_PATH;
    } else {
      process.env.HIREARCHY_DB_PATH = originalDatabasePath;
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  it('reports independent ready checks after verifying the key and database rows', async () => {
    new SessionService(
      new SqliteSessionStore(process.env.HIREARCHY_DB_PATH!),
    ).createSession();

    const readiness = await inspectApplicationReadiness();

    expect(readiness.status).toBe('ready');
    expect(readiness.checks).toMatchObject({
      startup: 'ready',
      keyConfiguration: 'ready',
      keyAssociation: 'ready',
      database: 'ready',
      schema: 'ready',
      docker: 'ready',
      images: { scenario001: 'ready', scenario002: 'ready' },
      reconciliation: 'ready',
      provisioning: 'not_checked',
      ai: 'not_checked',
    });
    expect(runDockerProcess).toHaveBeenCalledTimes(3);
    expect(
      runDockerProcess.mock.calls.every(
        ([, args]) => args[0] === 'info' || args[0] === 'image',
      ),
    ).toBe(true);
  });

  it('reports corrupt encrypted rows as a failed key association', async () => {
    new SessionService(
      new SqliteSessionStore(process.env.HIREARCHY_DB_PATH!),
    ).createSession();
    const database = new Database(process.env.HIREARCHY_DB_PATH!);
    database
      .prepare(
        "UPDATE assessment_sessions SET candidate_token_ciphertext = 'v1.invalid.invalid.invalid'",
      )
      .run();
    database.close();

    const readiness = await inspectApplicationReadiness();

    expect(readiness.status).toBe('not_ready');
    expect(readiness.checks).toMatchObject({
      database: 'ready',
      schema: 'not_ready',
      keyAssociation: 'not_ready',
    });
  });

  it('reports an absent database without creating it while liveness remains healthy', async () => {
    const missingPath = path.join(directory, 'not-created.sqlite');
    process.env.HIREARCHY_DB_PATH = missingPath;

    const readiness = await inspectApplicationReadiness();

    expect(readiness.status).toBe('not_ready');
    expect(readiness.checks).toMatchObject({
      database: 'not_ready',
      schema: 'not_checked',
      docker: 'ready',
    });
    expect(existsSync(missingPath)).toBe(false);
    expect(getHealthStatus()).toMatchObject({
      status: 'ok',
      readiness: 'not-checked',
    });
  });

  it('reports Docker probe failure with sanitized checks and healthy liveness', async () => {
    new SessionService(
      new SqliteSessionStore(process.env.HIREARCHY_DB_PATH!),
    ).createSession();
    const secretDetails = 'docker://private-host/path?key=synthetic-secret';
    runDockerProcess.mockRejectedValueOnce(new Error(secretDetails));

    const readiness = await inspectApplicationReadiness();

    expect(readiness.status).toBe('not_ready');
    expect(readiness.checks).toMatchObject({
      database: 'ready',
      schema: 'ready',
      docker: 'not_ready',
      images: { scenario001: 'not_checked', scenario002: 'not_checked' },
    });
    expect(JSON.stringify(readiness)).not.toContain(secretDetails);
    expect(runDockerProcess).toHaveBeenCalledTimes(1);
    expect(getHealthStatus()).toMatchObject({
      status: 'ok',
      readiness: 'not-checked',
    });
  });
});
