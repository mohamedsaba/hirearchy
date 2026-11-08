import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  saveEarlyAccessRecord,
  readAllEarlyAccessRecords,
  checkRateLimit,
  type EarlyAccessSubmissionInput,
} from '../../apps/web/src/early-access/store';
import { POST } from '../../apps/web/app/api/early-access/route';

describe('Early Access Data Store & Rate Limiter', () => {
  let tempDir: string;
  let tempStoreFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-test-'));
    tempStoreFile = path.join(tempDir, 'early-access.json');
    process.env.EARLY_ACCESS_STORAGE_PATH = tempStoreFile;
  });

  afterEach(() => {
    delete process.env.EARLY_ACCESS_STORAGE_PATH;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('saves and reads early access records durably', async () => {
    const input: EarlyAccessSubmissionInput = {
      name: 'Alice Developer',
      email: 'alice@example.com',
      company: 'Acme Systems',
      role: 'VP Engineering',
      teamSize: '51-200',
      primaryChallenge: 'leetcode_fatigue',
      notes: 'Interested in backend scenarios',
      clientIp: '127.0.0.1',
    };

    const record = await saveEarlyAccessRecord(input);
    expect(record.id).toBeDefined();
    expect(record.name).toBe('Alice Developer');
    expect(record.receivedAt).toBeDefined();

    const stored = await readAllEarlyAccessRecords();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(record.id);
    expect(stored[0].company).toBe('Acme Systems');
  });

  it('enforces rate limits per client IP', () => {
    const testIp = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    for (let i = 0; i < 5; i++) {
      const check = checkRateLimit(testIp);
      expect(check.allowed).toBe(true);
    }
    const sixthCheck = checkRateLimit(testIp);
    expect(sixthCheck.allowed).toBe(false);
    expect(sixthCheck.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('Early Access API Route (POST /api/early-access)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-api-test-'));
    process.env.EARLY_ACCESS_STORAGE_PATH = path.join(
      tempDir,
      'early-access.json',
    );
  });

  afterEach(() => {
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
        name: 'Sarah Connor',
        email: 'sarah@cyberdyne.io',
        company: 'Cyberdyne Systems',
        role: 'Director of Platform Engineering',
        teamSize: '11-50',
        primaryChallenge: 'ai_authenticity_uncertainty',
        notes: 'Exploring pilots for upcoming Q1 hiring',
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.submissionId).toBeDefined();
    expect(body.receivedAt).toBeDefined();
    expect(body.company).toBe('Cyberdyne Systems');
    expect(body.message).toContain('Automated email delivery is disabled');
    expect(body.message).toContain('follow up directly');

    const stored = await readAllEarlyAccessRecords();
    expect(stored).toHaveLength(1);
    expect(stored[0].company).toBe('Cyberdyne Systems');
  });
});
