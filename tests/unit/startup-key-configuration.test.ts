import { afterEach, describe, expect, it, vi } from 'vitest';

const { getCookie, getService, startSweeper, verifyStorage } = vi.hoisted(
  () => ({
    getCookie: vi.fn(),
    getService: vi.fn(),
    startSweeper: vi.fn(),
    verifyStorage: vi.fn(),
  }),
);
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: getCookie }),
}));
vi.mock('../../apps/web/src/sessions/session-timeout-sweeper', () => ({
  startSessionTimeoutSweeper: startSweeper,
}));
vi.mock('../../apps/web/src/sessions/session-service', () => ({
  getSessionService: getService,
  getSessionServiceForStartup: () => ({
    verifyStorageForStartup: verifyStorage,
  }),
}));

import { POST as createAssessment } from '../../apps/web/app/api/evaluator/assessments/route';
import { createSignedEvaluatorToken } from '../../apps/web/src/access/evaluator-access';
import { supportedAssessmentSelection } from '../../apps/web/src/assessments/assessment-options';
import { register } from '../../apps/web/instrumentation';
import {
  getApplicationStartupStatus,
  markApplicationStartupReady,
} from '../../apps/web/src/startup-status';

describe('startup candidate-token key configuration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    markApplicationStartupReady();
  });

  it.each([undefined, 'invalid-key'])(
    'rejects %s before database reconciliation',
    async (key) => {
      vi.stubEnv('NEXT_RUNTIME', 'nodejs');
      vi.stubEnv('HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY', key);
      await register();
      expect(startSweeper).not.toHaveBeenCalled();
      expect(verifyStorage).not.toHaveBeenCalled();
      expect(getApplicationStartupStatus()).toEqual({
        state: 'failed',
        failure: 'candidate_token_storage',
      });
    },
  );

  it('starts reconciliation with an explicitly configured synthetic key', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv(
      'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY',
      Buffer.alloc(32, 0x74).toString('base64'),
    );
    await register();
    expect(verifyStorage).toHaveBeenCalledOnce();
    expect(startSweeper).toHaveBeenCalledOnce();
    expect(getApplicationStartupStatus()).toEqual({ state: 'ready' });
  });

  it('keeps issuance unavailable while reconciliation is pending, then allows it after success', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv(
      'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY',
      Buffer.alloc(32, 0x74).toString('base64'),
    );
    vi.stubEnv('HIREARCHY_EVALUATOR_KEY', 'startup-test-evaluator-key');
    getCookie.mockReturnValue({
      value: createSignedEvaluatorToken('startup-test-evaluator-key'),
    });
    getService.mockReturnValue({
      createSession: () => ({
        candidateToken: 'synthetic-candidate-token',
        session: {
          id: 'synthetic-session',
          scenario: {
            id: 'scenario-002-booking-notification-retry',
            version: '1.0.0',
            title: 'Synthetic scenario',
          },
          durationSeconds: 1800,
          terminalEnabled: true,
          taskRubricSnapshot: null,
        },
      }),
    });

    let finishReconciliation!: () => void;
    startSweeper.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishReconciliation = resolve;
      }),
    );
    const registration = register();
    for (
      let attempt = 0;
      attempt < 10 && !startSweeper.mock.calls.length;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(startSweeper).toHaveBeenCalledOnce();

    const makeRequest = () =>
      new Request('http://localhost/api/evaluator/assessments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...supportedAssessmentSelection,
          integratedAi: false,
          useCuratedBlueprint: true,
        }),
      });
    const pending = await createAssessment(makeRequest());
    expect(pending.status).toBe(503);

    finishReconciliation();
    await registration;
    const ready = await createAssessment(makeRequest());
    expect(ready.status).toBe(201);
    expect(getApplicationStartupStatus()).toEqual({ state: 'ready' });
  });

  it('records failed reconciliation without logging exception details', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv(
      'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY',
      Buffer.alloc(32, 0x74).toString('base64'),
    );
    const secretDetails = 'sqlite:///private/path?key=synthetic-secret';
    startSweeper.mockRejectedValueOnce(new Error(secretDetails));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await register();

    expect(getApplicationStartupStatus()).toEqual({
      state: 'failed',
      failure: 'reconciliation',
    });
    expect(log).toHaveBeenCalledWith(
      'Application startup initialization failed [reconciliation]',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(secretDetails);
  });

  it('does not initialize Node services in another runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY', undefined);
    await register();
    expect(startSweeper).not.toHaveBeenCalled();
  });
});
