export const isAuthenticatedStaging = () =>
  process.env.HIREARCHY_RUNTIME_PROFILE === 'staging-authenticated';

// Both staging profiles deny legacy execution, AI and initialization paths.
export const isStagingLockdown = () =>
  process.env.HIREARCHY_RUNTIME_PROFILE === 'staging-lockdown' ||
  isAuthenticatedStaging();
