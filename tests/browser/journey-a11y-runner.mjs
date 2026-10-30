import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import net from 'node:net';
import {
  REQUIRED_DIMENSIONS,
  REQUIRED_ENGINES,
  assertAuditPassed,
  assertHiddenPaneIsolated,
  assertNoHorizontalOverflow,
  assertNoPageErrors,
  assessRun,
  captureScreenshot,
  closeBrowserBounded,
  runEngineBoundary,
} from './journey-a11y-runner-core.mjs';

const require = createRequire(import.meta.url);

const STAGING_ROOT = process.env.HIREARCHY_STAGING_DIR;
assert.ok(
  STAGING_ROOT,
  'Set HIREARCHY_STAGING_DIR to an explicit disposable built app directory',
);
assert.ok(
  fs.existsSync(path.join(STAGING_ROOT, 'apps/web')),
  'Staging app is missing apps/web',
);
assert.ok(
  fs.existsSync(path.join(STAGING_ROOT, 'node_modules/next/dist/bin/next')),
  'Staging app is missing its local Next.js installation',
);

const PLAYWRIGHT_MODULE =
  process.env.HIREARCHY_PLAYWRIGHT_MODULE ||
  require.resolve('playwright', { paths: [STAGING_ROOT, process.cwd()] });
const playwright = require(PLAYWRIGHT_MODULE);
let AXE_PATH = process.env.HIREARCHY_AXE_PATH;
if (!AXE_PATH) {
  try {
    AXE_PATH = require.resolve('axe-core/axe.min.js', {
      paths: [STAGING_ROOT, process.cwd()],
    });
  } catch {
    AXE_PATH = null;
  }
}
const axeSource =
  AXE_PATH && fs.existsSync(AXE_PATH)
    ? fs.readFileSync(AXE_PATH, 'utf8')
    : null;

const PORT = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});

const OUTPUT_ROOT = fs.mkdtempSync(path.join(STAGING_ROOT, '.journey-a11y-'));
const TEMP_DIR = path.join(OUTPUT_ROOT, 'tmp');
const RECEIPTS_DIR = path.join(OUTPUT_ROOT, 'receipts');
const SCREENSHOTS_DIR = path.join(OUTPUT_ROOT, 'screenshots');
try {
  fs.chmodSync(OUTPUT_ROOT, 0o700);
  fs.mkdirSync(TEMP_DIR, { mode: 0o700 });
  fs.mkdirSync(RECEIPTS_DIR, { mode: 0o700 });
  fs.mkdirSync(SCREENSHOTS_DIR, { mode: 0o700 });
} catch (error) {
  fs.rmSync(OUTPUT_ROOT, { recursive: true, force: true });
  throw error;
}

const BASE_URL = `http://127.0.0.1:${PORT}`;

// Synthetic credentials
const SYNTHETIC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const SYNTHETIC_EVALUATOR_KEY =
  'gate-c-evaluator-' + crypto.randomBytes(16).toString('hex');
const DISPOSABLE_DB_PATH = path.join(TEMP_DIR, 'disposable.sqlite');

let serverProcess = null;
let serverLogStream = null;
let serverStartError = null;
let evaluatorCookie = null;
const ownedSessionIds = new Set();

function dockerNames(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const container = `hirearchy-sandbox-${safe}`;
  return {
    containers: [container, `${container}-frozen-capture`],
    volumes: [`hirearchy-ws-${safe}`, `hirearchy-ev-${safe}`],
  };
}

function browserEnvironment() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: TEMP_DIR,
    TMP: TEMP_DIR,
    TEMP: TEMP_DIR,
  };
}

function browserLaunchOptions(engine) {
  return {
    headless: true,
    env: browserEnvironment(),
    ...(engine === 'chromium'
      ? {
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
          ...(process.env.HIREARCHY_CHROMIUM_EXECUTABLE
            ? { executablePath: process.env.HIREARCHY_CHROMIUM_EXECUTABLE }
            : {}),
        }
      : {}),
  };
}

