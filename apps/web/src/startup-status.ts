export type ApplicationStartupState = 'pending' | 'ready' | 'failed';
export type ApplicationStartupFailure =
  'candidate_token_storage' | 'database' | 'reconciliation' | 'unknown';

export type ApplicationStartupStatus = Readonly<{
  state: ApplicationStartupState;
  failure?: ApplicationStartupFailure;
}>;

export class ApplicationStartupNotReadyError extends Error {
  constructor() {
    super('Application startup checks are not ready.');
    this.name = 'ApplicationStartupNotReadyError';
  }
}

const STARTUP_STATUS_KEY = Symbol.for('hirearchy.applicationStartupStatus');
type StartupGlobal = typeof globalThis & {
  [STARTUP_STATUS_KEY]?: ApplicationStartupStatus;
};

const setStatus = (status: ApplicationStartupStatus) => {
  (globalThis as StartupGlobal)[STARTUP_STATUS_KEY] = status;
};

export const getApplicationStartupStatus = (): ApplicationStartupStatus =>
  (globalThis as StartupGlobal)[STARTUP_STATUS_KEY] ?? { state: 'pending' };

export const markApplicationStartupPending = () =>
  setStatus({ state: 'pending' });

export const markApplicationStartupReady = () => setStatus({ state: 'ready' });

export const markApplicationStartupFailed = (
  failure: ApplicationStartupFailure,
) => setStatus({ state: 'failed', failure });

export const isAssessmentIssuanceReady = () =>
  getApplicationStartupStatus().state === 'ready';

export const assertApplicationStartupReady = () => {
  if (!isAssessmentIssuanceReady()) throw new ApplicationStartupNotReadyError();
};
