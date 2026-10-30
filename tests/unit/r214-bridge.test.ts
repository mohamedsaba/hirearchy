import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import {
  R214_PROTOCOL_VERSION,
  RESTRICTED_DISPATCH_VERSION,
  SYNTHETIC_RECIPE_ID,
  SYNTHETIC_RECIPE_VERSION,
  SYNTHETIC_RECIPE_DIGEST,
  SYNTHETIC_PROVENANCE,
  RESTRICTED_RECIPE_ID,
  RESTRICTED_RECIPE_VERSION,
  RESTRICTED_RECIPE_DIGEST,
  RESTRICTED_APPROVED_SCENARIO_REF,
  RESTRICTED_APPROVED_SCENARIO_VERSION,
  RESTRICTED_EXECUTOR_PROVENANCE,
  DEFAULT_PYTHON_CHECK_RECIPE,
  RESTRICTED_EXECUTOR_RECIPE,
  computeCanonicalSnapshotDigest,
  computeRecipeDigest,
  isScenarioCompatibleWithBackend,
  assertScenarioCompatible,
  signAdmissionEnvelope,
  signDispatchEnvelope,
  ScenarioIncompatibleError,
  InvalidSnapshotError,
  type R214ExecutionIntent,
} from '../../apps/web/src/r214-execution/contract';
import {
  RestrictedExecutorBridgeAdapter,
  getExecutionAdapter,
} from '../../apps/web/src/r214-execution/adapter';
import {
  r214CandidateExecutionRead,
  r214CandidateExecutionAction,
} from '../../apps/web/src/r214-execution/server';

describe('R2.14 Execution Contract and Protocol Specifications', () => {
  it('exposes R2.14 protocol constants and frozen approved recipe digests', () => {
    expect(R214_PROTOCOL_VERSION).toBe('r214-execution-v1');
    expect(RESTRICTED_DISPATCH_VERSION).toBe('executor-dispatch-v1');
    expect(SYNTHETIC_RECIPE_ID).toBe('recipe-python-check-v1');
    expect(SYNTHETIC_RECIPE_VERSION).toBe('1.0.0');
    expect(SYNTHETIC_RECIPE_DIGEST).toBe(
      '0760fc4197b0b1654be37456fc70f7c1a9159520ca78cd5b3115e7a5affd6fd2',
    );
    expect(SYNTHETIC_PROVENANCE).toBe('synthetic-execution-adapter');

    expect(RESTRICTED_RECIPE_ID).toBe('reservation-moves.pytest');
    expect(RESTRICTED_RECIPE_VERSION).toBe('3');
    expect(RESTRICTED_RECIPE_DIGEST).toBe(
      'eeac2baaf62ce107c7511268e862657ae24bb171cd1dec6ca01797c16ffbaad8',
    );
    expect(RESTRICTED_APPROVED_SCENARIO_REF).toBe('reservation-moves');
    expect(RESTRICTED_APPROVED_SCENARIO_VERSION).toBe('v3');
    expect(RESTRICTED_EXECUTOR_PROVENANCE).toBe('restricted-executor-service');
  });

  it('computes deterministic SHA-256 recipe digests matching frozen constants', () => {
    expect(computeRecipeDigest(DEFAULT_PYTHON_CHECK_RECIPE)).toBe(
      SYNTHETIC_RECIPE_DIGEST,
    );
    expect(computeRecipeDigest(RESTRICTED_EXECUTOR_RECIPE)).toBe(
      RESTRICTED_RECIPE_DIGEST,
    );
  });
});

describe('R2.14 Scenario Compatibility Whitelist Gating', () => {
  it('permits reservation-moves v3 for restricted-executor backend', () => {
    expect(
      isScenarioCompatibleWithBackend(
        'reservation-moves',
        'v3',
        'restricted-executor',
      ),
    ).toBe(true);
    expect(() =>
      assertScenarioCompatible(
        'reservation-moves',
        'v3',
        'restricted-executor',
      ),
    ).not.toThrow();
  });

  it('fails closed on non-reservation-moves scenarios for restricted-executor backend', () => {
    expect(
      isScenarioCompatibleWithBackend(
        'scenario-002-booking-notification-retry',
        '1.0.0',
        'restricted-executor',
      ),
    ).toBe(false);
    expect(() =>
      assertScenarioCompatible(
        'scenario-002-booking-notification-retry',
        '1.0.0',
        'restricted-executor',
      ),
    ).toThrow(ScenarioIncompatibleError);

    expect(
      isScenarioCompatibleWithBackend(
        'reservation-moves',
        'v2',
        'restricted-executor',
      ),
    ).toBe(false);
    expect(() =>
      assertScenarioCompatible(
        'reservation-moves',
        'v2',
        'restricted-executor',
      ),
    ).toThrow(ScenarioIncompatibleError);
  });

  it('permits all scenarios for deterministic-synthetic backend', () => {
    expect(
      isScenarioCompatibleWithBackend(
        'scenario-002-booking-notification-retry',
        '1.0.0',
        'deterministic-synthetic',
      ),
    ).toBe(true);
    expect(
      isScenarioCompatibleWithBackend(
        'reservation-moves',
        'v3',
        'deterministic-synthetic',
      ),
    ).toBe(true);
    expect(() =>
      assertScenarioCompatible(
        'any-scenario',
        'any-version',
        'deterministic-synthetic',
      ),
    ).not.toThrow();
  });
});

