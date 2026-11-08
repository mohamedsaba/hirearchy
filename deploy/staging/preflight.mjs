import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';

/** @typedef {{ name: string, passed: boolean, message: string }} PreflightCheckResult */

const expectedDatabaseUsers = new Map([
  ['STAGING_ADMIN_DATABASE_URL', 'postgres'],
  ['STAGING_MIGRATOR_DATABASE_URL', 'hirearchy_migrator'],
  ['STAGING_DATABASE_URL', 'r23_gateway'],
  ['STAGING_CANDIDATE_DATABASE_URL', 'app_candidate_gateway'],
]);

function add(results, name, passed, message) {
  results.push({ name, passed, message });
}

function isLoopback(hostname) {
  const address = hostname.replace(/^\[|\]$/g, '');
  return (
    address === '::1' || (isIP(address) === 4 && address.startsWith('127.'))
  );
}

function validHostname(value) {
  if (!value) return false;
  try {
    const url = new URL(`https://${value}`);
    return (
      url.hostname === value &&
      !url.port &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validateDatabaseUrl(env, name, username) {
  const value = env[name];
  if (!value) return `${name} is missing`;
  try {
    const url = new URL(value);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !isLoopback(url.hostname) ||
      !url.port ||
      url.port !== String(env.PG_PORT) ||
      url.username !== username ||
      !url.password ||
      url.pathname !== '/postgres' ||
      url.search ||
      url.hash
    ) {
      return `${name} must target loopback PostgreSQL as ${username} on database postgres`;
    }
    return null;
  } catch {
    return `${name} is not a valid PostgreSQL URL`;
  }
}

function validateHttpsOrigin(value, name) {
  if (!value) return `${name} is missing`;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return `${name} must be an HTTPS origin without credentials, port, path, or query`;
    }
    return null;
  } catch {
    return `${name} is not a valid HTTPS origin`;
  }
}

