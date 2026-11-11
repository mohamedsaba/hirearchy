import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const composeFile = 'deploy/founder-uat/docker-compose.yml';
const automationFile = 'deploy/founder-uat/docker-compose.automation.yml';
const stateRoot = path.join(os.homedir(), '.config/hirearchy/founder-uat');
const ports = [1025, 3000, 5434, 8025, 9997];
const services = ['postgres', 'gotrue', 'mailpit', 'web'];
const systemSecrets = [
  'POSTGRES_PASSWORD',
  'GOTRUE_DB_PASSWORD',
  'MIGRATOR_DATABASE_PASSWORD',
  'R23_GATEWAY_PASSWORD',
  'CANDIDATE_GATEWAY_PASSWORD',
  'APP_EVALUATOR_PASSWORD',
  'CONTROL_WORKER_PASSWORD',
  'GOTRUE_JWT_SECRET',
  'STAGING_PROOF_PRIVATE_KEY',
  'HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY',
  'STAGING_ADMIN_DATABASE_URL',
  'STAGING_MIGRATOR_DATABASE_URL',
  'STAGING_DATABASE_URL',
  'STAGING_CANDIDATE_DATABASE_URL',
  'FOUNDER_UAT_NVIDIA_API_KEY',
];

const modes = {
  persistent: {
    project: 'hirearchy-founder-uat',
    stateName: 'persistent',
  },
  automation: {
    project: 'hirearchy-founder-uat-automation',
    stateName: 'automation',
  },
};

function usage() {
  console.log(
    'Usage: node scripts/founder-uat-runtime.mjs <start|restart|stop|status> <persistent|automation>',
  );
}

function scrub(value, env) {
  let output = String(value ?? '');
  for (const name of systemSecrets) {
    const secret = env[name];
    if (secret) output = output.replaceAll(secret, '[redacted]');
  }
  return output.trim().slice(-1600);
}

function docker(args, { allowFailure = false, env = process.env } = {}) {
  try {
    return execFileSync('docker', args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    }).trim();
  } catch (error) {
    if (allowFailure && error.status !== 0) return '';
    const detail = scrub(error.stderr, env);
    throw new Error(`Docker command failed${detail ? `: ${detail}` : ''}`);
  }
}

function projectContainers(project) {
  return docker([
    'ps',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    'status=running',
  ]);
}

function projectHasState(project) {
  const containers = docker(
    [
      'ps',
      '--all',
      '--quiet',
      '--filter',
      `label=com.docker.compose.project=${project}`,
    ],
    { allowFailure: true },
  );
  const postgresVolume = docker(
    ['volume', 'inspect', `${project}-postgres-data`],
    { allowFailure: true },
  );
  const mailVolume = docker(['volume', 'inspect', `${project}-mailpit-data`], {
    allowFailure: true,
  });
  return Boolean(containers || postgresVolume || mailVolume);
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  assert(
    info.isDirectory() && !info.isSymbolicLink(),
    'Runtime state path must be a real directory',
  );
  if (typeof process.getuid === 'function') {
    assert.equal(
      info.uid,
      process.getuid(),
      'Runtime state directory must be owned by the current user',
    );
  }
  await chmod(directory, 0o700);
}

function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

function formatEnv(env) {
  return `${Object.entries(env)
    .map(([name, value]) => {
      assert.match(name, /^[A-Z][A-Z0-9_]*$/);
      const text = String(value);
      assert(!/[\r\n]/.test(text), 'Runtime values cannot contain newlines');
      assert(
        !text.includes('$'),
        'Runtime values cannot contain Compose interpolation',
      );
      return `${name}=${text}`;
    })
    .join('\n')}\n`;
}

