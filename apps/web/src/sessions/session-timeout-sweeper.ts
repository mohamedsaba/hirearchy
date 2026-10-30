import { getSessionService, type SessionService } from './session-service';

export const SESSION_TIMEOUT_SWEEP_INTERVAL_MS = 1_000;

const GLOBAL_SWEEPER_KEY = Symbol.for('hirearchy.sessionTimeoutSweeper');

type SweeperState = {
  timer?: NodeJS.Timeout;
  running: boolean;
  initialized: Promise<void>;
};

export const startSessionTimeoutSweeper = (
  service: SessionService = getSessionService(),
  intervalMs = SESSION_TIMEOUT_SWEEP_INTERVAL_MS,
): Promise<void> => {
  const target = globalThis as unknown as {
    [GLOBAL_SWEEPER_KEY]?: SweeperState;
  };
  const existing = target[GLOBAL_SWEEPER_KEY];
  if (existing) return existing.initialized;

  const state: SweeperState = {
    running: true,
    initialized: Promise.resolve(),
  };
  target[GLOBAL_SWEEPER_KEY] = state;
  state.initialized = service
    .reconcileSessions()
    .then(() => {
      state.running = false;
      state.timer = setInterval(() => {
        if (state.running) return;
        state.running = true;
        void service
          .sweepTimedOutSessions()
          .then((results) => {
            if (results.some((result) => result.status === 'rejected')) {
              console.error(
                'Session timeout sweep failed [TIMEOUT_SWEEP_FAILED]',
              );
            }
          })
          .catch(() =>
            console.error(
              'Session timeout sweep failed [TIMEOUT_SWEEP_FAILED]',
            ),
          )
          .finally(() => {
            state.running = false;
          });
      }, intervalMs);
      state.timer.unref();
    })
    .catch((error: unknown) => {
      state.running = false;
      console.error('Session reconciliation failed [RECONCILIATION_FAILED]');
      throw error;
    });
  return state.initialized;
};
