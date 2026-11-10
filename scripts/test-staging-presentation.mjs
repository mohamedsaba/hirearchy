import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

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

function redactDiagnostic(value) {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\b[A-F0-9]{64}\b/gi, '[redacted-secret]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted-token]')
    .slice(0, 2000);
}

function redactPathname(pathname) {
  return pathname
    .replace(/\/sess_[A-Za-z0-9_-]+/g, '/sess_[redacted]')
    .replace(/\/[A-F0-9]{8}-[A-F0-9-]{27,}/gi, '/[redacted-uuid]');
}

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

async function runReservationMovesBrowserFlow(presenter) {
  let stage = 'launch Chromium';
  const browserErrors = [];
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-network-change-notifier',
    ],
  });
  const trackErrors = (page) => {
    page.on('pageerror', (error) =>
      browserErrors.push(redactDiagnostic(error.message)),
    );
    page.on('console', (message) => {
      if (message.type() === 'error') {
        browserErrors.push(redactDiagnostic(message.text()));
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        const pathname = redactPathname(new URL(response.url()).pathname);
        browserErrors.push(
          `${stage}: ${response.request().method()} ${pathname} -> ${response.status()}`,
        );
      }
    });
  };

  try {
    stage = 'recruiter sign-in and organization entry';
    const recruiterContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const recruiter = await recruiterContext.newPage();
    trackErrors(recruiter);
    let response = await recruiter.goto(presenter.recruiter.loginUrl);
    assert.equal(response.status(), 200);
    await recruiter
      .locator('input[name="email"]')
      .fill(presenter.recruiter.email);
    await recruiter
      .locator('input[name="password"]')
      .fill(presenter.recruiter.password);
    await Promise.all([
      recruiter.waitForURL('**/r23/organizations'),
      recruiter.locator('button[type="submit"]').click(),
    ]);

    const organizationForm = recruiter.locator('form').filter({
      has: recruiter.locator(
        `input[value="${presenter.organizationId.toLowerCase()}"]`,
      ),
    });
    await organizationForm.locator('button[type="submit"]').click();
    await recruiter.waitForURL(
      `**/r23/organizations/${presenter.organizationId.toLowerCase()}`,
    );

    stage = 'Reservation Moves v3 authoring and invitation';
    response = await recruiter.goto(presenter.recruiter.builderUrl);
    assert.equal(response.status(), 200);
    await recruiter
      .getByLabel('Assessment template')
      .selectOption('reservation-moves-v3');
    await recruiter
      .locator('[data-testid="save-draft-button"]')
      .waitFor({ state: 'visible' });
    const [draftResponse] = await Promise.all([
      recruiter.waitForResponse(
        (item) =>
          item.url().includes('/assessments/draft') &&
          item.request().method() === 'PUT',
      ),
      recruiter.locator('[data-testid="save-draft-button"]').click(),
    ]);
    assert.equal(draftResponse.status(), 200);

    const [validationResponse] = await Promise.all([
      recruiter.waitForResponse(
        (item) =>
          item.url().includes('/assessments/validate') &&
          item.request().method() === 'POST',
      ),
      recruiter.locator('[data-testid="continue-to-validate-button"]').click(),
    ]);
    assert.equal(validationResponse.status(), 200);
    await recruiter
      .locator('[data-testid="validated-version-display"]')
      .waitFor({ state: 'visible' });
    await recruiter.locator('[data-testid="continue-to-issue-button"]').click();
    await recruiter
      .locator('[data-testid="issue-reviewer-select"]')
      .selectOption(presenter.evaluator.principalId);
    const [issueResponse] = await Promise.all([
      recruiter.waitForResponse(
        (item) =>
          item.url().includes('/sessions') &&
          item.request().method() === 'POST',
      ),
      recruiter.locator('[data-testid="issue-assessment-button"]').click(),
    ]);
    assert.equal(issueResponse.status(), 201);
    await recruiter
      .locator('[data-testid="candidate-invitation-create"]')
      .click();
    const invitation = await recruiter
      .locator('[data-testid="candidate-invitation-link"]')
      .inputValue();
    const candidateUrl = new URL(invitation);
    const sessionId = candidateUrl.pathname.split('/').pop();
    assert.match(candidateUrl.pathname, /^\/r26\/candidate\/sess_/);
    assert.ok(candidateUrl.hash.length > 1);
    await recruiterContext.close();

    stage = 'candidate consent, saved revision, and submission';
    const candidateContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const candidate = await candidateContext.newPage();
    trackErrors(candidate);
    response = await candidate.goto(invitation);
    assert.equal(response.status(), 200);
    await candidate
      .getByRole('button', { name: 'Activate assessment', exact: true })
      .waitFor({ state: 'visible' });
    const consent = candidate.getByRole('checkbox', {
      name: 'I acknowledge and agree to this data-use notice.',
    });
    await consent.check();
    const [activationResponse] = await Promise.all([
      candidate.waitForResponse(
        (item) =>
          item.url().includes(`/r26/api/candidate/${sessionId}`) &&
          item.request().method() === 'POST' &&
          item.request().postDataJSON()?.action === 'activate',
      ),
      candidate
        .getByRole('button', { name: 'Activate assessment', exact: true })
        .click(),
    ]);
    assert.equal(activationResponse.status(), 200);
    const editor = candidate.locator('.cm-content[aria-label="Edit file"]');
    await editor.waitFor({ state: 'visible' });
    await editor.click();
    await candidate.keyboard.press('Control+End');
    await candidate.keyboard.type(
      '\n# Synthetic demo edit recorded for human review; code was not executed.\n',
    );
    const [saveResponse] = await Promise.all([
      candidate.waitForResponse(
        (item) =>
          item.url().includes(`/r26/api/candidate/${sessionId}`) &&
          item.request().method() === 'POST' &&
          item.request().postDataJSON()?.action === 'save',
      ),
      candidate.getByRole('button', { name: 'Save work', exact: true }).click(),
    ]);
    assert.equal(saveResponse.status(), 200);
    await candidate.reload();
    await candidate
      .locator('.cm-content[contenteditable="true"]')
      .waitFor({ state: 'visible' });
    assert.match(
      await candidate.locator('.cm-content').innerText(),
      /Synthetic demo edit/,
    );
    const [submitResponse] = await Promise.all([
      candidate.waitForResponse(
        (item) =>
          item.url().includes(`/r26/api/candidate/${sessionId}`) &&
          item.request().method() === 'POST' &&
          item.request().postDataJSON()?.action === 'submit',
      ),
      candidate
        .getByRole('button', { name: 'Submit assessment', exact: true })
        .click(),
    ]);
    assert.equal(submitResponse.status(), 200);
    await candidate.locator('.r26-readonly-note').waitFor({ state: 'visible' });
    await candidateContext.close();

    stage = 'assigned evaluator evidence and human review';
    const evaluatorContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const evaluator = await evaluatorContext.newPage();
    trackErrors(evaluator);
    await evaluator.goto(presenter.evaluator.loginUrl);
    await evaluator
      .locator('input[name="email"]')
      .fill(presenter.evaluator.email);
    await evaluator
      .locator('input[name="password"]')
      .fill(presenter.evaluator.password);
    await Promise.all([
      evaluator.waitForURL('**/r23/organizations'),
      evaluator.locator('button[type="submit"]').click(),
    ]);
    const evaluatorOrganizationForm = evaluator.locator('form').filter({
      has: evaluator.locator(
        `input[value="${presenter.organizationId.toLowerCase()}"]`,
      ),
    });
    await evaluatorOrganizationForm.locator('button[type="submit"]').click();
    await evaluator.waitForURL(
      `**/r23/organizations/${presenter.organizationId.toLowerCase()}`,
    );
    const reviewUrl = `${presenter.appUrl}/r27/organizations/${presenter.organizationId.toLowerCase()}/sessions/${sessionId}`;
    response = await evaluator.goto(reviewUrl);
    assert.equal(response.status(), 200);
    await evaluator
      .locator('.evaluator-back-link')
      .waitFor({ state: 'visible' });
    const assertNoLegacyEvaluatorLinks = async () => {
      const legacyLinks = await evaluator
        .locator('a[href^="/evaluator"]')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
      assert.deepEqual(
        legacyLinks,
        [],
        'The R27 page must not link to legacy evaluator routes unavailable in staging.',
      );
    };
    await assertNoLegacyEvaluatorLinks();
    const sessionSummaryUrl = `/r23/organizations/${presenter.organizationId.toLowerCase()}/sessions/${sessionId}`;
    assert.equal(
      await evaluator
        .getByRole('link', { name: 'Session summary', exact: true })
        .getAttribute('href'),
      sessionSummaryUrl,
    );
    const [summaryResponse] = await Promise.all([
      evaluator.waitForResponse(
        (item) =>
          new URL(item.url()).pathname === sessionSummaryUrl &&
          item.request().method() === 'GET',
      ),
      evaluator
        .getByRole('link', { name: 'Session summary', exact: true })
        .click(),
    ]);
    assert.equal(summaryResponse.status(), 200);
    await evaluator
      .locator('[data-testid="session-lifecycle-status"]')
      .waitFor({ state: 'visible' });
    assert.equal(
      await evaluator
        .locator('[data-testid="session-lifecycle-status"]')
        .innerText(),
      'Submitted (SUBMITTED)',
    );
    const workbenchLink = evaluator.getByRole('link', {
      name: 'Open submitted evidence and review workbench',
    });
    await workbenchLink.waitFor({ state: 'visible' });
    const [workbenchResponse] = await Promise.all([
      evaluator.waitForResponse(
        (item) =>
          new URL(item.url()).pathname ===
            reviewUrl.replace(presenter.appUrl, '') &&
          item.request().method() === 'GET',
      ),
      workbenchLink.click(),
    ]);
    assert.equal(workbenchResponse.status(), 200);
    await evaluator
      .locator('.evaluator-back-link')
      .waitFor({ state: 'visible' });
    await assertNoLegacyEvaluatorLinks();
    await evaluator.locator('[data-workbench-mode-tab="evidence"]').click();
    const submittedEvent = evaluator.locator(
      'button.evaluator-source-row:has-text("Session submitted")',
    );
    await submittedEvent.waitFor({ state: 'visible' });
    await submittedEvent.click();
    const observations = evaluator.locator(
      'section[aria-label="Anchored Observations"]',
    );
    await observations.waitFor({ state: 'visible' });
    await observations
      .getByRole('textbox', { name: 'Observation note' })
      .fill('Synthetic rehearsal: submission and saved revision are visible.');
    const [observationResponse] = await Promise.all([
      evaluator.waitForResponse(
        (item) =>
          item.url().includes('/observations') &&
          item.request().method() === 'POST',
      ),
      observations.getByRole('button', { name: 'Save observation' }).click(),
    ]);
    assert.equal(observationResponse.status(), 201);

    await evaluator.locator('[data-workbench-mode-tab="review"]').click();
    const reviewPacket = evaluator.locator(
      '[data-testid="evaluator-review-packet"]',
    );
    await reviewPacket.waitFor({ state: 'visible' });
    const citation = reviewPacket
      .locator('label')
      .filter({ hasText: /Event #/ })
      .locator('input[type="checkbox"]')
      .first();
    await citation.check();
    await reviewPacket
      .getByRole('textbox', { name: 'Review summary' })
      .fill(
        'Synthetic demonstration review; evaluator interpretation remains human-owned.',
      );
    const [reviewSaveResponse] = await Promise.all([
      evaluator.waitForResponse(
        (item) =>
          item.url().includes('/review-packet') &&
          item.request().method() === 'PUT',
      ),
      reviewPacket
        .getByRole('button', { name: 'Save draft', exact: true })
        .click(),
    ]);
    assert.equal(reviewSaveResponse.status(), 200);
    await reviewPacket
      .getByRole('button', { name: 'Finalize review packet', exact: true })
      .click();
    const confirm = evaluator.getByRole('dialog', {
      name: 'Confirm Review Packet Finalization',
    });
    await confirm.waitFor({ state: 'visible' });
    const [finalizeResponse] = await Promise.all([
      evaluator.waitForResponse(
        (item) =>
          item.url().includes('/review-packet/finalize') &&
          item.request().method() === 'POST',
      ),
      confirm.getByRole('button', { name: 'Confirm and finalize' }).click(),
    ]);
    assert.equal(finalizeResponse.status(), 200);
    await evaluator
      .locator('[data-testid="review-packet-finalized-notice"]')
      .waitFor({ state: 'visible' });
    assert.deepEqual(browserErrors, []);
    await evaluatorContext.close();
    console.log(
      'Reservation Moves v3 recruiter, candidate, evidence, and human-review browser flow passed.',
    );
  } catch (error) {
    const cause = error instanceof Error ? error : new Error('Unknown error');
    throw new Error(`Browser flow failed during ${stage}`, { cause });
  } finally {
    await browser.close();
  }
}

let ready;
let stage = 'waiting for private presenter readiness';
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

  stage = 'Founder UAT CSS delivery regression';
  const cssResult = spawnSync(
    process.execPath,
    ['tests/browser/founder-uat-css-delivery.mjs'],
    {
      cwd: root,
      env: {
        ...process.env,
        FOUNDER_UAT_CSS_ORIGIN: presenter.appUrl,
        FOUNDER_UAT_CSS_PROFILE: 'staging-authenticated',
      },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  const cssOutput = `${cssResult.stdout ?? ''}${cssResult.stderr ?? ''}`;
  assert.equal(
    cssResult.status,
    0,
    `Founder UAT CSS delivery regression failed: ${redactDiagnostic(cssOutput || cssResult.error?.code || 'no diagnostic')}`,
  );
  console.log(cssResult.stdout.trim());

  stage = 'Reservation Moves v3 browser flow';
  await runReservationMovesBrowserFlow(presenter);

  stage = 'SIGTERM cleanup';
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
  let diagnosticPath;
  if (ready) {
    diagnosticPath = path.join(
      path.dirname(ready.presenterFile),
      'presentation-smoke-failure.txt',
    );
    const cause = error?.cause instanceof Error ? error.cause : error;
    const detail = {
      stage: redactDiagnostic(error?.message ?? stage),
      causeName: cause?.name ?? 'UnknownError',
      causeMessage: redactDiagnostic(cause?.message ?? 'No error message'),
    };
    await writeFile(diagnosticPath, JSON.stringify(detail, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(diagnosticPath, 0o600);
  }
  if (child.exitCode === null) {
    if (ready) {
      child.kill('SIGTERM');
      await Promise.race([exited, delay(90_000)]);
    } else {
      child.stdin.end('\n');
      await Promise.race([exited, delay(90_000)]);
    }
  }
  console.error(
    `Presentation shutdown smoke failed during ${stage}${diagnosticPath ? `; private diagnostic: ${diagnosticPath}` : ''}.`,
  );
  process.exitCode = 1;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
