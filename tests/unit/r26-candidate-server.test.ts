import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAdapter: vi.fn(),
  command: vi.fn(),
  close: vi.fn(),
  readAiCapability: vi.fn(),
  readExecutionCapability: vi.fn(),
}));

vi.mock('../../database/postgres/r26/adapter.mjs', () => ({
  R26CandidateError: class R26CandidateError extends Error {
    code = 'CANDIDATE_STORAGE_UNAVAILABLE';
    status = 503;
  },
  createR26CandidateAdapter: mocks.createAdapter,
}));
vi.mock('../../apps/web/src/r212-ai/server', () => ({
  readCandidateAiCapability: mocks.readAiCapability,
}));
vi.mock('../../apps/web/src/r213-execution/server', () => ({
  readCandidateExecutionCapability: mocks.readExecutionCapability,
}));

import {
  R26_CANDIDATE_DATA_NOTICE_TEXT,
  R26_CANDIDATE_DATA_NOTICE_VERSION,
} from '../../apps/web/src/r26-candidate/contract';
import {
  r26CandidateAction,
  r26CandidateRead,
} from '../../apps/web/src/r26-candidate/server';

const sessionId = 'sess_candidate_contract_1';
const candidateToken = 'A'.repeat(43);
const tokenHash = createHash('sha256')
  .update(candidateToken, 'utf8')
  .digest('hex');
const noticeDigest = createHash('sha256')
  .update(R26_CANDIDATE_DATA_NOTICE_TEXT, 'utf8')
  .digest('hex');
const durableView = {
  sessionId,
  status: 'CREATED',
  scenario: {},
  scenarioDigest: 'a'.repeat(64),
  activatedAt: null,
  deadline: null,
  durationSeconds: 1800,
  submittedAt: null,
  closureReason: null,
  serverNow: '2026-11-05T00:00:00.000Z',
  files: [],
  workspaceDigest: null,
  events: [],
  submission: null,
  invitationExpiresAt: '2026-11-12T00:00:00.000Z',
  capabilities: { ai: false, execution: false },
  dataNotice: {
    version: R26_CANDIDATE_DATA_NOTICE_VERSION,
    digest: noticeDigest,
    text: R26_CANDIDATE_DATA_NOTICE_TEXT,
  },
};

function configureDurableStaging() {
  vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', 'staging-authenticated');
  vi.stubEnv(
    'STAGING_DATABASE_URL',
    'postgres://r23_gateway:recruiter-only@127.0.0.1:5432/postgres',
  );
  vi.stubEnv(
    'STAGING_CANDIDATE_DATABASE_URL',
    'postgres://app_candidate_gateway:candidate-only@127.0.0.1:5432/postgres',
  );
  vi.stubEnv('STAGING_PUBLIC_ORIGIN', 'http://127.0.0.1:3000');
}

function configureDisposableProfile() {
  vi.stubEnv('HIREARCHY_RUNTIME_PROFILE', '');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('HIREARCHY_R23_DISPOSABLE', '1');
  vi.stubEnv('HIREARCHY_R26_DISPOSABLE', '1');
  vi.stubEnv('R23_PUBLIC_ORIGIN', 'https://127.0.0.1:4443');
  vi.stubEnv('R23_AUTH_URL', 'http://127.0.0.1:9999');
  vi.stubEnv('R23_AUTH_ISSUER', 'https://auth.example.test/auth/v1');
  vi.stubEnv('R23_AUTH_AUDIENCE', 'authenticated');
  vi.stubEnv(
    'R23_DATABASE_URL',
    'postgres://r23_gateway:synthetic@127.0.0.1:5432/postgres',
  );
  vi.stubEnv('R23_SESSION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('R23_APP_SESSION_TTL_SECONDS', '900');
  vi.stubEnv(
    'R26_DATABASE_URL',
    'postgres://app_candidate_gateway:synthetic@127.0.0.1:5432/postgres',
  );
}

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAdapter.mockReturnValue({
    command: mocks.command,
    close: mocks.close,
  });
  mocks.command.mockResolvedValue(durableView);
  mocks.close.mockResolvedValue(undefined);
  mocks.readAiCapability.mockResolvedValue(false);
  mocks.readExecutionCapability.mockResolvedValue(false);
});

describe('R26 candidate API response contract', () => {
  it('keeps durable notice, deadline and disabled capabilities on reads and mutations', async () => {
    configureDurableStaging();
    const read = await r26CandidateRead(
      new Request('http://127.0.0.1:3000/r26/api/candidate/session', {
        headers: { Authorization: `Bearer ${candidateToken}` },
      }),
      sessionId,
    );
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody).toMatchObject({
      invitationExpiresAt: durableView.invitationExpiresAt,
      capabilities: { ai: false, execution: false },
      dataNotice: {
        version: R26_CANDIDATE_DATA_NOTICE_VERSION,
        digest: noticeDigest,
        text: R26_CANDIDATE_DATA_NOTICE_TEXT,
      },
    });
    expect(mocks.readAiCapability).not.toHaveBeenCalled();
    expect(mocks.readExecutionCapability).not.toHaveBeenCalled();

    const action = await r26CandidateAction(
      new Request('http://127.0.0.1:3000/r26/api/candidate/session', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${candidateToken}`,
          Origin: 'http://127.0.0.1:3000',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'activate',
          input: {
            consent: {
              version: R26_CANDIDATE_DATA_NOTICE_VERSION,
              digest: noticeDigest,
              accepted: true,
            },
          },
        }),
      }),
      sessionId,
    );
    expect(action.status).toBe(200);
    expect(await action.json()).toMatchObject({
      invitationExpiresAt: durableView.invitationExpiresAt,
      capabilities: { ai: false, execution: false },
      dataNotice: {
        version: R26_CANDIDATE_DATA_NOTICE_VERSION,
        digest: noticeDigest,
        text: R26_CANDIDATE_DATA_NOTICE_TEXT,
      },
    });
  });

  it('uses token-scoped disposable read models for legacy capability flags', async () => {
    configureDisposableProfile();
    mocks.readAiCapability.mockResolvedValue(true);
    mocks.readExecutionCapability.mockResolvedValue(false);
    mocks.command.mockResolvedValue({
      ...durableView,
      invitationExpiresAt: undefined,
      capabilities: undefined,
      dataNotice: undefined,
    });

    const response = await r26CandidateRead(
      new Request('https://127.0.0.1:4443/r26/api/candidate/session', {
        headers: { Authorization: `Bearer ${candidateToken}` },
      }),
      sessionId,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      invitationExpiresAt: null,
      capabilities: { ai: true, execution: false },
      dataNotice: null,
    });
    expect(mocks.readAiCapability).toHaveBeenCalledWith(
      'postgres://app_candidate_gateway:synthetic@127.0.0.1:5432/postgres',
      tokenHash,
      sessionId,
    );
    expect(mocks.readExecutionCapability).toHaveBeenCalledWith(
      'postgres://app_candidate_gateway:synthetic@127.0.0.1:5432/postgres',
      tokenHash,
      sessionId,
    );
  });

  it('retains the missing bearer denial without invoking candidate storage', async () => {
    configureDurableStaging();
    const response = await r26CandidateRead(
      new Request('http://127.0.0.1:3000/r26/api/candidate/session'),
      sessionId,
    );
    expect(response.status).toBe(401);
    expect(mocks.createAdapter).not.toHaveBeenCalled();
  });
});