describe('R2.14 Canonical Snapshot Digest Calculation', () => {
  it('computes deterministic digest sorted by path regardless of input order', () => {
    const filesA = [
      { path: 'test_b.py', content: 'def test_b(): pass\n' },
      { path: 'test_a.py', content: 'def test_a(): pass\n' },
    ];
    const filesB = [
      { path: 'test_a.py', content: 'def test_a(): pass\n' },
      { path: 'test_b.py', content: 'def test_b(): pass\n' },
    ];
    const record = {
      'test_b.py': 'def test_b(): pass\n',
      'test_a.py': 'def test_a(): pass\n',
    };

    const digestA = computeCanonicalSnapshotDigest(filesA);
    const digestB = computeCanonicalSnapshotDigest(filesB);
    const digestRecord = computeCanonicalSnapshotDigest(record);

    expect(digestA).toHaveLength(64);
    expect(digestA).toBe(digestB);
    expect(digestA).toBe(digestRecord);
  });

  it('rejects invalid snapshot paths and path traversal attempts', () => {
    expect(() =>
      computeCanonicalSnapshotDigest([{ path: '../secret.py', content: '' }]),
    ).toThrow(InvalidSnapshotError);
    expect(() =>
      computeCanonicalSnapshotDigest([{ path: '/root.py', content: '' }]),
    ).toThrow(InvalidSnapshotError);
    expect(() =>
      computeCanonicalSnapshotDigest([{ path: 'foo\\bar.py', content: '' }]),
    ).toThrow(InvalidSnapshotError);
    expect(() =>
      computeCanonicalSnapshotDigest([{ path: 'a/./b.py', content: '' }]),
    ).toThrow(InvalidSnapshotError);
    expect(() =>
      computeCanonicalSnapshotDigest([
        { path: 'dir', content: '' },
        { path: 'dir/file.py', content: '' },
      ]),
    ).toThrow(InvalidSnapshotError);
  });

  it('rejects duplicate paths and empty snapshot', () => {
    expect(() => computeCanonicalSnapshotDigest([])).toThrow(
      InvalidSnapshotError,
    );
    expect(() =>
      computeCanonicalSnapshotDigest([
        { path: 'dup.py', content: '1' },
        { path: 'dup.py', content: '2' },
      ]),
    ).toThrow(InvalidSnapshotError);
  });
});

