import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  deleteEarlyAccessRecords,
  saveEarlyAccessRecord,
  readAllEarlyAccessRecords,
  type EarlyAccessSubmissionInput,
} from '../../apps/web/src/early-access/store';
import { globalRateLimiter } from '../../apps/web/src/security/rate-limit';
import { POST } from '../../apps/web/app/api/early-access/route';

const execFileAsync = promisify(execFile);
const storeModuleUrl = new URL(
  '../../apps/web/src/early-access/store.ts',
  import.meta.url,
).href;

describe('Early Access Data Store & Rate Limiter', () => {
  let tempDir: string;
  let tempStoreFile: string;

  beforeEach(() => {
    globalRateLimiter.reset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-test-'));
    tempStoreFile = path.join(tempDir, 'early-access.json');
    process.env.EARLY_ACCESS_STORAGE_PATH = tempStoreFile;
  });

  afterEach(() => {
    globalRateLimiter.reset();
    delete process.env.EARLY_ACCESS_STORAGE_PATH;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('saves and reads early access records durably', async () => {
    const input: EarlyAccessSubmissionInput = {
      name: 'Demo Buyer',
      email: 'buyer@hirearchy.test',
      company: 'Synthetic Example Team',
      role: 'Synthetic Engineering Lead',
      teamSize: '51-200',
      primaryChallenge: 'leetcode_fatigue',
      notes: 'Synthetic preview acceptance record.',
    };

    const record = await saveEarlyAccessRecord(input);
    expect(record.id).toBeDefined();
    expect(record.name).toBe('Demo Buyer');
    expect(record.receivedAt).toBeDefined();

    const stored = await readAllEarlyAccessRecords();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(record.id);
    expect(stored[0].company).toBe('Synthetic Example Team');
    expect(stored[0].clientIp).toBeUndefined();
    expect(stored[0].userAgent).toBeUndefined();
    expect(fs.statSync(tempStoreFile).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent submissions without dropping records', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        saveEarlyAccessRecord({
          name: `Synthetic ${index}`,
          email: `synthetic-${index}@example.test`,
          company: `Team ${index}`,
          teamSize: '1-10',
          role: 'Engineering lead',
          primaryChallenge: 'other',
        }),
      ),
    );

    expect(await readAllEarlyAccessRecords()).toHaveLength(8);
  });

  it('fails closed on a corrupt store instead of replacing its contents', async () => {
    fs.writeFileSync(tempStoreFile, '{');

    await expect(
      saveEarlyAccessRecord({
        name: 'Synthetic',
        email: 'synthetic@example.test',
        company: 'Example Team',
        teamSize: '1-10',
        role: 'Engineering lead',
        primaryChallenge: 'other',
      }),
    ).rejects.toThrow(SyntaxError);

    expect(fs.readFileSync(tempStoreFile, 'utf8')).toBe('{');
  });

  it('does not create a store when an operator reads an empty intake', async () => {
    expect(await readAllEarlyAccessRecords()).toEqual([]);
    expect(fs.existsSync(tempStoreFile)).toBe(false);
  });

  it('fails closed when the store is valid JSON with the wrong shape', async () => {
    fs.writeFileSync(tempStoreFile, 'null');

    await expect(readAllEarlyAccessRecords()).rejects.toThrow(
      'must contain a JSON array',
    );
    await expect(
      saveEarlyAccessRecord({
        name: 'Synthetic',
        email: 'synthetic@example.test',
        company: 'Example Team',
        teamSize: '1-10',
        role: 'Engineering lead',
        primaryChallenge: 'other',
      }),
    ).rejects.toThrow('must contain a JSON array');
    expect(fs.readFileSync(tempStoreFile, 'utf8')).toBe('null');
  });

  it('writes a replay filter before replacing the active store and treats repeats as no-ops', async () => {
    const target = await saveEarlyAccessRecord({
      name: 'Synthetic Target',
      email: 'target@example.test',
      company: 'Example Team',
      teamSize: '1-10',
      role: 'Engineering lead',
      primaryChallenge: 'other',
    });
    const retained = await saveEarlyAccessRecord({
      name: 'Synthetic Retained',
      email: 'retained@example.test',
      company: 'Example Team',
      teamSize: '1-10',
      role: 'Engineering lead',
      primaryChallenge: 'other',
    });
    let receiptWrittenBeforeReplace = false;

    const deleted = await deleteEarlyAccessRecords(
      { kind: 'id', id: target.id },
      async (ids) => {
        expect(ids).toEqual([target.id]);
        expect(await readAllEarlyAccessRecords()).toHaveLength(2);
        receiptWrittenBeforeReplace = true;
      },
    );

    expect(receiptWrittenBeforeReplace).toBe(true);
    expect(deleted).toEqual([target.id]);
    expect(await readAllEarlyAccessRecords()).toEqual([retained]);
    await expect(
      deleteEarlyAccessRecords({ kind: 'id', id: target.id }),
    ).resolves.toEqual([]);
  });

  it('leaves data unchanged on receipt failure and retains a replay filter on store-write failure', async () => {
    const target = await saveEarlyAccessRecord({
      name: 'Synthetic Target',
      email: 'target@example.test',
      company: 'Example Team',
      teamSize: '1-10',
      role: 'Engineering lead',
      primaryChallenge: 'other',
    });
    const before = fs.readFileSync(tempStoreFile, 'utf8');

    await expect(
      deleteEarlyAccessRecords({ kind: 'id', id: target.id }, async () => {
        throw new Error('synthetic receipt write failure');
      }),
    ).rejects.toThrow('synthetic receipt write failure');
    expect(fs.readFileSync(tempStoreFile, 'utf8')).toBe(before);

    const receiptPath = path.join(tempDir, 'delete-receipt.json');
    const renameSpy = vi
      .spyOn(fs.promises, 'rename')
      .mockRejectedValueOnce(new Error('synthetic store write failure'));
    try {
      await expect(
        deleteEarlyAccessRecords({ kind: 'id', id: target.id }, async (ids) => {
          fs.writeFileSync(
            receiptPath,
            JSON.stringify({ version: 1, affectedIds: ids }),
            { mode: 0o600 },
          );
        }),
      ).rejects.toThrow('synthetic store write failure');
    } finally {
      renameSpy.mockRestore();
    }

    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    expect(receipt.affectedIds).toEqual([target.id]);
    expect(fs.readFileSync(tempStoreFile, 'utf8')).toBe(before);
    await expect(
      deleteEarlyAccessRecords({ kind: 'ids', ids: receipt.affectedIds }),
    ).resolves.toEqual([target.id]);
    expect(await readAllEarlyAccessRecords()).toEqual([]);
  });

  it('rejects a malformed row without changing the store', async () => {
    const contents = JSON.stringify([
      {
        id: 'not-a-uuid',
        receivedAt: '2026-11-09T00:00:00.000Z',
        name: 'Synthetic',
      },
    ]);
    fs.writeFileSync(tempStoreFile, contents);

    await expect(
      deleteEarlyAccessRecords({
        kind: 'before',
        cutoff: '2026-12-01T00:00:00.000Z',
      }),
    ).rejects.toThrow('invalid record');
    expect(fs.readFileSync(tempStoreFile, 'utf8')).toBe(contents);
  });

  it('does not discard concurrent writes and leaves stale locks for operator recovery', async () => {
    const target = await saveEarlyAccessRecord({
      name: 'Synthetic Target',
      email: 'target@example.test',
      company: 'Example Team',
      teamSize: '1-10',
      role: 'Engineering lead',
      primaryChallenge: 'other',
    });
    const childEnv = {
      ...process.env,
      EARLY_ACCESS_STORAGE_PATH: tempStoreFile,
    };
    const writer = `
      import { saveEarlyAccessRecord } from ${JSON.stringify(storeModuleUrl)};
      await Promise.all(Array.from({ length: 8 }, (_, index) => saveEarlyAccessRecord({
        name: \`Synthetic \${index}\`, email: \`synthetic-\${index}@example.test\`,
        company: 'Example Team', teamSize: '1-10', role: 'Engineering lead',
        primaryChallenge: 'other',
      })));
    `;
    const deleter = `
      import { deleteEarlyAccessRecords } from ${JSON.stringify(storeModuleUrl)};
      await deleteEarlyAccessRecords({ kind: 'id', id: ${JSON.stringify(target.id)} });
    `;
    const runNode = (source) =>
      execFileAsync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', source],
        { env: childEnv },
      );

    await Promise.all([runNode(writer), runNode(deleter)]);
    expect(await readAllEarlyAccessRecords()).toHaveLength(8);

    fs.writeFileSync(`${tempStoreFile}.lock`, 'stale lock');
    await expect(
      saveEarlyAccessRecord({
        name: 'Synthetic',
        email: 'synthetic@example.test',
        company: 'Example Team',
        teamSize: '1-10',
        role: 'Engineering lead',
        primaryChallenge: 'other',
      }),
    ).rejects.toMatchObject({ code: 'ELOCKED' });
    expect(fs.existsSync(`${tempStoreFile}.lock`)).toBe(true);
    expect(await readAllEarlyAccessRecords()).toHaveLength(8);
  });
});

