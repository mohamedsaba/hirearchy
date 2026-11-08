import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalAppEnvironment } from '../../scripts/local-app-environment.mjs';

test('local app environment inherits OS fields and generated staging fields only', () => {
  const parentEnvironment = Object.freeze({
    PATH: '/usr/bin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'Africa/Cairo',
    TMPDIR: '/tmp/local-staging',
    HOME: '/private/parent-home',
    NODE_OPTIONS: '--require /private/preload.mjs',
    NODE_PATH: '/private/node-modules',
    GITHUB_TOKEN: 'synthetic-github-token',
    AWS_ACCESS_KEY_ID: 'synthetic-cloud-key',
    NVIDIA_API_KEY: 'synthetic-provider-key',
    PORT: '9999',
    STAGING_AUTH_URL: 'https://ambient-auth.invalid',
  });
  const parentSnapshot = { ...parentEnvironment };
  const stagingEnvironment = Object.freeze({
    PORT: '3005',
    HIREARCHY_RUNTIME_PROFILE: 'staging-authenticated',
    STAGING_AUTH_URL: 'http://127.0.0.1:9998',
  });

  const appEnvironment = createLocalAppEnvironment(
    parentEnvironment,
    stagingEnvironment,
  );

  assert.deepEqual(Object.keys(appEnvironment).sort(), [
    'HIREARCHY_RUNTIME_PROFILE',
    'LANG',
    'LC_ALL',
    'PATH',
    'PORT',
    'STAGING_AUTH_URL',
    'TMPDIR',
    'TZ',
  ]);
  assert.equal(appEnvironment.PATH, parentEnvironment.PATH);
  assert.equal(appEnvironment.LANG, parentEnvironment.LANG);
  assert.equal(appEnvironment.LC_ALL, parentEnvironment.LC_ALL);
  assert.equal(appEnvironment.TZ, parentEnvironment.TZ);
  assert.equal(appEnvironment.TMPDIR, parentEnvironment.TMPDIR);
  assert.equal(appEnvironment.PORT, stagingEnvironment.PORT);
  assert.equal(
    appEnvironment.STAGING_AUTH_URL,
    stagingEnvironment.STAGING_AUTH_URL,
  );
  assert.equal(
    appEnvironment.HIREARCHY_RUNTIME_PROFILE,
    stagingEnvironment.HIREARCHY_RUNTIME_PROFILE,
  );
  assert.deepEqual(parentEnvironment, parentSnapshot);
});
