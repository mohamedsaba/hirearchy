/**
 * Local synthetic executor for the reservation-moves pytest recipe.
 * A zero pytest exit is only the observed result of tests contained in the
 * supplied snapshot; it is not independent validation or a candidate verdict.
 */
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as http from 'node:http';
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  readlink,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  RECIPE,
  RECIPE_DIGEST,
  SNAPSHOT_LOADER,
  isReviewedImageIdentity,
} from './recipes.mjs';
import { createPostgresExecutionStore, ExecutionStoreError } from './store.mjs';

export { RECIPE, RECIPE_DIGEST };
export { ExecutionStoreError };

const DOCKER = '/usr/bin/docker';
const DOCKER_SOCKET = '/var/run/docker.sock';
const DOCKER_HOST = 'unix:///var/run/docker.sock';
const MAX_FILES = 128;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MIN_MEMORY_BYTES = 128 * 1024 * 1024;
const MAX_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_CPU_COUNT = 1;
const MIN_PID_COUNT = 16;
const MAX_PID_COUNT = 64;
const MAX_ADMISSION_TTL_MS = 5 * 60 * 1000;
const LABEL = 'com.hirearchy.restricted-executor.request';
const OPERATION_LABEL = 'com.hirearchy.restricted-executor.operation';
const ATTEMPT_LABEL = 'com.hirearchy.restricted-executor.attempt';
const DOCKER_ENV = Object.freeze({
  LANG: 'C.UTF-8',
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export class ExecutorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExecutorError';
    this.code = code;
  }
}

function requireSecureStorageBoundary() {
  throw new ExecutorError(
    'SECURE_STORAGE_UNAVAILABLE',
    'Filesystem-backed executor state is disabled; configure the PostgreSQL execution store.',
  );
}

export async function provisionExecutorStateRoot() {
  requireSecureStorageBoundary();
}

function unauthorized() {
  return new ExecutorError('UNAUTHORIZED', 'Admission authentication failed.');
}

function canonicalAdmissionPayload(fields) {
  return {
    version: 1,
    callerId: fields.callerId,
    keyId: fields.keyId,
    sessionRef: fields.sessionRef,
    operationId: fields.operationId,
    requestId: fields.requestId,
    generation: fields.generation,
    fence: fields.fence,
    scenarioRef: fields.scenarioRef,
    scenarioVersion: fields.scenarioVersion,
    snapshotDigest: fields.snapshotDigest,
    recipeId: fields.recipeId,
    recipeVersion: fields.recipeVersion,
    recipeDigest: fields.recipeDigest,
    timeoutMs: fields.timeoutMs,
    resources: {
      memoryBytes: fields.resources.memoryBytes,
      cpus: fields.resources.cpus,
      pids: fields.resources.pids,
    },
    outputBytes: fields.outputBytes,
    issuedAtMs: fields.issuedAtMs,
    expiresAtMs: fields.expiresAtMs,
  };
}

function validateAdmissionKeys(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new ExecutorError(
      'INVALID_CONFIG',
      'admissionKeys must contain configured test-lane keys.',
    );
  }
  const keys = new Map();
  for (const entry of value) {
    try {
      requireExactKeys(entry, ['keyId', 'callerId', 'secret'], 'admission key');
      const keyId = requireIdentifier(entry.keyId, 'keyId');
      const callerId = requireIdentifier(entry.callerId, 'callerId');
      if (
        typeof entry.secret !== 'string' ||
        Buffer.byteLength(entry.secret, 'utf8') < 32 ||
        Buffer.byteLength(entry.secret, 'utf8') > 1024
      ) {
        throw new Error('invalid key material');
      }
      if (keys.has(keyId)) throw new Error('duplicate key ID');
      keys.set(keyId, { callerId, secret: Buffer.from(entry.secret, 'utf8') });
    } catch {
      throw new ExecutorError('INVALID_CONFIG', 'admissionKeys are invalid.');
    }
  }
  return keys;
}

function requirePlainObject(value, name) {
  if (
    value === null ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new ExecutorError('INVALID_REQUEST', `${name} must be an object.`);
  }
}

function requireExactKeys(value, keys, name) {
  requirePlainObject(value, name);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ExecutorError(
      'INVALID_REQUEST',
      `${name} has unsupported fields.`,
    );
  }
}

function requireIdentifier(value, name) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new ExecutorError('INVALID_REQUEST', `${name} is invalid.`);
  }
  return value;
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
    throw new ExecutorError(
      'INVALID_SNAPSHOT',
      'Snapshot file count is invalid.',
    );
  }

  const normalized = [];
  const paths = new Set();
  let totalBytes = 0;
  for (const file of files) {
    requireExactKeys(file, ['path', 'content'], 'snapshot file');
    const { path, content } = file;
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      hasLoneSurrogate(path) ||
      Buffer.byteLength(path, 'utf8') > 256 ||
      path.startsWith('/') ||
      /^[A-Za-z]:/.test(path) ||
      path.includes('\\') ||
      path.includes('\0') ||
      /[\u0000-\u001f\u007f]/.test(path)
    ) {
      throw new ExecutorError('INVALID_SNAPSHOT', 'Snapshot path is invalid.');
    }
    const parts = path.split('/');
    if (
      parts.some(
        (part) =>
          part === '' ||
          part === '.' ||
          part === '..' ||
          Buffer.byteLength(part, 'utf8') > 255,
      )
    ) {
      throw new ExecutorError('INVALID_SNAPSHOT', 'Snapshot path is invalid.');
    }
    if (paths.has(path)) {
      throw new ExecutorError(
        'INVALID_SNAPSHOT',
        'Snapshot paths must be unique.',
      );
    }
    if (typeof content !== 'string' || hasLoneSurrogate(content)) {
      throw new ExecutorError(
        'INVALID_SNAPSHOT',
        'Snapshot content must be valid UTF-8 text.',
      );
    }
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new ExecutorError(
        'INVALID_SNAPSHOT',
        'Snapshot file exceeds its byte limit.',
      );
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      throw new ExecutorError(
        'INVALID_SNAPSHOT',
        'Snapshot exceeds its byte limit.',
      );
    }
    paths.add(path);
    normalized.push({ path, content, bytes });
  }

  for (const { path } of normalized) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      if (paths.has(parts.slice(0, index).join('/'))) {
        throw new ExecutorError(
          'INVALID_SNAPSHOT',
          'Snapshot paths cannot place a file inside another file.',
        );
      }
    }
  }

  return normalized;
}

