import { isIP } from 'node:net';

import { isStagingLockdown } from '../runtime/profile';

export const R23_SESSION_COOKIE = '__Host-r23-session';
export const R23_CSRF_COOKIE = '__Host-r23-csrf';
export const R23_CALLBACK_COOKIE = '__Host-r23-callback';

export type R23Config = Readonly<{
  authUrl: URL;
  authIssuer: string;
  authAudience: string;
  databaseUrl: string;
  publicOrigin: string;
  sessionKey: Buffer;
  appSessionTtlSeconds: number;
}>;

export class R23ConfigurationError extends Error {
  readonly code = 'R23_CONFIGURATION_UNAVAILABLE';

  constructor() {
    super('R2.3 Auth lane configuration is unavailable');
    this.name = 'R23ConfigurationError';
  }
}

function isLoopback(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  if (host === '::1') return true;
  if (isIP(host) !== 4) return false;
  return Number(host.split('.')[0]) === 127;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.length > 4096) throw new R23ConfigurationError();
  return value;
}

function loopbackUrl(value: string, protocols: string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new R23ConfigurationError();
  }
  if (
    !protocols.includes(url.protocol) ||
    !isLoopback(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new R23ConfigurationError();
  }
  return url;
}

export function r23IsEnabled(): boolean {
  return (
    !isStagingLockdown() &&
    process.env.NODE_ENV !== 'production' &&
    (process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'test') &&
    process.env.HIREARCHY_R23_DISPOSABLE === '1'
  );
}

export function readR23Config(): R23Config | null {
  if (!r23IsEnabled()) return null;

  const publicOrigin = required('R23_PUBLIC_ORIGIN');
  const origin = loopbackUrl(publicOrigin, ['https:']);
  if (
    origin.pathname !== '/' ||
    origin.origin !== publicOrigin ||
    origin.port.length === 0
  ) {
    throw new R23ConfigurationError();
  }

  const authUrl = loopbackUrl(required('R23_AUTH_URL'), ['http:', 'https:']);
  if (authUrl.pathname !== '/' || authUrl.port.length === 0) {
    throw new R23ConfigurationError();
  }

  let database: URL;
  try {
    database = new URL(required('R23_DATABASE_URL'));
  } catch {
    throw new R23ConfigurationError();
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !isLoopback(database.hostname) ||
    !database.port ||
    database.username !== 'r23_gateway' ||
    !database.password ||
    database.pathname !== '/postgres' ||
    database.search ||
    database.hash
  ) {
    throw new R23ConfigurationError();
  }

  const authIssuer = required('R23_AUTH_ISSUER');
  let issuer: URL;
  try {
    issuer = new URL(authIssuer);
  } catch {
    throw new R23ConfigurationError();
  }
  if (
    !['http:', 'https:'].includes(issuer.protocol) ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  ) {
    throw new R23ConfigurationError();
  }
  const authAudience = required('R23_AUTH_AUDIENCE');
  const encodedKey = required('R23_SESSION_KEY');
  const sessionKey = Buffer.from(encodedKey, 'base64');
  if (
    sessionKey.length !== 32 ||
    sessionKey.toString('base64') !== encodedKey
  ) {
    throw new R23ConfigurationError();
  }

  const ttl = Number(required('R23_APP_SESSION_TTL_SECONDS'));
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
    throw new R23ConfigurationError();
  }

  return Object.freeze({
    authUrl,
    authIssuer,
    authAudience,
    databaseUrl: database.toString(),
    publicOrigin,
    sessionKey,
    appSessionTtlSeconds: ttl,
  });
}