describe('R2.14 HMAC Envelope Signing', () => {
  const secret =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('signs admission envelope with exact canonical property order and valid tag', () => {
    const envelope = signAdmissionEnvelope({
      callerId: 'hirearchy-app-caller',
      keyId: 'admission-key-1',
      secret,
      sessionRef: 'sess_123',
      operationId: 'op_001',
      requestId: 'req_001',
      generation: 1,
      fence: 1,
      scenarioRef: 'reservation-moves',
      scenarioVersion: 'v3',
      snapshotDigest:
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      recipeId: RESTRICTED_RECIPE_ID,
      recipeVersion: RESTRICTED_RECIPE_VERSION,
      recipeDigest: RESTRICTED_RECIPE_DIGEST,
      timeoutMs: 10_000,
      resources: {
        memoryBytes: 536870912,
        cpus: 1,
        pids: 64,
      },
      outputBytes: 64_000,
      issuedAtMs: 1700000000000,
      ttlMs: 60_000,
    });

    expect(envelope.version).toBe(1);
    expect(envelope.callerId).toBe('hirearchy-app-caller');
    expect(envelope.tag).toHaveLength(64);

    // Verify tag matches canonical HMAC calculation
    const payloadWithoutTag = { ...envelope };
    delete (payloadWithoutTag as { tag?: string }).tag;
    const expectedTag = createHmac('sha256', secret)
      .update(JSON.stringify(payloadWithoutTag), 'utf8')
      .digest('hex');

    expect(envelope.tag).toBe(expectedTag);
  });

  it('signs dispatch envelope with payloadDigest and valid tag for run and lookup actions', () => {
    const requestPayload = { foo: 'bar', n: 42 };
    const runDispatch = signDispatchEnvelope({
      action: 'run',
      callerId: 'hirearchy-app-caller',
      keyId: 'dispatch-key-1',
      secret,
      sessionRef: 'sess_123',
      requestId: 'req_001',
      requestPayload,
      issuedAtMs: 1700000000000,
    });

    expect(runDispatch.version).toBe(1);
    expect(runDispatch.payloadDigest).toBe(
      createHash('sha256').update(JSON.stringify(requestPayload)).digest('hex'),
    );
    expect(runDispatch.tag).toHaveLength(64);

    const lookupDispatch = signDispatchEnvelope({
      action: 'lookup',
      callerId: 'hirearchy-app-caller',
      keyId: 'dispatch-key-1',
      secret,
      sessionRef: 'sess_123',
      requestId: 'req_001',
      requestPayload: null,
      issuedAtMs: 1700000000000,
    });

    expect(lookupDispatch.payloadDigest).toBe(
      createHash('sha256').update('null').digest('hex'),
    );
    expect(lookupDispatch.tag).toHaveLength(64);
  });
});

