import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const coreUrl = new URL('./journey-a11y-runner-core.mjs', import.meta.url).href;

function runSubprocess(source) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 5000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: os.tmpdir(),
    },
  });
}

test('engine boundary preserves thrown journey failure and still cleans resources', () => {
  const result = runSubprocess(`
    import { runEngineBoundary, REQUIRED_DIMENSIONS, assessRun } from ${JSON.stringify(coreUrl)};
    const report = { engineDetection: { chromium: { available: true }, firefox: { available: false }, webkit: { available: false } }, journeyResults: { chromium: Object.fromEntries(REQUIRED_DIMENSIONS.map((key) => [key, 'Pending'])) }, cleanupErrors: [] };
    let cleaned = false;
    const ok = await runEngineBoundary(report, 'chromium', async () => { await new Promise((resolve, reject) => setTimeout(() => reject(new Error('synthetic navigation timeout')), 20)); }, async () => { cleaned = true; });
    if (ok || !cleaned || report.journeyResults.chromium.candidateJourney !== 'Failed') process.exit(2);
    const acceptance = assessRun(report);
    process.exitCode = acceptance.passed ? 0 : 1;
    console.log(JSON.stringify({ cleaned, error: report.journeyResults.chromium.error, acceptance }));
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /synthetic navigation timeout/);
});

test('engine boundary records rejected cleanup and success requires all required engines', () => {
  const result = runSubprocess(`
    import { runEngineBoundary, REQUIRED_DIMENSIONS, REQUIRED_ENGINES, assessRun } from ${JSON.stringify(coreUrl)};
    const report = { engineDetection: Object.fromEntries(REQUIRED_ENGINES.map((name) => [name, { available: true }])), journeyResults: Object.fromEntries(REQUIRED_ENGINES.map((name) => [name, Object.fromEntries(REQUIRED_DIMENSIONS.map((key) => [key, 'Passed']))])), cleanupErrors: [] };
    const ok = await runEngineBoundary(report, 'chromium', async () => {}, async () => { throw new Error('synthetic browser close rejection'); });
    const accepted = assessRun(report);
    if (ok || accepted.passed || !accepted.failures.some((entry) => entry.includes('browser close rejection'))) process.exit(2);
    report.cleanupErrors = [];
    report.engineDetection.webkit.available = false;
    if (assessRun(report).passed) process.exit(3);
    console.log('cleanup rejection and unavailable required engine fail closed');
    process.exitCode = 0;
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /unavailable required engine fail closed/);
});

test('all required engine dimensions passing returns success while a pending dimension fails', () => {
  const passing = runSubprocess(`
    import { REQUIRED_DIMENSIONS, REQUIRED_ENGINES, assessRun } from ${JSON.stringify(coreUrl)};
    const report = { engineDetection: Object.fromEntries(REQUIRED_ENGINES.map((name) => [name, { available: true }])), journeyResults: Object.fromEntries(REQUIRED_ENGINES.map((name) => [name, Object.fromEntries(REQUIRED_DIMENSIONS.map((key) => [key, 'Passed']))])) };
    const acceptance = assessRun(report);
    process.exitCode = acceptance.passed ? 0 : 1;
    console.log(JSON.stringify(acceptance));
  `);
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /"passed":true/);

  const incomplete = runSubprocess(`
    import { REQUIRED_DIMENSIONS, REQUIRED_ENGINES, assessRun } from ${JSON.stringify(coreUrl)};
    const report = { engineDetection: Object.fromEntries(REQUIRED_ENGINES.map((name) => [name, { available: true }])), journeyResults: Object.fromEntries(REQUIRED_ENGINES.map((name) => [name, Object.fromEntries(REQUIRED_DIMENSIONS.map((key) => [key, 'Passed']))])) };
    report.journeyResults.firefox.automatedAxeCore = 'Pending';
    const acceptance = assessRun(report);
    process.exitCode = acceptance.passed ? 0 : 1;
    console.log(JSON.stringify(acceptance));
  `);
  assert.equal(incomplete.status, 1, incomplete.stderr);
  assert.match(incomplete.stdout, /firefox\.automatedAxeCore: Pending/);
});

