import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveEarlyAccessRecord } from '../../apps/web/src/early-access/store';

const cliPath = path.resolve('scripts/manage-early-access-requests.mjs');
const exportAliasPath = path.resolve(
  'scripts/export-early-access-requests.mjs',
);

describe('early-access operator export and deletion CLI', () => {
  let root: string;
  let storePath: string;
  let outputDirectory: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-admin-test-'));
    storePath = path.join(root, 'volume', 'early-access.json');
    fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
    outputDirectory = path.join(root, 'operator');
    fs.mkdirSync(outputDirectory, { mode: 0o700 });
    process.env.EARLY_ACCESS_STORAGE_PATH = storePath;
  });

  afterEach(() => {
    delete process.env.EARLY_ACCESS_STORAGE_PATH;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    return spawnSync(
      process.execPath,
      ['--experimental-strip-types', cliPath, ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, EARLY_ACCESS_STORAGE_PATH: storePath },
      },
    );
  }

  function runExport(...args: string[]) {
    return spawnSync(
      process.execPath,
      ['--experimental-strip-types', exportAliasPath, ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, EARLY_ACCESS_STORAGE_PATH: storePath },
      },
    );
  }

  it('keeps export count-only until an explicit protected file is requested', async () => {
    const record = await saveEarlyAccessRecord({
      name: 'Synthetic Canary',
      email: 'canary@example.test',
      company: 'Synthetic Team',
      teamSize: '1-10',
      role: 'Engineering lead',
      primaryChallenge: 'other',
      notes: 'synthetic-only',
    });
    const outputPath = path.join(outputDirectory, 'export.json');

    const dryRun = runExport('--all');
    expect(dryRun.status).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toEqual({
      ok: true,
      operation: 'export',
      mode: 'dry-run',
      selector: 'all',
      matchedCount: 1,
    });
    expect(dryRun.stdout).not.toContain('canary@example.test');
    expect(fs.existsSync(outputPath)).toBe(false);

    const applied = runExport('--all', '--apply', '--output', outputPath);
    expect(applied.status).toBe(0);
    expect(applied.stdout).not.toContain('canary@example.test');
    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toEqual([record]);
    expect(runExport('--all', '--apply', '--output', outputPath).status).toBe(
      1,
    );
    expect(
      runExport(
        '--all',
        '--apply',
        '--output',
        path.join(path.dirname(storePath), 'inside-volume.json'),
      ).status,
    ).toBe(1);
  });

  it('deletes only after apply, writes a private replay receipt, and safely replays it after restore', async () => {
    const record = await saveEarlyAccessRecord({
      name: 'Synthetic Canary',
      email: 'canary@example.test',
      company: 'Synthetic Team',
      teamSize: '1-10',
      role: 'Engineering lead',
      primaryChallenge: 'other',
    });
    const receiptPath = path.join(outputDirectory, 'delete-receipt.json');
    const before = fs.readFileSync(storePath, 'utf8');

    const dryRun = run('delete', '--id', record.id);
    expect(dryRun.status).toBe(0);
    expect(JSON.parse(dryRun.stdout).matchedCount).toBe(1);
    expect(dryRun.stdout).not.toContain(record.id);
    expect(fs.readFileSync(storePath, 'utf8')).toBe(before);

    const noMatch = run(
      'delete',
      '--id',
      '00000000-0000-4000-8000-000000000001',
      '--apply',
    );
    expect(JSON.parse(noMatch.stdout).result).toBe('no-op');
    expect(fs.readFileSync(storePath, 'utf8')).toBe(before);

    const applied = run(
      'delete',
      '--id',
      record.id,
      '--apply',
      '--receipt-out',
      receiptPath,
    );
    expect(applied.status).toBe(0);
    expect(applied.stdout).not.toContain(record.id);
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    expect(receipt).toEqual({
      version: 1,
      operation: 'delete',
      requestedAt: expect.any(String),
      selector: 'id',
      affectedIds: [record.id],
    });
    expect(JSON.stringify(receipt)).not.toContain('canary@example.test');
    expect(JSON.parse(fs.readFileSync(storePath, 'utf8'))).toEqual([]);

    fs.writeFileSync(storePath, before, { mode: 0o600 });
    const replayDryRun = run('replay', '--receipt', receiptPath);
    expect(JSON.parse(replayDryRun.stdout).matchedCount).toBe(1);
    expect(JSON.parse(fs.readFileSync(storePath, 'utf8'))).toHaveLength(1);
    expect(
      JSON.parse(run('replay', '--receipt', receiptPath, '--apply').stdout),
    ).toMatchObject({
      deletedCount: 1,
      result: 'applied',
    });
    expect(
      JSON.parse(run('replay', '--receipt', receiptPath, '--apply').stdout),
    ).toMatchObject({
      deletedCount: 0,
      result: 'no-op',
    });
  });

  it('requires canonical UTC cutoffs and refuses corrupt storage without exporting it', async () => {
    await saveEarlyAccessRecord({
      name: 'Synthetic',
      email: 'synthetic@example.test',
      company: 'Synthetic Team',
      teamSize: '1-10',
      role: 'Engineering lead',
      primaryChallenge: 'other',
    });
    const cutoff = run('delete', '--before', '2099-01-01T00:00:00.000Z');
    expect(JSON.parse(cutoff.stdout).matchedCount).toBe(1);
    expect(run('delete', '--before', '2099-01-01', '--apply').status).toBe(1);

    const corrupt = '{';
    fs.writeFileSync(storePath, corrupt);
    const outputPath = path.join(outputDirectory, 'must-not-exist.json');
    expect(runExport('--all', '--apply', '--output', outputPath).status).toBe(
      1,
    );
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.readFileSync(storePath, 'utf8')).toBe(corrupt);
  });

  it('decides an applied cutoff deletion after acquiring the shared store lock', async () => {
    const lockPath = `${storePath}.lock`;
    const lock = fs.openSync(lockPath, 'wx', 0o600);
    const record = {
      id: '00000000-0000-4000-8000-000000000099',
      receivedAt: '2026-11-01T00:00:00.000Z',
      name: 'Synthetic Buyer',
      email: 'buyer@hirearchy.test',
      company: 'Synthetic Team',
      teamSize: '1-10',
      role: 'Engineering lead',
      primaryChallenge: 'other',
    };
    const receiptPath = path.join(outputDirectory, 'concurrent-delete.json');
    let child;
    let lockOpen = true;

    try {
      child = spawn(
        process.execPath,
        [
          '--experimental-strip-types',
          cliPath,
          'delete',
          '--before',
          '2026-12-01T00:00:00.000Z',
          '--apply',
          '--receipt-out',
          receiptPath,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, EARLY_ACCESS_STORAGE_PATH: storePath },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      const exited = once(child, 'exit');

      await delay(200);
      expect(child.exitCode).toBe(null);
      fs.writeFileSync(storePath, JSON.stringify([record]), { mode: 0o600 });
      fs.closeSync(lock);
      lockOpen = false;
      fs.unlinkSync(lockPath);

      const [code] = await exited;
      expect(code).toBe(0, stderr);
      expect(JSON.parse(stdout)).toMatchObject({
        operation: 'delete',
        mode: 'applied',
        deletedCount: 1,
      });
      expect(
        JSON.parse(fs.readFileSync(receiptPath, 'utf8')).affectedIds,
      ).toEqual([record.id]);
      expect(JSON.parse(fs.readFileSync(storePath, 'utf8'))).toEqual([]);
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      if (lockOpen) {
        fs.closeSync(lock);
        lockOpen = false;
      }
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    }
  });
});