async function writeAtomic(file, contents) {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

async function readState(mode, { createIfMissing = true } = {}) {
  const info = modes[mode];
  const directory = path.join(stateRoot, info.stateName);
  await ensurePrivateDirectory(stateRoot);
  await ensurePrivateDirectory(directory);
  const envPath = path.join(directory, 'runtime.env');
  let values;
  try {
    const envInfo = await lstat(envPath);
    assert(
      envInfo.isFile() && !envInfo.isSymbolicLink(),
      'Runtime env must be a regular file',
    );
    if (typeof process.getuid === 'function') {
      assert.equal(
        envInfo.uid,
        process.getuid(),
        'Runtime env must be owned by the current user',
      );
    }
    assert.equal(
      envInfo.mode & 0o077,
      0,
      'Runtime env permissions must be 0600',
    );
    values = parseEnv(await readFile(envPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!createIfMissing) return null;
    if (projectHasState(info.project)) {
      throw new Error(
        `Refusing to generate new secrets because ${info.project} already has containers or data volumes; restore the protected runtime.env file first.`,
      );
    }
    values = await createRuntimeEnvironment(mode);
    await writeAtomic(envPath, formatEnv(values));
    console.log(`Created protected ${mode} runtime state at ${directory}.`);
  }

  assert.equal(
    values.COMPOSE_PROJECT_NAME,
    info.project,
    'Runtime project name does not match the selected mode',
  );
  assert.equal(values.HIREARCHY_RUNTIME_PROFILE, 'founder-uat');
  assert.equal(values.PG_PORT, '5434');
  assert.equal(values.APP_PORT, '3000');
  assert.equal(values.GOTRUE_API_PORT, '9997');
  assert.equal(values.MAILPIT_API_PORT, '8025');
  assert.equal(values.MAILPIT_SMTP_PORT, '1025');
  assert.equal(values.FOUNDER_UAT_SOURCE_DIR, await realpath(rootDir));
  assert.equal(
    values.FOUNDER_UAT_NODE_MODULES_DIR,
    await realpath(path.join(rootDir, 'node_modules')),
  );
  assert.equal(
    values.FOUNDER_UAT_NEXT_CACHE_DIR,
    path.join(rootDir, 'apps/web/.next/cache'),
  );
  assert(values.STAGING_PROOF_PRIVATE_KEY && values.GOTRUE_JWT_SECRET);
  if (mode === 'automation') {
    assert(
      !values.FOUNDER_UAT_NVIDIA_API_KEY,
      'Automation runtime must not have a live NVIDIA credential',
    );
    assert.match(
      values.FOUNDER_UAT_AUTOMATION_RUN_ID ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  } else {
    assert(!Object.hasOwn(values, 'FOUNDER_UAT_AUTOMATION_RUN_ID'));
  }
  return { directory, envPath, values };
}

async function createRuntimeEnvironment(mode) {
  const { project } = modes[mode];
  const sourceDir = await realpath(rootDir);
  const nodeModulesDir = await realpath(path.join(rootDir, 'node_modules'));
  const nextCacheDir = path.join(sourceDir, 'apps/web/.next/cache');
  await mkdir(nextCacheDir, { recursive: true, mode: 0o700 });
  const passwords = Object.fromEntries(
    [
      'POSTGRES_PASSWORD',
      'GOTRUE_DB_PASSWORD',
      'MIGRATOR_DATABASE_PASSWORD',
      'R23_GATEWAY_PASSWORD',
      'CANDIDATE_GATEWAY_PASSWORD',
      'APP_EVALUATOR_PASSWORD',
      'CONTROL_WORKER_PASSWORD',
      'GOTRUE_JWT_SECRET',
    ].map((name) => [name, randomBytes(32).toString('hex')]),
  );
  const { privateKey } = generateKeyPairSync('ed25519');
  const proofPrivateKey = privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .toString('base64');
  const candidateKey = randomBytes(32).toString('base64');
  const authOrigin = 'http://127.0.0.1:9997';
  const appOrigin = 'http://127.0.0.1:3000';
  const database = (user, password) =>
    `postgres://${user}:${password}@127.0.0.1:5434/postgres`;

  return {
    COMPOSE_PROJECT_NAME: project,
    FOUNDER_UAT_SOURCE_DIR: sourceDir,
    FOUNDER_UAT_NODE_MODULES_DIR: nodeModulesDir,
    FOUNDER_UAT_NEXT_CACHE_DIR: nextCacheDir,
    HIREARCHY_RUNTIME_PROFILE: 'founder-uat',
    HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED: 'true',
    HIREARCHY_RATE_LIMIT_ENABLED: 'true',
    PG_PORT: '5434',
    APP_PORT: '3000',
    GOTRUE_API_PORT: '9997',
    MAILPIT_API_PORT: '8025',
    MAILPIT_SMTP_PORT: '1025',
    FOUNDER_UAT_SIGNUP_ENABLED: 'false',
    FOUNDER_UAT_SIGNUP_DISABLED: 'true',
    FOUNDER_UAT_APP_ORIGIN: appOrigin,
    FOUNDER_UAT_MAILPIT_API_URL: 'http://127.0.0.1:8025',
    STAGING_PUBLIC_ORIGIN: appOrigin,
    STAGING_AUTH_URL: authOrigin,
    STAGING_AUTH_ISSUER: authOrigin,
    STAGING_AUTH_AUDIENCE: 'authenticated',
    STAGING_PROOF_ISSUER: 'hirearchy-founder-uat',
    STAGING_PROOF_AUDIENCE: 'hirearchy-postgres',
    STAGING_PROOF_KEY_ID: randomUUID(),
    STAGING_PROOF_PRIVATE_KEY: proofPrivateKey,
    HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY: candidateKey,
    STAGING_ADMIN_DATABASE_URL: database(
      'postgres',
      passwords.POSTGRES_PASSWORD,
    ),
    STAGING_MIGRATOR_DATABASE_URL: database(
      'hirearchy_migrator',
      passwords.MIGRATOR_DATABASE_PASSWORD,
    ),
    STAGING_DATABASE_URL: database(
      'r23_gateway',
      passwords.R23_GATEWAY_PASSWORD,
    ),
    STAGING_CANDIDATE_DATABASE_URL: database(
      'app_candidate_gateway',
      passwords.CANDIDATE_GATEWAY_PASSWORD,
    ),
    ...passwords,
    ...(mode === 'automation'
      ? { FOUNDER_UAT_AUTOMATION_RUN_ID: randomUUID() }
      : {}),
  };
}

function composePrefix(state, mode) {
  const args = [
    'compose',
    '--project-name',
    modes[mode].project,
    '--env-file',
    state.envPath,
    '-f',
    composeFile,
  ];
  if (mode === 'automation') args.push('-f', automationFile);
  return args;
}

function compose(state, mode, args, options = {}) {
  return docker([...composePrefix(state, mode), ...args], {
    ...options,
    env: {
      ...process.env,
      ...state.values,
      FOUNDER_UAT_NVIDIA_API_KEY:
        mode === 'persistent'
          ? (state.values.FOUNDER_UAT_NVIDIA_API_KEY ?? '')
          : '',
    },
  });
}

async function setSignupEnabled(state, mode, enabled) {
  state.values.FOUNDER_UAT_SIGNUP_ENABLED = enabled ? 'true' : 'false';
  state.values.FOUNDER_UAT_SIGNUP_DISABLED = enabled ? 'false' : 'true';
  await writeAtomic(state.envPath, formatEnv(state.values));
  const updated = await readFile(state.envPath, 'utf8');
  state.values = parseEnv(updated);
  assert.equal(
    state.values.FOUNDER_UAT_SIGNUP_ENABLED,
    enabled ? 'true' : 'false',
  );
  assert.equal(
    state.values.FOUNDER_UAT_SIGNUP_DISABLED,
    enabled ? 'false' : 'true',
  );
  await compose(state, mode, ['config', '--quiet']);
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error('Unable to verify Founder UAT source provenance.');
  }
}

async function sourceFingerprint() {
  assert(
    Number.parseInt(process.versions.node.split('.')[0], 10) >= 22,
    'Founder UAT runtime requires Node.js 22 or later',
  );
  const dirty = git(['status', '--porcelain', '--untracked-files=normal']);
  assert.equal(
    dirty,
    '',
    'Founder UAT requires a clean tracked and untracked source tree',
  );
  const commit = git(['rev-parse', 'HEAD']);
  assert.match(commit, /^[0-9a-f]{40}$/);
  const lock = await readFile(path.join(rootDir, 'package-lock.json'));
  const lockfile = JSON.parse(lock.toString('utf8'));
  const nodeModules = await realpath(path.join(rootDir, 'node_modules'));
  for (const name of ['next', 'pg', 'vitest', 'playwright']) {
    const lockEntry = lockfile.packages?.[`node_modules/${name}`];
    assert(lockEntry?.version, `Lockfile is missing the root ${name} package`);
    const installed = JSON.parse(
      await readFile(path.join(nodeModules, name, 'package.json'), 'utf8'),
    );
    assert.equal(
      installed.version,
      lockEntry.version,
      `Installed ${name} does not match package-lock.json`,
    );
  }
  return {
    commit,
    packageLockSha256: createHash('sha256').update(lock).digest('hex'),
  };
}

async function buildIsCurrent(fingerprint) {
  try {
    const stamp = JSON.parse(
      await readFile(
        path.join(rootDir, 'apps/web/.next/founder-uat-source.json'),
        'utf8',
      ),
    );
    const buildId = await readFile(
      path.join(rootDir, 'apps/web/.next/BUILD_ID'),
      'utf8',
    );
    return (
      buildId.trim().length > 0 &&
      stamp.commit === fingerprint.commit &&
      stamp.packageLockSha256 === fingerprint.packageLockSha256
    );
  } catch {
    return false;
  }
}

async function buildApplication(state, mode, fingerprint) {
  console.log(
    `Building Founder UAT app at ${fingerprint.commit.slice(0, 12)}.`,
  );
  const buildEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith('STAGING_') &&
        !name.startsWith('FOUNDER_UAT_') &&
        !name.startsWith('HIREARCHY_RUNTIME_'),
    ),
  );
  execFileSync('npm', ['run', 'build'], {
    cwd: rootDir,
    env: {
      ...buildEnv,
      NODE_OPTIONS: '--max-old-space-size=768',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: 'inherit',
  });
  await readFile(path.join(rootDir, 'apps/web/.next/BUILD_ID'), 'utf8');
  await writeAtomic(
    path.join(rootDir, 'apps/web/.next/founder-uat-source.json'),
    `${JSON.stringify(fingerprint, null, 2)}\n`,
  );
  assert(
    await buildIsCurrent(fingerprint),
    'Founder UAT build provenance could not be recorded',
  );
  await compose(state, mode, ['build', 'postgres']);
}

async function portAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      reject(
        new Error(
          `Refusing to bind Founder UAT port 127.0.0.1:${port}: ${error.code ?? 'unavailable'}`,
        ),
      );
    });
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