test('screenshot write failures and browser-close timeouts reject', () => {
  const result = runSubprocess(`
    import assert from 'node:assert/strict';
    import { captureScreenshot, closeBrowserBounded } from ${JSON.stringify(coreUrl)};
    await assert.rejects(captureScreenshot({ waitForTimeout: async () => {}, screenshot: async () => { throw new Error('synthetic screenshot failure'); } }, { path: '/missing/screenshot.png' }), /synthetic screenshot failure/);
    await assert.rejects(captureScreenshot({ waitForTimeout: async () => {}, screenshot: async () => {} }, { path: '/missing/screenshot.png' }), /Screenshot was not written/);
    await assert.rejects(closeBrowserBounded(null, { close: () => new Promise(() => {}), kill: async () => {}, process: () => null }, 'chromium', 20), /browser close timed out/);
    console.log('screenshot failures and browser close timeout reject');
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /browser close timeout reject/);
});

test('a hung owned browser server close force-stops its child process', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const browserServer = {
    close: () => new Promise(() => {}),
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    },
    process: () => child,
  };
  const { closeBrowserBounded } =
    await import('./journey-a11y-runner-core.mjs');
  await assert.rejects(
    closeBrowserBounded(null, browserServer, 'chromium', 20),
    /owned process was force-stopped/,
  );
  assert.equal(child.signalCode, 'SIGKILL');
});

test('page, overflow, and axe checks reject browser faults and incomplete audits', () => {
  const result = runSubprocess(`
    import { assertNoPageErrors, assertNoHorizontalOverflow, assertAuditPassed, assertHiddenPaneIsolated } from ${JSON.stringify(coreUrl)};
    import assert from 'node:assert/strict';
    assert.throws(() => assertNoPageErrors(['synthetic page crash'], 'chromium'), /page crash/);
    assert.throws(() => assertNoHorizontalOverflow({ clientWidth: 375, scrollWidth: 390, hasHorizontalOverflow: true }, 'candidate'), /overflow/);
    assert.throws(() => assertAuditPassed({ axe: { status: 'Unavailable', violations: [] }, overflow: { clientWidth: 375, scrollWidth: 375, hasHorizontalOverflow: false } }, 'candidate'), /did not complete/);
    assert.throws(() => assertAuditPassed({ axe: { status: 'Passed', violations: [{ id: 'color-contrast' }] }, overflow: { clientWidth: 375, scrollWidth: 375, hasHorizontalOverflow: false } }, 'candidate'), /violations/);
    assert.throws(() => assertHiddenPaneIsolated(false, 'hidden pane'), /not isolated/);
    console.log('browser faults and incomplete audits reject');
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /incomplete audits reject/);
});

test('real runner CLI returns nonzero, writes an unavailable-engine receipt, and stops its synthetic server', (t) => {
  const sandbox = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hirearchy-runner-cli-'),
  );
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const stage = path.join(sandbox, 'stage');
  const nextBin = path.join(stage, 'node_modules/next/dist/bin');
  const appDir = path.join(stage, 'apps/web');
  fs.mkdirSync(nextBin, { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });

  fs.writeFileSync(
    path.join(nextBin, 'next'),
    `
    const http = require('node:http');
    const port = Number(process.argv[process.argv.indexOf('-p') + 1]);
    console.log('TEST_SERVER_PID:' + process.pid);
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') { res.writeHead(200); res.end('ok'); return; }
      if (req.url === '/api/evaluator/access') { res.setHeader('set-cookie', 'evaluator=synthetic; Path=/'); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (req.url === '/api/evaluator/readiness') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ready"}'); return; }
      res.writeHead(200); res.end('ok');
    });
    server.listen(port, '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `,
  );
  const playwrightStub = path.join(sandbox, 'playwright.cjs');
  fs.writeFileSync(
    playwrightStub,
    `
    const unavailable = { launchServer: async () => { throw new Error('synthetic engine unavailable'); } };
    module.exports = { chromium: unavailable, firefox: unavailable, webkit: unavailable };
  `,
  );
  const runnerPath = fileURLToPath(
    new URL('./journey-a11y-runner.mjs', import.meta.url),
  );
  const result = spawnSync(process.execPath, [runnerPath], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: os.tmpdir(),
      HIREARCHY_STAGING_DIR: stage,
      HIREARCHY_PLAYWRIGHT_MODULE: playwrightStub,
    },
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const receiptMatch = result.stdout.match(/Receipts saved to (.+)/);
  assert.ok(receiptMatch, `${result.stdout}\n${result.stderr}`);
  const reportPath = path.join(receiptMatch[1], 'journey-results.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.acceptance.passed, false);
  assert.equal(report.engineDetection.chromium.available, false);
  assert.ok(
    report.acceptance.failures.some((failure) =>
      failure.includes('required engine unavailable'),
    ),
  );
  assert.equal(fs.existsSync(report.receipts.tempDir), false);
  const serverLog = fs.readFileSync(
    path.join(path.dirname(report.receipts.resultsJson), 'server.log'),
    'utf8',
  );
  const serverPidMatch = serverLog.match(/TEST_SERVER_PID:(\d+)/);
  assert.ok(serverPidMatch, serverLog);
  const serverPid = Number(serverPidMatch[1]);
  assert.throws(() => process.kill(serverPid, 0), { code: 'ESRCH' });
});