function validStagingPublicOrigin(value, hostname, httpsPort) {
  try {
    const url = new URL(value ?? '');
    const expectedPort = Number(httpsPort) === 443 ? '' : String(httpsPort);
    return (
      url.protocol === 'https:' &&
      url.hostname === hostname &&
      url.port === expectedPort &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function portsAreValid(env, names) {
  const ports = names.map((name) => Number(env[name]));
  return (
    ports.every(
      (port) => Number.isInteger(port) && port >= 1 && port <= 65535,
    ) && new Set(ports).size === ports.length
  );
}

function accessCidrsAreRestricted(value) {
  const cidrs = (value ?? '').trim().split(/\s+/).filter(Boolean);
  return (
    cidrs.length > 0 &&
    cidrs.every((cidr) => {
      const [address, prefix, ...extra] = cidr.split('/');
      const family = isIP(address);
      const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : 0;
      const prefixLength = prefix === undefined ? maxPrefix : Number(prefix);
      return (
        family !== 0 &&
        extra.length === 0 &&
        Number.isInteger(prefixLength) &&
        prefixLength >= 1 &&
        prefixLength <= maxPrefix
      );
    })
  );
}

/**
 * Validate the operator-provided deployment environment without printing secret values.
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {{ dockerComposeVersion?: string, checkoutSha?: string, workingTreeClean?: boolean }} [evidence]
 * @returns {PreflightCheckResult[]}
 */
export function runPreflightChecks(env = process.env, evidence = {}) {
  const results = [];
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  add(
    results,
    'Node.js runtime >= 22',
    nodeMajor >= 22,
    `Running Node.js v${process.versions.node}`,
  );

  try {
    const docker =
      evidence.dockerComposeVersion ??
      execFileSync('docker', ['compose', 'version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    add(results, 'Docker Compose v2 available', true, docker);
  } catch {
    add(
      results,
      'Docker Compose v2 available',
      false,
      'Install Docker Engine and the Compose v2 plugin',
    );
  }

  const releaseSha = env.HIREARCHY_RELEASE_SHA ?? '';
  let checkoutSha = '';
  let workingTreeClean = false;
  try {
    checkoutSha =
      evidence.checkoutSha ??
      execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    workingTreeClean =
      evidence.workingTreeClean ??
      execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() === '';
  } catch {
    // Report a failed provenance check below without exposing command output.
  }
  const provenanceValid =
    /^[0-9a-f]{40}$/.test(releaseSha) &&
    releaseSha === checkoutSha &&
    workingTreeClean;
  add(
    results,
    'Release provenance matches clean checked-out commit',
    provenanceValid,
    provenanceValid
      ? `Compose image tag is ${releaseSha}`
      : 'Set HIREARCHY_RELEASE_SHA to the exact commit and use a clean checkout',
  );

  const mode = env.HIREARCHY_DEPLOY_MODE ?? 'supervised-alpha';
  add(
    results,
    'Deployment mode is recognized',
    mode === 'public-preview' || mode === 'supervised-alpha',
    mode === 'public-preview' || mode === 'supervised-alpha'
      ? `Selected ${mode}`
      : 'Use public-preview or supervised-alpha',
  );

  const proxyHopsValid =
    env.HIREARCHY_TRUSTED_PROXY_HOPS === undefined ||
    env.HIREARCHY_TRUSTED_PROXY_HOPS === '0';
  add(
    results,
    'Trusted proxy hops stay disabled',
    proxyHopsValid,
    proxyHopsValid
      ? 'Client identity does not trust proxy-supplied headers'
      : 'Must be unset or 0; upstream proxies are not configured as trusted',
  );

  const caddyBind = (env.CADDY_BIND_ADDRESS ?? '').trim().split(/\s+/);
  const caddyBindValid =
    (caddyBind.length === 1 && caddyBind[0] === '127.0.0.1') ||
    (caddyBind.length === 2 &&
      caddyBind[0] === '0.0.0.0' &&
      caddyBind[1] === '::');
  add(
    results,
    'Caddy bind address is explicit',
    caddyBindValid,
    caddyBindValid
      ? caddyBind[0] === '127.0.0.1'
        ? 'Loopback-only listener for rehearsal'
        : 'Public IPv4 and IPv6 listeners require approved activation'
      : 'Use 127.0.0.1 for rehearsal or 0.0.0.0 :: for approved public activation',
  );

  add(
    results,
    'Compose project name is isolated',
    /^[a-z0-9][a-z0-9_-]{0,62}$/.test(env.COMPOSE_PROJECT_NAME ?? ''),
    /^[a-z0-9][a-z0-9_-]{0,62}$/.test(env.COMPOSE_PROJECT_NAME ?? '')
      ? 'Persistent volumes are scoped to this Compose project'
      : 'Set a lowercase Compose project name outside shared test projects',
  );

  const previewHostnameValid = validHostname(env.PREVIEW_HOSTNAME ?? '');
  add(
    results,
    'Preview hostname is valid',
    previewHostnameValid,
    previewHostnameValid
      ? 'Valid preview hostname'
      : 'Set a hostname without a scheme, path, or port',
  );

  const previewPorts = [
    'PREVIEW_APP_PORT',
    'CADDY_HTTP_PORT',
    'CADDY_HTTPS_PORT',
  ];
  const allPorts = ['PG_PORT', 'GOTRUE_API_PORT', 'APP_PORT', ...previewPorts];
  const relevantPorts = mode === 'public-preview' ? previewPorts : allPorts;
  const portNamesValid = portsAreValid(env, relevantPorts);
  add(
    results,
    'Service ports are valid and unique',
    portNamesValid,
    portNamesValid
      ? 'All configured listener ports are unique'
      : 'Set distinct TCP ports between 1 and 65535',
  );

  if (mode === 'public-preview') return results;
  if (mode !== 'supervised-alpha') return results;

  for (const [name, username] of expectedDatabaseUsers) {
    const error = validateDatabaseUrl(env, name, username);
    add(results, `${name} loopback URL`, !error, error ?? 'Valid loopback URL');
  }

  for (const name of ['PG_BIND_ADDRESS', 'AUTH_BIND_ADDRESS']) {
    const value = env[name];
    add(
      results,
      `${name} is loopback-only`,
      value === '127.0.0.1',
      value === '127.0.0.1'
        ? 'Bound to IPv4 loopback'
        : 'Must be exactly 127.0.0.1 for the supported host-network recipe',
    );
  }

  let authOk = false;
  try {
    const url = new URL(env.STAGING_AUTH_URL ?? '');
    authOk =
      url.protocol === 'http:' &&
      isLoopback(url.hostname) &&
      Boolean(url.port) &&
      url.port === String(env.GOTRUE_API_PORT) &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
  } catch {
    authOk = false;
  }
  add(
    results,
    'STAGING_AUTH_URL is loopback-only',
    authOk,
    authOk
      ? 'Valid loopback GoTrue URL'
      : 'Must be an HTTP URL on loopback at GOTRUE_API_PORT',
  );

  const authIssuerError = validateHttpsOrigin(
    env.STAGING_AUTH_ISSUER,
    'STAGING_AUTH_ISSUER',
  );
  add(
    results,
    'STAGING_AUTH_ISSUER is a public HTTPS origin',
    !authIssuerError &&
      env.STAGING_AUTH_ISSUER === `https://${env.STAGING_HOSTNAME}`,
    !authIssuerError &&
      env.STAGING_AUTH_ISSUER === `https://${env.STAGING_HOSTNAME}`
      ? 'Issuer matches the staging hostname'
      : (authIssuerError ?? 'Issuer must match https://STAGING_HOSTNAME'),
  );
  add(
    results,
    'STAGING_AUTH_AUDIENCE is authenticated',
    env.STAGING_AUTH_AUDIENCE === 'authenticated',
    env.STAGING_AUTH_AUDIENCE === 'authenticated'
      ? 'GoTrue audience matches the application'
      : 'Must equal authenticated',
  );
  const stagingPublicOriginValid = validStagingPublicOrigin(
    env.STAGING_PUBLIC_ORIGIN,
    env.STAGING_HOSTNAME ?? '',
    env.CADDY_HTTPS_PORT,
  );
  add(
    results,
    'STAGING_PUBLIC_ORIGIN matches the HTTPS proxy origin',
    stagingPublicOriginValid,
    stagingPublicOriginValid
      ? 'Candidate links and browser Origin checks match Caddy TLS'
      : 'Set the HTTPS origin for STAGING_HOSTNAME and include the CADDY_HTTPS_PORT when it is nonstandard',
  );

  const jwtSecret = env.GOTRUE_JWT_SECRET ?? '';
  add(
    results,
    'GOTRUE_JWT_SECRET is 32 bytes of hex',
    /^[0-9a-f]{64}$/i.test(jwtSecret),
    /^[0-9a-f]{64}$/i.test(jwtSecret)
      ? 'Valid 256-bit secret'
      : 'Generate a 64-character hex secret with openssl rand -hex 32',
  );

  const proofKey = env.STAGING_PROOF_PRIVATE_KEY ?? '';
  let proofKeyValid = false;
  try {
    const der = Buffer.from(proofKey, 'base64');
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    proofKeyValid =
      der.toString('base64') === proofKey &&
      key.asymmetricKeyType === 'ed25519';
  } catch {
    proofKeyValid = false;
  }
  add(
    results,
    'STAGING_PROOF_PRIVATE_KEY is canonical Ed25519 PKCS#8',
    proofKeyValid,
    proofKeyValid
      ? 'Valid Ed25519 private key'
      : 'Provide a base64 PKCS#8 DER Ed25519 private key',
  );

  const candidateKey = env.HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY ?? '';
  const candidateBytes = Buffer.from(candidateKey, 'base64');
  const candidateKeyValid =
    candidateBytes.length === 32 &&
    candidateBytes.toString('base64') === candidateKey;
  add(
    results,
    'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY is canonical 32-byte base64',
    candidateKeyValid,
    candidateKeyValid
      ? 'Valid 256-bit encryption key'
      : 'Provide canonical base64 for exactly 32 random bytes',
  );

  const proofIssuer = env.STAGING_PROOF_ISSUER ?? '';
  const proofAudience = env.STAGING_PROOF_AUDIENCE ?? '';
  const keyId = env.STAGING_PROOF_KEY_ID ?? '';
  const proofMetadataValid =
    /^[A-Za-z0-9._-]{1,128}$/.test(keyId) &&
    proofIssuer.length > 0 &&
    proofIssuer.length <= 256 &&
    proofAudience.length > 0 &&
    proofAudience.length <= 256;
  add(
    results,
    'Staging proof issuer, audience, and key ID configured',
    proofMetadataValid,
    proofMetadataValid
      ? 'Proof metadata is valid'
      : 'Provide bounded issuer/audience and a valid key ID',
  );

  const passwordNames = [
    'POSTGRES_PASSWORD',
    'GOTRUE_DB_PASSWORD',
    'MIGRATOR_DATABASE_PASSWORD',
    'R23_GATEWAY_PASSWORD',
    'CANDIDATE_GATEWAY_PASSWORD',
    'APP_EVALUATOR_PASSWORD',
    'CONTROL_WORKER_PASSWORD',
  ];
  const missingPasswords = passwordNames.filter(
    (name) => !/^[0-9a-f]{64}$/i.test(env[name] ?? ''),
  );
  add(
    results,
    'PostgreSQL role passwords are generated values',
    missingPasswords.length === 0,
    missingPasswords.length === 0
      ? 'All PostgreSQL passwords have the expected 256-bit hex form'
      : `Generate 64-character hex values for: ${missingPasswords.join(', ')}`,
  );

  const stagingHostnameValid = validHostname(env.STAGING_HOSTNAME ?? '');
  const distinctHostnames = env.PREVIEW_HOSTNAME !== env.STAGING_HOSTNAME;
  add(
    results,
    'Staging hostname is valid and separate',
    stagingHostnameValid && distinctHostnames,
    stagingHostnameValid && distinctHostnames
      ? 'Preview and staging use separate hostnames'
      : 'Use a valid staging hostname distinct from preview',
  );

  const accessBoundaryValid = accessCidrsAreRestricted(
    env.STAGING_ALLOWED_CIDRS,
  );
  add(
    results,
    'Staging edge allowlist is restricted',
    accessBoundaryValid,
    accessBoundaryValid
      ? 'Caddy denies requests outside the explicit team/VPN CIDRs'
      : 'Provide valid team/VPN CIDRs; wildcard and /0 ranges are rejected',
  );

  return results;
}

if (process.argv[1] && process.argv[1].endsWith('preflight.mjs')) {
  console.log('--- Hirearchy Deployment Preflight ---');
  const checks = runPreflightChecks();
  for (const check of checks) {
    console.log(`${check.passed ? '✓' : '✗'} ${check.name}: ${check.message}`);
  }
  process.exit(checks.every((check) => check.passed) ? 0 : 1);
}
