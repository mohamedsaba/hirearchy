import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { readFileSync, statfsSync } from 'node:fs';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const previewCompose = 'deploy/staging/docker-compose.preview.yml';
const stagingCompose = 'deploy/staging/docker-compose.staging.yml';
let previewComposeFiles = [previewCompose];
let stagingComposeFiles = [stagingCompose];
const execFileAsync = promisify(execFile);
const me = fileURLToPath(import.meta.url);

function childEnvironment(extra = {}) {
  const allowed = [
    'PATH',
    'HOME',
    'TMPDIR',
    'XDG_RUNTIME_DIR',
    'DOCKER_CONFIG',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ];
  return {
    ...Object.fromEntries(
      allowed
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    ),
    ...extra,
  };
}

function docker(...args) {
  return execFileSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function safeFailureDiagnostic(error, envFiles, privateValues) {
  const redactions = new Set();
  const addRedaction = (value) => {
    if (!value || value.length < 4) return;
    redactions.add(value);
    try {
      const url = new URL(value);
      if (url.username) redactions.add(decodeURIComponent(url.username));
      if (url.password) redactions.add(decodeURIComponent(url.password));
    } catch {
      // Most values are not URLs.
    }
  };
  for (const value of privateValues) addRedaction(value);
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
  ]) {
    addRedaction(process.env[name]);
  }
  let environmentReadable = true;
  for (const envFile of envFiles) {
    try {
      for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
        if (
          !match ||
          (!/(PASSWORD|SECRET|TOKEN|PRIVATE|KEY|CREDENTIAL)/i.test(match[1]) &&
            !/(^|_)DATABASE_URL$/i.test(match[1]))
        ) {
          continue;
        }
        const value = match[2].trim().replace(/^['"]|['"]$/g, '');
        addRedaction(value);
      }
    } catch {
      environmentReadable = false;
    }
  }

  let errorLine;
  if (environmentReadable) {
    let detail = Buffer.isBuffer(error.stderr)
      ? error.stderr.toString('utf8')
      : typeof error.stderr === 'string'
        ? error.stderr
        : '';
    for (const value of redactions) {
      detail = detail.replaceAll(value, '[redacted]');
    }
    errorLine = detail
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/\b[a-f0-9]{12,64}\b/gi, '[redacted-id]')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) =>
        /error|failed|invalid|denied|already|not found|cannot|could not/i.test(
          line,
        ),
      )
      .slice(-1)[0]
      ?.slice(0, 400);
  }

  const assertionValues =
    error.code === 'ERR_ASSERTION' &&
    ['number', 'boolean'].includes(typeof error.actual) &&
    ['number', 'boolean'].includes(typeof error.expected)
      ? ' actual=' + error.actual + ' expected=' + error.expected
      : '';
  const diagnostic = [
    'type=' + (error.name || 'Error'),
    Number.isInteger(error.status) ? 'exit=' + error.status : null,
    error.code ? 'code=' + error.code : null,
    error.code === 'ERR_ASSERTION' && error.operator
      ? 'assertion=' + error.operator + assertionValues
      : null,
    errorLine ? 'stderr=' + errorLine : null,
  ].filter(Boolean);
  return diagnostic.join(' ');
}