async function launchBrowser(engine) {
  const browserServer = await playwright[engine].launchServer(
    browserLaunchOptions(engine),
  );
  try {
    const browser = await playwright[engine].connect(
      browserServer.wsEndpoint(),
      {
        timeout: 10000,
      },
    );
    return { browser, browserServer };
  } catch (error) {
    try {
      await closeBrowserBounded(browser, browserServer, `${engine} launch`);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${engine} browser connection failed and server cleanup failed`,
      );
    }
    throw error;
  }
}

function removeDockerResource(args, missingPattern) {
  try {
    execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
  } catch (error) {
    const output = `${error.stderr || ''}\n${error.message || ''}`;
    if (!missingPattern.test(output)) throw error;
  }
}

function stopOwnedContainers() {
  const cleanupErrors = [];
  for (const sessionId of ownedSessionIds) {
    const names = dockerNames(sessionId);
    for (const name of names.containers) {
      try {
        removeDockerResource(
          ['rm', '-f', name],
          /no such container|no such object/i,
        );
      } catch (error) {
        cleanupErrors.push(`docker container ${name}: ${error.message}`);
      }
    }
    for (const name of names.volumes) {
      try {
        removeDockerResource(['volume', 'rm', name], /no such volume/i);
      } catch (error) {
        cleanupErrors.push(`docker volume ${name}: ${error.message}`);
      }
    }
  }
  if (cleanupErrors.length) throw new Error(cleanupErrors.join('\n'));
}

async function stopServer() {
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
  if (serverStartError) {
    serverStartError = null;
    if (serverLogStream) {
      fs.closeSync(serverLogStream);
      serverLogStream = null;
    }
    return;
  }
  const waitForExit = (timeoutMs) =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resolve(true);
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  let stopped = child.exitCode !== null || child.signalCode !== null;
  try {
    if (!stopped) child.kill('SIGTERM');
    if (!stopped) stopped = await waitForExit(3000);
    if (!stopped) {
      child.kill('SIGKILL');
      stopped = await waitForExit(2000);
    }
  } finally {
    if (serverLogStream) {
      fs.closeSync(serverLogStream);
      serverLogStream = null;
    }
  }
  if (!stopped) {
    child.unref();
    throw new Error('Staged server did not stop after SIGKILL');
  }
}

async function startServer() {
  await stopServer();
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: TEMP_DIR,
    TMP: TEMP_DIR,
    TEMP: TEMP_DIR,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    HIREARCHY_DB_PATH: DISPOSABLE_DB_PATH,
    HIREARCHY_EVALUATOR_KEY: SYNTHETIC_EVALUATOR_KEY,
    HIREARCHY_CANDIDATE_TOKEN_ENCRYPTION_KEY: SYNTHETIC_ENCRYPTION_KEY,
    HIREARCHY_TRUSTED_PROXY_HOPS: '0',
  };

  const logFile = path.join(RECEIPTS_DIR, 'server.log');
  serverLogStream = fs.openSync(logFile, 'w', 0o600);

  serverStartError = null;
  serverProcess = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      'start',
      'apps/web',
      '-H',
      '127.0.0.1',
      '-p',
      String(PORT),
    ],
    {
      cwd: STAGING_ROOT,
      env,
      stdio: ['ignore', serverLogStream, serverLogStream],
    },
  );
  serverProcess.once('error', (error) => {
    serverStartError = error;
  });

  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (serverStartError) {
      throw new Error(
        `Staged server failed to spawn: ${serverStartError.message}`,
      );
    }
    if (serverProcess.exitCode !== null) break;
    try {
      const res = await fetch(`${BASE_URL}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!ready) {
    throw new Error('Server failed to start within timeout');
  }
  console.log(`Server started successfully on ${BASE_URL}`);
}

async function apiRequest(method, urlPath, body = undefined, headers = {}) {
  const reqHeaders = {
    'content-type': 'application/json',
    ...(evaluatorCookie ? { cookie: evaluatorCookie } : {}),
    ...headers,
  };
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: reqHeaders,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, body: json || text };
}

// Axe runner helper
async function runAxe(page, onViolations = () => {}) {
  assert.ok(
    axeSource,
    'axe-core is required; set HIREARCHY_AXE_PATH or install axe-core',
  );
  const hasAxe = await page.evaluate(
    () => typeof globalThis.axe !== 'undefined',
  );
  if (!hasAxe) {
    await page.addScriptTag({ content: axeSource });
  }
  const violations = await page.evaluate(async () => {
    const results = await globalThis.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
    });
    return results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodesCount: v.nodes.length,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
    }));
  });
  onViolations(violations);
  assert.deepEqual(violations, [], 'axe-core reported WCAG violations');
  return { status: 'Passed', violations };
}

// Check responsive overflow
async function checkOverflow(page) {
  return await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    hasHorizontalOverflow:
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  }));
}

// Check active focus element
async function getFocusInfo(page) {
  return await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    return {
      tagName: el.tagName,
      role: el.getAttribute('role'),
      id: el.id,
      className: el.className,
      text: el.innerText
        ? el.innerText.slice(0, 50)
        : el.getAttribute('aria-label') || el.name || '',
    };
  });
}

