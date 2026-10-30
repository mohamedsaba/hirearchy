import assert from 'node:assert/strict';
import fs from 'node:fs';

export const REQUIRED_ENGINES = ['chromium', 'firefox', 'webkit'];
export const REQUIRED_DIMENSIONS = [
  'candidateJourney',
  'builder',
  'lifecycle',
  'evaluatorWorkbench',
  'responsive375_768_1440',
  'keyboardFocusNav',
  'hiddenPaneIsolation',
  'formErrorAnnouncement',
  'automatedAxeCore',
];

export async function runEngineBoundary(report, engine, runJourney, cleanup) {
  let failed = false;
  try {
    await runJourney();
  } catch (error) {
    failed = true;
    const result = report.journeyResults[engine];
    result.error = error instanceof Error ? error.message : String(error);
    for (const dimension of REQUIRED_DIMENSIONS) {
      if (result[dimension] === 'Pending') result[dimension] = 'Failed';
    }
  } finally {
    try {
      await cleanup();
    } catch (error) {
      failed = true;
      report.cleanupErrors ??= [];
      report.cleanupErrors.push(
        `${engine}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return !failed;
}

function processHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForProcessExit(child, timeoutMs) {
  if (processHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(processHasExited(child)), timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function closeBrowserBounded(
  browser,
  browserServer,
  engine,
  timeoutMs = 10000,
) {
  try {
    await withTimeout(
      (async () => {
        if (browser) await browser.close();
        await browserServer.close();
      })(),
      timeoutMs,
      `${engine} browser close timed out after ${timeoutMs}ms`,
    );
  } catch (closeError) {
    try {
      await withTimeout(
        browserServer.kill(),
        3000,
        `${engine} browser force-kill timed out`,
      );
    } catch (killError) {
      const child = browserServer.process();
      if (!child) {
        throw new AggregateError(
          [closeError, killError],
          `${engine} browser server could not be stopped`,
        );
      }
      if (!processHasExited(child)) child.kill('SIGKILL');
      if (!(await waitForProcessExit(child, 3000))) {
        throw new AggregateError(
          [closeError, killError],
          `${engine} browser process remained alive after SIGKILL`,
        );
      }
    }
    throw new Error(
      `${engine} browser server close failed; owned process was force-stopped: ${closeError.message}`,
      { cause: closeError },
    );
  }
}

export async function captureScreenshot(page, options) {
  await page.waitForTimeout(200);
  await page.screenshot(options);
  const image = fs.existsSync(options.path) ? fs.statSync(options.path) : null;
  assert.ok(
    image && image.isFile() && image.size > 0,
    `Screenshot was not written: ${options.path}`,
  );
}

export function assertNoPageErrors(errors, engine) {
  assert.deepEqual(
    errors,
    [],
    `${engine} reported browser page error(s): ${errors.join('; ')}`,
  );
}

export function assertNoHorizontalOverflow(overflow, label) {
  assert.equal(
    overflow.hasHorizontalOverflow,
    false,
    `${label} has horizontal overflow (${overflow.scrollWidth}px > ${overflow.clientWidth}px)`,
  );
}

export function assertHiddenPaneIsolated(isolated, label) {
  assert.equal(
    isolated,
    true,
    `${label} is not isolated from keyboard interaction`,
  );
}

export function assertAuditPassed({ axe, overflow }, label) {
  assertNoHorizontalOverflow(overflow, label);
  assert.equal(
    axe.status,
    'Passed',
    `${label} axe-core audit did not complete`,
  );
  assert.deepEqual(axe.violations, [], `${label} has axe-core violations`);
}

export function assessRun(report) {
  const failures = [];
  for (const engine of REQUIRED_ENGINES) {
    if (!report.engineDetection[engine]?.available) {
      failures.push(`${engine}: required engine unavailable`);
      continue;
    }
    const results = report.journeyResults[engine] ?? {};
    if (results.error) failures.push(`${engine}: ${results.error}`);
    for (const dimension of REQUIRED_DIMENSIONS) {
      if (results[dimension] !== 'Passed') {
        failures.push(
          `${engine}.${dimension}: ${results[dimension] ?? 'Not run'}`,
        );
      }
    }
  }
  if (report.fatalError) failures.push(`fatal: ${report.fatalError}`);
  for (const error of report.cleanupErrors ?? [])
    failures.push(`cleanup: ${error}`);
  report.acceptance = { passed: failures.length === 0, failures };
  return report.acceptance;
}