async function selfCheckSafeFailureDiagnostic() {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), 'hirearchy-diagnostic-check-'),
  );
  const envFile = path.join(tempDir, 'synthetic.env');
  const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
  const previousProxyValues = new Map(
    proxyNames.map((name) => [name, process.env[name]]),
  );
  const secrets = [
    'synthetic-db-password-123',
    'synthetic-url-password-456',
    'synthetic-proxy-password-789',
  ];
  const proxyUrl =
    'http://proxy-user:' + secrets[2] + '@proxy.example.test:8080';
  try {
    await writeFile(
      envFile,
      [
        'POSTGRES_PASSWORD=' + secrets[0],
        'DATABASE_URL=postgres://db-user:' +
          secrets[1] +
          '@db.example.test/postgres',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    process.env.HTTP_PROXY = proxyUrl;
    const error = new Error('synthetic diagnostic');
    error.stderr = Buffer.from('Error: ' + secrets.join(' ') + ' ' + proxyUrl);
    const safe = safeFailureDiagnostic(error, [envFile], []);
    for (const secret of secrets) assert.ok(!safe.includes(secret));
    assert.ok(!safe.includes('proxy-user'));
    assert.match(safe, /stderr=Error:/);

    const unreadable = safeFailureDiagnostic(
      Object.assign(new Error('missing env file'), {
        stderr: Buffer.from('Error: unreadable-env-secret'),
      }),
      [path.join(tempDir, 'missing.env')],
      [],
    );
    assert.ok(!unreadable.includes('stderr='));
    assert.ok(!unreadable.includes('unreadable-env-secret'));
  } finally {
    for (const name of proxyNames) {
      const value = previousProxyValues.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

function assertLocalDockerTarget() {
  const context =
    process.env.DOCKER_CONTEXT || docker('context', 'show').trim();
  const contextEndpoint = docker(
    'context',
    'inspect',
    '--format',
    '{{(index .Endpoints "docker").Host}}',
    context,
  ).trim();
  const endpoints = [contextEndpoint, process.env.DOCKER_HOST].filter(Boolean);
  assert.ok(
    endpoints.length > 0 &&
      endpoints.every(
        (endpoint) =>
          endpoint.startsWith('unix://') &&
          path.isAbsolute(endpoint.slice('unix://'.length)),
      ),
    'The release package rehearsal requires only a local Unix-socket Docker endpoint.',
  );
  if (process.env.DOCKER_HOST && process.env.DOCKER_CONTEXT) {
    assert.equal(
      process.env.DOCKER_HOST,
      contextEndpoint,
      'DOCKER_HOST and DOCKER_CONTEXT must select the same local daemon.',
    );
  }
}

function assertNoProjectResourceCollision(projectName) {
  const projectLabel = 'label=com.docker.compose.project=' + projectName;
  const labeled = [
    docker('ps', '-aq', '--filter', projectLabel),
    docker('network', 'ls', '-q', '--filter', projectLabel),
    docker('volume', 'ls', '-q', '--filter', projectLabel),
  ];
  const namePrefix = projectName + '-';
  const namedResources = [
    docker('ps', '-a', '--format', '{{.Names}}'),
    docker('network', 'ls', '--format', '{{.Name}}'),
    docker('volume', 'ls', '--format', '{{.Name}}'),
  ]
    .flatMap((listing) => listing.split(/\r?\n/))
    .filter((name) => name.startsWith(namePrefix));
  assert.ok(
    labeled.every((listing) => !listing) && namedResources.length === 0,
    'Refusing to reuse a Compose project name that already owns resources.',
  );
}

async function writeInternalCaddyConfigs(tempDir) {
  const previewSource = await readFile(
    path.join(root, 'deploy/staging/Caddyfile.preview'),
    'utf8',
  );
  const stagingSource = await readFile(
    path.join(root, 'deploy/staging/Caddyfile.staging'),
    'utf8',
  );
  const previewAnchor = '{$PUBLIC_HOSTNAME} {';
  const stagingPreviewAnchor = '{$PREVIEW_HOSTNAME} {';
  const stagingAlphaAnchor = '{$STAGING_HOSTNAME} {';
  assert.equal(previewSource.split(previewAnchor).length, 2);
  assert.equal(stagingSource.split(stagingPreviewAnchor).length, 2);
  assert.equal(stagingSource.split(stagingAlphaAnchor).length, 2);

  const previewConfig = previewSource.replace(
    previewAnchor,
    previewAnchor + '\n\ttls internal',
  );
  const stagingConfig = stagingSource
    .replace(stagingPreviewAnchor, stagingPreviewAnchor + '\n\ttls internal')
    .replace(stagingAlphaAnchor, stagingAlphaAnchor + '\n\ttls internal');
  assert.ok(previewConfig.includes(previewAnchor + '\n\ttls internal'));
  assert.ok(stagingConfig.includes(stagingPreviewAnchor + '\n\ttls internal'));
  assert.ok(stagingConfig.includes(stagingAlphaAnchor + '\n\ttls internal'));
  const previewPath = path.join(tempDir, 'Caddyfile.preview.internal');
  const stagingPath = path.join(tempDir, 'Caddyfile.staging.internal');
  await writeFile(previewPath, previewConfig, { mode: 0o644, flag: 'wx' });
  await writeFile(stagingPath, stagingConfig, { mode: 0o644, flag: 'wx' });

  const writeOverride = async (sourcePath, targetName) => {
    const overridePath = path.join(tempDir, targetName);
    await writeFile(
      overridePath,
      [
        'services:',
        '  caddy:',
        '    volumes:',
        '      - type: bind',
        '        source: ' + JSON.stringify(sourcePath),
        '        target: /etc/caddy/Caddyfile',
        '        read_only: true',
        '',
      ].join('\n'),
      { mode: 0o600, flag: 'wx' },
    );
    return overridePath;
  };

  return {
    previewOverride: await writeOverride(
      previewPath,
      'compose.preview.internal.yml',
    ),
    stagingOverride: await writeOverride(
      stagingPath,
      'compose.staging.internal.yml',
    ),
  };
}

async function dockerAsync(...args) {
  const result = await execFileAsync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    env: childEnvironment(),
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function runResourceSampler(projectName, outputPath) {
  let stopping = false;
  process.once('SIGTERM', () => {
    stopping = true;
  });
  process.once('SIGINT', () => {
    stopping = true;
  });

  const startedAt = Date.now();
  const memoryFreeAtStart = os.freemem();
  const dockerRoot = await dockerAsync(
    'info',
    '--format',
    '{{.DockerRootDir}}',
  );
  const diskAtStart = statfsSync(dockerRoot);
  const limitsByService = {};
  let peakMemoryMiB = 0;
  let peakCpuPercent = 0;
  let peakAtSeconds = 0;
  let samples = 0;

  while (!stopping) {
    try {
      const ids = (
        await dockerAsync(
          'ps',
          '-q',
          '--filter',
          'label=com.docker.compose.project=' + projectName,
        )
      )
        .split(/\s+/)
        .filter(Boolean);
      const containers = ids.length
        ? (
            await dockerAsync(
              'inspect',
              '--format',
              '{{.Id}}\t{{.Name}}\t{{.HostConfig.Memory}}\t{{.HostConfig.NanoCpus}}\t{{.HostConfig.CpuQuota}}\t{{.HostConfig.CpuPeriod}}\t{{.HostConfig.PidsLimit}}',
              ...ids,
            )
          )
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
              const [, rawName, ...rawLimits] = line.split('\t');
              const [memoryBytes, nanoCpus, cpuQuota, cpuPeriod, pidsLimit] =
                rawLimits.map(Number);
              const name = rawName.replace(/^\//, '');
              const service = name
                .slice(projectName.length + 1)
                .replace(/-\d+$/, '');
              const limits = {
                service,
                memoryMiB: memoryBytes > 0 ? memoryBytes / 1048576 : null,
                cpuCores:
                  nanoCpus > 0
                    ? nanoCpus / 1_000_000_000
                    : cpuQuota > 0 && cpuPeriod > 0
                      ? cpuQuota / cpuPeriod
                      : null,
                pidsLimit: pidsLimit > 0 ? pidsLimit : null,
              };
              limitsByService[service] = limits;
              return { name, limits };
            })
        : [];
      const limitsByName = new Map(
        containers.map(({ name, limits }) => [name, { limits }]),
      );
      const lines = ids.length
        ? (
            await dockerAsync(
              'stats',
              '--no-stream',
              '--format',
              '{{.Name}}\t{{.MemPerc}}\t{{.CPUPerc}}',
              ...ids,
            )
          )
            .split(/\r?\n/)
            .filter(Boolean)
        : [];
      let totalMemoryMiB = 0;
      let totalCpuPercent = 0;

      for (const line of lines) {
        const [rawName, rawMemory, rawCpu] = line.split('\t');
        const name = rawName?.replace(/^\//, '');
        const memoryPercent = Number.parseFloat(rawMemory);
        const cpuPercent = Number.parseFloat(rawCpu);
        const container = limitsByName.get(name);
        const limits = container?.limits;
        if (
          !container ||
          !Number.isFinite(memoryPercent) ||
          !Number.isFinite(cpuPercent)
        )
          continue;

        if (limits.memoryMiB !== null) {
          totalMemoryMiB += limits.memoryMiB * (memoryPercent / 100);
        }
        totalCpuPercent += cpuPercent;
      }

      samples += 1;
      if (totalMemoryMiB > peakMemoryMiB) {
        peakMemoryMiB = totalMemoryMiB;
        peakAtSeconds = (Date.now() - startedAt) / 1000;
      }
      peakCpuPercent = Math.max(
        peakCpuPercent,
        (totalCpuPercent / os.availableParallelism()) * 100,
      );
    } catch {
      // Sampling is best-effort; the deployment assertions remain authoritative.
    }
    await delay(1000);
  }

  const diskAtEnd = statfsSync(dockerRoot);
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        method: 'docker stats sampled approximately once per second',
        workload:
          'Fresh preview-to-alpha startup, one synthetic intake, health/readiness probes, PostgreSQL outage and recovery; no concurrent or sustained load.',
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        samples,
        host: {
          cpuCores: os.availableParallelism(),
          memoryTotalMiB: Math.round(os.totalmem() / 1048576),
          memoryFreeAtStartMiB: Math.round(memoryFreeAtStart / 1048576),
          memoryFreeAtEndMiB: Math.round(os.freemem() / 1048576),
          dockerDiskTotalGiB: Number(
            ((diskAtStart.blocks * diskAtStart.bsize) / 1073741824).toFixed(2),
          ),
          dockerDiskAvailableAtStartGiB: Number(
            ((diskAtStart.bavail * diskAtStart.bsize) / 1073741824).toFixed(2),
          ),
          dockerDiskAvailableAtEndGiB: Number(
            ((diskAtEnd.bavail * diskAtEnd.bsize) / 1073741824).toFixed(2),
          ),
        },
        configuredContainerLimits: limitsByService,
        observedPeak: {
          projectMemoryMiB: Number(peakMemoryMiB.toFixed(1)),
          projectCpuPercentOfHost: Number(peakCpuPercent.toFixed(1)),
          sampledAtSeconds: Number(peakAtSeconds.toFixed(1)),
        },
        limitation:
          'This small synthetic sample is not a concurrency, latency, disk-growth, or capacity guarantee.',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}

async function reservePort(used) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (!used.has(port)) {
      used.add(port);
      return port;
    }
  }
  throw new Error('Could not reserve distinct loopback ports');
}

async function writeConfiguredEnvironment(templatePath, targetPath, overrides) {
  let content = await readFile(templatePath, 'utf8');
  for (const [name, value] of Object.entries(overrides)) {
    const lines = content.split(/\r?\n/);
    const matches = lines.filter((line) => line.startsWith(name + '='));
    assert.equal(matches.length, 1, 'Environment template must define ' + name);
    content = lines
      .map((line) => (line.startsWith(name + '=') ? name + '=' + value : line))
      .join('\n');
  }
  await writeFile(targetPath, content, { mode: 0o600, flag: 'wx' });
  await chmod(targetPath, 0o600);
  assert.equal((await stat(targetPath)).mode & 0o777, 0o600);
}

function composePrefix(envFile, composeFile, projectName) {
  const selectedFiles = Array.isArray(composeFile)
    ? composeFile
    : composeFile === previewCompose
      ? previewComposeFiles
      : composeFile === stagingCompose
        ? stagingComposeFiles
        : [composeFile];
  return [
    'compose',
    '--env-file',
    envFile,
    '--project-name',
    projectName,
    '--project-directory',
    path.join(root, 'deploy/staging'),
    ...selectedFiles.flatMap((file) => ['-f', file]),
  ];
}

function compose(envFile, composeFile, projectName, ...args) {
  return docker(...composePrefix(envFile, composeFile, projectName), ...args);
}

async function assertComposeBuildInputs(envFile, composeFile, projectName) {
  const config = JSON.parse(
    compose(envFile, composeFile, projectName, 'config', '--format', 'json'),
  );
  const buildServices = Object.entries(config.services).filter(
    ([, service]) => service.build,
  );
  assert.ok(buildServices.length > 0, 'Compose must define build inputs');
  for (const [serviceName, service] of buildServices) {
    assert.equal(
      path.resolve(service.build.context),
      root,
      'Compose build context must resolve to the repository root: ' +
        serviceName,
    );
    const dockerfile = path.resolve(
      service.build.context,
      service.build.dockerfile || 'Dockerfile',
    );
    await stat(dockerfile);
  }
}

function composeOperatorTool(envFile, projectName, operatorDir, ...args) {
  return docker(
    ...composePrefix(envFile, stagingCompose, projectName),
    'run',
    '--rm',
    '-T',
    '--volume',
    operatorDir + ':/run/hirearchy/operator:rw',
    ...args,
  );
}

function setOperatorDirectoryOwner(
  envFile,
  projectName,
  operatorDir,
  uid,
  gid,
) {
  composeOperatorTool(
    envFile,
    projectName,
    operatorDir,
    '--user',
    '0:0',
    '--entrypoint',
    'chown',
    'web-preview',
    '-R',
    uid + ':' + gid,
    '/run/hirearchy/operator',
  );
}

function runNodeWithEnvironment(envFile, script, extraEnv = {}) {
  return execFileSync(process.execPath, ['--env-file=' + envFile, script], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnvironment(extraEnv),
    maxBuffer: 8 * 1024 * 1024,
  });
}

function runProbe(envFile, logPath) {
  return spawnSync('bash', ['scripts/run-staging-readiness-check.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: childEnvironment({
      STAGING_ENV_FILE: envFile,
      STAGING_READINESS_LOG: logPath,
    }),
    maxBuffer: 1024 * 1024,
  });
}