describe('R2.14 Execution Adapters and Backend Selection', () => {
  const admissionKey = {
    callerId: 'hirearchy-app-caller',
    keyId: 'admission-key-1',
    secret: randomBytes(32).toString('hex'),
  };
  const dispatchKey = {
    callerId: 'hirearchy-app-caller',
    keyId: 'dispatch-key-1',
    secret: randomBytes(32).toString('hex'),
  };
  const baseIntent: R214ExecutionIntent = {
    organizationId: '11111111-1111-1111-1111-111111111111',
    sessionId: 'sess_test_123',
    operationId: 'op_exec_test_001',
    requestId: 'req_exec_001',
    assessmentVersion: 'reservation-moves@v3',
    persistedWorkspaceVersion: '2',
    canonicalWorkspaceSnapshotDigest:
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    approvedRecipeId: RESTRICTED_RECIPE_ID,
    approvedRecipeVersion: RESTRICTED_RECIPE_VERSION,
    approvedRecipeDigest: RESTRICTED_RECIPE_DIGEST,
    admittedAt: '2026-10-28T00:00:00.000Z',
    sessionDeadline: '2026-10-28T01:00:00.000Z',
    budgets: {
      timeoutMs: 10_000,
      maxStdoutBytes: 64_000,
      maxStderrBytes: 64_000,
      maxExecutionCount: 10,
    },
    generation: 1,
    fence: 5,
    protocolVersion: R214_PROTOCOL_VERSION,
  };

  it('selects correct adapter via factory', () => {
    const synthetic = getExecutionAdapter('deterministic-synthetic');
    expect(synthetic.provenance).toBe('synthetic-execution-adapter');
    expect(synthetic.isSynthetic).toBe(true);

    const bridge = getExecutionAdapter('restricted-executor');
    expect(bridge.provenance).toBe('restricted-executor-service');
    expect(bridge.isSynthetic).toBe(false);
  });

  it('does not dispatch with missing execution keys', async () => {
    vi.stubEnv('HIREARCHY_ADMISSION_KEY', '');
    vi.stubEnv('HIREARCHY_DISPATCH_KEY', '');
    const handle = vi.fn();
    try {
      const bridge = new RestrictedExecutorBridgeAdapter({
        dispatcher: { handle },
      });
      await expect(
        bridge.execute(baseIntent, { 'test.py': 'pass\n' }),
      ).rejects.toThrow('Execution key is unavailable');
      expect(handle).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('restricted executor bridge maps receipt into factual execution outcome', async () => {
    const mockDispatcher = {
      handle: async (input: unknown) => {
        const typed = input as {
          action: string;
          authorization: unknown;
          request: { recipeId: string };
        };
        expect(typed.action).toBe('run');
        expect(typed.authorization).toBeDefined();
        expect(typed.request.recipeId).toBe(RESTRICTED_RECIPE_ID);

        return {
          receiptId: 'rcpt_12345',
          admission: {
            callerId: 'hirearchy-app-caller',
            keyId: 'admission-key-1',
            verified: true,
          },
          requestId: baseIntent.requestId,
          operationId: baseIntent.operationId,
          generation: baseIntent.generation,
          fence: baseIntent.fence,
          sessionRef: baseIntent.sessionId,
          scenarioRef: RESTRICTED_APPROVED_SCENARIO_REF,
          scenarioVersion: RESTRICTED_APPROVED_SCENARIO_VERSION,
          snapshotDigest: computeCanonicalSnapshotDigest({
            'test.py': 'def test_moves(): pass\n',
          }),
          recipeId: RESTRICTED_RECIPE_ID,
          recipeVersion: RESTRICTED_RECIPE_VERSION,
          recipeDigest: RESTRICTED_RECIPE_DIGEST,
          status: 'completed',
          exitCode: 0,
          timedOut: false,
          startedAt: '2026-10-28T12:00:00.000Z',
          endedAt: '2026-10-28T12:00:00.450Z',
          stdout: {
            base64: Buffer.from('pytest 3 passed\n').toString('base64'),
            byteCount: 16,
            truncated: false,
            sha256: createHash('sha256')
              .update('pytest 3 passed\n')
              .digest('hex'),
          },
          stderr: {
            base64: '',
            byteCount: 0,
            truncated: false,
            sha256: createHash('sha256').update('').digest('hex'),
          },
          cleanup: {
            verified: true,
            containerRemoved: true,
            lateCreatePossible: false,
          },
        };
      },
    };

    const bridgeAdapter = new RestrictedExecutorBridgeAdapter({
      dispatcher: mockDispatcher,
      admissionKey,
      dispatchKey,
    });

    const outcome = await bridgeAdapter.execute(baseIntent, {
      'test.py': 'def test_moves(): pass\n',
    });

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.provenance).toBe('restricted-executor-service');
    expect(outcome.isSynthetic).toBe(false);
    expect(outcome.isUnknown).toBe(false);
    expect(outcome.stdout).toBe('pytest 3 passed\n');
    expect(outcome.stderr).toBe('');
    expect(outcome.cleanupStatus).toBe('CLEAN');
    expect(outcome.resourceUsage.durationMs).toBe(450);
  });

  it('restricted executor bridge preserves UNKNOWN on dispatcher error', async () => {
    const mockDispatcher = {
      handle: async () => {
        const error = Object.assign(
          new Error('Execution state could not be determined'),
          {
            code: 'EXECUTION_UNKNOWN',
          },
        );
        throw error;
      },
    };

    const bridgeAdapter = new RestrictedExecutorBridgeAdapter({
      dispatcher: mockDispatcher,
      admissionKey,
      dispatchKey,
    });

    const outcome = await bridgeAdapter.execute(baseIntent, {
      'test.py': 'def test_moves(): pass\n',
    });

    expect(outcome.status).toBe('UNKNOWN');
    expect(outcome.isUnknown).toBe(true);
    expect(outcome.cleanupStatus).toBe('UNKNOWN');
    expect(outcome.provenance).toBe('restricted-executor-service');
    expect(outcome.isSynthetic).toBe(false);
    expect(outcome.exitCode).toBeNull();
  });

  it('treats an unverifiable receipt and a lost response as UNKNOWN', async () => {
    for (const dispatcher of [
      { handle: async () => ({ receiptId: 'wrong-request' }) },
      {
        handle: async () => {
          throw new Error('connection lost');
        },
      },
    ]) {
      const bridge = new RestrictedExecutorBridgeAdapter({
        dispatcher,
        admissionKey,
        dispatchKey,
      });
      const outcome = await bridge.execute(baseIntent, { 'test.py': 'pass\n' });
      expect(outcome.status).toBe('UNKNOWN');
      expect(outcome.isUnknown).toBe(true);
      expect(outcome.cleanupStatus).toBe('UNKNOWN');
    }
  });
});

describe('R2.14 Candidate Execution API Route Handlers', () => {
  const configure = () => {
    const values = {
      NODE_ENV: 'test',
      HIREARCHY_R23_DISPOSABLE: '1',
      HIREARCHY_R26_DISPOSABLE: '1',
      R23_PUBLIC_ORIGIN: 'https://127.0.0.1:4443',
      R23_AUTH_URL: 'http://127.0.0.1:9999',
      R23_AUTH_ISSUER: 'https://auth.example.test/auth/v1',
      R23_AUTH_AUDIENCE: 'authenticated',
      R23_DATABASE_URL:
        'postgres://r23_gateway:synthetic@127.0.0.1:5432/postgres',
      R23_SESSION_KEY: Buffer.alloc(32, 7).toString('base64'),
      R23_APP_SESSION_TTL_SECONDS: '900',
      R26_DATABASE_URL:
        'postgres://app_candidate_gateway:synthetic@127.0.0.1:5432/postgres',
    };
    for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects invalid sessionId with 404 ASSESSMENT_NOT_FOUND', async () => {
    const req = new Request(
      'http://localhost/r26/api/candidate/bad_id/execution',
      {
        method: 'GET',
      },
    );
    const res = await r214CandidateExecutionRead(req, 'bad_id');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('ASSESSMENT_NOT_FOUND');
  });

  it('rejects execution action when R26 candidate environment is disabled', async () => {
    vi.stubEnv('HIREARCHY_R26_DISPOSABLE', '');
    const req = new Request(
      'https://127.0.0.1:4443/r26/api/candidate/sess_valid_session_123/execution',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requestId: 'req_123',
          expectedWorkspaceDigest: 'a'.repeat(64),
        }),
      },
    );
    const res = await r214CandidateExecutionAction(
      req,
      'sess_valid_session_123',
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('ASSESSMENT_NOT_FOUND');
  });

  it('rejects missing or malformed candidate bearer token', async () => {
    configure();

    const reqNoAuth = new Request(
      'https://127.0.0.1:4443/r26/api/candidate/sess_valid_session_123/execution',
      {
        method: 'GET',
      },
    );
    const resNoAuth = await r214CandidateExecutionRead(
      reqNoAuth,
      'sess_valid_session_123',
    );
    expect(resNoAuth.status).toBe(401);
    const bodyNoAuth = await resNoAuth.json();
    expect(bodyNoAuth.error.code).toBe('CANDIDATE_ACCESS_DENIED');

    const reqBadBearer = new Request(
      'https://127.0.0.1:4443/r26/api/candidate/sess_valid_session_123/execution',
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer bad token with spaces!',
        },
      },
    );
    const resBadBearer = await r214CandidateExecutionRead(
      reqBadBearer,
      'sess_valid_session_123',
    );
    expect(resBadBearer.status).toBe(401);
    const bodyBadBearer = await resBadBearer.json();
    expect(bodyBadBearer.error.code).toBe('CANDIDATE_ACCESS_DENIED');
  });

  it('enforces origin checks on action requests', async () => {
    configure();

    const reqForeignOrigin = new Request(
      'https://127.0.0.1:4443/r26/api/candidate/sess_valid_session_123/execution',
      {
        method: 'POST',
        headers: {
          origin: 'http://evil.com',
          authorization: `Bearer ${Buffer.alloc(32, 1).toString('base64url')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requestId: 'req_123',
          expectedWorkspaceDigest: 'a'.repeat(64),
        }),
      },
    );
    const resForeignOrigin = await r214CandidateExecutionAction(
      reqForeignOrigin,
      'sess_valid_session_123',
    );
    expect(resForeignOrigin.status).toBe(403);
    const body = await resForeignOrigin.json();
    expect(body.error.code).toBe('ORIGIN_DENIED');
  });

  it('validates request payload structure and rejects invalid payloads', async () => {
    configure();

    const validToken = Buffer.alloc(32, 1).toString('base64url');

    // Non-JSON content type
    const reqNonJson = new Request(
      'https://127.0.0.1:4443/r26/api/candidate/sess_valid_session_123/execution',
      {
        method: 'POST',
        headers: {
          origin: 'https://127.0.0.1:4443',
          authorization: `Bearer ${validToken}`,
          'content-type': 'text/plain',
        },
        body: 'plain text',
      },
    );
    const resNonJson = await r214CandidateExecutionAction(
      reqNonJson,
      'sess_valid_session_123',
    );
    expect(resNonJson.status).toBe(400);

    // Missing required fields
    const reqMissingFields = new Request(
      'https://127.0.0.1:4443/r26/api/candidate/sess_valid_session_123/execution',
      {
        method: 'POST',
        headers: {
          origin: 'https://127.0.0.1:4443',
          authorization: `Bearer ${validToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requestId: 'req_123' }),
      },
    );
    const resMissingFields = await r214CandidateExecutionAction(
      reqMissingFields,
      'sess_valid_session_123',
    );
    expect(resMissingFields.status).toBe(400);
    const bodyMissing = await resMissingFields.json();
    expect(bodyMissing.error.code).toBe('INVALID_REQUEST');
  });
});