describe('Early Access API Route (POST /api/early-access)', () => {
  let tempDir: string;

  beforeEach(() => {
    globalRateLimiter.reset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-api-test-'));
    process.env.EARLY_ACCESS_STORAGE_PATH = path.join(
      tempDir,
      'early-access.json',
    );
  });

  afterEach(() => {
    globalRateLimiter.reset();
    delete process.env.EARLY_ACCESS_STORAGE_PATH;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid content-type', async () => {
    const request = new Request('http://localhost:3000/api/early-access', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
      },
      body: 'invalid',
    });

    const response = await POST(request);
    expect(response.status).toBe(415);
  });

  it('rejects missing or invalid fields with 400', async () => {
    const request = new Request('http://localhost:3000/api/early-access', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: '',
        email: 'not-an-email',
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Validation failed');
    expect(body.details.email).toBeDefined();
    expect(body.details.name).toBeDefined();
  });

  it('records valid request and returns truthful confirmation payload', async () => {
    const request = new Request('http://localhost:3000/api/early-access', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.42',
      },
      body: JSON.stringify({
        name: 'Demo Buyer',
        email: 'buyer@hirearchy.test',
        company: 'Synthetic Example Team',
        role: 'Synthetic Engineering Lead',
        teamSize: '11-50',
        primaryChallenge: 'ai_authenticity_uncertainty',
        notes: 'Synthetic preview acceptance record.',
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.submissionId).toBeDefined();
    expect(body.receivedAt).toBeDefined();
    expect(body.company).toBe('Synthetic Example Team');
    expect(body.message).toContain('No email was sent');
    expect(body.message).toContain('authorized operator');

    const stored = await readAllEarlyAccessRecords();
    expect(stored).toHaveLength(1);
    expect(stored[0].company).toBe('Synthetic Example Team');
    expect(stored[0].clientIp).toBeUndefined();
    expect(stored[0].userAgent).toBeUndefined();
  });

  it('returns a generic storage failure without logging store contents', async () => {
    const canary = 'CANARY42XY';
    const storePath = process.env.EARLY_ACCESS_STORAGE_PATH;
    const originalVerbose = process.env.HIREARCHY_LOG_VERBOSE;
    expect(storePath).toBeDefined();
    fs.writeFileSync(storePath!, `${canary}{`);
    process.env.HIREARCHY_LOG_VERBOSE = 'true';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await POST(
        new Request('http://localhost:3000/api/early-access', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Synthetic Buyer',
            email: 'buyer@example.test',
            company: 'Example Team',
            role: 'Engineering lead',
            teamSize: '1-10',
            primaryChallenge: 'other',
          }),
        }),
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: 'Failed to record your request. Please try again later.',
      });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const loggedText = errorSpy.mock.calls
        .flat()
        .map((value) => String(value))
        .join(' ');
      expect(loggedText).not.toContain(canary);
      expect(loggedText).toContain('early_access.store_write_failed');
    } finally {
      errorSpy.mockRestore();
      if (originalVerbose === undefined) {
        delete process.env.HIREARCHY_LOG_VERBOSE;
      } else {
        process.env.HIREARCHY_LOG_VERBOSE = originalVerbose;
      }
    }
  });

  it('returns a retryable response when the operator store lock is unavailable', async () => {
    const storePath = path.join(tempDir, 'early-access.json');
    fs.writeFileSync(`${storePath}.lock`, 'stale lock', { mode: 0o600 });
    const response = await POST(
      new Request('http://localhost:3000/api/early-access', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify({
          name: 'Demo Buyer',
          email: 'buyer@hirearchy.test',
          company: 'Synthetic Example Team',
          role: 'Synthetic Engineering Lead',
          teamSize: '1-10',
          primaryChallenge: 'other',
        }),
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.existsSync(`${storePath}.lock`)).toBe(true);
  });

  it('does not let forwarded-header rotation bypass the shared intake limit', async () => {
    const payload = {
      name: 'Synthetic Buyer',
      email: 'buyer@example.test',
      company: 'Example Team',
      role: 'Engineering lead',
      teamSize: '1-10',
      primaryChallenge: 'other',
    };
    const post = (index: number) =>
      POST(
        new Request('http://localhost:3000/api/early-access', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': `198.51.100.${index}`,
            'user-agent': `Synthetic browser ${index}`,
          },
          body: JSON.stringify(payload),
        }),
      );

    for (let index = 1; index <= 5; index += 1) {
      expect((await post(index)).status).toBe(201);
    }
    const limited = await post(6);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await readAllEarlyAccessRecords()).toHaveLength(5);
  });
});
