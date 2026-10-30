export const isStagingLockdown = () =>
  process.env.HIREARCHY_RUNTIME_PROFILE === 'staging-lockdown';