async function main() {
  const runReport = {
    timestamp: new Date().toISOString(),
    engineDetection: {},
    journeyResults: {},
    a11yFindings: [],
    keyboardAndFocus: [],
    hiddenPaneIsolation: [],
    formAnnouncements: [],
    backlog: [],
    cleanupErrors: [],
    receipts: {},
  };

  console.log('=== Checking Playwright Browser Engines ===');
  // 1. Check Engines
  for (const engine of REQUIRED_ENGINES) {
    let browser;
    let browserServer;
    try {
      ({ browser, browserServer } = await launchBrowser(engine));
      await closeBrowserBounded(browser, browserServer, `${engine} detection`);
      browser = null;
      browserServer = null;
      runReport.engineDetection[engine] = {
        available: true,
        package: PLAYWRIGHT_MODULE,
      };
      console.log(`Engine ${engine}: AVAILABLE`);
    } catch (e) {
      try {
        if (browserServer)
          await closeBrowserBounded(
            browser,
            browserServer,
            `${engine} detection`,
          );
      } catch (closeError) {
        runReport.cleanupErrors.push(
          `${engine} detection browser: ${closeError.message}`,
        );
      }
      runReport.engineDetection[engine] = {
        available: false,
        reason: e.message.split('\n')[0],
      };
      console.log(
        `Engine ${engine}: UNAVAILABLE (${e.message.split('\n')[0]})`,
      );
    }
  }

  // Journey results initialization
  for (const engine of REQUIRED_ENGINES) {
    runReport.journeyResults[engine] = Object.fromEntries(
      REQUIRED_DIMENSIONS.map((dimension) => [
        dimension,
        runReport.engineDetection[engine].available &&
        (dimension !== 'automatedAxeCore' || axeSource)
          ? 'Pending'
          : 'Unavailable',
      ]),
    );
  }

  try {
    console.log('\n=== Starting Staged App Server ===');
    await startServer();

    // Authenticate evaluator via API
    const authRes = await apiRequest('POST', '/api/evaluator/access', {
      credential: SYNTHETIC_EVALUATOR_KEY,
    });
    assert.equal(authRes.status, 200, 'Evaluator access failed');
    evaluatorCookie = authRes.headers.get('set-cookie').split(';')[0];
    console.log('Evaluator authenticated successfully');

    // Verify readiness
    const readyRes = await apiRequest('GET', '/api/evaluator/readiness');
    assert.equal(readyRes.status, 200, 'Readiness failed');
    assert.equal(readyRes.body.status, 'ready', 'Readiness status not ready');
    console.log('Readiness probe: 200 OK, status: ready');

    const activeEngines = REQUIRED_ENGINES.filter(
      (e) => runReport.engineDetection[e]?.available,
    );
    console.log(
      `\n=== Running Journeys for Engines: ${activeEngines.join(', ')} ===`,
    );

    for (const engine of activeEngines) {
      let browser;
      let browserServer;
      let context;
      const pageErrors = [];
      let markBrowserClosing = () => {};
      await runEngineBoundary(
        runReport,
        engine,
        async () => {
          console.log(`\n========================================`);
          console.log(`=== RUNNING JOURNEYS FOR ${engine.toUpperCase()} ===`);
          console.log(`========================================`);

          // -----------------------------------------------------------------
          // TEST LIFECYCLE (Issuance + Recovery / Replay) FOR THIS ENGINE
          // -----------------------------------------------------------------
          console.log(
            `\n[${engine}] Testing Lifecycle (Issuance + Idempotent Replay)...`,
          );
          const idempotencyKey =
            `gate-c-idempotent-${engine}-` +
            crypto.randomBytes(8).toString('hex');
          const issuancePayload = {
            field: 'backend',
            workKind: 'incident',
            domain: 'travel',
            stack: 'python-flask',
            depth: 'layered',
            durationMinutes: 60,
            integratedAi: false,
            useCuratedBlueprint: true,
          };
          const issueRes1 = await apiRequest(
            'POST',
            '/api/evaluator/assessments',
            issuancePayload,
            {
              'Idempotency-Key': idempotencyKey,
            },
          );
          assert.equal(
            issueRes1.status,
            201,
            `Issuance failed for ${engine} with status ${issueRes1.status}: ${JSON.stringify(issueRes1.body)}`,
          );
          assert.ok(issueRes1.body.sessionId, 'Missing sessionId in issuance');
          assert.equal(
            typeof issueRes1.body.sessionId,
            'string',
            'sessionId must be a string',
          );
          assert.ok(
            issueRes1.body.candidatePath,
            'Missing candidatePath in issuance',
          );
          const { sessionId, candidatePath } = issueRes1.body;
          ownedSessionIds.add(sessionId);
          const candidateToken = candidatePath.split('/').pop();
          console.log(
            `[${engine}] Issued session: ${sessionId}, token: [synthetic]`,
          );

          // Idempotent replay with same key
          const replayRes = await apiRequest(
            'POST',
            '/api/evaluator/assessments',
            issuancePayload,
            {
              'Idempotency-Key': idempotencyKey,
            },
          );
          assert.equal(
            replayRes.status,
            200,
            `Idempotent replay failed for ${engine} with non-200`,
          );
          assert.equal(
            replayRes.body.sessionId,
            sessionId,
            `Replay returned different sessionId for ${engine}`,
          );
          assert.equal(
            replayRes.body.candidatePath,
            candidatePath,
            `Replay returned different candidatePath for ${engine}`,
          );
          console.log(
            `[${engine}] Idempotent replay returned 200 with identical session/token`,
          );

          // Candidate token recovery from assessments list
          const listRes = await apiRequest('GET', '/api/evaluator/assessments');
          assert.equal(
            listRes.status,
            200,
            `Failed to fetch assessments list for ${engine}`,
          );
          const foundSession = listRes.body.assessments?.find(
            (a) => a.sessionId === sessionId,
          );
          assert.ok(
            foundSession,
            `Issued session missing from assessments list for ${engine}`,
          );
          assert.equal(
            foundSession.candidatePath,
            candidatePath,
            `candidatePath mismatch in assessments list for ${engine}`,
          );
          console.log(
            `[${engine}] Candidate token recovery verified via evaluator assessment list`,
          );
          runReport.journeyResults[engine].lifecycle = 'Passed';

          // Launch Browser
          console.log(`\n[${engine}] Launching ${engine}...`);
          ({ browser, browserServer } = await launchBrowser(engine));

          context = await browser.newContext({
            viewport: { width: 1440, height: 1000 },
            reducedMotion: 'reduce',
          });
          let browserIsClosing = false;
          browser.on('disconnected', () => {
            if (!browserIsClosing) {
              pageErrors.push('browser disconnected unexpectedly');
            }
          });
          context.on('page', (page) => {
            page.on('pageerror', (error) => pageErrors.push(error.message));
            page.on('crash', () => pageErrors.push('page crashed'));
          });
          markBrowserClosing = () => {
            browserIsClosing = true;
          };

          // Helper to test viewports and axe on a target page
          async function auditPageCheckpoint(
            targetPage,
            name,
            viewports = [1440, 768, 375],
          ) {
            const results = {};
            for (const width of viewports) {
              const height = width === 375 ? 812 : width === 768 ? 1024 : 1000;
              await targetPage.setViewportSize({ width, height });
              await targetPage.waitForLoadState('networkidle');
              assertNoPageErrors(pageErrors, engine);
              const overflow = await checkOverflow(targetPage);
              assertNoHorizontalOverflow(overflow, `${name} ${width}px`);
              const screenshotPath = path.join(
                SCREENSHOTS_DIR,
                `${engine}-${name}-${width}.png`,
              );
              await captureScreenshot(targetPage, { path: screenshotPath });

              let axe = { status: 'Skipped', violations: [] };
              if (width === 1440) {
                axe = await runAxe(targetPage, (violations) => {
                  if (violations.length)
                    runReport.a11yFindings.push({
                      engine,
                      view: `${name} [${engine}]`,
                      viewport: width,
                      violations,
                    });
                });
                assertAuditPassed({ axe, overflow }, `${name} ${width}px`);
              }
              results[width] = { overflow, axe };
            }
            await targetPage.setViewportSize({ width: 1440, height: 1000 });
            return results;
          }

          // -----------------------------------------------------------------
          // JOURNEY 1: Evaluator Sign-in, Queue & Builder
          // -----------------------------------------------------------------
          console.log(
            `\n[${engine}] --- Auditing Evaluator Sign-In, Queue & Builder ---`,
          );
          const evalPage = await context.newPage();

          // 1a: Unauthenticated sign-in error check
          await evalPage.goto(`${BASE_URL}/evaluator`);
          await evalPage.waitForLoadState('networkidle');

          const credentialInput = evalPage.getByLabel(/Evaluator credential/);
          await credentialInput.fill('bad-credential');
          await evalPage
            .getByRole('button', { name: /Continue to review queue/ })
            .click();
          await evalPage.waitForTimeout(500);

          const accessFormError = await evalPage.locator('.form-error').first();
          const errorRole = await accessFormError.getAttribute('role');
          const errorLive = await accessFormError.getAttribute('aria-live');
          const errorId = await accessFormError.getAttribute('id');
          const describedBy =
            await credentialInput.getAttribute('aria-describedby');
          const errorText = await accessFormError.innerText();
          runReport.formAnnouncements.push({
            engine,
            form: 'Evaluator Access Form',
            hasRoleAlert: errorRole === 'alert',
            ariaLive: errorLive,
            text: errorText,
          });

          assert.equal(
            errorRole,
            'alert',
            'Credential error must use role="alert"',
          );
          assert.equal(
            errorLive,
            'assertive',
            'Credential error must announce assertively',
          );
          assert.ok(
            errorText.trim(),
            'Credential error announcement must contain text',
          );
          assert.ok(
            errorId && describedBy?.split(/\s+/).includes(errorId),
            'Credential input must reference its error announcement',
          );

          await auditPageCheckpoint(evalPage, '01-evaluator-signin');

          // 1b: Set signed evaluator cookie on context for authenticated views
          const [cName, ...cValParts] = evaluatorCookie.split('=');
          const cVal = cValParts.join('=');
          await context.addCookies([
            {
              name: cName,
              value: cVal,
              domain: '127.0.0.1',
              path: '/',
              httpOnly: true,
            },
          ]);

          // Review Queue
          await evalPage.goto(`${BASE_URL}/evaluator`);
          await evalPage.waitForLoadState('networkidle');
          await evalPage
            .getByRole('heading', { name: 'Reviews' })
            .waitFor({ timeout: 10000 });
          await auditPageCheckpoint(evalPage, '02-evaluator-queue');

          // Builder
          await evalPage.goto(`${BASE_URL}/evaluator/assessments/new`);
          await evalPage.waitForLoadState('networkidle');
          await evalPage
            .getByRole('heading', { name: 'Build an assessment' })
            .waitFor({ timeout: 10000 });
          await auditPageCheckpoint(evalPage, '03-assessment-builder-initial');

          // Keyboard navigation in Builder
          console.log(
            `[${engine}] Testing keyboard navigation in Assessment Builder...`,
          );
          const builderFocusSequence = [];
          for (let i = 0; i < 12; i++) {
            await evalPage.keyboard.press('Tab');
            const focus = await getFocusInfo(evalPage);
            if (focus && focus.tagName !== 'BODY') {
              builderFocusSequence.push(focus);
            }
          }
          runReport.keyboardAndFocus.push({
            engine,
            view: 'Assessment Builder',
            focusSequence: builderFocusSequence,
          });
          assert.ok(
            builderFocusSequence.length > 0,
            'Builder keyboard navigation never focused a control',
          );

          // Configure options via triggers and options
          for (const [triggerId, optionText] of [
            ['#assessment-field', 'Backend engineering'],
            ['#assessment-stack', 'Python · Flask'],
            ['#assessment-domain', 'Travel and bookings'],
            ['#assessment-challenge', 'Investigate a production incident'],
            ['#assessment-depth', 'Layered'],
          ]) {
            const trigger = evalPage.locator(triggerId);
            await trigger.waitFor({ state: 'visible', timeout: 5000 });
            await trigger.click();
            const opt = evalPage.getByRole('option', {
              name: optionText,
              exact: true,
            });
            await opt.waitFor({ state: 'visible', timeout: 5000 });
            await opt.click();
          }

          const durationRadio = evalPage.getByLabel(/60 min/);
          await durationRadio.first().check();

          // Click "Continue to Validate"
          const validateBtn = evalPage.getByRole('button', {
            name: 'Continue to Validate',
          });
          await validateBtn.waitFor({ state: 'visible', timeout: 5000 });
          await validateBtn.click();
          await evalPage.waitForLoadState('networkidle');
          await evalPage
            .getByRole('heading', { name: 'Prepare and validate a task' })
            .waitFor({ timeout: 10000 });
          await auditPageCheckpoint(
            evalPage,
            '04-assessment-builder-validation',
          );

          assertNoPageErrors(pageErrors, engine);
          runReport.journeyResults[engine].builder = 'Passed';
          await evalPage.close();
          console.log(
            `[${engine}] Page 1 (Evaluator & Builder) finished and closed cleanly`,
          );

          // -----------------------------------------------------------------
          // JOURNEY 2: Candidate Journey (Page 2)
          // -----------------------------------------------------------------
          console.log(`\n[${engine}] --- Auditing Candidate Journey ---`);
          let candPage = await context.newPage();

          await candPage.goto(`${BASE_URL}${candidatePath}`);
          await candPage.waitForLoadState('networkidle');

          // Candidate Entry view
          await auditPageCheckpoint(candPage, '05-candidate-entry');

          // Click Continue to orientation
          await candPage
            .getByRole('button', { name: 'Continue to orientation' })
            .click();
          await candPage.waitForLoadState('networkidle');
          await auditPageCheckpoint(candPage, '06-candidate-orientation');

          // Click Continue to start
          await candPage
            .getByRole('button', { name: 'Continue to start' })
            .click();
          await candPage.waitForLoadState('networkidle');
          await auditPageCheckpoint(candPage, '07-candidate-ready-to-start');

          // Click Start Assessment
          const startBtn = candPage.getByRole('button', {
            name: 'Start Assessment',
            exact: true,
          });
          await startBtn.waitFor({ state: 'visible', timeout: 10000 });
          await startBtn.click();

          // Wait for CodeMirror editor to mount
          const editor = candPage.locator('.cm-content[contenteditable=true]');
          await editor.waitFor({ timeout: 60000 });
          await candPage.waitForLoadState('networkidle');

          // Verify session status ACTIVE via API
          const candStatus = await apiRequest(
            'GET',
            `/api/candidate/sessions/${candidateToken}`,
          );
          assert.equal(
            candStatus.body.status,
            'ACTIVE',
            `Candidate session is not ACTIVE for ${engine}`,
          );
          console.log(
            `[${engine}] Candidate session is ACTIVE, Docker sandbox mounted`,
          );

          // Candidate Workspace initial desktop audit
          const activeOverflow = await checkOverflow(candPage);
          assertNoHorizontalOverflow(
            activeOverflow,
            'candidate workspace 1440px',
          );
          await captureScreenshot(candPage, {
            path: path.join(
              SCREENSHOTS_DIR,
              `${engine}-08-candidate-workspace-active-1440.png`,
            ),
          });
          const activeAxe = await runAxe(candPage, (violations) => {
            if (violations.length)
              runReport.a11yFindings.push({
                engine,
                view: `Candidate Workspace Active [${engine}]`,
                viewport: 1440,
                violations,
              });
          });
          assertAuditPassed(
            { axe: activeAxe, overflow: activeOverflow },
            'candidate workspace 1440px',
          );

          // Test Hidden-Pane Focus Isolation in Candidate Workspace
          console.log(
            `[${engine}] Testing Hidden-Pane Focus Isolation in Candidate Workspace...`,
          );
          const terminalClosed = await candPage.evaluate(() => {
            const details = document.querySelector('.terminal-details');
            return details ? !details.open : true;
          });
          const terminalInputIsTabbableWhenClosed = await candPage.evaluate(
            () => {
              const cmdInput = document.querySelector(
                '.terminal-command-input',
              );
              const details = document.querySelector('.terminal-details');
              return Boolean(
                details &&
                cmdInput &&
                !details.open &&
                cmdInput.offsetParent !== null,
              );
            },
          );
          runReport.hiddenPaneIsolation.push({
            engine,
            pane: 'Terminal Drawer (<details>)',
            closedByDefault: terminalClosed,
            isolatedWhenClosed: !terminalInputIsTabbableWhenClosed,
          });
          assertHiddenPaneIsolated(
            terminalClosed,
            'Terminal drawer closed state',
          );
          assertHiddenPaneIsolated(
            !terminalInputIsTabbableWhenClosed,
            'Closed terminal command input',
          );

          // Keyboard navigation in Candidate Workspace
          const workspaceFocusSequence = [];
          for (let i = 0; i < 15; i++) {
            await candPage.keyboard.press('Tab');
            const focus = await getFocusInfo(candPage);
            if (focus && focus.tagName !== 'BODY') {
              workspaceFocusSequence.push(focus);
            }
          }
          runReport.keyboardAndFocus.push({
            engine,
            view: 'Candidate Workspace',
            focusSequence: workspaceFocusSequence,
          });
          assert.ok(
            workspaceFocusSequence.length > 0,
            'Workspace keyboard navigation never focused a control',
          );

          // Candidate Edit & Save
          console.log(`[${engine}] Editing workspace file and saving...`);
          await editor.click();
          await candPage.keyboard.press('Control+End');
          await candPage.keyboard.type('\n# Gate C verified candidate edit\n');

          const saveResponsePromise = candPage.waitForResponse(
            (r) =>
              r.url().includes('/workspace/file') &&
              r.request().method() === 'PUT',
          );
          await candPage
            .getByRole('button', { name: 'Save', exact: true })
            .click();
          const saveResponse = await saveResponsePromise;
          assert.equal(
            saveResponse.status(),
            200,
            `Save file returned non-200 for ${engine}`,
          );
          console.log(
            `[${engine}] Candidate edits saved successfully (200 OK)`,
          );

          // Open terminal and run command
          console.log(`[${engine}] Executing terminal command in sandbox...`);
          await candPage.evaluate(() => {
            const d = document.querySelector('.terminal-details');
            if (d) d.open = true;
          });
          const cmdInput = candPage.getByRole('textbox', {
            name: 'Command',
            exact: true,
          });
          await cmdInput.waitFor({ state: 'visible', timeout: 5000 });
          await cmdInput.fill('printf "Gate C execution proof\\n"; pytest -q');

          const execPromise = candPage.waitForResponse((r) =>
            r.url().includes('/terminal/exec'),
          );
          await candPage
            .getByRole('button', { name: 'Run', exact: true })
            .click();
          const execRes = await execPromise;
          assert.equal(
            execRes.status(),
            200,
            `Terminal exec returned non-200 for ${engine}`,
          );
          console.log(`[${engine}] Terminal command executed (200 OK)`);
          await candPage.waitForLoadState('networkidle');
          await captureScreenshot(candPage, {
            path: path.join(
              SCREENSHOTS_DIR,
              `${engine}-09-candidate-terminal-run-1440.png`,
            ),
          });

          // Reload continuity test
          console.log(`[${engine}] Testing reload continuity...`);
          const candUrl = candPage.url();
          await candPage.close();
          candPage = await context.newPage();
          await candPage.goto(candUrl, { waitUntil: 'domcontentloaded' });
          await candPage.waitForLoadState('networkidle');

          await candPage.locator('.cm-content').waitFor({ timeout: 15000 });
          await candPage.waitForTimeout(1000);

          const editorContent = await candPage
            .locator('.cm-content')
            .innerText();
          assert.ok(
            editorContent.includes('Gate C verified candidate edit'),
            `Saved editor content lost on reload for ${engine}`,
          );

          await candPage.evaluate(() => {
            const d = document.querySelector('.terminal-details');
            if (d) d.open = true;
          });
          await candPage
            .getByLabel('Command history')
            .waitFor({ timeout: 10000 });
          const cmdHistory = await candPage
            .getByLabel('Command history')
            .innerText();
          assert.ok(
            cmdHistory.includes('Gate C execution proof') ||
              cmdHistory.includes('pytest -q'),
            `Command history lost on reload for ${engine}`,
          );
          console.log(
            `[${engine}] Reload continuity verified: editor edits and command history persisted`,
          );
          await captureScreenshot(candPage, {
            path: path.join(
              SCREENSHOTS_DIR,
              `${engine}-10-candidate-reloaded-1440.png`,
            ),
          });

          // Responsive audit of reloaded candidate workspace
          console.log(
            `[${engine}] Auditing candidate workspace responsive viewports...`,
          );
          for (const width of [768, 375]) {
            const height = width === 375 ? 812 : 1024;
            await candPage.setViewportSize({ width, height });
            await candPage.waitForLoadState('networkidle');
            assertNoPageErrors(pageErrors, engine);
            const overflow = await checkOverflow(candPage);
            assertNoHorizontalOverflow(
              overflow,
              `candidate workspace ${width}px`,
            );
            await captureScreenshot(candPage, {
              path: path.join(
                SCREENSHOTS_DIR,
                `${engine}-10-candidate-workspace-${width}.png`,
              ),
            });
          }
          await candPage.setViewportSize({ width: 1440, height: 1000 });

          // Submit work
          console.log(`[${engine}] Submitting candidate assessment...`);
          await candPage
            .getByRole('button', { name: 'Review submission', exact: true })
            .click();

          // Check hidden-pane focus isolation during submission review mode
          const isolationDuringReview = await candPage.evaluate(() => {
            const content = document.querySelector(
              '.candidate-workspace-content',
            );
            return {
              inert: content ? content.hasAttribute('inert') : false,
              ariaHidden: content ? content.getAttribute('aria-hidden') : null,
            };
          });
          runReport.hiddenPaneIsolation.push({
            engine,
            pane: 'Candidate Workspace Content during Submission Review',
            inert: isolationDuringReview.inert,
            ariaHidden: isolationDuringReview.ariaHidden,
            isolated:
              isolationDuringReview.inert ||
              isolationDuringReview.ariaHidden === 'true',
          });
          assertHiddenPaneIsolated(
            isolationDuringReview.inert ||
              isolationDuringReview.ariaHidden === 'true',
            'Workspace content during submission review',
          );

          const submitPromise = candPage.waitForResponse((r) =>
            r.url().endsWith('/submit'),
          );
          await candPage
            .getByRole('button', { name: 'Submit Assessment', exact: true })
            .click();
          const submitRes = await submitPromise;
          assert.equal(
            submitRes.status(),
            200,
            `Candidate submit failed with non-200 for ${engine}`,
          );
          await candPage.waitForLoadState('networkidle');

          // Verify submitted status
          await auditPageCheckpoint(candPage, '11-candidate-submitted');

          // Verify Post-Submission Immutability via API
          const putFile = await apiRequest(
            'PUT',
            `/api/candidate/sessions/${candidateToken}/file`,
            { content: 'illegal' },
          );
          assert.equal(
            putFile.status,
            409,
            `Expected 409 on post-submit /file write for ${engine}`,
          );
          const putWFile = await apiRequest(
            'PUT',
            `/api/candidate/sessions/${candidateToken}/workspace/file`,
            { path: 'test.py', content: 'illegal' },
          );
          assert.equal(
            putWFile.status,
            409,
            `Expected 409 on post-submit /workspace/file write for ${engine}`,
          );
          console.log(
            `[${engine}] Post-submission immutability confirmed: writes rejected with 409 Conflict`,
          );

          assertNoPageErrors(pageErrors, engine);
          runReport.journeyResults[engine].candidateJourney = 'Passed';
          await candPage.close();
          console.log(
            `[${engine}] Candidate Journey finished and closed cleanly`,
          );

          // -----------------------------------------------------------------
          // JOURNEY 3: Evaluator Workbench (Page 3)
          // -----------------------------------------------------------------
          console.log(`\n[${engine}] --- Auditing Evaluator Workbench ---`);
          const wbPage = await context.newPage();

          await wbPage.goto(
            `${BASE_URL}/evaluator/sessions/${sessionId}?depth=ENGINEER`,
          );
          await wbPage.waitForLoadState('networkidle');

          // Evaluator Workbench A11y & responsive audit
          await auditPageCheckpoint(wbPage, '12-evaluator-workbench-evidence');

          // Test Hidden-Pane Focus Isolation across Evaluator Tabs
          console.log(
            `[${engine}] Testing Evaluator Workbench Tab Isolation...`,
          );
          const tabPanels = await wbPage.evaluate(() => {
            const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
            const inactiveTabs = tabs.filter(
              (t) => t.getAttribute('aria-selected') !== 'true',
            );
            const allInactiveHaveNegativeTabIndex = inactiveTabs.every(
              (t) => t.getAttribute('tabindex') === '-1',
            );
            return {
              tabCount: tabs.length,
              inactiveTabsCount: inactiveTabs.length,
              inactiveTabsHaveNegativeTabIndex: allInactiveHaveNegativeTabIndex,
            };
          });
          runReport.hiddenPaneIsolation.push({
            engine,
            pane: 'Evaluator Workbench Inactive Tabs',
            tabCount: tabPanels.tabCount,
            isolatedViaNegativeTabIndex:
              tabPanels.inactiveTabsHaveNegativeTabIndex,
          });
          assert.ok(
            tabPanels.tabCount > 1,
            'Evaluator Workbench must expose its tab set',
          );
          assert.ok(
            tabPanels.inactiveTabsCount > 0,
            'Evaluator Workbench must have an inactive tab to verify',
          );
          assertHiddenPaneIsolated(
            tabPanels.inactiveTabsHaveNegativeTabIndex,
            'Inactive evaluator tabs',
          );

          // Keyboard navigation in Evaluator Workbench
          console.log(
            `[${engine}] Testing keyboard navigation in Evaluator Workbench...`,
          );
          const workbenchFocusSequence = [];
          for (let i = 0; i < 15; i++) {
            await wbPage.keyboard.press('Tab');
            const focus = await getFocusInfo(wbPage);
            if (focus && focus.tagName !== 'BODY') {
              workbenchFocusSequence.push(focus);
            }
          }
          runReport.keyboardAndFocus.push({
            engine,
            view: 'Evaluator Workbench',
            focusSequence: workbenchFocusSequence,
          });
          assert.ok(
            workbenchFocusSequence.length > 0,
            'Workbench keyboard navigation never focused a control',
          );

          // Evaluator requests clarification via API
          console.log(`[${engine}] Testing Clarification Workflow...`);
          const clarReq = await apiRequest(
            'POST',
            `/api/evaluator/sessions/${sessionId}/review-workflow`,
            {
              action: 'request_clarification',
              prompt: `Gate C synthetic verification (${engine}): explain your fix.`,
              requestKey: crypto.randomUUID(),
            },
          );
          assert.equal(
            clarReq.status,
            201,
            `Clarification request failed for ${engine}`,
          );
          const clarificationId = clarReq.body.clarification?.id;
          assert.ok(clarificationId, 'Missing clarification ID');

          // Candidate replies to clarification
          const candReply = await apiRequest(
            'POST',
            `/api/candidate/sessions/${candidateToken}/clarifications`,
            {
              id: clarificationId,
              reply: `Gate C synthetic reply (${engine}): invalidation timing was updated to resolve stale restock reads.`,
            },
          );
          assert.equal(
            candReply.status,
            200,
            `Candidate clarification reply failed for ${engine}`,
          );
          console.log(
            `[${engine}] Clarification requested and replied successfully`,
          );

          // Evaluator records human next step
          const currentWf = await apiRequest(
            'GET',
            `/api/evaluator/sessions/${sessionId}/review-workflow`,
          );
          const nextStepRes = await apiRequest(
            'POST',
            `/api/evaluator/sessions/${sessionId}/review-workflow`,
            {
              action: 'save_next_step',
              step: 'technical_review',
              note: `Gate C verified human review next step (${engine}).`,
              expectedVersion: currentWf.body.nextStep?.version ?? 0,
            },
          );
          assert.equal(
            nextStepRes.status,
            200,
            `Saving next step failed for ${engine}`,
          );
          console.log(`[${engine}] Human next step recorded (200 OK)`);

          // Evaluator saves decision note via UI
          await wbPage.goto(
            `${BASE_URL}/evaluator/sessions/${sessionId}?depth=ENGINEER`,
          );
          await wbPage.waitForLoadState('networkidle');

          const reviewTab = wbPage.locator(
            '[data-workbench-mode-tab="review"]',
          );
          await reviewTab.waitFor({ state: 'visible', timeout: 10000 });
          await reviewTab.click();
          await wbPage.waitForLoadState('networkidle');

          const noteInput = wbPage.locator('#reviewer-note-body');
          await noteInput.waitFor({ state: 'visible', timeout: 10000 });
          await noteInput.fill(
            `Gate C human evaluator review note (${engine}): verified evidence and reproducible trace.`,
          );
          const saveBtn = wbPage.locator('#save-review-note');
          const saveNotePromise = wbPage.waitForResponse(
            (r) =>
              r.url().includes('/review-workflow') &&
              r.request().method() === 'POST',
          );
          await saveBtn.click();
          const noteSaveRes = await saveNotePromise;
          assert.equal(
            noteSaveRes.status(),
            200,
            `Save decision note returned non-200 for ${engine}`,
          );
          console.log(`[${engine}] Decision note saved via UI (200 OK)`);
          await auditPageCheckpoint(wbPage, '13-evaluator-workbench-review');

          assertNoPageErrors(pageErrors, engine);
          runReport.journeyResults[engine].evaluatorWorkbench = 'Passed';
          runReport.journeyResults[engine].responsive375_768_1440 = 'Passed';
          runReport.journeyResults[engine].keyboardFocusNav = 'Passed';
          runReport.journeyResults[engine].hiddenPaneIsolation = 'Passed';
          runReport.journeyResults[engine].formErrorAnnouncement = 'Passed';
          runReport.journeyResults[engine].automatedAxeCore = 'Passed';

          markBrowserClosing();
          await closeBrowserBounded(browser, browserServer, engine);
          browser = null;
          browserServer = null;
          context = null;
          console.log(
            `\n=== [${engine.toUpperCase()}] All Journeys Completed Successfully ===`,
          );
        },
        async () => {
          const cleanupErrors = [];
          try {
            if (browserServer) {
              markBrowserClosing();
              await closeBrowserBounded(browser, browserServer, engine);
            }
          } catch (error) {
            cleanupErrors.push(error);
          } finally {
            browser = null;
            browserServer = null;
            context = null;
          }
          if (cleanupErrors.length) {
            throw new AggregateError(cleanupErrors, 'Browser cleanup failed');
          }
        },
      );
    }
  } catch (err) {
    console.error('Fatal error during test run:', err);
    runReport.fatalError = err instanceof Error ? err.message : String(err);
  } finally {
    console.log('\n=== Cleaning Up Server and Docker Containers ===');
    try {
      await stopServer();
    } catch (error) {
      runReport.cleanupErrors.push(`staged server: ${error.message}`);
    }
    try {
      stopOwnedContainers();
    } catch (error) {
      runReport.cleanupErrors.push(`Docker resources: ${error.message}`);
    }
    try {
      fs.rmSync(TEMP_DIR, {
        recursive: true,
        force: false,
        maxRetries: 2,
        retryDelay: 100,
      });
    } catch (error) {
      runReport.cleanupErrors.push(`private temp directory: ${error.message}`);
    }
  }

  // Deduplicate and summarize a11y findings
  const violationMap = new Map();
  for (const item of runReport.a11yFindings) {
    for (const v of item.violations) {
      if (!violationMap.has(v.id)) {
        violationMap.set(v.id, {
          id: v.id,
          impact: v.impact,
          description: v.description,
          help: v.help,
          helpUrl: v.helpUrl,
          occurrences: [],
        });
      }
      violationMap.get(v.id).occurrences.push({
        view: item.view,
        viewport: item.viewport,
        targets: v.targets,
      });
    }
  }

  // Synthesize Backlog
  for (const [id, v] of violationMap.entries()) {
    const isBlocking = v.impact === 'critical';
    runReport.backlog.push({
      id: `A11Y-${id}`,
      severity: isBlocking ? 'blocking' : 'cosmetic',
      description: `${v.help}: ${v.description}`,
      impact: v.impact,
      viewsAffected: Array.from(new Set(v.occurrences.map((o) => o.view))),
      remediation: `Consult WCAG rule at ${v.helpUrl} and resolve targets: ${v.occurrences[0].targets.slice(0, 3).join(', ')}`,
    });
  }

  runReport.receipts = {
    resultsJson: path.join(RECEIPTS_DIR, 'journey-results.json'),
    a11yReportJson: path.join(RECEIPTS_DIR, 'a11y-report.json'),
    backlogJson: path.join(RECEIPTS_DIR, 'backlog.json'),
    screenshotsDir: SCREENSHOTS_DIR,
    outputDir: OUTPUT_ROOT,
    tempDir: TEMP_DIR,
  };
  const acceptance = assessRun(runReport);

  fs.writeFileSync(
    runReport.receipts.resultsJson,
    JSON.stringify(runReport, null, 2),
  );
  fs.writeFileSync(
    runReport.receipts.a11yReportJson,
    JSON.stringify(Array.from(violationMap.values()), null, 2),
  );
  fs.writeFileSync(
    runReport.receipts.backlogJson,
    JSON.stringify(runReport.backlog, null, 2),
  );

  console.log(`\nReceipts saved to ${RECEIPTS_DIR}`);
  console.log(`Screenshots saved to ${SCREENSHOTS_DIR}`);
  console.log(
    acceptance.passed
      ? 'Journey acceptance: PASS'
      : `Journey acceptance: FAIL (${acceptance.failures.length} unmet requirement(s))`,
  );
  if (!acceptance.passed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Unhandled script error:', e);
  process.exitCode = 1;
});
