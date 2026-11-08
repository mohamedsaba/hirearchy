import { isIP } from 'node:net';

import { readR23Config, r23IsEnabled } from '../r23-auth/config';
import { isAuthenticatedStaging } from '../runtime/profile';

export type R26Config = Readonly<{
  databaseUrl: string;
  publicOrigin: string;
  profile: 'durable-staging' | 'disposable';
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

export function r26CandidatePageIsAvailable(): boolean {
  return isAuthenticatedStaging() || r26IsEnabled();
}

function configuredCandidateUrl(configuredUrl: string): URL {
  if (!configuredUrl || configuredUrl.length > 4096) {
    throw new R26ConfigurationError();
  }
  try {
    return new URL(configuredUrl);
  } catch {
    throw new R26ConfigurationError();
  }
}

function requiredStagingOrigin(): string {
  const configuredOrigin = process.env.STAGING_PUBLIC_ORIGIN;
  if (!configuredOrigin || configuredOrigin.length > 2048) {
    throw new R26ConfigurationError();
  }
  let origin: URL;
  try {
    origin = new URL(configuredOrigin);
  } catch {
    throw new R26ConfigurationError();
  }
  if (
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && isLoopback(origin.hostname))) ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new R26ConfigurationError();
  }
  return origin.origin;
}

function readDurableStagingConfig(): R26Config {
  const candidateDatabase = configuredCandidateUrl(
    process.env.STAGING_CANDIDATE_DATABASE_URL ?? '',
  );
  let recruiterDatabase: URL;
  try {
    recruiterDatabase = new URL(process.env.STAGING_DATABASE_URL ?? '');
  } catch {
    throw new R26ConfigurationError();
  }

  if (
    !['postgres:', 'postgresql:'].includes(candidateDatabase.protocol) ||
    !isLoopback(candidateDatabase.hostname) ||
    !candidateDatabase.port ||
    candidateDatabase.username !== 'app_candidate_gateway' ||
    !candidateDatabase.password ||
    candidateDatabase.pathname.length <= 1 ||
    !['postgres:', 'postgresql:'].includes(recruiterDatabase.protocol) ||
    !isLoopback(recruiterDatabase.hostname) ||
    !recruiterDatabase.port ||
    recruiterDatabase.username !== 'r23_gateway' ||
    !recruiterDatabase.password ||
    recruiterDatabase.pathname.length <= 1 ||
    recruiterDatabase.protocol !== candidateDatabase.protocol ||
    recruiterDatabase.hostname !== candidateDatabase.hostname ||
    recruiterDatabase.port !== candidateDatabase.port ||
    recruiterDatabase.pathname !== candidateDatabase.pathname ||
    recruiterDatabase.search !== candidateDatabase.search ||
    recruiterDatabase.hash !== candidateDatabase.hash
  ) {
    throw new R26ConfigurationError();
  }

  return Object.freeze({
    databaseUrl: candidateDatabase.toString(),
    publicOrigin: requiredStagingOrigin(),
    profile: 'durable-staging',
  });
}

export function readR26Config(): R26Config | null {
  if (isAuthenticatedStaging()) return readDurableStagingConfig();
  if (!r26IsEnabled()) return null;

  const r23 = readR23Config();
  if (!r23) return null;

  const candidateDatabase = configuredCandidateUrl(
    process.env.R26_DATABASE_URL ?? '',
  );
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
    profile: 'disposable',
  });
}
