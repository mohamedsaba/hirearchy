import { getRateLimitIdentityStatus } from './access/trusted-proxy-client-identity';

export type HealthStatus = Readonly<{
  service: 'hirearchy-web';
  status: 'ok';
  readiness: 'not-checked';
  rateLimitIdentity: ReturnType<typeof getRateLimitIdentityStatus>;
}>;

export const getHealthStatus = (): HealthStatus => ({
  service: 'hirearchy-web',
  status: 'ok',
  readiness: 'not-checked',
  // Surfaced so a refused trusted-proxy configuration is visible to operators
  // without having to trigger a login attempt.
  rateLimitIdentity: getRateLimitIdentityStatus(),
});
