import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  fail: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../../database/postgres/r213/adapter.mjs', () => ({
  admitCandidateExecution: mocks.admit,
  completeCandidateExecution: vi.fn(),
  failCandidateExecution: mocks.fail,
  getCandidateExecutionsView: vi.fn(),
}));
vi.mock('../../database/postgres/r26/adapter.mjs', () => ({
  createR26CandidateAdapter: () => ({
    command: mocks.read,
    close: mocks.close,
  }),
}));
vi.mock('../../apps/web/src/r26-candidate/config', () => ({
  r26IsEnabled: () => true,
  readR26Config: () => ({
    databaseUrl: 'postgres://localhost/test',
    publicOrigin: 'https://127.0.0.1:4443',
  }),
}));

import { r214CandidateExecutionAction } from '../../apps/web/src/r214-execution/server';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('does not dispatch files changed after execution admission', async () => {
  const admittedDigest = 'a'.repeat(64);
  mocks.admit.mockResolvedValue({
    status: 'ADMITTED',
    intent: {
      canonicalWorkspaceSnapshotDigest: admittedDigest,
      operationId: 'operation_1',
      generation: 1,
      fence: 1,
    },
  });
  mocks.read.mockResolvedValue({
    workspaceDigest: 'b'.repeat(64),
    files: [{ path: 'main.py', content: 'changed' }],
  });
  mocks.fail.mockResolvedValue({});
  const execute = vi.fn();
  const request = new Request('https://127.0.0.1:4443/execution', {
    method: 'POST',
    headers: {
      origin: 'https://127.0.0.1:4443',
      authorization: `Bearer ${Buffer.alloc(32, 1).toString('base64url')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      requestId: 'request_1',
      expectedWorkspaceDigest: admittedDigest,
    }),
  });

  const response = await r214CandidateExecutionAction(request, 'sess_test', {
    execute,
    provenance: 'synthetic-execution-adapter',
    isSynthetic: true,
  });

  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe('STALE_WORKSPACE');
  expect(execute).not.toHaveBeenCalled();
  expect(mocks.fail).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ failureReason: 'STALE_WORKSPACE' }),
  );
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('does not label an UNKNOWN replay as completed', async () => {
  mocks.admit.mockResolvedValue({
    status: 'REPLAY',
    operation: { status: 'UNKNOWN', provenance: 'restricted-executor-service' },
  });
  const execute = vi.fn();
  const response = await r214CandidateExecutionAction(
    new Request('https://127.0.0.1:4443/execution', {
      method: 'POST',
      headers: {
        origin: 'https://127.0.0.1:4443',
        authorization: `Bearer ${Buffer.alloc(32, 1).toString('base64url')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: 'request_1',
        expectedWorkspaceDigest: 'a'.repeat(64),
      }),
    }),
    'sess_test',
    { execute, provenance: 'restricted-executor-service', isSynthetic: false },
  );

  const body = await response.json();
  expect(body.status).toBe('UNKNOWN');
  expect(body.admissionStatus).toBe('REPLAY');
  expect(execute).not.toHaveBeenCalled();
});

it('keeps custom authored assessments on the synthetic adapter', async () => {
  vi.stubEnv('HIREARCHY_EXECUTION_BACKEND', 'restricted-executor');
  mocks.read.mockResolvedValue({
    scenario: {
      id: 'scenario-002-booking-notification-retry',
      version: '1.0.0',
    },
  });
  mocks.admit.mockResolvedValue({
    status: 'DENIED',
    reason: 'TERMINAL_DISABLED',
  });
  const response = await r214CandidateExecutionAction(
    new Request('https://127.0.0.1:4443/execution', {
      method: 'POST',
      headers: {
        origin: 'https://127.0.0.1:4443',
        authorization: `Bearer ${Buffer.alloc(32, 1).toString('base64url')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: 'request_1',
        expectedWorkspaceDigest: 'a'.repeat(64),
      }),
    }),
    'sess_test',
  );
  expect(response.status).toBe(403);
  expect(mocks.admit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      recipeId: 'recipe-python-check-v1',
      provenance: 'synthetic-execution-adapter',
    }),
  );
});
