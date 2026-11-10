export type FounderUatProfileConfiguration = Readonly<{
  appOrigin: URL;
  authUrl: URL;
  authIssuer: string;
  authAudience: string;
  databaseUrl: URL;
  mailpitApiUrl: URL;
}>;

function isLoopback(hostname: string): boolean {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  if (host === '::1') return true;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  const octets = host.split('.').map(Number);
  return octets[0] === 127 && octets.every((octet) => octet <= 255);
}

function environmentUrl(
  name: string,
  protocols: readonly string[],
  rootOnly: boolean,
): URL | null {
  const value = process.env[name];
  if (!value || value.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !protocols.includes(url.protocol) ||
    !isLoopback(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (rootOnly && url.pathname !== '/')
  ) {
    return null;
  }
  return url;
}

export const isFounderUatProfile = () =>
  process.env.HIREARCHY_RUNTIME_PROFILE === 'founder-uat';

export function readFounderUatProfileConfiguration(): FounderUatProfileConfiguration | null {
  if (!isFounderUatProfile()) return null;

  const appOrigin = environmentUrl(
    'FOUNDER_UAT_APP_ORIGIN',
    ['http:', 'https:'],
    true,
  );
  const authUrl = environmentUrl('STAGING_AUTH_URL', ['http:', 'https:'], true);
  const mailpitApiUrl = environmentUrl(
    'FOUNDER_UAT_MAILPIT_API_URL',
    ['http:'],
    true,
  );
  const databaseText = process.env.STAGING_DATABASE_URL;
  const authIssuer = process.env.STAGING_AUTH_ISSUER;
  const authAudience = process.env.STAGING_AUTH_AUDIENCE;
  const proofKey = process.env.STAGING_PROOF_PRIVATE_KEY;
  let databaseUrl: URL | null = null;
  try {
    if (databaseText && databaseText.length <= 4096) {
      databaseUrl = new URL(databaseText);
    }
  } catch {
    databaseUrl = null;
  }

  if (
    !appOrigin ||
    appOrigin.origin !== process.env.FOUNDER_UAT_APP_ORIGIN ||
    !authUrl ||
    authUrl.origin !== process.env.STAGING_AUTH_URL ||
    !mailpitApiUrl ||
    mailpitApiUrl.origin !== process.env.FOUNDER_UAT_MAILPIT_API_URL ||
    process.env.STAGING_PUBLIC_ORIGIN !== appOrigin.origin ||
    !authIssuer ||
    !authAudience ||
    !process.env.STAGING_PROOF_ISSUER ||
    !process.env.STAGING_PROOF_AUDIENCE ||
    !process.env.STAGING_PROOF_KEY_ID ||
    !proofKey ||
    proofKey.length > 4096 ||
    !databaseUrl ||
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    !isLoopback(databaseUrl.hostname) ||
    !databaseUrl.port ||
    databaseUrl.username !== 'r23_gateway' ||
    !databaseUrl.password ||
    databaseUrl.pathname !== '/postgres' ||
    databaseUrl.search ||
    databaseUrl.hash
  ) {
    return null;
  }

  let issuer: URL;
  try {
    issuer = new URL(authIssuer);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(issuer.protocol) ||
    !isLoopback(issuer.hostname) ||
    issuer.origin !== authUrl.origin ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  ) {
    return null;
  }

  return Object.freeze({
    appOrigin,
    authUrl,
    authIssuer,
    authAudience,
    databaseUrl,
    mailpitApiUrl,
  });
}

export const isFounderUatEnabled = () =>
  readFounderUatProfileConfiguration() !== null;

export const isAuthenticatedStaging = () =>
  process.env.HIREARCHY_RUNTIME_PROFILE === 'staging-authenticated' ||
  isFounderUatEnabled();

export const isPublicPreview = () =>
  process.env.HIREARCHY_RUNTIME_PROFILE === 'public-preview';

// Restricted profiles deny legacy execution, AI and initialization paths.
// Founder UAT remains locked down even if its strict loopback config is invalid.
export const isStagingLockdown = () =>
  process.env.HIREARCHY_RUNTIME_PROFILE === 'staging-lockdown' ||
  isFounderUatProfile() ||
  isAuthenticatedStaging() ||
  isPublicPreview();