async function assertPortsAvailable() {
  for (const port of ports) await portAvailable(port);
}

function markerPath(state) {
  return path.join(state.directory, 'initialized.json');
}

async function readMarker(state, mode) {
  try {
    const info = await lstat(markerPath(state));
    assert(
      info.isFile() && !info.isSymbolicLink(),
      'Initialization marker must be a regular file',
    );
    assert.equal(
      info.mode & 0o077,
      0,
      'Initialization marker permissions must be 0600',
    );
    const marker = JSON.parse(await readFile(markerPath(state), 'utf8'));
    assert.equal(marker.project, modes[mode].project);
    assert.equal(marker.proofKeyId, state.values.STAGING_PROOF_KEY_ID);
    assert.match(marker.databaseId ?? '', /^[A-Za-z0-9_-]{22}$/);
    return marker;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeMarker(state, mode, fingerprint, databaseId) {
  const marker = {
    initializedAt: new Date().toISOString(),
    project: modes[mode].project,
    proofKeyId: state.values.STAGING_PROOF_KEY_ID,
    databaseId,
    sourceCommit: fingerprint.commit,
  };
  await writeAtomic(markerPath(state), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

async function waitFor(check, description, timeoutMs = 120_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `${description} did not become ready within ${Math.ceil(timeoutMs / 1000)} seconds${lastError instanceof Error ? ` (${lastError.message})` : ''}`,
  );
}

async function serviceHealth(state, mode, service) {
  const id = compose(state, mode, ['ps', '--quiet', service], {
    allowFailure: true,
  });
  if (!id) return null;
  const health = docker(
    ['inspect', '--format', '{{.State.Health.Status}}', id],
    {
      allowFailure: true,
      env: { ...process.env, ...state.values },
    },
  );
  const status = docker(['inspect', '--format', '{{.State.Status}}', id], {
    allowFailure: true,
    env: { ...process.env, ...state.values },
  });
  if (status === 'exited' || status === 'dead') {
    throw new Error(`Founder UAT ${service} container exited during startup`);
  }
  return health === 'healthy' ? true : null;
}

async function waitForServices(state, mode, selectedServices) {
  for (const service of selectedServices) {
    await waitFor(
      () => serviceHealth(state, mode, service),
      `Founder UAT ${service}`,
    );
    console.log(`Founder UAT ${service} is healthy.`);
  }
}

async function waitForHttp(url, description) {
  return waitFor(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok ? response : null;
  }, description);
}

function assertLoopbackListeners() {
  const output = execFileSync('ss', ['-ltn'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const port of ports) {
    const matches = output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[3])
      .filter((address) => address?.endsWith(`:${port}`));
    assert.deepEqual(
      matches,
      [`127.0.0.1:${port}`],
      `Founder UAT port ${port} must have exactly one 127.0.0.1 listener`,
    );
  }
}

async function runInstaller(state, mode, requireEmpty) {
  console.log(
    requireEmpty
      ? `Installing the ${mode} schema and API before the first-use empty database check.`
      : `Verifying the ${mode} schema, API, and protected key bindings; preserving existing records.`,
  );
  let output;
  try {
    output = execFileSync(
      process.execPath,
      ['--env-file', state.envPath, 'scripts/founder-uat-install.mjs'],
      {
        cwd: rootDir,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          ...state.values,
          ...(requireEmpty ? { FOUNDER_UAT_REQUIRE_EMPTY: '1' } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    const stdout = scrub(error.stdout, state.values);
    const stderr = scrub(error.stderr, state.values);
    if (stdout) process.stdout.write(`${stdout}\n`);
    if (stderr) process.stderr.write(`${stderr}\n`);
    throw new Error(
      'Founder UAT database installation failed; see safe output above.',
    );
  }
  process.stdout.write(output);
  const match = output.match(/^FOUNDER_UAT_DATABASE_ID=([A-Za-z0-9_-]{22})$/m);
  assert(match, 'Founder UAT installer did not report its database identity');
  return match[1];
}

async function readiness(state, mode) {
  const response = await waitFor(async () => {
    try {
      return await fetch('http://127.0.0.1:3000/api/staging/readiness', {
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      return null;
    }
  }, 'Founder UAT application readiness endpoint');
  assert(response.ok, `Founder UAT readiness returned HTTP ${response.status}`);
  const body = await response.json();
  const expectedRunId = state.values.FOUNDER_UAT_AUTOMATION_RUN_ID;
  if (mode === 'automation') {
    assert.equal(
      body.founderUatAutomationRunId,
      expectedRunId,
      'Disposable automation readiness ID does not match protected runtime state',
    );
    console.log(`Automation readiness attestation: ${expectedRunId}`);
  } else {
    assert(
      !Object.hasOwn(body, 'founderUatAutomationRunId'),
      'Persistent Founder UAT must not expose an automation readiness ID',
    );
  }
  return body;
}

async function stop(mode) {
  docker(['info', '--format', '{{.ServerVersion}}']);
  const state = await readState(mode, { createIfMissing: false });
  if (!state) {
    console.log(
      projectHasState(modes[mode].project)
        ? `Refusing to stop ${modes[mode].project} because its protected runtime.env is missing; retained containers or volumes are untouched.`
        : `${modes[mode].project} has no protected runtime state.`,
    );
    return;
  }
  if (projectContainers(modes[mode].project)) {
    compose(state, mode, ['stop']);
    console.log(
      `Stopped only ${modes[mode].project}; its database and mail volumes remain.`,
    );
  } else {
    console.log(`${modes[mode].project} is already stopped.`);
  }
}

async function status(mode) {
  docker(['info', '--format', '{{.ServerVersion}}']);
  const state = await readState(mode, { createIfMissing: false });
  if (!state) {
    console.log(
      projectHasState(modes[mode].project)
        ? `${modes[mode].project} has retained containers or data volumes but its protected runtime.env is missing; do not alter them.`
        : `${modes[mode].project} has no protected runtime state.`,
    );
    return;
  }
  const output = compose(state, mode, ['ps'], {
    allowFailure: true,
  });
  console.log(output || `${modes[mode].project} has no containers.`);
  if (projectContainers(modes[mode].project)) {
    try {
      await readiness(state, mode);
      assertLoopbackListeners();
      console.log('Founder UAT application and loopback listeners are ready.');
    } catch (error) {
      console.log(
        `Founder UAT is not fully ready: ${error instanceof Error ? error.message : 'readiness check failed'}`,
      );
    }
  }
}

async function start(mode, { forceRestart = false } = {}) {
  docker(['info', '--format', '{{.ServerVersion}}']);
  const state = await readState(mode);
  const otherMode = mode === 'automation' ? 'persistent' : 'automation';
  if (projectContainers(modes[otherMode].project)) {
    throw new Error(
      `Refusing to start ${modes[mode].project} while ${modes[otherMode].project} is active; both profiles use the same loopback ports.`,
    );
  }

  const fingerprint = await sourceFingerprint();
  let active = projectContainers(modes[mode].project).length > 0;
  const currentBuild = await buildIsCurrent(fingerprint);
  if (active && forceRestart) {
    compose(state, mode, ['stop']);
    active = false;
    console.log(
      `Stopped only ${modes[mode].project} for the requested restart.`,
    );
  } else if (active && currentBuild) {
    try {
      await readiness(state, mode);
      assertLoopbackListeners();
      console.log(
        `Founder UAT is already ready at ${state.values.FOUNDER_UAT_APP_ORIGIN}.`,
      );
      return;
    } catch {
      compose(state, mode, ['stop']);
      active = false;
      console.log(
        `Stopped the incomplete ${modes[mode].project} stack before retrying startup.`,
      );
    }
  } else if (active) {
    compose(state, mode, ['stop']);
    active = false;
    console.log(
      `Stopped ${modes[mode].project} before rebuilding stale app output.`,
    );
  }

  if (!active) await assertPortsAvailable();
  if (!(await buildIsCurrent(fingerprint))) {
    await buildApplication(state, mode, fingerprint);
  }

  const marker = await readMarker(state, mode);
  await setSignupEnabled(state, mode, false);
  await compose(state, mode, ['config', '--quiet']);
  console.log(`Starting ${modes[mode].project} with loopback-only listeners.`);
  compose(state, mode, ['up', '-d', 'postgres', 'gotrue', 'mailpit']);
  await waitForServices(state, mode, ['postgres', 'gotrue', 'mailpit']);
  await waitForHttp(`${state.values.STAGING_AUTH_URL}/health`, 'GoTrue API');

  const databaseId = await runInstaller(state, mode, marker === null);
  if (marker === null) {
    await writeMarker(state, mode, fingerprint, databaseId);
  } else if (marker.databaseId !== databaseId) {
    throw new Error(
      'Founder UAT database identity changed from protected runtime state; refusing to expose this database.',
    );
  }

  await setSignupEnabled(state, mode, true);
  compose(state, mode, ['up', '-d', 'gotrue']);
  await waitForServices(state, mode, ['gotrue']);
  await waitForHttp(
    `${state.values.STAGING_AUTH_URL}/health`,
    'GoTrue API with signup enabled',
  );
  if (marker === null) {
    console.log(
      'Self-service signup was enabled only after the empty first-use assertion passed.',
    );
  }

  compose(state, mode, ['up', '-d', 'web']);
  await waitForServices(state, mode, services);
  assertLoopbackListeners();
  await readiness(state, mode);
  console.log(
    `Founder UAT is ready at ${state.values.FOUNDER_UAT_APP_ORIGIN}.`,
  );
  console.log(
    'Confirmation and password reset messages are available from their account flows.',
  );
}

async function main() {
  const [command, mode] = process.argv.slice(2);
  if (
    !['start', 'restart', 'stop', 'status'].includes(command) ||
    !modes[mode]
  ) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (command === 'start') return start(mode);
  if (command === 'restart') return start(mode, { forceRestart: true });
  if (command === 'stop') return stop(mode);
  return status(mode);
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : 'Founder UAT runtime command failed.',
  );
  process.exitCode = 1;
});
