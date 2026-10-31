import { getRateLimitIdentityStatus } from './access/trusted-proxy-client-identity';
import { isAuthenticatedStaging, isStagingLockdown } from './runtime/profile';

export type HealthStatus = Readonly<{
  service: 'hirearchy-web';
  status: 'ok';
  readiness: 'not-checked';
  rateLimitIdentity: ReturnType<typeof getRateLimitIdentityStatus>;
  capabilities?: {
    application: 'disabled' | 'restricted';
    execution: 'disabled';
    ai: 'disabled';
  };
}>;

export const getHealthStatus = (): HealthStatus => ({
  service: 'hirearchy-web',
  status: 'ok',
  readiness: 'not-checked',
  // Surfaced so a refused trusted-proxy configuration is visible to operators
  // without having to trigger a login attempt.
  rateLimitIdentity: getRateLimitIdentityStatus(),
  ...(isStagingLockdown()
    ? {
        capabilities: {
          application: isAuthenticatedStaging() ? 'restricted' : 'disabled',
          execution: 'disabled',
          ai: 'disabled',
        } as const,
      }
    : {}),
});
