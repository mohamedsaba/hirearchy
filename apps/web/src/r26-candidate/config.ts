import { isIP } from 'node:net';

import { readR23Config, r23IsEnabled } from '../r23-auth/config';

export type R26Config = Readonly<{
  databaseUrl: string;
  publicOrigin: string;
}>;

export class R26ConfigurationError extends Error {
  readonly code = 'R26_CONFIGURATION_UNAVAILABLE';

  constructor() {
    super('The isolated candidate workspace is unavailable.');
    this.name = 'R26ConfigurationError';
  }
}

const isLoopback = (hostname: string) => {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  if (host === '::1') return true;
  if (isIP(host) !== 4) return false;
  return Number(host.split('.')[0]) === 127;
};

export function r26IsEnabled(): boolean {
  return process.env.HIREARCHY_R26_DISPOSABLE === '1' && r23IsEnabled();
}

export function readR26Config(): R26Config | null {
  if (!r26IsEnabled()) return null;

  const r23 = readR23Config();
  if (!r23) return null;

  const configuredUrl = process.env.R26_DATABASE_URL;
  if (!configuredUrl || configuredUrl.length > 4096) {
    throw new R26ConfigurationError();
  }

  let candidateDatabase: URL;
  try {
    candidateDatabase = new URL(configuredUrl);
  } catch {
    throw new R26ConfigurationError();
  }

  let evaluatorDatabase: URL;
  try {
    evaluatorDatabase = new URL(r23.databaseUrl);
  } catch {
    throw new R26ConfigurationError();
  }

  if (
    !['postgres:', 'postgresql:'].includes(candidateDatabase.protocol) ||
    !isLoopback(candidateDatabase.hostname) ||
    candidateDatabase.hostname !== evaluatorDatabase.hostname ||
    candidateDatabase.port !== evaluatorDatabase.port ||
    candidateDatabase.username !== 'app_candidate_gateway' ||
    !candidateDatabase.password ||
    candidateDatabase.pathname !== '/postgres' ||
    candidateDatabase.search ||
    candidateDatabase.hash
  ) {
    throw new R26ConfigurationError();
  }

  return Object.freeze({
    databaseUrl: candidateDatabase.toString(),
    publicOrigin: r23.publicOrigin,
  });
}
