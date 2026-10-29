import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';

const POSTGRES_IMAGE =
  'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
const LABEL_PREFIX = 'com.hirearchy.restricted-executor.test';
const DOCKER_ENV = Object.freeze({
  LANG: 'C.UTF-8',
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
});
const EXPECTED_DISCONNECT_CODES = new Set([
  '57P01',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
]);

async function chooseLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function docker(args, phase, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...DOCKER_ENV, ...options.env },
    maxBuffer: 16 * 1024,
    timeout: options.timeout ?? 30_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Disposable PostgreSQL ${phase} failed.`);
  return result.stdout.trim();
}

function identifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Disposable PostgreSQL identifier is invalid.');
  return `"${value}"`;
}

function password() {
  return randomBytes(32).toString('base64url');
}

function expectedLabels(fixtureId) {
  return {
    [`${LABEL_PREFIX}.purpose`]: 'acceptance',
    [`${LABEL_PREFIX}.fixture-id`]: fixtureId,
  };
}

function expectedVolumeLabels(fixtureId) {
  return {
    ...expectedLabels(fixtureId),
    [`${LABEL_PREFIX}.component`]: 'postgres-data',
  };
}

export async function startPostgresFixture({ schemaSql }) {
  const fixtureId = randomUUID().replaceAll('-', '');
  const name = `hirearchy-rex-pg-${fixtureId.slice(0, 16)}`;
  const labels = expectedLabels(fixtureId);
  const volumeName = `hirearchy-rex-pg-data-${fixtureId.slice(0, 16)}`;
  const volumeLabels = expectedVolumeLabels(fixtureId);
  let root;

  const adminPassword = password();
  const appPassword = password();
  const schemaOwner = 'restricted_executor_owner';
  const appRole = 'restricted_executor_runtime';
  const database = `rex_${fixtureId.slice(0, 24)}`;
  const adminConnection = {
    host: '127.0.0.1',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: adminPassword,
    connectionTimeoutMillis: 1_000,
    application_name: `rex-admin-${fixtureId.slice(0, 12)}`,
  };
  let containerId;
  let createdVolumeName;
  let adminPool;
  let schemaPool;
  let runtimePool;
  let inspectorPool;
  let inspectorApplicationName;
  let expectedDisconnectWindow = false;
  const unexpectedPoolErrors = [];
  const observedPoolErrors = [];
  let closed = false;
  let phase = 'temporary directory';

  const dockerConfig = () => join(root, 'docker-config');

  function callDocker(args, phase, options = {}) {
    return docker(
      [
        '--config',
        dockerConfig(),
        '--host',
        'unix:///var/run/docker.sock',
        ...args,
      ],
      phase,
      options,
    );
  }

  function watchPool(pool, poolName) {
    pool.on('error', (error) => {
      const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      const expected =
        expectedDisconnectWindow && EXPECTED_DISCONNECT_CODES.has(code);
      const observation = { pool: poolName, code, expected };
      observedPoolErrors.push(observation);
      if (!expected) unexpectedPoolErrors.push(observation);
    });
    return pool;
  }

  function assertNoUnexpectedPoolErrors() {
    if (unexpectedPoolErrors.length > 0) {
      const codes = unexpectedPoolErrors
        .map(({ pool, code }) => `${pool}:${code}`)
        .join(',');
      throw new Error(
        `Unexpected PostgreSQL pool errors were observed (${codes}).`,
      );
    }
  }

  function inspectOwnedResource(id, expected) {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new Error('Fixture container ID is invalid.');
    const output = callDocker(
      [
        'container',
        'inspect',
        '--format',
        '{{.Id}}|{{json .Config.Labels}}|{{json .HostConfig}}|{{json .Mounts}}',
        id,
      ],
      'container ownership inspection',
    );
    const [observedId, labelsJson, hostConfigJson, mountsJson] =
      output.split('|');
    if (observedId !== id)
      throw new Error('Fixture container identity changed.');
    let observedLabels;
    let hostConfig;
    let mounts;
    try {
      observedLabels = JSON.parse(labelsJson);
      hostConfig = JSON.parse(hostConfigJson);
      mounts = JSON.parse(mountsJson);
    } catch {
      throw new Error('Fixture container inspection is invalid.');
    }
    if (
      !observedLabels ||
      Object.keys(observedLabels).length !== Object.keys(expected).length ||
      Object.entries(expected).some(
        ([key, value]) => observedLabels[key] !== value,
      )
    ) {
      throw new Error('Fixture container ownership mismatch.');
    }
    return { id: observedId, labels: observedLabels, hostConfig, mounts };
  }

  function removeOwnedResource(id, expected) {
    const resource = inspectOwnedResource(id, expected);
    callDocker(['container', 'rm', '--force', id], 'container cleanup');
    const remaining = callDocker(
      [
        'container',
        'ls',
        '--all',
        '--no-trunc',
        '--filter',
        `id=${id}`,
        '--format',
        '{{.ID}}',
      ],
      'cleanup verification',
    );
    if (remaining) throw new Error('Fixture container remains after cleanup.');
    return resource;
  }

  function inspectOwnedVolume(name, expected) {
    if (name !== volumeName) throw new Error('Fixture volume name changed.');
    const output = callDocker(
      [
        'volume',
        'inspect',
        '--format',
        '{{.Name}}|{{json .Labels}}|{{.Mountpoint}}',
        name,
      ],
      'volume ownership inspection',
    );
    const [observedName, labelsJson, mountpoint] = output.split('|');
    if (observedName !== name || !mountpoint)
      throw new Error('Fixture volume identity changed.');
    let observedLabels;
    try {
      observedLabels = JSON.parse(labelsJson);
    } catch {
      throw new Error('Fixture volume inspection is invalid.');
    }
    if (
      !observedLabels ||
      Object.keys(observedLabels).length !== Object.keys(expected).length ||
      Object.entries(expected).some(
        ([key, value]) => observedLabels[key] !== value,
      )
    ) {
      throw new Error('Fixture volume ownership mismatch.');
    }
    return { name: observedName, labels: observedLabels, mountpoint };
  }

  function removeOwnedVolume(name, expected) {
    const volume = inspectOwnedVolume(name, expected);
    callDocker(['volume', 'rm', name], 'volume cleanup');
    const remaining = callDocker(
      ['volume', 'ls', '--quiet', '--filter', `name=^${name}$`],
      'volume cleanup verification',
    );
    if (remaining) throw new Error('Fixture volume remains after cleanup.');
    return volume;
  }

  function containerExistsById(id) {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new Error('Fixture container ID is invalid.');
    const output = callDocker(
      [
        'container',
        'ls',
        '--all',
        '--no-trunc',
        '--filter',
        `id=${id}`,
        '--format',
        '{{.ID}}',
      ],
      'container presence inspection',
    );
    return output.split('\n').includes(id);
  }

  async function close() {
    if (closed) return;
    closed = true;
    let cleanupFailed = false;
    for (const pool of [runtimePool, schemaPool, inspectorPool, adminPool]) {
      if (!pool) continue;
      try {
        await pool.end();
      } catch {
        cleanupFailed = true;
      }
    }
    if (containerId) {
      try {
        removeOwnedResource(containerId, labels);
      } catch {
        cleanupFailed = true;
      }
    }
    if (createdVolumeName && !cleanupFailed) {
      try {
        removeOwnedVolume(createdVolumeName, volumeLabels);
      } catch {
        cleanupFailed = true;
      }
    }
    if (root) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
    try {
      assertNoUnexpectedPoolErrors();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed)
      throw new Error('Disposable PostgreSQL fixture cleanup failed.');
  }

  try {
    root = await mkdtemp(join(tmpdir(), 'hirearchy-rex-postgres-'));
    await chmod(root, 0o700);
    await mkdir(dockerConfig(), { mode: 0o700 });
    await chmod(dockerConfig(), 0o700);
    phase = 'container startup';
    const selectedPort = await chooseLoopbackPort();
    const createdVolume = callDocker(
      [
        'volume',
        'create',
        ...Object.entries(volumeLabels).flatMap(([key, value]) => [
          '--label',
          `${key}=${value}`,
        ]),
        volumeName,
      ],
      'volume startup',
    );
    if (createdVolume !== volumeName)
      throw new Error('Fixture volume identity is invalid.');
    createdVolumeName = createdVolume;
    const volume = inspectOwnedVolume(createdVolumeName, volumeLabels);
    const runEnv = { POSTGRES_PASSWORD: adminPassword };
    const created = callDocker(
      [
        'run',
        '--pull',
        'never',
        '--detach',
        '--name',
        name,
        ...Object.entries(labels).flatMap(([key, value]) => [
          '--label',
          `${key}=${value}`,
        ]),
        '--publish',
        `127.0.0.1:${selectedPort}:5432`,
        '--env',
        'POSTGRES_PASSWORD',
        '--mount',
        `type=volume,src=${volume.name},dst=/var/lib/postgresql/data`,
        POSTGRES_IMAGE,
      ],
      'container startup',
      { env: runEnv },
    );
    if (!/^[a-f0-9]{64}$/.test(created))
      throw new Error('Fixture container ID is invalid.');
    containerId = created;
    phase = 'container ownership verification';
    const ownedContainer = inspectOwnedResource(containerId, labels);
    const dataMounts = ownedContainer.mounts.filter(
      (mount) => mount.Destination === '/var/lib/postgresql/data',
    );
    if (
      dataMounts.length !== 1 ||
      dataMounts[0].Type !== 'volume' ||
      dataMounts[0].Name !== volume.name ||
      dataMounts[0].RW !== true
    ) {
      throw new Error('Disposable PostgreSQL data volume is not mounted.');
    }

    phase = 'loopback port verification';
    const published = callDocker(
      ['port', containerId, '5432/tcp'],
      'loopback port inspection',
    );
    const match = /^127\.0\.0\.1:(\d+)$/.exec(published);
    if (!match) throw new Error('Disposable PostgreSQL is not loopback-bound.');

    const connection = {
      ...adminConnection,
      port: selectedPort,
    };
    if (Number(match[1]) !== selectedPort)
      throw new Error('Disposable PostgreSQL published port changed.');
    phase = 'database readiness';
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      const probe = new Client(connection);
      try {
        await probe.connect();
        await probe.query('SELECT 1');
        ready = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      } finally {
        await probe.end().catch(() => undefined);
      }
    }
    if (!ready) throw new Error('Disposable PostgreSQL readiness failed.');

    phase = 'restricted role setup';
    adminPool = new Pool({ ...connection, max: 4 });
    watchPool(adminPool, 'admin');
    const dbName = identifier(database);
    const schemaOwnerName = identifier(schemaOwner);
    const appRoleName = identifier(appRole);
    await adminPool.query(
      `CREATE ROLE ${schemaOwnerName} NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
    );
    await adminPool.query(
      `CREATE ROLE ${appRoleName} LOGIN NOINHERIT PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION CONNECTION LIMIT 12`,
    );
    await adminPool.query(`CREATE DATABASE ${dbName}`);
    await adminPool.query(`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
    await adminPool.query(
      `GRANT CONNECT ON DATABASE ${dbName} TO ${appRoleName}`,
    );
    await adminPool.query(
      `GRANT CREATE ON DATABASE ${dbName} TO ${schemaOwnerName}`,
    );

    phase = 'schema installation';
    schemaPool = new Pool({
      ...connection,
      database,
      application_name: `rex-ddl-${fixtureId.slice(0, 12)}`,
      max: 1,
    });
    watchPool(schemaPool, 'schema');
    await schemaPool.query(`SET ROLE ${schemaOwnerName}`);
    await schemaPool.query(schemaSql);
    phase = 'database privilege cleanup';
    await schemaPool.query(
      `REVOKE CREATE ON DATABASE ${dbName} FROM ${schemaOwnerName}`,
    );
    await schemaPool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');

    phase = 'runtime role connection';
    let runtimeConfig = {
      ...connection,
      database,
      user: appRole,
      password: appPassword,
      application_name: `rex-runtime-${fixtureId.slice(0, 12)}`,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 1_000,
      max: 12,
    };
    runtimePool = new Pool(runtimeConfig);
    watchPool(runtimePool, 'runtime');
    await runtimePool.query('SELECT 1');

    inspectorApplicationName = `rex-inspector-${fixtureId.slice(0, 12)}`;
    inspectorPool = new Pool({
      ...connection,
      database,
      application_name: inspectorApplicationName,
      max: 4,
    });
    watchPool(inspectorPool, 'inspector');
    return {
      fixtureId,
      containerId,
      database,
      root,
      dockerConfig: dockerConfig(),
      get runtimePool() {
        return runtimePool;
      },
      get runtimeConfig() {
        return { ...runtimeConfig };
      },
      get adminPool() {
        return inspectorPool;
      },
      appRole,
      schemaOwner,
      volumeName,
      createRuntimePool(
        applicationName,
        { user = appRole, password = appPassword, max = 4 } = {},
      ) {
        if (
          typeof applicationName !== 'string' ||
          !/^rex-[a-z0-9-]{1,40}$/.test(applicationName) ||
          typeof user !== 'string' ||
          !/^[a-z][a-z0-9_]{0,62}$/.test(user) ||
          typeof password !== 'string' ||
          password.length === 0 ||
          !Number.isInteger(max) ||
          max < 1
        ) {
          throw new Error('Disposable PostgreSQL application name is invalid.');
        }
        return watchPool(
          new Pool({
            ...runtimeConfig,
            user,
            password,
            application_name: applicationName,
            max,
          }),
          applicationName,
        );
      },
      poolErrors() {
        return observedPoolErrors.map((entry) => ({ ...entry }));
      },
      assertNoUnexpectedPoolErrors,
      containerExistsById,
      inspectOwnedResource,
      removeOwnedResource,
      inspectOwnedVolume,
      removeOwnedVolume,
      stopServer() {
        inspectOwnedResource(containerId, labels);
        expectedDisconnectWindow = true;
        callDocker(
          ['container', 'stop', '--time', '10', containerId],
          'database stop',
        );
      },
      async startServer() {
        inspectOwnedResource(containerId, labels);
        callDocker(['container', 'start', containerId], 'database start');
        const published = callDocker(
          ['port', containerId, '5432/tcp'],
          'restarted port inspection',
        );
        const publishedMatch = /^127\.0\.0\.1:(\d+)$/.exec(published);
        if (!publishedMatch)
          throw new Error('Disposable PostgreSQL is not loopback-bound.');
        const newPort = Number(publishedMatch[1]);
        connection.port = newPort;
        runtimeConfig = { ...runtimeConfig, port: newPort };
        for (const pool of [
          runtimePool,
          schemaPool,
          inspectorPool,
          adminPool,
        ]) {
          if (pool) await pool.end();
        }
        runtimePool = watchPool(new Pool(runtimeConfig), 'runtime');
        schemaPool = null;
        adminPool = null;
        inspectorPool = watchPool(
          new Pool({
            ...connection,
            database,
            application_name: inspectorApplicationName,
            max: 4,
          }),
          'inspector',
        );
        const restartDeadline = Date.now() + 30_000;
        let restarted = false;
        let lastProbeErrorCode;
        while (!restarted && Date.now() < restartDeadline) {
          const probe = new Client(connection);
          try {
            await probe.connect();
            await probe.query('SELECT 1');
            restarted = true;
          } catch (error) {
            lastProbeErrorCode =
              typeof error?.code === 'string' ? error.code : 'unknown';
            await new Promise((resolve) => setTimeout(resolve, 250));
          } finally {
            await probe.end().catch(() => undefined);
          }
        }
        if (!restarted) {
          const state = callDocker(
            [
              'container',
              'inspect',
              '--format',
              '{{.State.Status}}|{{.State.Running}}|{{.State.ExitCode}}',
              containerId,
            ],
            'restart status inspection',
          );
          let internalReadiness = 'unavailable';
          try {
            callDocker(
              [
                'exec',
                containerId,
                'pg_isready',
                '--host',
                '127.0.0.1',
                '--port',
                '5432',
                '--username',
                'postgres',
                '--dbname',
                'postgres',
              ],
              'internal restart readiness inspection',
            );
            internalReadiness = 'ready';
          } catch {
            internalReadiness = 'not-ready';
          }
          throw new Error(
            `Disposable PostgreSQL restart readiness failed (${lastProbeErrorCode ?? 'unknown'}; state=${state}; port=127.0.0.1:${newPort}; internal=${internalReadiness}).`,
          );
        }
        inspectOwnedVolume(volumeName, volumeLabels);
        expectedDisconnectWindow = false;
      },
      async restartServer() {
        this.stopServer();
        await this.startServer();
      },
      async close() {
        await close();
      },
    };
  } catch (error) {
    try {
      await close();
    } catch {
      throw new Error('Disposable PostgreSQL fixture cleanup failed.');
    }
    const code = typeof error?.code === 'string' ? ` (${error.code})` : '';
    const position = /^\d+$/.test(error?.position ?? '')
      ? ` at SQL character ${error.position}`
      : '';
    throw new Error(
      `Disposable PostgreSQL fixture setup failed during ${phase}${code}${position}.`,
    );
  }
}