async function waitFor(check, description, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {
      // Startup probes retry until the fixed deadline.
    }
    await delay(1000);
  }
  throw new Error('Timed out waiting for ' + description);
}

async function waitForHealthy(envFile, composeFile, projectName, service) {
  return waitFor(() => {
    const id = compose(envFile, composeFile, projectName, 'ps', '-q', service);
    if (!id) return false;
    const status = docker(
      'inspect',
      '--format',
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
      id,
    );
    return status === 'healthy';
  }, service + ' health');
}

async function localCaFromCaddy(envFile, composeFile, projectName) {
  return waitFor(() => {
    const id = compose(envFile, composeFile, projectName, 'ps', '-q', 'caddy');
    if (!id) return false;
    const found = docker(
      'exec',
      id,
      'find',
      '/data',
      '-path',
      '*/pki/authorities/local/root.crt',
      '-type',
      'f',
    )
      .split(/\r?\n/)
      .find((value) => value.endsWith('/pki/authorities/local/root.crt'));
    if (!found) return false;
    return docker('exec', id, 'cat', found);
  }, 'Caddy local CA');
}

function curlRequest({
  url,
  host,
  port,
  caFile,
  sourceAddress,
  method,
  headers = [],
  body,
}) {
  const args = [
    '-sS',
    '--max-time',
    '15',
    '--dump-header',
    '-',
    '--output',
    '-',
    '--write-out',
    '\n__HIREARCHY_STATUS__%{http_code}',
  ];
  if (url.startsWith('https://')) args.push('--cacert', caFile);
  if (host && port) args.push('--resolve', host + ':' + port + ':127.0.0.1');
  if (sourceAddress) args.push('--interface', sourceAddress);
  if (method) args.push('-X', method);
  for (const header of headers) args.push('-H', header);
  if (body !== undefined) args.push('--data-binary', body);
  args.push(url);

  const raw = execFileSync('curl', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnvironment({ NO_PROXY: '*', no_proxy: '*' }),
    maxBuffer: 2 * 1024 * 1024,
  });
  const marker = '\n__HIREARCHY_STATUS__';
  const markerIndex = raw.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1, 'curl returned an HTTP status');
  const responseText = raw.slice(0, markerIndex);
  const headerEnd = responseText.indexOf('\r\n\r\n');
  const headerBlock = headerEnd >= 0 ? responseText.slice(0, headerEnd) : '';
  const responseBody =
    headerEnd >= 0 ? responseText.slice(headerEnd + 4) : responseText;
  const status = Number(raw.slice(markerIndex + marker.length).trim());
  const location = headerBlock
    .split(/\r?\n/)
    .find((line) => /^location:/i.test(line))
    ?.replace(/^location:\s*/i, '')
    .trim();
  return { status, headers: headerBlock, body: responseBody, location };
}