export function snapshotDigest(files) {
  const pairs = validateFiles(files)
    .map(({ path, bytes }) => [path, sha256(bytes)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return sha256(Buffer.from(JSON.stringify(pairs), 'utf8'));
}

function validateAdmission(request, admissionKeys) {
  const envelope = request.authorization;
  try {
    requireExactKeys(
      envelope,
      [
        'version',
        'callerId',
        'keyId',
        'sessionRef',
        'operationId',
        'requestId',
        'generation',
        'fence',
        'scenarioRef',
        'scenarioVersion',
        'snapshotDigest',
        'recipeId',
        'recipeVersion',
        'recipeDigest',
        'timeoutMs',
        'resources',
        'outputBytes',
        'issuedAtMs',
        'expiresAtMs',
        'tag',
      ],
      'authorization',
    );
    if (envelope.version !== 1) throw unauthorized();
    for (const [field, name] of [
      ['callerId', 'callerId'],
      ['keyId', 'keyId'],
      ['sessionRef', 'sessionRef'],
      ['operationId', 'operationId'],
      ['requestId', 'requestId'],
      ['scenarioRef', 'scenarioRef'],
      ['scenarioVersion', 'scenarioVersion'],
      ['recipeId', 'recipeId'],
      ['recipeVersion', 'recipeVersion'],
    ]) {
      requireIdentifier(envelope[field], name);
    }
    if (
      !Number.isSafeInteger(envelope.generation) ||
      envelope.generation < 1 ||
      !Number.isSafeInteger(envelope.fence) ||
      envelope.fence < 1 ||
      !Number.isSafeInteger(envelope.issuedAtMs) ||
      !Number.isSafeInteger(envelope.expiresAtMs) ||
      typeof envelope.snapshotDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(envelope.snapshotDigest) ||
      typeof envelope.recipeDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(envelope.recipeDigest) ||
      typeof envelope.tag !== 'string' ||
      !/^[a-f0-9]{64}$/.test(envelope.tag)
    ) {
      throw unauthorized();
    }
    requireExactKeys(
      envelope.resources,
      ['memoryBytes', 'cpus', 'pids'],
      'admission resources',
    );

    const equalityFields = [
      'requestId',
      'sessionRef',
      'scenarioRef',
      'scenarioVersion',
      'snapshotDigest',
      'recipeId',
      'recipeVersion',
      'recipeDigest',
      'timeoutMs',
      'outputBytes',
    ];
    if (equalityFields.some((field) => envelope[field] !== request[field]))
      throw unauthorized();
    if (
      envelope.resources.memoryBytes !== request.resources.memoryBytes ||
      envelope.resources.cpus !== request.resources.cpus ||
      envelope.resources.pids !== request.resources.pids
    ) {
      throw unauthorized();
    }

    const configured = admissionKeys.get(envelope.keyId);
    if (!configured || configured.callerId !== envelope.callerId)
      throw unauthorized();

    const now = Date.now();
    if (
      envelope.issuedAtMs > now ||
      envelope.expiresAtMs <= now ||
      envelope.expiresAtMs <= envelope.issuedAtMs ||
      envelope.expiresAtMs - envelope.issuedAtMs > MAX_ADMISSION_TTL_MS
    ) {
      throw unauthorized();
    }

    const payload = canonicalAdmissionPayload(envelope);
    const expected = createHmac('sha256', configured.secret)
      .update(JSON.stringify(payload), 'utf8')
      .digest();
    const actual = Buffer.from(envelope.tag, 'hex');
    if (!timingSafeEqual(expected, actual)) throw unauthorized();
    return payload;
  } catch {
    throw unauthorized();
  }
}

function validateRequest(request, admissionKeys) {
  requireExactKeys(
    request,
    [
      'requestId',
      'sessionRef',
      'scenarioRef',
      'scenarioVersion',
      'files',
      'snapshotDigest',
      'recipeId',
      'recipeVersion',
      'recipeDigest',
      'timeoutMs',
      'resources',
      'outputBytes',
      'authorization',
    ],
    'request',
  );

  const requestId = requireIdentifier(request.requestId, 'requestId');
  const sessionRef = requireIdentifier(request.sessionRef, 'sessionRef');
  const scenarioRef = requireIdentifier(request.scenarioRef, 'scenarioRef');
  const scenarioVersion = requireIdentifier(
    request.scenarioVersion,
    'scenarioVersion',
  );
  const recipeId = requireIdentifier(request.recipeId, 'recipeId');
  const recipeVersion = requireIdentifier(
    request.recipeVersion,
    'recipeVersion',
  );
  if (
    typeof request.recipeDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.recipeDigest)
  ) {
    throw new ExecutorError('INVALID_REQUEST', 'recipeDigest is invalid.');
  }
  const files = validateFiles(request.files);
  const actualDigest = snapshotDigest(
    files.map(({ path, content }) => ({ path, content })),
  );
  if (
    typeof request.snapshotDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.snapshotDigest) ||
    request.snapshotDigest !== actualDigest
  ) {
    throw new ExecutorError(
      'SNAPSHOT_DIGEST_MISMATCH',
      'Snapshot digest does not match its files.',
    );
  }

  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < MIN_TIMEOUT_MS ||
    request.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new ExecutorError(
      'INVALID_REQUEST',
      'timeoutMs is outside the supported range.',
    );
  }
  if (
    !Number.isSafeInteger(request.outputBytes) ||
    request.outputBytes < 0 ||
    request.outputBytes > MAX_OUTPUT_BYTES
  ) {
    throw new ExecutorError(
      'INVALID_REQUEST',
      'outputBytes is outside the supported range.',
    );
  }
  requireExactKeys(
    request.resources,
    ['memoryBytes', 'cpus', 'pids'],
    'resources',
  );
  if (
    !Number.isSafeInteger(request.resources.memoryBytes) ||
    request.resources.memoryBytes < MIN_MEMORY_BYTES ||
    request.resources.memoryBytes > MAX_MEMORY_BYTES ||
    typeof request.resources.cpus !== 'number' ||
    !Number.isFinite(request.resources.cpus) ||
    request.resources.cpus < 0.25 ||
    request.resources.cpus > MAX_CPU_COUNT ||
    Math.round(request.resources.cpus * 4) !== request.resources.cpus * 4 ||
    !Number.isSafeInteger(request.resources.pids) ||
    request.resources.pids < MIN_PID_COUNT ||
    request.resources.pids > MAX_PID_COUNT
  ) {
    throw new ExecutorError(
      'INVALID_REQUEST',
      'Resource limits are outside the supported range.',
    );
  }
  const authorization = validateAdmission(request, admissionKeys);

  const intent = {
    requestId,
    sessionRef,
    scenarioRef,
    scenarioVersion,
    snapshotDigest: actualDigest,
    recipeId,
    recipeVersion,
    recipeDigest: request.recipeDigest,
    timeoutMs: request.timeoutMs,
    resources: {
      memoryBytes: request.resources.memoryBytes,
      cpus: request.resources.cpus,
      pids: request.resources.pids,
    },
    outputBytes: request.outputBytes,
    operationId: authorization.operationId,
    generation: authorization.generation,
    fence: authorization.fence,
    callerId: authorization.callerId,
    keyId: authorization.keyId,
    admissionVersion: authorization.version,
  };
  return { files, intent, intentDigest: sha256(JSON.stringify(intent)) };
}

function requireSupportedRecipe(intent) {
  if (
    intent.scenarioRef !== RECIPE.scenarioRef ||
    intent.scenarioVersion !== RECIPE.scenarioVersion ||
    intent.recipeId !== RECIPE.recipeId ||
    intent.recipeVersion !== RECIPE.recipeVersion ||
    intent.recipeDigest !== RECIPE_DIGEST
  ) {
    throw new ExecutorError(
      'UNSUPPORTED_RECIPE',
      'Scenario or recipe is not supported.',
    );
  }
}

function collectBytes(limits) {
  const buffers = { stdout: [], stderr: [] };
  const captured = { stdout: 0, stderr: 0 };
  const observed = { stdout: 0, stderr: 0 };
  const cap = limits.totalBytes;
  const add = (stream, chunk) => {
    observed[stream] += chunk.length;
    const remaining = Math.max(0, cap - captured.stdout - captured.stderr);
    const keep = Math.min(remaining, chunk.length);
    if (keep > 0) {
      buffers[stream].push(Buffer.from(chunk.subarray(0, keep)));
      captured[stream] += keep;
    }
  };
  const output = (stream) => {
    const bytes = Buffer.concat(buffers[stream], captured[stream]);
    return {
      base64: bytes.toString('base64'),
      byteCount: bytes.length,
      observedByteCount: observed[stream],
      truncated: observed[stream] > bytes.length,
      sha256: sha256(bytes),
    };
  };
  return { add, output };
}

function runChild(binary, args, timeoutMs, maxBytes, inputBytes) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(binary, args, {
      detached: true,
      env: DOCKER_ENV,
      stdio: [inputBytes === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const streams = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let timedOut = false;
    let overflow = false;
    let settled = false;
    const stopGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // The child may already have exited.
        }
      }
    };
    const capture = (stream, chunk) => {
      const keep = Math.min(
        chunk.length,
        Math.max(0, maxBytes - sizes[stream]),
      );
      if (keep > 0) {
        streams[stream].push(Buffer.from(chunk.subarray(0, keep)));
        sizes[stream] += keep;
      }
      if (keep < chunk.length) {
        overflow = true;
        stopGroup();
      }
    };
    child.stdout.on('data', (chunk) => capture('stdout', chunk));
    child.stderr.on('data', (chunk) => capture('stderr', chunk));
    if (inputBytes !== undefined) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(inputBytes);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup();
    }, timeoutMs);
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectChild(
        new ExecutorError(
          'DOCKER_UNAVAILABLE',
          'Docker process could not be started.',
        ),
      );
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveChild({
        code,
        signal,
        timedOut,
        overflow,
        stdout: Buffer.concat(streams.stdout, sizes.stdout),
        stderr: Buffer.concat(streams.stderr, sizes.stderr),
      });
    });
  });
}

