import {
  markApplicationStartupFailed,
  markApplicationStartupPending,
  markApplicationStartupReady,
} from './src/startup-status';

export const register = async () => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  markApplicationStartupPending();
  let reconciliationStarted = false;

  try {
    const { loadCandidateTokenEncryptionKey } =
      await import('./src/sessions/candidate-token-storage.mjs');
    loadCandidateTokenEncryptionKey();
    const { getSessionServiceForStartup } =
      await import('./src/sessions/session-service');
    const service = getSessionServiceForStartup();
    service.verifyStorageForStartup();
    const { startSessionTimeoutSweeper } =
      await import('./src/sessions/session-timeout-sweeper');
    reconciliationStarted = true;
    await startSessionTimeoutSweeper(service);
    markApplicationStartupReady();
  } catch (error) {
    const errorName = error instanceof Error ? error.name : '';
    const failure =
      errorName === 'CandidateTokenStorageError'
        ? 'candidate_token_storage'
        : errorName === 'SessionReconciliationError' || reconciliationStarted
          ? 'reconciliation'
          : 'database';
    markApplicationStartupFailed(failure);
    console.error(`Application startup initialization failed [${failure}]`);
  }
};
