import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rootDir = fileURLToPath(new URL('../../', import.meta.url));
const launcher = join(rootDir, 'scripts', 'launch-staging-environment.mjs');
const statusFile = join(rootDir, '.data', 'local-staging', 'status.json');

async function statusMetadata() {
  try {
    const metadata = await stat(statusFile);
    return {
      ino: metadata.ino,
      mode: metadata.mode,
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function makeStubs(directory, { containers = '', networks = '' }) {
  const binDir = join(directory, 'bin');
  const dockerCalls = join(directory, 'docker-calls.txt');
  const fuserCalls = join(directory, 'fuser-calls.txt');
  await mkdir(binDir);

  const dockerStub = join(binDir, 'docker');
  await writeFile(
    dockerStub,
    [
      '#!/bin/sh',
      'echo "$*" >> "$DOCKER_CALLS"',
      'case "$1:$2" in',
      '  ps:--all) echo "$CONTAINER_NAMES" ;;',
      '  network:ls) echo "$NETWORK_NAMES" ;;',
      '  *) echo "unexpected Docker mutation" >&2; exit 97 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  await chmod(dockerStub, 0o755);

  const fuserStub = join(binDir, 'fuser');
  await writeFile(
    fuserStub,
    ['#!/bin/sh', 'echo "$*" >> "$FUSER_CALLS"', ''].join('\n'),
  );
  await chmod(fuserStub, 0o755);

  return {
    dockerCalls,
    fuserCalls,
    env: {
      ...process.env,
      PATH: binDir + delimiter + (process.env.PATH ?? ''),
      CONTAINER_NAMES: containers,
      NETWORK_NAMES: networks,
      DOCKER_CALLS: dockerCalls,
      FUSER_CALLS: fuserCalls,
    },
  };
}

async function assertRefusedWithoutMutation(directory, stubOptions, message) {
  const before = await statusMetadata();
  const stubs = await makeStubs(directory, stubOptions);
  const result = spawnSync(process.execPath, [launcher], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 5000,
    env: stubs.env,
  });

  assert.ifError(result.error);
  const output = result.stdout + '\n' + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, message);
  const calls = await readFile(stubs.dockerCalls, 'utf8');
  assert.match(calls, /^ps --all --format \{\{\.Names\}\}$/m);
  assert.doesNotMatch(calls, /\b(rm|create|run)\b/m);
  await assert.rejects(readFile(stubs.fuserCalls, 'utf8'), { code: 'ENOENT' });
  assert.deepEqual(await statusMetadata(), before);
}

test('launcher refuses an existing container without changing shared resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hirearchy-launcher-safety-'));
  try {
    await assertRefusedWithoutMutation(
      directory,
      { containers: 'hirearchy-local-staging-pg' },
      /Refusing to overwrite existing local staging resources: container hirearchy-local-staging-pg/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('launcher refuses an existing network without changing shared resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hirearchy-launcher-safety-'));
  try {
    await assertRefusedWithoutMutation(
      directory,
      { networks: 'hirearchy-local-staging-net' },
      /Refusing to overwrite existing local staging resources: network hirearchy-local-staging-net/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('launcher refuses an occupied port without stopping its owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hirearchy-launcher-safety-'));
  const server = createServer();
  let serverOwned = false;
  try {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(5433, '127.0.0.1', resolve);
      });
      serverOwned = true;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }

    await assertRefusedWithoutMutation(
      directory,
      {},
      /Refusing to start local staging: 127\.0\.0\.1:5433 is unavailable/,
    );
  } finally {
    if (serverOwned) {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await rm(directory, { recursive: true, force: true });
  }
});