async function docker(
  args,
  { timeoutMs = 5_000, maxBytes = 64 * 1024, inputBytes } = {},
) {
  let configDirectory;
  let result;
  let failure;
  try {
    configDirectory = await mkdtemp(
      join(tmpdir(), 'hirearchy-executor-codex-docker-config-'),
    );
    await chmod(configDirectory, 0o700);
    result = await runChild(
      DOCKER,
      ['--config', configDirectory, '--host', DOCKER_HOST, ...args],
      timeoutMs,
      maxBytes,
      inputBytes,
    );
    if (result.timedOut)
      failure = new ExecutorError(
        'DOCKER_TIMEOUT',
        'Docker operation timed out.',
      );
    else if (result.overflow)
      failure = new ExecutorError(
        'DOCKER_OUTPUT_LIMIT',
        'Docker response exceeded its limit.',
      );
    else if (result.code !== 0)
      failure = new ExecutorError('DOCKER_FAILURE', 'Docker operation failed.');
  } catch (error) {
    failure =
      error instanceof ExecutorError
        ? error
        : new ExecutorError(
            'DOCKER_UNAVAILABLE',
            'Docker operation could not be completed.',
          );
  }

  if (configDirectory) {
    try {
      if (!(await removeDirectory(configDirectory)))
        throw new Error('still exists');
    } catch {
      try {
        await rm(configDirectory, { recursive: true, force: true });
        if (!(await removeDirectory(configDirectory)))
          throw new Error('still exists');
      } catch {
        failure = new ExecutorError(
          'DOCKER_CONFIG_CLEANUP_FAILED',
          'Docker client configuration cleanup failed.',
        );
      }
    }
  }
  if (failure) throw failure;
  return result.stdout.toString('utf8').trim();
}

async function removeDirectory(path) {
  try {
    await rm(path, { recursive: true, force: false });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

async function requireLocalSocket() {
  try {
    const socket = await lstat(DOCKER_SOCKET);
    if (!socket.isSocket()) throw new Error('not a socket');
  } catch {
    throw new ExecutorError(
      'DOCKER_UNAVAILABLE',
      'The local Docker socket is unavailable.',
    );
  }
}

async function preflight() {
  await requireLocalSocket();
  let daemon;
  try {
    daemon = await docker(
      [
        'info',
        '--format',
        '{{.CgroupVersion}}|{{.MemoryLimit}}|{{.SwapLimit}}|{{.CPUCfsQuota}}|{{.PidsLimit}}|{{.DefaultRuntime}}|{{json .SecurityOptions}}',
      ],
      { timeoutMs: 5_000, maxBytes: 8 * 1024 },
    );
  } catch {
    throw new ExecutorError(
      'DOCKER_UNAVAILABLE',
      'The local Docker daemon is unavailable.',
    );
  }
  const [cgroupVersion, memory, swap, cpu, pids, runtime, securityJson] =
    daemon.split('|');
  let securityOptions;
  try {
    securityOptions = JSON.parse(securityJson);
  } catch {
    securityOptions = [];
  }
  if (
    cgroupVersion !== '2' ||
    memory !== 'true' ||
    swap !== 'true' ||
    cpu !== 'true' ||
    pids !== 'true' ||
    runtime !== 'runc' ||
    !Array.isArray(securityOptions) ||
    !securityOptions.includes('name=seccomp,profile=builtin') ||
    !securityOptions.includes('name=cgroupns')
  ) {
    throw new ExecutorError(
      'UNSUPPORTED_ISOLATION',
      'Docker does not provide the required isolation controls.',
    );
  }

  let image;
  try {
    const raw = await docker(
      ['image', 'inspect', '--format', '{{json .}}', RECIPE.image],
      { timeoutMs: 5_000, maxBytes: 128 * 1024 },
    );
    image = JSON.parse(raw);
  } catch {
    throw new ExecutorError(
      'PINNED_IMAGE_UNAVAILABLE',
      'The pinned local recipe image is unavailable.',
    );
  }
  if (
    !isReviewedImageIdentity(image) ||
    !Array.isArray(image.Config?.Env) ||
    image.Config.Env.length !== 5 ||
    image.Config.Env.some(
      (entry) =>
        ![
          'PATH=/usr/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          'LANG=C.UTF-8',
          'GPG_KEY=7169605F62C751356D054A26A821E680E5FA6305',
          'PYTHON_VERSION=3.12.13',
          'PYTHON_SHA256=c08bc65a81971c1dd5783182826503369466c7e67374d1646519adf05207b684',
        ].includes(entry),
    ) ||
    Object.keys(image.Config.Volumes ?? {}).length !== 0
  ) {
    throw new ExecutorError(
      'PINNED_IMAGE_INVALID',
      'Pinned image identity or environment does not match the reviewed recipe.',
    );
  }
}

function resourceArgs(resources) {
  return [
    '--memory',
    String(resources.memoryBytes),
    '--memory-swap',
    String(resources.memoryBytes),
    '--cpus',
    String(resources.cpus),
    '--pids-limit',
    String(resources.pids),
  ];
}

async function verifyContainer(
  container,
  request,
  containerName,
  identity,
  started = false,
) {
  const config = container?.Config;
  const host = container?.HostConfig;
  const tmpfs = host?.Tmpfs ?? {};
  const mounts = container?.Mounts ?? [];
  const memoryBytes = request.resources.memoryBytes;
  const cpusNano = Math.round(request.resources.cpus * 1_000_000_000);
  const safeMounts = Array.isArray(mounts) && mounts.length === 0;
  if (
    container?.Name !== `/${containerName}` ||
    config?.Image !== RECIPE.image ||
    config?.Entrypoint?.join(' ') !== '/bin/sleep' ||
    config?.Cmd?.join(' ') !== 'infinity' ||
    config?.User !== RECIPE.user ||
    config?.WorkingDir !== RECIPE.workingDirectory ||
    config?.Labels?.[LABEL] !== identity.requestLabel ||
    config?.Labels?.[OPERATION_LABEL] !== identity.operationLabel ||
    config?.Labels?.[ATTEMPT_LABEL] !== identity.attemptLabel ||
    host?.NetworkMode !== 'none' ||
    host?.ReadonlyRootfs !== true ||
    host?.Memory !== memoryBytes ||
    host?.MemorySwap !== memoryBytes ||
    host?.NanoCpus !== cpusNano ||
    host?.PidsLimit !== request.resources.pids ||
    host?.ShmSize !== 16 * 1024 * 1024 ||
    host?.Privileged !== false ||
    host?.IpcMode === 'host' ||
    host?.PidMode === 'host' ||
    host?.UsernsMode === 'host' ||
    host?.AutoRemove !== false ||
    host?.CgroupnsMode !== 'private' ||
    (host?.Mounts ?? []).length !== 0 ||
    (host?.CapDrop ?? []).length !== 1 ||
    host.CapDrop[0] !== 'ALL' ||
    (host?.CapAdd ?? []).length !== 0 ||
    !(host?.SecurityOpt ?? []).includes('no-new-privileges:true') ||
    (host?.Binds ?? []).length !== 0 ||
    (host?.Devices ?? []).length !== 0 ||
    Object.keys(config?.Volumes ?? {}).length !== 0 ||
    tmpfs['/workspace'] !==
      'rw,noexec,nosuid,nodev,size=16m,uid=65534,gid=65534,mode=0755' ||
    tmpfs['/tmp'] !== 'rw,noexec,nosuid,nodev,size=16m,mode=1777' ||
    !safeMounts
  ) {
    throw new ExecutorError(
      'UNSUPPORTED_ISOLATION',
      'Docker did not apply every required container restriction.',
    );
  }
  if (Boolean(container.State?.Running) !== started) {
    throw new ExecutorError(
      'UNSUPPORTED_ISOLATION',
      'Docker container lifecycle state does not match the expected stage.',
    );
  }
  if (started) await verifyLiveMounts(container.Name.slice(1));
}

function mountSizeBytes(options) {
  const value = options.find((option) => option.startsWith('size='));
  const match = /^size=(\d+)(k|m)?$/.exec(value ?? '');
  if (!match) return null;
  return (
    Number(match[1]) *
    (match[2] === 'k' ? 1024 : match[2] === 'm' ? 1024 * 1024 : 1)
  );
}

async function verifyLiveMounts(containerName) {
  const raw = await docker(
    [
      'exec',
      '--user',
      RECIPE.user,
      containerName,
      '/bin/cat',
      '/proc/self/mountinfo',
    ],
    { timeoutMs: 5_000, maxBytes: 16 * 1024 },
  );
  const mounts = new Map();
  for (const line of raw.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const mount = line.slice(0, separator).split(' ');
    const filesystem = line.slice(separator + 3).split(' ');
    if (mount.length < 6 || filesystem.length < 3) continue;
    mounts.set(mount[4], {
      filesystem: filesystem[0],
      options: mount[5].split(','),
      superOptions: filesystem[2].split(','),
    });
  }
  const root = mounts.get('/');
  if (root?.filesystem !== 'overlay' || !root.options.includes('ro')) {
    throw new ExecutorError(
      'UNSUPPORTED_ISOLATION',
      'The live container root filesystem is not read-only.',
    );
  }
  for (const path of ['/dev/shm', '/tmp', '/workspace']) {
    const mount = mounts.get(path);
    const ownedWorkspace =
      path !== '/workspace' ||
      (mount?.superOptions.includes('uid=65534') &&
        mount?.superOptions.includes('gid=65534'));
    if (
      mount?.filesystem !== 'tmpfs' ||
      !['rw', 'nosuid', 'nodev', 'noexec'].every((option) =>
        mount.options.includes(option),
      ) ||
      mountSizeBytes(mount.superOptions) !== 16 * 1024 * 1024 ||
      !ownedWorkspace
    ) {
      throw new ExecutorError(
        'UNSUPPORTED_ISOLATION',
        'A live container tmpfs mount does not match the reviewed bounds.',
      );
    }
  }
}

async function inspectContainer(containerName) {
  const raw = await docker(
    ['container', 'inspect', '--format', '{{json .}}', containerName],
    { timeoutMs: 5_000, maxBytes: 128 * 1024 },
  );
  let container;
  try {
    container = JSON.parse(raw);
  } catch {
    throw new ExecutorError(
      'DOCKER_FAILURE',
      'Docker returned an invalid container record.',
    );
  }
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    throw new ExecutorError(
      'DOCKER_FAILURE',
      'Docker returned an invalid container record.',
    );
  }
  return container;
}

function snapshotInput(files) {
  const input = Buffer.from(
    JSON.stringify(
      files.map(({ path, bytes }) => [
        path,
        bytes.toString('base64'),
        sha256(bytes),
      ]),
    ),
    'utf8',
  );
  if (input.byteLength > MAX_SNAPSHOT_INPUT_BYTES) {
    throw new ExecutorError(
      'INVALID_SNAPSHOT',
      'Encoded snapshot exceeds its byte limit.',
    );
  }
  return input;
}

function parseDockerStream(collector) {
  let header = Buffer.alloc(0);
  let frameType = null;
  let remaining = 0;
  return {
    push(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        if (frameType === null) {
          const needed = 8 - header.length;
          const take = Math.min(needed, chunk.length - offset);
          header = Buffer.concat([
            header,
            chunk.subarray(offset, offset + take),
          ]);
          offset += take;
          if (header.length < 8) continue;
          frameType = header[0];
          remaining = header.readUInt32BE(4);
          header = Buffer.alloc(0);
          if (frameType !== 1 && frameType !== 2) {
            throw new ExecutorError(
              'DOCKER_TRANSPORT_FAILED',
              'Docker returned an invalid output stream.',
            );
          }
          if (remaining === 0) {
            frameType = null;
            continue;
          }
        }
        const take = Math.min(remaining, chunk.length - offset);
        collector.add(
          frameType === 1 ? 'stdout' : 'stderr',
          chunk.subarray(offset, offset + take),
        );
        offset += take;
        remaining -= take;
        if (remaining === 0) frameType = null;
      }
    },
    finish() {
      if (header.length !== 0 || frameType !== null || remaining !== 0) {
        throw new ExecutorError(
          'DOCKER_TRANSPORT_FAILED',
          'Docker output stream ended unexpectedly.',
        );
      }
    },
  };
}