async function startSampler(projectName, outputPath) {
  const child = spawn(
    process.execPath,
    [me, '--sample-resources', projectName, outputPath],
    { cwd: root, stdio: 'ignore', env: childEnvironment() },
  );
  await waitFor(
    () => (child.exitCode === null ? true : false),
    'resource sampler startup',
    5000,
  );
  return child;
}

async function stopSampler(child, outputPath) {
  if (!child) return null;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([exited, delay(10_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    return null;
  }
  return JSON.parse(await readFile(outputPath, 'utf8'));
}

async function testPackage() {
  await selfCheckSafeFailureDiagnostic();
  console.log('Safe failure diagnostic redaction self-check passed.');
  const runId = randomBytes(8).toString('hex');
  const projectName = 'hirearchy-release-smoke-' + runId;
  assert.match(projectName, /^hirearchy-release-smoke-[a-f0-9]{16}$/);
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), 'hirearchy-release-smoke-'),
  );
  const previewEnv = path.join(tempDir, 'preview.env');
  const stagingEnv = path.join(tempDir, 'staging.env');
  const localCaFile = path.join(tempDir, 'caddy-root-ca.crt');
  const alertFile = path.join(tempDir, 'readiness-alerts.jsonl');
  const resourceFile = path.join(tempDir, 'resource-sample.json');
  const operatorDir = path.join(tempDir, 'operator');
  let sampler;
  let operatorDirectoryOwnedByContainer = false;
  let previewEnvReady = false;
  let stagingEnvReady = false;
  let previewStackStarted = false;
  let stagingStackStarted = false;
  let cleanupFailed = false;
  let syntheticEmail;
  let stage = 'prepare isolated loopback environments';

  try {
    assertLocalDockerTarget();
    await mkdir(operatorDir, { mode: 0o700 });
    await chmod(operatorDir, 0o700);
    assert.equal((await stat(operatorDir)).mode & 0o777, 0o700);
    const usedPorts = new Set();
    const ports = [];
    for (let index = 0; index < 6; index += 1) {
      ports.push(await reservePort(usedPorts));
    }
    const [httpPort, httpsPort, pgPort, authPort, appPort, previewPort] = ports;
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnvironment(),
    }).trim();
    assert.match(sha, /^[0-9a-f]{40}$/);
    const previewHostname = 'preview-' + runId + '.localhost';
    const stagingHostname = 'alpha-' + runId + '.localhost';
    const common = {
      COMPOSE_PROJECT_NAME: projectName,
      HIREARCHY_RELEASE_SHA: sha,
      HIREARCHY_TRUSTED_PROXY_HOPS: '0',
      CADDY_BIND_ADDRESS: '127.0.0.1',
      CADDY_HTTP_PORT: String(httpPort),
      CADDY_HTTPS_PORT: String(httpsPort),
      PREVIEW_HOSTNAME: previewHostname,
      PREVIEW_APP_PORT: String(previewPort),
    };

    await writeConfiguredEnvironment(
      path.join(root, 'deploy/staging/env.preview.example'),
      previewEnv,
      { ...common, HIREARCHY_DEPLOY_MODE: 'public-preview' },
    );
    previewEnvReady = true;
    await writeConfiguredEnvironment(
      path.join(root, 'deploy/staging/env.staging.example'),
      stagingEnv,
      {
        ...common,
        HIREARCHY_DEPLOY_MODE: 'supervised-alpha',
        STAGING_HOSTNAME: stagingHostname,
        STAGING_ALLOWED_CIDRS: '127.0.0.1/32',
        PG_BIND_ADDRESS: '127.0.0.1',
        PG_PORT: String(pgPort),
        AUTH_BIND_ADDRESS: '127.0.0.1',
        GOTRUE_API_PORT: String(authPort),
        APP_PORT: String(appPort),
        STAGING_AUTH_ISSUER: 'https://' + stagingHostname,
        STAGING_PUBLIC_ORIGIN: 'https://' + stagingHostname + ':' + httpsPort,
      },
    );
    stagingEnvReady = true;
    runNodeWithEnvironment(previewEnv, 'deploy/staging/preflight.mjs');
    const caddyOverrides = await writeInternalCaddyConfigs(tempDir);
    previewComposeFiles = [previewCompose, caddyOverrides.previewOverride];
    stagingComposeFiles = [stagingCompose, caddyOverrides.stagingOverride];
    stage = 'validate preview Compose build inputs';
    await assertComposeBuildInputs(previewEnv, previewCompose, projectName);
    docker(
      ...composePrefix(previewEnv, previewCompose, projectName),
      'config',
      '--quiet',
    );
    execFileSync(
      process.execPath,
      ['scripts/generate-staging-secrets.mjs', stagingEnv],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnvironment(),
      },
    );
    runNodeWithEnvironment(stagingEnv, 'deploy/staging/preflight.mjs');
    stage = 'validate staging Compose build inputs';
    await assertComposeBuildInputs(stagingEnv, stagingCompose, projectName);
    docker(
      ...composePrefix(stagingEnv, stagingCompose, projectName),
      'config',
      '--quiet',
    );

    assertNoProjectResourceCollision(projectName);
    sampler = await startSampler(projectName, resourceFile);
    stage = 'public preview Compose, TLS, and route boundary';
    previewStackStarted = true;
    compose(previewEnv, previewCompose, projectName, 'up', '-d', '--build');
    await waitForHealthy(previewEnv, previewCompose, projectName, 'web');
    const previewCa = await localCaFromCaddy(
      previewEnv,
      previewCompose,
      projectName,
    );
    assert.match(previewCa, /^-----BEGIN CERTIFICATE-----/);
    await writeFile(localCaFile, previewCa, { mode: 0o600 });
    await chmod(localCaFile, 0o600);
    assert.equal((await stat(localCaFile)).mode & 0o777, 0o600);

    const httpRedirect = curlRequest({
      url: 'http://' + previewHostname + ':' + httpPort + '/',
      host: previewHostname,
      port: httpPort,
    });
    assert.equal(httpRedirect.status, 308);
    assert.equal(
      httpRedirect.location,
      'https://' + previewHostname + ':' + httpsPort + '/',
    );

    const previewHealth = curlRequest({
      url: 'https://' + previewHostname + ':' + httpsPort + '/api/health',
      host: previewHostname,
      port: httpsPort,
      caFile: localCaFile,
    });
    assert.equal(previewHealth.status, 200);
    assert.equal(JSON.parse(previewHealth.body).status, 'ok');

    const deniedPreviewRoutes = [
      '/api/auth/signup',
      '/api/staging/readiness',
      '/r23/login',
      '/r26/candidate/synthetic',
      '/r26/api/candidate/synthetic/ai',
      '/r26/api/candidate/synthetic/execution',
      '/api/candidate/sessions/synthetic/terminal/exec',
      '/evaluator',
    ];
    for (const route of deniedPreviewRoutes) {
      const response = curlRequest({
        url: 'https://' + previewHostname + ':' + httpsPort + route,
        host: previewHostname,
        port: httpsPort,
        caFile: localCaFile,
      });
      assert.equal(response.status, 404, 'Public preview denies ' + route);
      assert.match(response.body, /PREVIEW_ROUTE_UNAVAILABLE/);
    }

    syntheticEmail = 'release-smoke-' + runId + '@example.test';
    const submission = curlRequest({
      url: 'https://' + previewHostname + ':' + httpsPort + '/api/early-access',
      host: previewHostname,
      port: httpsPort,
      caFile: localCaFile,
      method: 'POST',
      headers: [
        'Content-Type: application/json',
        'Origin: https://' + previewHostname + ':' + httpsPort,
      ],
      body: JSON.stringify({
        name: 'Synthetic release smoke',
        email: syntheticEmail,
        company: 'Synthetic QA',
        teamSize: '1-10',
        role: 'Synthetic operator acceptance',
        primaryChallenge: 'other',
        notes: 'Disposable local release package check.',
      }),
    });
    assert.equal(submission.status, 201);
    assert.equal(JSON.parse(submission.body).ok, true);

    const expectedVolumes = [
      projectName + '-early-access-data',
      projectName + '-caddy-data',
      projectName + '-caddy-config',
    ];
    compose(previewEnv, previewCompose, projectName, 'down');
    const volumesAfterPreview = new Set(
      docker('volume', 'ls', '--format', '{{.Name}}').split(/\r?\n/),
    );
    for (const volume of expectedVolumes) {
      assert.ok(
        volumesAfterPreview.has(volume),
        'Stage transition retains ' + volume,
      );
    }

    stage = 'fresh supervised alpha provisioning and TLS';
    stagingStackStarted = true;
    compose(
      stagingEnv,
      stagingCompose,
      projectName,
      'up',
      '-d',
      '--build',
      'postgres',
      'gotrue',
      'web-preview',
    );
    await waitForHealthy(stagingEnv, stagingCompose, projectName, 'postgres');
    await waitForHealthy(stagingEnv, stagingCompose, projectName, 'gotrue');
    await waitForHealthy(
      stagingEnv,
      stagingCompose,
      projectName,
      'web-preview',
    );
    runNodeWithEnvironment(
      stagingEnv,
      'scripts/deploy-single-team-staging.mjs',
    );
    compose(
      stagingEnv,
      stagingCompose,
      projectName,
      'up',
      '-d',
      '--build',
      'web',
    );
    await waitForHealthy(stagingEnv, stagingCompose, projectName, 'web');
    compose(stagingEnv, stagingCompose, projectName, 'up', '-d', 'caddy');
    const stagingCa = await localCaFromCaddy(
      stagingEnv,
      stagingCompose,
      projectName,
    );
    assert.equal(
      stagingCa,
      previewCa,
      'Stage transition retains the trusted Caddy CA',
    );

    const stagingRedirect = curlRequest({
      url: 'http://' + stagingHostname + ':' + httpPort + '/r23/login',
      host: stagingHostname,
      port: httpPort,
    });
    assert.equal(stagingRedirect.status, 308);
    assert.equal(
      stagingRedirect.location,
      'https://' + stagingHostname + ':' + httpsPort + '/r23/login',
    );

    const stagingLogin = curlRequest({
      url: 'https://' + stagingHostname + ':' + httpsPort + '/r23/login',
      host: stagingHostname,
      port: httpsPort,
      caFile: localCaFile,
    });
    assert.equal(stagingLogin.status, 200);

    const stagingHealth = curlRequest({
      url: 'https://' + stagingHostname + ':' + httpsPort + '/api/health',
      host: stagingHostname,
      port: httpsPort,
      caFile: localCaFile,
    });
    assert.equal(stagingHealth.status, 200);
    assert.deepEqual(JSON.parse(stagingHealth.body).capabilities, {
      application: 'restricted',
      execution: 'disabled',
      ai: 'disabled',
    });

    const readinessUrl =
      'http://127.0.0.1:' + appPort + '/api/staging/readiness';
    const directReadiness = curlRequest({ url: readinessUrl });
    assert.equal(directReadiness.status, 200);
    const readiness = JSON.parse(directReadiness.body);
    assert.equal(readiness.status, 'ready');
    assert.equal(readiness.capabilities.emailDeliveryEnabled, false);
    assert.equal(readiness.capabilities.selfServiceOnboardingEnabled, false);

    const proxiedReadiness = curlRequest({
      url:
        'https://' +
        stagingHostname +
        ':' +
        httpsPort +
        '/api/staging/readiness',
      host: stagingHostname,
      port: httpsPort,
      caFile: localCaFile,
    });
    assert.equal(proxiedReadiness.status, 404);

    for (const route of [
      '/api/auth/signup',
      '/r26/api/candidate/synthetic/ai',
      '/r26/api/candidate/synthetic/execution',
    ]) {
      const response = curlRequest({
        url: 'https://' + previewHostname + ':' + httpsPort + route,
        host: previewHostname,
        port: httpsPort,
        caFile: localCaFile,
      });
      assert.equal(
        response.status,
        404,
        'Public preview remains locked at ' + route,
      );
    }

    for (const extraHeaders of [[], ['X-Forwarded-For: 127.0.0.1']]) {
      const outside = curlRequest({
        url: 'https://' + stagingHostname + ':' + httpsPort + '/r23/login',
        host: stagingHostname,
        port: httpsPort,
        caFile: localCaFile,
        sourceAddress: '127.0.0.2',
        headers: extraHeaders,
      });
      assert.equal(outside.status, 404, 'Staging denies outside source IP');
    }

    setOperatorDirectoryOwner(stagingEnv, projectName, operatorDir, 1000, 1000);
    operatorDirectoryOwnedByContainer = true;
    const operatorResult = composeOperatorTool(
      stagingEnv,
      projectName,
      operatorDir,
      '-e',
      'SYNTHETIC_EMAIL=' + syntheticEmail,
      '--entrypoint',
      'node',
      'web-preview',
      'scripts/test-early-access-operator-recovery.mjs',
    );
    assert.match(operatorResult, /"state":"passed"/);
    assert.ok(!operatorResult.includes(syntheticEmail));
    assert.equal((await stat(operatorDir)).mode & 0o777, 0o700);
    setOperatorDirectoryOwner(
      stagingEnv,
      projectName,
      operatorDir,
      process.getuid(),
      process.getgid(),
    );
    operatorDirectoryOwnedByContainer = false;
    console.log(
      'Private operator export, immutable receipt, active deletion, and restore replay passed with synthetic intake.',
    );

    stage = 'readiness outage, local alert dry-run, and recovery';
    compose(stagingEnv, stagingCompose, projectName, 'stop', 'postgres');
    const outageProbe = runProbe(stagingEnv, alertFile);
    assert.equal(outageProbe.status, 1);
    const outageRecord = JSON.parse(outageProbe.stdout.trim());
    assert.equal(outageRecord.state, 'not_ready');
    assert.match(outageRecord.action, /Keep traffic closed/);
    assert.equal((await stat(alertFile)).mode & 0o777, 0o600);
    const outageAlertRecords = (await readFile(alertFile, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(outageAlertRecords.length, 1);
    assert.equal(outageAlertRecords[0].state, 'not_ready');
    assert.ok(!JSON.stringify(outageAlertRecords).includes(syntheticEmail));

    compose(stagingEnv, stagingCompose, projectName, 'start', 'postgres');
    await waitForHealthy(stagingEnv, stagingCompose, projectName, 'postgres');
    const recoveredProbe = runProbe(stagingEnv, alertFile);
    assert.equal(recoveredProbe.status, 0);
    assert.equal(JSON.parse(recoveredProbe.stdout.trim()).state, 'ready');
    const alertRecords = (await readFile(alertFile, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      alertRecords.map(({ state }) => state),
      ['not_ready', 'ready'],
    );
    assert.ok(!JSON.stringify(alertRecords).includes(syntheticEmail));
    console.log(
      'Staging readiness probe and local redacted alert-file dry-run passed through PostgreSQL outage and recovery.',
    );

    const samplerResult = await stopSampler(sampler, resourceFile);
    sampler = null;
    assert.ok(samplerResult, 'Resource sample completed');
    console.log('PACKAGE_RESOURCE_SAMPLE ' + JSON.stringify(samplerResult));
    console.log(
      'Actual preview-to-alpha Compose, trusted local TLS, route boundaries, migration setup, intake persistence, and recovery passed.',
    );
  } catch (error) {
    console.error('Deployment package acceptance failed during ' + stage + '.');
    console.error(
      'Safe failure diagnostic: ' +
        safeFailureDiagnostic(
          error,
          [previewEnv, stagingEnv],
          [tempDir, projectName, syntheticEmail || ''],
        ),
    );
    process.exitCode = 1;
  } finally {
    if (sampler) {
      try {
        await stopSampler(sampler, resourceFile);
      } catch {
        console.error('Owned resource sampler did not finish cleanly.');
        process.exitCode = 1;
      }
    }
    if (operatorDirectoryOwnedByContainer && stagingEnvReady) {
      try {
        setOperatorDirectoryOwner(
          stagingEnv,
          projectName,
          operatorDir,
          process.getuid(),
          process.getgid(),
        );
        operatorDirectoryOwnedByContainer = false;
      } catch {
        console.error(
          'Owned private operator directory requires permission repair.',
        );
        process.exitCode = 1;
      }
    }
    if (stagingStackStarted && stagingEnvReady) {
      try {
        compose(
          stagingEnv,
          stagingCompose,
          projectName,
          'down',
          '--volumes',
          '--remove-orphans',
        );
      } catch {
        console.error(
          'Owned release-smoke Compose project requires cleanup: ' +
            projectName,
        );
        cleanupFailed = true;
        process.exitCode = 1;
      }
    } else if (previewStackStarted && previewEnvReady) {
      try {
        compose(
          previewEnv,
          previewCompose,
          projectName,
          'down',
          '--volumes',
          '--remove-orphans',
        );
      } catch {
        console.error(
          'Owned release-smoke Compose project requires cleanup: ' +
            projectName,
        );
        cleanupFailed = true;
        process.exitCode = 1;
      }
    }
    if (cleanupFailed) {
      console.error(
        'Private release-smoke artifacts retained for cleanup at ' + tempDir,
      );
    } else {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        console.error(
          'Private release-smoke artifacts retained for cleanup at ' + tempDir,
        );
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && me === process.argv[1]) {
  if (process.argv[2] === '--sample-resources') {
    await runResourceSampler(process.argv[3], process.argv[4]);
  } else if (process.argv[2] === '--self-check-diagnostics') {
    await selfCheckSafeFailureDiagnostic();
    console.log('Safe failure diagnostic redaction self-check passed.');
  } else {
    await testPackage();
  }
}
