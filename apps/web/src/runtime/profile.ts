export const isAuthenticatedStaging = () =>
  process.env.HIREARCHY_RUNTIME_PROFILE === 'staging-authenticated';

export const isPublicPreview = () =>
  process.env.HIREARCHY_RUNTIME_PROFILE === 'public-preview';

// Restricted profiles deny legacy execution, AI and initialization paths.
export const isStagingLockdown = () =>
  process.env.HIREARCHY_RUNTIME_PROFILE === 'staging-lockdown' ||
  isAuthenticatedStaging() ||
  isPublicPreview();