function dockerApiRequest(
  socketPath,
  apiVersion,
  method,
  route,
  body,
  timeoutMs,
  onStream,
) {
  return new Promise((resolveResponse, rejectResponse) => {
    const bodyBytes = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const request = http.request(
      {
        socketPath,
        method,
        path: `${apiVersion ? `/${apiVersion}` : ''}${route}`,
        headers: body
          ? {
              'content-type': 'application/json',
              'content-length': String(bodyBytes.length),
            }
          : undefined,
        agent: false,
      },
      (response) => {
        const chunks = [];
        let totalBytes = 0;
        response.on('data', (chunk) => {
          if (onStream) {
            try {
              onStream(chunk);
            } catch (error) {
              request.destroy(error);
            }
            return;
          }
          totalBytes += chunk.length;
          if (totalBytes > 64 * 1024) {
            request.destroy(
              new ExecutorError(
                'DOCKER_TRANSPORT_FAILED',
                'Docker response exceeded its limit.',
              ),
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          clearTimeout(timer);
          const responseBody = Buffer.concat(chunks, totalBytes);
          if (response.statusCode < 200 || response.statusCode >= 300) {
            rejectResponse(
              new ExecutorError(
                'DOCKER_TRANSPORT_FAILED',
                'Docker API operation failed.',
              ),
            );
          } else {
            resolveResponse({
              statusCode: response.statusCode,
              body: responseBody,
              contentType: response.headers['content-type'] ?? '',
            });
          }
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(
        new ExecutorError(
          'DOCKER_API_TIMEOUT',
          'Docker API operation timed out.',
        ),
      );
    }, timeoutMs);
    request.once('error', (error) => {
      clearTimeout(timer);
      rejectResponse(
        error instanceof ExecutorError
          ? error
          : new ExecutorError(
              'DOCKER_TRANSPORT_FAILED',
              'Docker API transport failed.',
            ),
      );
    });
    request.end(bodyBytes ?? undefined);
  });
}

async function dockerApiVersion(socketPath) {
  const response = await dockerApiRequest(
    socketPath,
    '',
    'GET',
    '/version',
    undefined,
    5_000,
  );
  let version;
  try {
    version = JSON.parse(response.body.toString('utf8')).ApiVersion;
  } catch {
    version = null;
  }
  if (typeof version !== 'string' || !/^\d+\.\d+$/.test(version)) {
    throw new ExecutorError(
      'DOCKER_UNAVAILABLE',
      'The local Docker API version is unsupported.',
    );
  }
  return `v${version}`;
}

async function createExec(socketPath, apiVersion, containerId) {
  const response = await dockerApiRequest(
    socketPath,
    apiVersion,
    'POST',
    `/containers/${containerId}/exec`,
    {
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: RECIPE.argv,
      Env: RECIPE.environment,
      WorkingDir: RECIPE.workingDirectory,
      User: RECIPE.user,
    },
    5_000,
  );
  let id;
  try {
    id = JSON.parse(response.body.toString('utf8')).Id;
  } catch {
    id = null;
  }
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) {
    throw new ExecutorError(
      'DOCKER_TRANSPORT_FAILED',
      'Docker did not return an exec identity.',
    );
  }
  return id;
}

async function inspectExec(socketPath, apiVersion, execId) {
  const response = await dockerApiRequest(
    socketPath,
    apiVersion,
    'GET',
    `/exec/${execId}/json`,
    undefined,
    3_000,
  );
  let state;
  try {
    state = JSON.parse(response.body.toString('utf8'));
  } catch {
    throw new ExecutorError(
      'DOCKER_TRANSPORT_FAILED',
      'Docker returned an invalid exec result.',
    );
  }
  if (typeof state.Running !== 'boolean') {
    throw new ExecutorError(
      'DOCKER_TRANSPORT_FAILED',
      'Docker returned an incomplete exec result.',
    );
  }
  if (state.Running) return { running: true, exitCode: null };
  if (
    !Number.isInteger(state.ExitCode) ||
    state.ExitCode < 0 ||
    state.ExitCode > 255
  ) {
    throw new ExecutorError(
      'DOCKER_TRANSPORT_FAILED',
      'Docker returned an incomplete exec result.',
    );
  }
  return { running: false, exitCode: state.ExitCode };
}

async function startExec(
  socketPath,
  apiVersion,
  containerId,
  execId,
  outputBytes,
  timeoutMs,
) {
  const collector = collectBytes({ totalBytes: outputBytes });
  const parser = parseDockerStream(collector);
  let streamComplete = false;
  let streamFailure = null;
  let request;

  const startStream = new Promise((resolveStream, rejectStream) => {
    const body = Buffer.from(
      JSON.stringify({ Detach: false, Tty: false }),
      'utf8',
    );
    request = http.request(
      {
        socketPath,
        method: 'POST',
        path: `/${apiVersion}/exec/${execId}/start`,
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
        agent: false,
      },
      (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          rejectStream(
            new ExecutorError(
              'DOCKER_TRANSPORT_FAILED',
              'Docker could not start the fixed recipe.',
            ),
          );
          return;
        }
        response.on('data', (chunk) => {
          try {
            parser.push(chunk);
          } catch (error) {
            streamFailure = error;
            request.destroy(error);
          }
        });
        response.once('end', () => {
          streamComplete = true;
          try {
            parser.finish();
            resolveStream();
          } catch (error) {
            streamFailure = error;
            rejectStream(error);
          }
        });
      },
    );
    request.once('error', (error) => {
      streamFailure =
        error instanceof ExecutorError
          ? error
          : new ExecutorError(
              'DOCKER_TRANSPORT_FAILED',
              'Docker recipe stream failed.',
            );
      rejectStream(streamFailure);
    });
    request.end(body);
  });

  let deadlineTimer;
  const timeoutSignal = new Promise((resolveTimeout) => {
    deadlineTimer = setTimeout(() => {
      resolveTimeout('deadline');
    }, timeoutMs);
  });
  const outcome = await Promise.race([
    startStream.then(
      () => 'complete',
      (error) => ({ error }),
    ),
    timeoutSignal,
  ]);
  clearTimeout(deadlineTimer);

  if (outcome === 'deadline') {
    const state = await inspectExec(socketPath, apiVersion, execId).catch(
      () => null,
    );
    if (state?.running) {
      request.destroy();
      return {
        timedOut: true,
        exitCode: null,
        stdout: collector.output('stdout'),
        stderr: collector.output('stderr'),
      };
    }
    request.destroy();
    throw new ExecutorError(
      'EXECUTION_UNKNOWN',
      'Recipe completion could not be confirmed before its deadline.',
    );
  }
  if (outcome?.error || streamFailure || !streamComplete) {
    throw new ExecutorError(
      'EXECUTION_UNKNOWN',
      'Recipe output or completion could not be confirmed.',
    );
  }
  const state = await inspectExec(socketPath, apiVersion, execId);
  if (state.running) {
    throw new ExecutorError(
      'EXECUTION_UNKNOWN',
      'Docker output ended while the recipe was still running.',
    );
  }
  return {
    timedOut: false,
    exitCode: state.exitCode,
    stdout: collector.output('stdout'),
    stderr: collector.output('stderr'),
  };
}

function parseProcessStartTicks(stat) {
  const closeParen = stat.lastIndexOf(')');
  if (closeParen < 0) throw new Error('invalid proc stat');
  const fields = stat
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/);
  const startTicks = fields[19];
  if (!/^\d+$/.test(startTicks ?? '')) throw new Error('invalid proc stat');
  return startTicks;
}

async function currentProcessIdentity() {
  try {
    return {
      pid: process.pid,
      startTicks: parseProcessStartTicks(
        await readFile('/proc/self/stat', 'utf8'),
      ),
      bootId: (
        await readFile('/proc/sys/kernel/random/boot_id', 'utf8')
      ).trim(),
      pidNamespace: await readlink('/proc/self/ns/pid'),
    };
  } catch {
    throw new ExecutorError(
      'EXECUTION_OWNER_UNAVAILABLE',
      'The executor process identity could not be verified.',
    );
  }
}

async function processIdentityIsAlive(identity) {
  if (
    !identity ||
    !Number.isSafeInteger(identity.pid) ||
    typeof identity.startTicks !== 'string' ||
    typeof identity.bootId !== 'string' ||
    typeof identity.pidNamespace !== 'string'
  ) {
    return null;
  }
  let bootId;
  try {
    bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  } catch {
    return null;
  }
  if (identity.bootId !== bootId) return null;
  try {
    if ((await readlink('/proc/self/ns/pid')) !== identity.pidNamespace)
      return null;
  } catch {
    return null;
  }
  try {
    const stat = await readFile(`/proc/${identity.pid}/stat`, 'utf8');
    return identity.startTicks === parseProcessStartTicks(stat);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return false;
    return null;
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function makeReceipt(request, start, execution, cleanup) {
  const oomEventCounter = execution.oomEventCounter ?? null;
  const oomKillObserved = (oomEventCounter?.delta?.oom_kill ?? 0) > 0;
  const failure = !cleanup.verified
    ? { classification: 'cleanup_failed' }
    : execution.failureClassification
      ? {
          classification: execution.failureClassification,
          ...(execution.failureCode ? { code: execution.failureCode } : {}),
        }
      : execution.timedOut
        ? { classification: 'timeout' }
        : execution.exitCode === 0
          ? null
          : execution.exitCode === null
            ? { classification: 'setup_failed' }
            : { classification: 'workload_nonzero_exit' };
  return deepFreeze({
    receiptId: randomUUID(),
    requestId: request.requestId,
    operationId: request.operationId,
    generation: request.generation,
    fence: request.fence,
    admission: {
      callerId: request.callerId,
      keyId: request.keyId,
      verified: true,
    },
    sessionRef: request.sessionRef,
    scenarioRef: request.scenarioRef,
    scenarioVersion: request.scenarioVersion,
    snapshotDigest: request.snapshotDigest,
    recipeId: request.recipeId,
    recipeVersion: request.recipeVersion,
    recipeDigest: request.recipeDigest,
    resultMeaning:
      execution.exitCode === null && !execution.timedOut
        ? 'command_not_started'
        : 'observed_command_result_only',
    status: failure ? 'failed' : 'completed',
    startedAt: start,
    endedAt: new Date().toISOString(),
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    resourceAttribution: {
      classification: oomKillObserved
        ? 'cgroup_oom_kill_observed'
        : execution.exitCode === 137 && !execution.timedOut
          ? 'resource_related_unconfirmed'
          : 'not_observed',
      oomEventCounter,
    },
    stdout: execution.stdout,
    stderr: execution.stderr,
    isolation: {
      image: RECIPE.image,
      containerId: cleanup.containerId,
      network: 'none',
      rootFilesystemReadOnly: true,
      workspace: 'container tmpfs, noexec,nosuid,nodev',
      user: RECIPE.user,
      memoryBytes: request.resources.memoryBytes,
      memorySwapBytes: request.resources.memoryBytes,
      cpus: request.resources.cpus,
      pids: request.resources.pids,
      capabilities: 'ALL dropped',
      noNewPrivileges: true,
      seccomp: 'Docker built-in profile',
    },
    failure,
    cleanup: {
      verified: cleanup.verified,
      containerRemoved: cleanup.containerRemoved,
      lateCreatePossible: cleanup.lateCreatePossible === true,
      stagingDirectoryRemoved: cleanup.stagingDirectoryRemoved,
      dockerClientConfigRemoved: cleanup.dockerClientConfigRemoved !== false,
    },
  });
}

async function listOwnedContainers(attempt) {
  const filters = [
    `${LABEL}=${attempt.requestLabel}`,
    `${OPERATION_LABEL}=${attempt.operationLabel}`,
    `${ATTEMPT_LABEL}=${attempt.attemptLabel}`,
  ];
  const args = ['container', 'ls', '--all', '--no-trunc'];
  for (const filter of filters) args.push('--filter', `label=${filter}`);
  if (attempt.containerId) args.push('--filter', `id=${attempt.containerId}`);
  args.push('--format', '{{.ID}}');
  const output = await docker(args, { timeoutMs: 5_000, maxBytes: 4 * 1024 });
  return output.length === 0 ? [] : output.split('\n');
}

async function listNamedContainers(containerName) {
  const output = await docker(
    [
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      `name=^${containerName}$`,
      '--format',
      '{{.ID}}',
    ],
    { timeoutMs: 5_000, maxBytes: 4 * 1024 },
  );
  return output.length === 0 ? [] : output.split('\n');
}

async function listExactContainerId(containerId) {
  const output = await docker(
    [
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      `id=${containerId}`,
      '--format',
      '{{.ID}}',
    ],
    { timeoutMs: 5_000, maxBytes: 4 * 1024 },
  );
  return output.length === 0 ? [] : output.split('\n');
}

function assertOwnedContainer(container, attempt, expectedId = null) {
  if (
    !container ||
    !/^[a-f0-9]{64}$/.test(container.Id ?? '') ||
    (expectedId && container.Id !== expectedId) ||
    container.Config?.Labels?.[LABEL] !== attempt.requestLabel ||
    container.Config?.Labels?.[OPERATION_LABEL] !== attempt.operationLabel ||
    container.Config?.Labels?.[ATTEMPT_LABEL] !== attempt.attemptLabel ||
    (attempt.containerId && container.Id !== attempt.containerId)
  ) {
    throw new ExecutorError(
      'CLEANUP_FAILED',
      'Container ownership could not be verified.',
    );
  }
}

function decodeMountInfoPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function parseCgroupV2Path(raw) {
  const entries = raw
    .split('\n')
    .map((line) => line.split(':'))
    .filter((parts) => parts.length === 3 && parts[0] === '0');
  if (entries.length !== 1 || entries[0][1] !== '') return null;

  const path = entries[0][2];
  if (
    !path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '.' || part === '..') ||
    path
      .split('/')
      .filter(Boolean)
      .some((part) => !/^[A-Za-z0-9_.:@-]+$/.test(part))
  ) {
    return null;
  }
  return path;
}

function containerCgroupPath(path, containerId) {
  return path
    .split('/')
    .some(
      (part) => part === containerId || part === `docker-${containerId}.scope`,
    );
}

async function cgroup2MemoryEventsPath(cgroupPath, containerId) {
  let mountInfo;
  try {
    mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
  } catch {
    return null;
  }

  const candidates = [];
  for (const line of mountInfo.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const mountFields = line.slice(0, separator).split(' ');
    const filesystemFields = line.slice(separator + 3).split(' ');
    if (filesystemFields[0] !== 'cgroup2') continue;
    const mountRoot = decodeMountInfoPath(mountFields[3] ?? '');
    const mountPoint = decodeMountInfoPath(mountFields[4] ?? '');
    if (!mountRoot.startsWith('/') || !mountPoint.startsWith('/')) continue;
    if (
      mountRoot === '/'
        ? !cgroupPath.startsWith('/')
        : cgroupPath !== mountRoot && !cgroupPath.startsWith(`${mountRoot}/`)
    )
      continue;

    const relativePath =
      mountRoot === '/'
        ? cgroupPath.slice(1)
        : cgroupPath === mountRoot
          ? ''
          : cgroupPath.slice(mountRoot.length + 1);
    candidates.push({ mountPoint, relativePath });
  }
  if (candidates.length !== 1) return null;

  const { mountPoint, relativePath } = candidates[0];
  try {
    const resolvedMountPoint = await realpath(mountPoint);
    const directory = resolve(resolvedMountPoint, relativePath);
    if (
      directory !== resolvedMountPoint &&
      !directory.startsWith(`${resolvedMountPoint}/`)
    ) {
      return null;
    }
    if ((await realpath(directory)) !== directory) return null;
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      return null;
    if (!containerCgroupPath(cgroupPath, containerId)) return null;
    return {
      cgroupPath,
      directory,
      eventsPath: join(directory, 'memory.events'),
    };
  } catch {
    return null;
  }
}

function parseMemoryEvents(raw) {
  const counters = {};
  for (const line of raw.trim().split('\n')) {
    const match = /^([a-z][a-z0-9_]*)\s+(\d+)$/.exec(line.trim());
    if (!match || Object.hasOwn(counters, match[1])) return null;
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value < 0) return null;
    counters[match[1]] = value;
  }
  if (!Object.hasOwn(counters, 'oom') || !Object.hasOwn(counters, 'oom_kill'))
    return null;
  return { oom: counters.oom, oom_kill: counters.oom_kill };
}

async function readVerifiedMemoryEvents(path) {
  let handle;
  try {
    const fileInfo = await lstat(path);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) return null;
    if ((await realpath(path)) !== path) return null;
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.dev !== fileInfo.dev ||
      openedInfo.ino !== fileInfo.ino
    ) {
      return null;
    }
    return parseMemoryEvents(await handle.readFile('utf8'));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function sampleOwnedContainerMemoryEvents(
  containerId,
  request,
  attempt,
  onDockerConfigCleanupFailure,
) {
  const dockerCall = async (callback) => {
    try {
      return await callback();
    } catch (error) {
      if (error?.code === 'DOCKER_CONFIG_CLEANUP_FAILED')
        onDockerConfigCleanupFailure();
      throw error;
    }
  };
  try {
    const before = await dockerCall(() => inspectContainer(containerId));
    assertOwnedContainer(before, attempt, containerId);
    await dockerCall(() =>
      verifyContainer(before, request, attempt.containerName, attempt, true),
    );
    const pid = before.State?.Pid;
    if (
      before.State?.Running !== true ||
      !Number.isSafeInteger(pid) ||
      pid < 1
    ) {
      return null;
    }

    const processPath = `/proc/${pid}`;
    const startTicks = parseProcessStartTicks(
      await readFile(`${processPath}/stat`, 'utf8'),
    );
    const cgroupPath = parseCgroupV2Path(
      await readFile(`${processPath}/cgroup`, 'utf8'),
    );
    if (!cgroupPath || !containerCgroupPath(cgroupPath, containerId))
      return null;
    const location = await cgroup2MemoryEventsPath(cgroupPath, containerId);
    if (!location) return null;
    const counters = await readVerifiedMemoryEvents(location.eventsPath);
    if (!counters) return null;

    if (
      parseProcessStartTicks(await readFile(`${processPath}/stat`, 'utf8')) !==
        startTicks ||
      parseCgroupV2Path(await readFile(`${processPath}/cgroup`, 'utf8')) !==
        cgroupPath
    ) {
      return null;
    }
    const after = await dockerCall(() => inspectContainer(containerId));
    assertOwnedContainer(after, attempt, containerId);
    await dockerCall(() =>
      verifyContainer(after, request, attempt.containerName, attempt, true),
    );
    if (after.State?.Pid !== pid || after.State?.Running !== true) return null;

    return {
      containerId,
      pid,
      startTicks,
      cgroupPath,
      eventsPath: location.eventsPath,
      counters,
    };
  } catch (error) {
    if (error?.code === 'DOCKER_CONFIG_CLEANUP_FAILED')
      onDockerConfigCleanupFailure();
    return null;
  }
}

function pairMemoryEventSamples(baseline, post) {
  if (
    !baseline ||
    !post ||
    baseline.containerId !== post.containerId ||
    baseline.pid !== post.pid ||
    baseline.startTicks !== post.startTicks ||
    baseline.cgroupPath !== post.cgroupPath ||
    baseline.eventsPath !== post.eventsPath
  ) {
    return null;
  }
  const keys = Object.keys(baseline.counters).sort();
  if (
    keys.join('\0') !== Object.keys(post.counters).sort().join('\0') ||
    !keys.includes('oom_kill')
  ) {
    return null;
  }
  const delta = {};
  for (const key of keys) {
    const before = baseline.counters[key];
    const after = post.counters[key];
    if (after < before) return null;
    delta[key] = after - before;
  }
  return {
    source: 'cgroup_v2_memory.events',
    baseline: baseline.counters,
    post: post.counters,
    delta,
  };
}

async function cleanupContainer(attempt) {
  let dockerClientConfigRemoved = true;
  if (attempt.stage === 'prepared') {
    return {
      verified: true,
      containerRemoved: true,
      containerId: null,
      containerStatus: 'absent',
      lateCreatePossible: false,
      stagingDirectoryRemoved: true,
      dockerClientConfigRemoved,
    };
  }

  let containerId = attempt.containerId;
  let sawOwnedContainer = false;
  const delays = [0, 50, 100, 200];
  for (const delayMs of delays) {
    if (delayMs > 0)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    const ids = await listOwnedContainers({ ...attempt, containerId: null });
    for (const id of await listNamedContainers(attempt.containerName)) {
      if (!ids.includes(id)) ids.push(id);
    }
    if (containerId) {
      for (const id of await listExactContainerId(containerId)) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
    if (ids.length > 1 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
      throw new ExecutorError(
        'CLEANUP_FAILED',
        'The executor container identity is ambiguous.',
      );
    }
    if (ids.length === 0) continue;

    const id = ids[0];
    const container = await inspectContainer(id);
    if (attempt.containerId && id !== attempt.containerId) {
      throw new ExecutorError(
        'CLEANUP_FAILED',
        'A different container carries the executor ownership labels.',
      );
    }
    assertOwnedContainer(container, attempt, id);
    sawOwnedContainer = true;
    containerId = id;

    // Recheck immutable container ID and all ownership labels immediately before removal.
    const current = await inspectContainer(containerId);
    assertOwnedContainer(current, attempt, containerId);
    try {
      await docker(['container', 'rm', '--force', containerId], {
        timeoutMs: 10_000,
        maxBytes: 4 * 1024,
      });
    } catch (error) {
      if (error?.code === 'DOCKER_CONFIG_CLEANUP_FAILED')
        dockerClientConfigRemoved = false;
      // The exact-ID absence check below decides whether removal completed.
    }
  }

  const remaining = await listOwnedContainers({
    ...attempt,
    containerId: null,
  });
  for (const id of await listNamedContainers(attempt.containerName)) {
    if (!remaining.includes(id)) remaining.push(id);
  }
  if (containerId) {
    for (const id of await listExactContainerId(containerId)) {
      if (!remaining.includes(id)) remaining.push(id);
    }
  }
  if (remaining.length > 0) {
    for (const id of remaining) {
      const container = await inspectContainer(id);
      assertOwnedContainer(container, attempt, id);
    }
    return {
      verified: false,
      containerRemoved: false,
      containerId,
      containerStatus: 'present',
      lateCreatePossible: attempt.createAmbiguous,
      stagingDirectoryRemoved: true,
      dockerClientConfigRemoved,
    };
  }
  if (attempt.createAmbiguous) {
    return {
      verified: false,
      containerRemoved: sawOwnedContainer,
      containerId: sawOwnedContainer ? containerId : null,
      containerStatus: sawOwnedContainer ? 'removed' : 'absent',
      lateCreatePossible: true,
      stagingDirectoryRemoved: true,
      dockerClientConfigRemoved,
    };
  }
  return {
    verified: dockerClientConfigRemoved,
    containerRemoved: true,
    containerId,
    containerStatus: sawOwnedContainer ? 'removed' : 'absent',
    lateCreatePossible: false,
    stagingDirectoryRemoved: true,
    dockerClientConfigRemoved,
  };
}

async function setupFailureReceipt(request, startedAt, error, cleanup) {
  const verified =
    cleanup.containerRemoved && cleanup.dockerClientConfigRemoved !== false;
  const receipt = makeReceipt(
    request,
    startedAt,
    {
      exitCode: null,
      timedOut: false,
      failureClassification:
        error?.code === 'UNSUPPORTED_ISOLATION'
          ? 'unsupported_isolation'
          : 'setup_failed',
      failureCode: error?.code ?? 'UNKNOWN_SETUP_FAILURE',
      stdout: {
        base64: '',
        byteCount: 0,
        observedByteCount: 0,
        truncated: false,
        sha256: sha256(Buffer.alloc(0)),
      },
      stderr: {
        base64: '',
        byteCount: 0,
        observedByteCount: 0,
        truncated: false,
        sha256: sha256(Buffer.alloc(0)),
      },
    },
    { ...cleanup, verified, stagingDirectoryRemoved: true },
  );
  return receipt;
}

export function createExecutor(config) {
  if (
    config === null ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).sort().join(',') !== 'admissionKeys,pool'
  ) {
    throw new ExecutorError(
      'INVALID_CONFIG',
      'config must contain only pool and admissionKeys.',
    );
  }
  const admissionKeys = validateAdmissionKeys(config.admissionKeys);
  const store = createPostgresExecutionStore({ pool: config.pool });

  async function run(request) {
    const validated = validateRequest(request, admissionKeys);
    const { files, intent, intentDigest } = validated;
    const inputBytes = snapshotInput(files);
    requireSupportedRecipe(intent);
    const owner = await currentProcessIdentity();
    const attemptId = randomUUID().replaceAll('-', '');
    const attempt = {
      attemptId,
      containerName: `hirearchy-executor-codex-${attemptId}`,
      requestLabel: sha256(
        `${intent.requestId}\0${intentDigest}\0${attemptId}`,
      ),
      operationLabel: sha256(intent.operationId),
      attemptLabel: attemptId,
      stage: 'prepared',
      createAmbiguous: false,
      containerId: null,
    };
    const reservation = await store.reserve({
      intent,
      intentDigest,
      owner,
      attempt,
      ownerIsAlive: processIdentityIsAlive,
    });
    if (reservation.receipt) return deepFreeze(reservation.receipt);

    const handle = reservation.handle;
    let currentAttempt = reservation.entry.attempt;
    let workloadStarted = false;
    let dockerClientConfigCleanupFailed = false;
    let oomEventBaseline = null;
    let startedAt = new Date().toISOString();
    let execution;
    let setupError;
    let unknownError;
    let persistenceError;
    let cleanup = {
      verified: true,
      containerRemoved: true,
      containerId: null,
      containerStatus: 'absent',
      lateCreatePossible: false,
      stagingDirectoryRemoved: true,
      dockerClientConfigRemoved: true,
    };
    const saveAttempt = async (patch) => {
      const entry = await store.updateAttempt(handle, patch);
      currentAttempt = entry.attempt;
    };

    try {
      await preflight();
      await saveAttempt({ stage: 'creating', createAmbiguous: true });
      const created = await docker(
        [
          'container',
          'create',
          '--name',
          currentAttempt.containerName,
          '--label',
          `${LABEL}=${currentAttempt.requestLabel}`,
          '--label',
          `${OPERATION_LABEL}=${currentAttempt.operationLabel}`,
          '--label',
          `${ATTEMPT_LABEL}=${currentAttempt.attemptLabel}`,
          '--network',
          'none',
          '--read-only',
          '--tmpfs',
          '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
          '--tmpfs',
          '/workspace:rw,noexec,nosuid,nodev,size=16m,uid=65534,gid=65534,mode=0755',
          '--shm-size=16m',
          ...resourceArgs(intent.resources),
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges:true',
          '--cgroupns',
          'private',
          '--user',
          RECIPE.user,
          '--workdir',
          RECIPE.workingDirectory,
          '--entrypoint',
          RECIPE.bootstrap[0],
          RECIPE.image,
          ...RECIPE.bootstrap.slice(1),
        ],
        { timeoutMs: 10_000, maxBytes: 4 * 1024 },
      );
      if (!/^[a-f0-9]{64}$/.test(created)) {
        throw new ExecutorError(
          'DOCKER_FAILURE',
          'Docker did not return a container identity.',
        );
      }
      await saveAttempt({
        stage: 'created',
        createAmbiguous: false,
        containerId: created,
      });
      const inspected = await inspectContainer(created);
      if (inspected.Id !== created) {
        throw new ExecutorError(
          'DOCKER_FAILURE',
          'Docker container identity changed during setup.',
        );
      }
      await verifyContainer(
        inspected,
        intent,
        currentAttempt.containerName,
        currentAttempt,
      );
      await saveAttempt({ stage: 'starting' });
      await docker(['container', 'start', created], {
        timeoutMs: 10_000,
        maxBytes: 4 * 1024,
      });
      const running = await inspectContainer(created);
      if (running.State?.Running !== true) {
        throw new ExecutorError(
          'DOCKER_FAILURE',
          'The restricted container did not start.',
        );
      }
      await verifyContainer(
        running,
        intent,
        currentAttempt.containerName,
        currentAttempt,
        true,
      );
      await docker(
        [
          'exec',
          '-i',
          '--user',
          RECIPE.user,
          '--workdir',
          RECIPE.workingDirectory,
          created,
          RECIPE.argv[0],
          '-B',
          '-c',
          SNAPSHOT_LOADER,
        ],
        {
          timeoutMs: 10_000,
          maxBytes: 4 * 1024,
          inputBytes,
        },
      );

      const socket = await realpath(DOCKER_SOCKET);
      const apiVersion = await dockerApiVersion(socket);
      const execId = await createExec(socket, apiVersion, created);
      await saveAttempt({ stage: 'running' });
      workloadStarted = true;
      oomEventBaseline = await sampleOwnedContainerMemoryEvents(
        created,
        intent,
        currentAttempt,
        () => {
          dockerClientConfigCleanupFailed = true;
        },
      );
      startedAt = new Date().toISOString();
      execution = await startExec(
        socket,
        apiVersion,
        created,
        execId,
        intent.outputBytes,
        intent.timeoutMs,
      );
      if (!execution.timedOut) {
        const oomEventPost = await sampleOwnedContainerMemoryEvents(
          created,
          intent,
          currentAttempt,
          () => {
            dockerClientConfigCleanupFailed = true;
          },
        );
        execution = {
          ...execution,
          oomEventCounter: pairMemoryEventSamples(
            oomEventBaseline,
            oomEventPost,
          ),
        };
      }
    } catch (error) {
      if (error instanceof ExecutionStoreError) persistenceError = error;
      else if (error?.code === 'EXECUTION_UNKNOWN' || workloadStarted)
        unknownError = error;
      else setupError = error;
    } finally {
      try {
        cleanup = await cleanupContainer(currentAttempt);
      } catch (error) {
        cleanup = {
          verified: false,
          containerRemoved: false,
          containerId: currentAttempt.containerId,
          containerStatus:
            error?.code === 'CLEANUP_FAILED' ? 'unverified' : 'unavailable',
          lateCreatePossible: currentAttempt.createAmbiguous,
          stagingDirectoryRemoved: true,
          dockerClientConfigRemoved:
            error?.code !== 'DOCKER_CONFIG_CLEANUP_FAILED',
        };
      }
      cleanup.dockerClientConfigRemoved =
        cleanup.dockerClientConfigRemoved !== false &&
        setupError?.code !== 'DOCKER_CONFIG_CLEANUP_FAILED' &&
        !dockerClientConfigCleanupFailed;
      if (!cleanup.dockerClientConfigRemoved) cleanup.verified = false;
    }

    try {
      if (persistenceError) throw persistenceError;

      if (unknownError || !cleanup.verified || currentAttempt.createAmbiguous) {
        await store.markUnknown(handle, {
          attempt: currentAttempt,
          cleanup,
        });
        const executionUnknown =
          currentAttempt.createAmbiguous ||
          (cleanup.verified && Boolean(unknownError));
        throw new ExecutorError(
          executionUnknown ? 'EXECUTION_UNKNOWN' : 'CLEANUP_FAILED',
          executionUnknown
            ? 'Recipe outcome is ambiguous; this request will not be rerun.'
            : 'Owned-resource cleanup is not verified; this request will not be rerun.',
        );
      }

      if (setupError) {
        const receipt = await setupFailureReceipt(
          intent,
          startedAt,
          setupError,
          cleanup,
        );
        await store.complete(handle, {
          attempt: currentAttempt,
          cleanup,
          receipt,
        });
        return receipt;
      }

      if (!execution) {
        await store.markUnknown(handle, {
          attempt: currentAttempt,
          cleanup,
        });
        throw new ExecutorError(
          'EXECUTION_UNKNOWN',
          'Recipe outcome is ambiguous; this request will not be rerun.',
        );
      }

      const receipt = makeReceipt(intent, startedAt, execution, cleanup);
      await store.complete(handle, {
        attempt: currentAttempt,
        cleanup,
        receipt,
      });
      return receipt;
    } finally {
      await store.release(handle);
    }
  }

  async function reconcile(requestId) {
    requireIdentifier(requestId, 'requestId');
    const owner = await currentProcessIdentity();
    const target = await store.claimReconciliation({
      requestId,
      owner,
      ownerIsAlive: processIdentityIsAlive,
    });
    if (target.completed) {
      return deepFreeze({
        requestId,
        operationId: target.operationId,
        generation: target.entry.generation,
        fence: target.entry.fence,
        state: 'complete',
        receipt: target.entry.receipt,
      });
    }

    let attempt = target.entry.attempt;
    let cleanup;
    try {
      try {
        cleanup = await cleanupContainer(attempt);
      } catch (error) {
        cleanup = {
          verified: false,
          containerRemoved: false,
          containerId: attempt.containerId,
          containerStatus:
            error?.code === 'CLEANUP_FAILED' ? 'unverified' : 'unavailable',
          lateCreatePossible: attempt.createAmbiguous,
          stagingDirectoryRemoved: true,
          dockerClientConfigRemoved:
            error?.code !== 'DOCKER_CONFIG_CLEANUP_FAILED',
        };
      }
      if (cleanup.containerId) {
        attempt = { ...attempt, containerId: cleanup.containerId };
      }
      const finalized = await store.finishReconciliation(target.handle, {
        attempt,
        cleanup,
      });
      const lateCreatePossible = finalized.attempt.createAmbiguous;
      return deepFreeze({
        requestId,
        operationId: target.operationId,
        generation: finalized.generation,
        fence: finalized.fence,
        state: 'unknown',
        observedAt: new Date().toISOString(),
        attemptId: finalized.attempt.attemptId,
        container: {
          status: cleanup.containerStatus,
          ...(cleanup.containerId ? { containerId: cleanup.containerId } : {}),
        },
        cleanup: {
          attempted: finalized.attempt.stage !== 'prepared',
          verified: cleanup.verified,
          containerRemoved: cleanup.containerRemoved,
          lateCreatePossible: cleanup.lateCreatePossible === true,
        },
        reason: lateCreatePossible
          ? 'ambiguous_create_may_complete_late'
          : 'execution_outcome_remains_unknown',
      });
    } finally {
      await store.release(target.handle);
    }
  }

  return Object.freeze({ snapshotDigest, run, reconcile });
}
