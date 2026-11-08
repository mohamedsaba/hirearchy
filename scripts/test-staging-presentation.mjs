import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const tempDir = await mkdtemp(
  path.join(os.tmpdir(), 'hirearchy-presentation-'),
);
const readyFile = path.join(tempDir, 'ready.json');
await chmod(tempDir, 0o700);

const child = spawn(
  process.execPath,
  ['scripts/test-staging-integration.mjs', '--presentation'],
  {
    cwd: root,
    env: { ...process.env, HIREARCHY_PRESENTATION_READY_FILE: readyFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
let output = '';
child.stdout.on('data', (data) => {
  output += data.toString();
});
child.stderr.on('data', (data) => {
  output += data.toString();
});
const exited = new Promise((resolve) => {
  child.once('exit', (code, signal) => resolve({ code, signal }));
});

async function waitForReady() {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const ready = JSON.parse(await readFile(readyFile, 'utf8'));
      return ready;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError))
        throw error;
    }
    const result = await Promise.race([exited, delay(500).then(() => null)]);
    if (result) {
      throw new Error(
        `Presentation process exited before readiness (${result.code ?? result.signal}); inspect its private .data diagnostics.`,
      );
    }
  }
  throw new Error('Timed out waiting for the presentation presenter file.');
}

let ready;
try {
  ready = await waitForReady();
  const presenterStat = await stat(ready.presenterFile);
  const directoryStat = await stat(path.dirname(ready.presenterFile));
  assert.equal(presenterStat.mode & 0o777, 0o600);
  assert.equal(directoryStat.mode & 0o777, 0o700);

  const presenter = JSON.parse(await readFile(ready.presenterFile, 'utf8'));
  assert.equal(presenter.organizationId.length, 36);
  assert.match(presenter.appUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(presenter.recruiter.email, 'recruiter@staging.test');
  assert.equal(presenter.evaluator.email, 'reviewer@staging.test');
  assert.equal(presenter.candidate.name, 'Demo Candidate');
  assert.ok(presenter.recruiter.password.length >= 40);
  assert.ok(
    !output.includes(presenter.recruiter.password),
    'Presenter password must not be printed to stdout/stderr',
  );

  child.kill('SIGTERM');
  const result = await Promise.race([exited, delay(90_000).then(() => null)]);
  assert.ok(result, 'SIGTERM must complete owned-resource cleanup');
  assert.equal(result.code, 143);

  const remainingContainers = execFileSync(
    'docker',
    ['ps', '-aq', '--filter', `label=hirearchy.r215.owner=${ready.name}`],
    { encoding: 'utf8' },
  ).trim();
  assert.equal(remainingContainers, '', 'Owned containers must be removed');

  const [remainingVolumes, remainingNetworks] = await Promise.all([
    execFileSync('docker', ['volume', 'ls', '-q'], { encoding: 'utf8' }),
    execFileSync('docker', ['network', 'ls', '--format', '{{.Name}}'], {
      encoding: 'utf8',
    }),
  ]);
  const existingVolumes = new Set(remainingVolumes.trim().split(/\s+/));
  const existingNetworks = new Set(remainingNetworks.trim().split(/\s+/));
  for (const volume of ready.volumes) {
    assert.ok(!existingVolumes.has(volume), `Owned volume remains: ${volume}`);
  }
  assert.ok(
    !existingNetworks.has(ready.network),
    'Owned network must be removed',
  );

  await assert.rejects(readFile(ready.presenterFile), { code: 'ENOENT' });
  console.log(
    `Presentation SIGTERM cleanup passed (${ready.resources.length} containers, ${ready.volumes.length} volumes, 1 network).`,
  );
} catch (error) {
  if (child.exitCode === null) {
    if (ready) {
      child.kill('SIGTERM');
      await Promise.race([exited, delay(90_000)]);
    } else {
      child.stdin.end('\n');
      await Promise.race([exited, delay(90_000)]);
    }
  }
  console.error(`Presentation shutdown smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
