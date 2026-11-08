import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  APPROVED_BROWSER_EVIDENCE_FILES,
  CANDIDATE_INVITATION_MASK_SELECTOR,
  assertBrowserEvidenceDirectory,
  assertNoSensitiveScreenshotContent,
  prepareBrowserEvidenceDirectory,
} from './browser-evidence-privacy.mjs';

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [process.env.R23_PLAYWRIGHT_MODULE, 'playwright'].filter(
    Boolean,
  );
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next configured module path.
    }
  }
  throw new Error('Unable to resolve Playwright module');
}

async function waitUntil(predicate, description, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function signInAndSelectOrganization(page, appUrl, user, organizationId) {
  await page.goto(`${appUrl}/r23/login`);
  await page.waitForLoadState('domcontentloaded');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/r23/organizations');

  const organization = organizationId.toLowerCase();
  const selectForm = page.locator('form').filter({
    has: page.locator(`input[value="${organization}"]`),
  });
  await selectForm.locator('button[type="submit"]').click();
  await page.waitForURL(`**/r23/organizations/${organization}`);
}

function candidatePathAtAppOrigin(candidateUrl, appUrl) {
  const original = new URL(candidateUrl);
  return new URL(
    `${original.pathname}${original.search}${original.hash}`,
    appUrl,
  ).toString();
}

async function gotoCandidateInvitation(page, candidateUrl) {
  try {
    await page.goto(candidateUrl);
  } catch {
    // The fragment is a bearer credential; keep it out of Playwright error logs.
    throw new Error('Candidate invitation navigation failed');
  }
}

async function saveBrowserEvidence(
  page,
  browserEvidenceDir,
  filename,
  options = {},
) {
  if (!APPROVED_BROWSER_EVIDENCE_FILES.includes(filename)) {
    throw new Error(
      'Browser evidence name is not in the approved eight-image set.',
    );
  }
  const {
    maskSelectors = [],
    protectedValues = [],
    maskableValues = [],
    ...screenshotOptions
  } = options;
  const masks = [];
  for (const selector of maskSelectors) {
    const locator = page.locator(selector);
    if ((await locator.count()) === 0) {
      throw new Error(
        'A required screenshot mask did not match a rendered field.',
      );
    }
    masks.push(locator);
  }
  const surface = await page.evaluate((selectors) => {
    const isRendered = (element) => {
      if (element instanceof HTMLInputElement && element.type === 'hidden') {
        return false;
      }
      if (element.getClientRects().length === 0) return false;
      for (let current = element; current; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if (
          current.hidden ||
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number(style.opacity) === 0
        ) {
          return false;
        }
        if (current === document.body) break;
      }
      return true;
    };
    const coveredBy = (element) =>
      selectors.find(
        (selector) => element.matches(selector) || element.closest(selector),
      ) ?? null;
    const fields = Array.from(
      document.querySelectorAll('input, textarea, [contenteditable="true"]'),
    )
      .filter(isRendered)
      .map((element) => ({
        value:
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
            ? element.value
            : (element.innerText ?? element.textContent ?? ''),
        maskSelector: coveredBy(element),
      }));
    const urls = Array.from(document.querySelectorAll('a[href], area[href]'))
      .filter(isRendered)
      .map((element) => ({
        value: element.href,
        maskSelector: coveredBy(element),
      }));
    return { text: document.body?.innerText ?? '', fields, urls };
  }, maskSelectors);
  const cookies = await page.context().cookies();
  const pageUrl = new URL(page.url());
  pageUrl.hash = '';
  surface.urls.push({ value: pageUrl.toString(), maskSelector: null });
  assertNoSensitiveScreenshotContent(surface, {
    protectedValues: [
      ...protectedValues,
      ...cookies.map((cookie) => cookie.value),
    ],
    maskableValues,
    maskSelectors,
  });

  await page.screenshot({
    path: join(browserEvidenceDir, filename),
    type: 'png',
    fullPage: false,
    animations: 'disabled',
    ...screenshotOptions,
    ...(masks.length > 0 ? { mask: masks } : {}),
  });
}

async function assertNoHorizontalOverflow(page, surface) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
    ),
  }));
  assert.ok(
    dimensions.document <= dimensions.viewport + 1,
    `${surface} has horizontal overflow at ${dimensions.viewport}px: ${dimensions.document}px`,
  );
}

/**
 * Durable candidate and assigned-reviewer browser acceptance. The existing
 * staging harness owns provisioning and invokes this suite for its issued
 * session; this module does not provision users or touch the database.
 */
export async function checkCandidateReviewBrowserAcceptance({
  appUrl: initialAppUrl,
  browserEvidenceDir,
  users,
  screenshotSensitiveValues = [],
  organizationId,
  sessionId,
  stopApp,
  startApp,
  source,
  authUrl,
}) {
  assert.match(sessionId, /^sess_[A-Za-z0-9_-]{1,128}$/);
  assert.ok(
    users?.[0]?.email && users[0]?.password,
    'Recruiter credentials are required',
  );
  assert.ok(
    users?.[1]?.email && users[1]?.password,
    'Assigned reviewer credentials are required',
  );
  assert.equal(typeof stopApp, 'function', 'App stop callback is required');
  assert.equal(typeof startApp, 'function', 'App start callback is required');
  assert.equal(
    typeof browserEvidenceDir,
    'string',
    'A private browser evidence directory is required',
  );
  if (
    !Array.isArray(screenshotSensitiveValues) ||
    screenshotSensitiveValues.length === 0 ||
    screenshotSensitiveValues.some(
      (value) => typeof value !== 'string' || value.length === 0,
    )
  ) {
    throw new Error(
      'Synthetic infrastructure secrets are required for screenshot privacy checks.',
    );
  }
  await prepareBrowserEvidenceDirectory(browserEvidenceDir);

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.R23_CHROMIUM_PATH
      ? { executablePath: process.env.R23_CHROMIUM_PATH }
      : {}),
  });

  let appUrl = initialAppUrl;
  let heldSaveResponseRelease = null;
  let heldRevokeResponseRelease = null;
  let recruiterContext = null;
  let candidateContext = null;
  let reviewerContext = null;

  try {
    recruiterContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
      timezoneId: 'Africa/Cairo',
    });
    const recruiterPage = await recruiterContext.newPage();
    let issuancePostCount = 0;
    recruiterPage.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          `/r23/api/organizations/${organizationId.toLowerCase()}/sessions`
      ) {
        issuancePostCount += 1;
      }
    });

    await signInAndSelectOrganization(
      recruiterPage,
      appUrl,
      users[0],
      organizationId,
    );

    const builderPath = `/r23/organizations/${organizationId.toLowerCase()}/builder`;
    const staleReference = `sess_stale_${randomUUID()}`;
    await recruiterPage.goto(
      `${appUrl}${builderPath}?issuedSession=${encodeURIComponent(staleReference)}`,
    );
    await recruiterPage
      .getByTestId('recovered-candidate-invitation-panel')
      .waitFor();
    await recruiterPage.getByTestId('recovered-session-error').waitFor();
    assert.equal(
      await recruiterPage.getByTestId('issuance-success').count(),
      0,
      'A stale reference must not fabricate an issuance receipt',
    );
    assert.equal(
      issuancePostCount,
      0,
      'Opening a stale reference must not issue a new session',
    );

    const recoveredUrl = `${appUrl}${builderPath}?issuedSession=${encodeURIComponent(sessionId)}`;
    await recruiterPage.goto(recoveredUrl);
    await recruiterPage
      .getByTestId('recovered-session-id')
      .waitFor({ timeout: 20_000 });
    assert.equal(
      (
        await recruiterPage.getByTestId('recovered-session-id').textContent()
      ).trim(),
      sessionId,
    );
    assert.equal(
      await recruiterPage.getByTestId('issuance-success').count(),
      0,
      'Recovered context must not fabricate an issuance receipt',
    );

    await recruiterPage.reload();
    await recruiterPage
      .getByTestId('recovered-session-id')
      .waitFor({ timeout: 20_000 });
    assert.equal(
      issuancePostCount,
      0,
      'Reloading a recovered session must not issue another session',
    );

    await recruiterPage
      .getByTestId('candidate-invitation-create')
      .waitFor({ timeout: 20_000 });
    const expiryInput = recruiterPage.getByTestId(
      'candidate-invitation-expires-at',
    );
    const intendedExpiry = await expiryInput.evaluate((input) =>
      new Date(input.value).toISOString(),
    );
    const intendedLifetimeMs = Date.parse(intendedExpiry) - Date.now();
    assert.ok(
      intendedLifetimeMs > 6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000,
      'The default invitation expiry should be approximately seven days ahead',
    );
    assert.ok(
      intendedLifetimeMs <= 7 * 24 * 60 * 60 * 1000,
      'The default invitation expiry should not exceed seven days',
    );
    await recruiterPage.getByTestId('candidate-invitation-create').click();
    await recruiterPage
      .getByTestId('candidate-invitation-link')
      .waitFor({ timeout: 20_000 });
    const candidateUrl = await recruiterPage
      .getByTestId('candidate-invitation-link')
      .inputValue();
    let candidateLinkIsSafe = false;
    try {
      const parsedCandidateUrl = new URL(candidateUrl);
      candidateLinkIsSafe =
        parsedCandidateUrl.origin === new URL(appUrl).origin &&
        parsedCandidateUrl.pathname === `/r26/candidate/${sessionId}` &&
        parsedCandidateUrl.hash.length > 1;
    } catch {
      // Do not include the candidate bearer URL in assertion diagnostics.
    }
    assert.ok(
      candidateLinkIsSafe,
      'The active candidate link must be same-origin and target this session; token details are kept out of test output',
    );
    const candidateUrlHash = new URL(candidateUrl).hash.slice(1);
    let decodedCandidateBearer = candidateUrlHash;
    try {
      decodedCandidateBearer = decodeURIComponent(candidateUrlHash);
    } catch {
      // Keep the raw fragment for matching without exposing it in diagnostics.
    }
    const candidateMaskableValues = [
      candidateUrl,
      candidateUrlHash,
      decodedCandidateBearer,
    ].filter(
      (value, index, values) => value && values.indexOf(value) === index,
    );
    const screenshotProtectedValues = [
      ...screenshotSensitiveValues,
      ...users.map((user) => user?.password).filter(Boolean),
    ];
    assert.equal(
      await recruiterPage
        .locator('[data-testid="recovered-candidate-invitation-panel"] time')
        .getAttribute('datetime'),
      intendedExpiry,
      'Africa/Cairo datetime-local input must round-trip to the intended expiry instant',
    );
    assert.match(
      await recruiterPage
        .getByTestId('recovered-candidate-invitation-panel')
        .innerText(),
      /No email was sent/i,
    );
    await recruiterPage.setViewportSize({ width: 390, height: 844 });
    const recruiterInvitationPanel = recruiterPage.getByTestId(
      'recovered-candidate-invitation-panel',
    );
    await recruiterInvitationPanel.scrollIntoViewIfNeeded();
    await assertNoHorizontalOverflow(
      recruiterPage,
      'Recruiter invitation view',
    );
    await saveBrowserEvidence(
      recruiterPage,
      browserEvidenceDir,
      '01-recruiter-invitation.png',
      {
        protectedValues: screenshotProtectedValues,
        maskableValues: candidateMaskableValues,
        maskSelectors: [CANDIDATE_INVITATION_MASK_SELECTOR],
        maskColor: '#111827',
      },
    );
    await recruiterPage.setViewportSize({ width: 1280, height: 900 });

    candidateContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    let forbiddenCapabilityRequests = [];
    let candidatePage = await candidateContext.newPage();
    candidatePage.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (
        pathname === `/r26/api/candidate/${sessionId}/ai` ||
        pathname === `/r26/api/candidate/${sessionId}/execution`
      ) {
        forbiddenCapabilityRequests.push(pathname);
      }
    });
    await gotoCandidateInvitation(candidatePage, candidateUrl);
    const notice = candidatePage.getByTestId('candidate-data-use-notice');
    await notice.waitFor({ timeout: 20_000 });
    const noticeText = await notice.innerText();
    assert.match(
      noticeText,
      /records saved code, revisions, task activity and submission/i,
    );
    assert.match(
      noticeText,
      /do not enter secrets or real candidate information/i,
    );
    assert.equal(
      await candidatePage
        .getByRole('button', { name: 'Activate assessment' })
        .isDisabled(),
      true,
      'Activation must require affirmative consent',
    );
    assert.equal(
      await candidatePage
        .locator('[data-testid="candidate-execution-panel"]')
        .count(),
      0,
      'Execution UI stays unavailable when the server disables execution',
    );
    assert.ok(
      (await candidatePage
        .locator('[data-testid="ai-disabled-notice"]')
        .count()) > 0,
      'The AI-disabled state must be explicit',
    );
    await notice.scrollIntoViewIfNeeded();
    await saveBrowserEvidence(
      candidatePage,
      browserEvidenceDir,
      '02-candidate-prestart.png',
      {
        protectedValues: screenshotProtectedValues,
        maskableValues: candidateMaskableValues,
      },
    );
    await assertNoHorizontalOverflow(candidatePage, 'Candidate prestart view');

    await candidatePage.reload();
    await candidatePage.getByTestId('candidate-data-use-notice').waitFor();
    assert.equal(
      await candidatePage
        .getByRole('button', { name: 'Activate assessment' })
        .isDisabled(),
      true,
      'Consent must remain unchecked after reload until the candidate confirms it',
    );
    const consentCheckbox = candidatePage
      .getByTestId('candidate-data-use-notice')
      .locator('input[type="checkbox"]');
    await consentCheckbox.focus();
    await candidatePage.keyboard.press('Space');
    assert.equal(
      await consentCheckbox.isChecked(),
      true,
      'Candidate consent must be operable from the keyboard',
    );
    const activateButton = candidatePage.getByRole('button', {
      name: 'Activate assessment',
    });
    await activateButton.focus();
    await Promise.all([
      candidatePage.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/r26/api/candidate/${sessionId}` &&
          response.request().method() === 'POST' &&
          response.ok(),
      ),
      candidatePage.keyboard.press('Enter'),
    ]);
    await candidatePage
      .getByText('Assessment activated. Your time has started.')
      .waitFor();

    const editor = candidatePage.locator('.cm-content[aria-label="Edit file"]');
    await editor.waitFor({ timeout: 20_000 });
    const initialText = `${randomUUID()}\n# first durable save`;
    const laterText = `${initialText}\n# edit typed while the save was in flight`;
    const saveInputs = [];
    let firstSaveStatus = null;
    let firstSaveOk = false;
    let firstSaveCommittedFlag = false;
    let resolveCommittedSave;
    let rejectCommittedSave;
    let releaseFirstResponse;
    const firstSaveCommitted = new Promise((resolve, reject) => {
      resolveCommittedSave = resolve;
      rejectCommittedSave = reject;
    });
    const firstResponseHeld = new Promise((resolve) => {
      releaseFirstResponse = resolve;
    });
    heldSaveResponseRelease = releaseFirstResponse;

    await candidatePage.route(
      `**/r26/api/candidate/${sessionId}`,
      async (route) => {
        const request = route.request();
        const body =
          request.method() === 'POST'
            ? JSON.parse(request.postData() ?? '{}')
            : null;
        if (body?.action !== 'save') {
          await route.continue();
          return;
        }

        saveInputs.push(body.input);
        if (saveInputs.length === 1) {
          try {
            const response = await route.fetch();
            firstSaveStatus = response.status();
            firstSaveOk = response.ok();
            firstSaveCommittedFlag = true;
            resolveCommittedSave();
            await firstResponseHeld;
            await route.abort('failed');
          } catch (error) {
            firstSaveCommittedFlag = true;
            rejectCommittedSave(error);
            await route.abort('failed').catch(() => {});
          }
          return;
        }

        await route.continue();
      },
    );

    try {
      await editor.fill(initialText);
      await waitUntil(
        () => firstSaveCommittedFlag,
        'the first candidate save to commit',
      );
      await firstSaveCommitted;
      assert.equal(
        firstSaveOk,
        true,
        'The first save must commit before its response is dropped',
      );
      assert.ok(firstSaveStatus >= 200 && firstSaveStatus < 300);
      await editor.fill(laterText);
      assert.equal(
        await editor.getAttribute('aria-readonly'),
        'false',
        'The editor must remain available while a save is in flight',
      );
      releaseFirstResponse();

      await candidatePage
        .getByText(/Save outcome is unknown/i)
        .waitFor({ timeout: 20_000 });
      assert.ok(
        (await editor.evaluate((element) => element.innerText)).includes(
          'edit typed while the save was in flight',
        ),
        'Typing after the in-flight save must remain visible after its response is lost',
      );
      const submitButton = candidatePage.getByRole('button', {
        name: 'Submit assessment',
      });
      assert.equal(
        await submitButton.isDisabled(),
        true,
        'Submit must pause until the unknown save is confirmed',
      );

      await candidatePage.getByRole('button', { name: 'Retry save' }).click();
      await waitUntil(
        () => saveInputs.length >= 3,
        'the same save retry and the later autosave',
      );
      await candidatePage
        .getByText('All changes saved')
        .waitFor({ timeout: 20_000 });
      assert.deepEqual(
        saveInputs[1],
        saveInputs[0],
        'Retry after a lost response must replay the exact request ID and payload',
      );
      assert.equal(saveInputs[2].content, laterText);
      assert.notEqual(
        saveInputs[2].requestId,
        saveInputs[0].requestId,
        'The newer edit must use a new save request after the replay is confirmed',
      );
      assert.notEqual(
        saveInputs[2].expectedVersion,
        saveInputs[0].expectedVersion,
        'The newer edit must save against the confirmed version',
      );
      assert.ok(
        (await editor.evaluate((element) => element.innerText)).includes(
          'edit typed while the save was in flight',
        ),
        'The confirmed first save must not overwrite the newer editor text',
      );
      const screenshotViewports = [
        { name: 'desktop', width: 1440, height: 1000 },
        { name: 'tablet', width: 820, height: 1180 },
        { name: 'mobile', width: 390, height: 844 },
      ];
      for (const [index, viewport] of screenshotViewports.entries()) {
        await candidatePage.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });
        await editor.scrollIntoViewIfNeeded();
        await assertNoHorizontalOverflow(
          candidatePage,
          `Candidate saved workspace (${viewport.name})`,
        );
        await saveBrowserEvidence(
          candidatePage,
          browserEvidenceDir,
          `0${index + 3}-candidate-saved-${viewport.name}.png`,
          {
            protectedValues: screenshotProtectedValues,
            maskableValues: candidateMaskableValues,
          },
        );
      }
      await candidatePage.setViewportSize({ width: 1280, height: 900 });
    } finally {
      releaseFirstResponse();
      heldSaveResponseRelease = null;
      await candidatePage.unrouteAll({ behavior: 'wait' });
    }

    const executionGatePage = await candidateContext.newPage();
    let executionPostCount = 0;
    executionGatePage.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname ===
          `/r26/api/candidate/${sessionId}/execution`
      ) {
        executionPostCount += 1;
      }
    });
    await executionGatePage.route(
      `**/r26/api/candidate/${sessionId}`,
      async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        const body = await response.json();
        body.capabilities.execution = true;
        await route.fulfill({ response, body: JSON.stringify(body) });
      },
    );
    await executionGatePage.route(
      `**/r26/api/candidate/${sessionId}/execution`,
      async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{}',
          });
          return;
        }
        await route.continue();
      },
    );
    await gotoCandidateInvitation(executionGatePage, candidateUrl);
    const runChecksButton = executionGatePage.getByTestId('run-checks-button');
    await executionGatePage
      .getByText('Run availability could not be confirmed')
      .waitFor({ timeout: 20_000 });
    assert.equal(
      await executionGatePage.getByTestId('execution-panel-budget').innerText(),
      'Run availability could not be confirmed',
      'A missing execution view must not display an invented run budget',
    );
    assert.equal(
      await runChecksButton.isDisabled(),
      true,
      'Execution must stay disabled until terminal availability and budget are confirmed',
    );
    await runChecksButton.evaluate((button) =>
      button.removeAttribute('disabled'),
    );
    await runChecksButton.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      executionPostCount,
      0,
      'The execution handler must also reject runs without a confirmed budget',
    );
    await executionGatePage.unrouteAll({ behavior: 'wait' });
    await executionGatePage.close();

    const submitInputs = [];
    let firstSubmitStatus = null;
    let firstSubmitFinished = false;
    let firstSubmitError = null;
    await candidatePage.route(
      `**/r26/api/candidate/${sessionId}`,
      async (route) => {
        const request = route.request();
        const body =
          request.method() === 'POST'
            ? JSON.parse(request.postData() ?? '{}')
            : null;
        if (body?.action !== 'submit') {
          await route.continue();
          return;
        }

        submitInputs.push(body.input);
        if (submitInputs.length === 1) {
          try {
            const response = await route.fetch();
            firstSubmitStatus = response.status();
            await route.abort('failed');
          } catch (error) {
            try {
              await route.abort('failed');
              firstSubmitError = error;
            } catch (abortError) {
              firstSubmitError = new AggregateError(
                [error, abortError],
                'Candidate submit interception and request abort both failed',
              );
            }
          } finally {
            firstSubmitFinished = true;
          }
          return;
        }
        await route.continue();
      },
    );
    await candidatePage
      .getByRole('button', { name: 'Submit assessment' })
      .click();
    await waitUntil(
      () => firstSubmitFinished,
      'the first submission response to be dropped',
    );
    if (firstSubmitError) throw firstSubmitError;
    assert.ok(
      firstSubmitStatus >= 200 && firstSubmitStatus < 300,
      'The first submission must commit before its response is dropped',
    );
    await candidatePage
      .getByTestId('candidate-submit-uncertain')
      .filter({ hasText: 'The submission outcome is unknown.' })
      .waitFor();
    const candidateEditor = candidatePage.locator(
      '.cm-content[aria-label="Edit file"]',
    );
    assert.equal(
      await candidateEditor.getAttribute('aria-readonly'),
      'true',
      'Editing must pause after a submission response is lost',
    );
    assert.equal(
      await candidatePage
        .getByRole('combobox', { name: 'Workspace file' })
        .isDisabled(),
      true,
      'File switching must pause while submission status is unknown',
    );
    await candidatePage
      .getByRole('button', { name: 'Retry submission' })
      .click();
    await candidatePage
      .getByText('Assessment submitted. Your saved work is now read-only.')
      .waitFor({ timeout: 20_000 });
    assert.deepEqual(
      submitInputs[1],
      submitInputs[0],
      'Retry after a lost submit response must reuse the same request ID and frozen digest',
    );
    await candidatePage
      .getByText('Assessment submitted. Your saved work is now read-only.')
      .scrollIntoViewIfNeeded();
    await saveBrowserEvidence(
      candidatePage,
      browserEvidenceDir,
      '06-candidate-submitted.png',
      {
        protectedValues: screenshotProtectedValues,
        maskableValues: candidateMaskableValues,
      },
    );
    await candidatePage.unrouteAll({ behavior: 'wait' });

    assert.deepEqual(
      forbiddenCapabilityRequests,
      [],
      'The candidate browser must not call disabled AI or execution APIs',
    );

    await candidateContext.close();
    candidateContext = null;
    await stopApp();
    appUrl = await startApp(source, authUrl);

    candidateContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    candidatePage = await candidateContext.newPage();
    await gotoCandidateInvitation(
      candidatePage,
      candidatePathAtAppOrigin(candidateUrl, appUrl),
    );
    const resumedEditor = candidatePage.locator(
      '.cm-content[aria-label="Edit file"]',
    );
    await resumedEditor.waitFor({ timeout: 20_000 });
    await waitUntil(
      async () =>
        (await resumedEditor.evaluate((element) => element.innerText)).includes(
          'edit typed while the save was in flight',
        ),
      'submitted candidate work to survive an application restart',
    );
    assert.equal(
      (await resumedEditor.evaluate((element) => element.innerText)).includes(
        'edit typed while the save was in flight',
      ),
      true,
      'The submitted work must remain available after restart',
    );
    assert.equal(
      await resumedEditor.getAttribute('aria-readonly'),
      'true',
      'A confirmed submission must remain read-only after restart',
    );

    await recruiterContext.close();
    recruiterContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
      timezoneId: 'Africa/Cairo',
    });
    const recoveredRecruiterPage = await recruiterContext.newPage();
    await signInAndSelectOrganization(
      recoveredRecruiterPage,
      appUrl,
      users[0],
      organizationId,
    );
    await recoveredRecruiterPage.goto(
      `${appUrl}${builderPath}?issuedSession=${encodeURIComponent(sessionId)}`,
    );
    await recoveredRecruiterPage
      .getByTestId('candidate-invitation-revoke')
      .waitFor({ timeout: 20_000 });

    let releaseRevokeResponse;
    let resolveRevokeCommitted;
    const revokeResponseHeld = new Promise((resolve) => {
      releaseRevokeResponse = resolve;
      heldRevokeResponseRelease = resolve;
    });
    const revokeCommitted = new Promise((resolve) => {
      resolveRevokeCommitted = resolve;
    });
    const invitationEndpoint =
      `**/r23/api/organizations/${organizationId.toLowerCase()}` +
      `/sessions/${sessionId}/candidate-token`;
    await recoveredRecruiterPage.route(invitationEndpoint, async (route) => {
      if (route.request().method() !== 'DELETE') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      assert.equal(
        response.ok(),
        true,
        'Revocation must commit before the stale response is delayed',
      );
      resolveRevokeCommitted();
      await revokeResponseHeld;
      await route.abort('failed');
    });
    await recoveredRecruiterPage
      .getByTestId('candidate-invitation-revoke')
      .click();
    await revokeCommitted;
    const staleAfterRevoke = `sess_stale_${randomUUID()}`;
    await recoveredRecruiterPage.goto(
      `${appUrl}${builderPath}?issuedSession=${encodeURIComponent(staleAfterRevoke)}`,
    );
    await recoveredRecruiterPage
      .getByTestId('recovered-session-error')
      .waitFor({ timeout: 20_000 });
    releaseRevokeResponse();
    heldRevokeResponseRelease = null;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      await recoveredRecruiterPage
        .getByTestId('candidate-invitation-link')
        .count(),
      0,
      'A late response from another session must not expose the old invitation link',
    );
    assert.equal(
      await recoveredRecruiterPage
        .getByText(/Candidate access has been revoked/i)
        .count(),
      0,
      'A late revoke response must not overwrite the current session panel',
    );
    await recoveredRecruiterPage.unrouteAll({ behavior: 'wait' });
    await recoveredRecruiterPage.goto(
      `${appUrl}${builderPath}?issuedSession=${encodeURIComponent(sessionId)}`,
    );
    await recoveredRecruiterPage
      .getByText(/This invitation has been revoked/i)
      .waitFor({ timeout: 20_000 });
    assert.equal(
      await recoveredRecruiterPage
        .getByTestId('candidate-invitation-link')
        .count(),
      0,
      'A revoked link must no longer be offered for copying',
    );

    await candidatePage.reload();
    await candidatePage
      .getByText('This candidate link is not available for this assessment.')
      .waitFor({ timeout: 20_000 });
    assert.equal(
      await candidatePage
        .locator('.cm-content[aria-label="Edit file"]')
        .count(),
      0,
      'Revocation must block further candidate workspace access',
    );

    reviewerContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const reviewerPage = await reviewerContext.newPage();
    await signInAndSelectOrganization(
      reviewerPage,
      appUrl,
      users[1],
      organizationId,
    );
    const evidenceResponse = await reviewerPage.goto(
      `${appUrl}/r27/organizations/${organizationId.toLowerCase()}/sessions/${sessionId}`,
    );
    assert.equal(
      evidenceResponse.status(),
      200,
      'The assigned evaluator must retain access to submitted evidence after candidate revocation',
    );
    await reviewerPage.locator('[data-workbench-mode-tab="evidence"]').click();
    const observationPanel = reviewerPage.locator(
      'section[aria-label="Anchored Observations"]',
    );
    await observationPanel.waitFor({ timeout: 20_000 });
    await reviewerPage.setViewportSize({ width: 390, height: 844 });
    await observationPanel.scrollIntoViewIfNeeded();
    await assertNoHorizontalOverflow(reviewerPage, 'Evaluator evidence view');
    await saveBrowserEvidence(
      reviewerPage,
      browserEvidenceDir,
      '07-evaluator-chronology.png',
      {
        protectedValues: screenshotProtectedValues,
        maskableValues: candidateMaskableValues,
      },
    );
    await reviewerPage.setViewportSize({ width: 1280, height: 900 });
    const observationText = `Observed saved revisions for session ${sessionId.slice(-8)}.`;
    await observationPanel
      .getByRole('textbox', { name: 'Observation note' })
      .fill(observationText);
    await observationPanel
      .getByRole('button', { name: 'Save observation' })
      .click();
    await observationPanel
      .getByText('Observation saved.', { exact: true })
      .waitFor({ timeout: 20_000 });

    await reviewerPage.reload();
    await reviewerPage
      .locator('[data-workbench-mode-tab="review"]')
      .waitFor({ timeout: 20_000 });
    await reviewerPage.locator('[data-workbench-mode-tab="review"]').click();
    const reviewPacket = reviewerPage.getByTestId('evaluator-review-packet');
    await reviewPacket.waitFor({ timeout: 20_000 });
    await waitUntil(
      async () =>
        (await reviewPacket
          .locator('[data-testid="review-packet-writes-unavailable"]')
          .count()) === 0,
      'assigned reviewer packet write access',
    );
    const citedObservation = reviewPacket
      .locator('label')
      .filter({ hasText: observationText })
      .locator('input[type="checkbox"]');
    await citedObservation.waitFor({ timeout: 20_000 });
    await citedObservation.check();
    const reviewSummary = `Observed candidate changes were saved and submitted for this synthetic session. This narrative records the work reviewed and makes no automatic score or verdict.`;
    const reviewSummaryInput = reviewPacket.getByRole('textbox', {
      name: 'Review summary',
    });
    await reviewSummaryInput.waitFor({ timeout: 20_000 });
    await reviewSummaryInput.fill(reviewSummary);
    await reviewPacket
      .getByRole('textbox', { name: 'Strengths' })
      .fill('Saved a later edit after confirming the earlier save.');
    await reviewPacket
      .getByRole('textbox', { name: 'Concerns' })
      .fill('Review the submitted implementation against the task criteria.');
    await reviewPacket
      .getByRole('textbox', { name: 'Unresolved questions' })
      .fill('Which tradeoff motivated the retry interval?');
    await reviewPacket.getByRole('button', { name: 'Save draft' }).click();
    await reviewPacket
      .getByText(/Draft saved at/i)
      .waitFor({ timeout: 20_000 });

    await reviewerPage.reload();
    await reviewerPage.locator('[data-workbench-mode-tab="review"]').click();
    const reloadedReviewPacket = reviewerPage.getByTestId(
      'evaluator-review-packet',
    );
    await reloadedReviewPacket.waitFor({ timeout: 20_000 });
    const reloadedSummaryInput = reloadedReviewPacket.getByRole('textbox', {
      name: 'Review summary',
    });
    await reloadedSummaryInput.waitFor({ timeout: 20_000 });
    await waitUntil(
      async () => (await reloadedSummaryInput.inputValue()) === reviewSummary,
      'human review draft to persist after reload',
    );
    assert.equal(
      await reloadedReviewPacket
        .locator('input[type="checkbox"]:checked')
        .count(),
      1,
      'The evidence citation must persist with the review draft',
    );

    await reloadedReviewPacket
      .getByRole('button', { name: 'Finalize review packet' })
      .click();
    const confirmation = reviewerPage.getByRole('dialog', {
      name: 'Confirm Review Packet Finalization',
    });
    await confirmation.waitFor();
    await confirmation
      .getByRole('button', { name: 'Confirm and finalize' })
      .click();
    await reloadedReviewPacket
      .getByTestId('review-packet-status')
      .getByText('FINALIZED')
      .waitFor({ timeout: 20_000 });
    await reloadedReviewPacket
      .getByTestId('review-packet-finalized-notice')
      .waitFor();
    await reviewerPage.setViewportSize({ width: 390, height: 844 });
    await reloadedReviewPacket.scrollIntoViewIfNeeded();
    await assertNoHorizontalOverflow(
      reviewerPage,
      'Finalized evaluator review',
    );
    await saveBrowserEvidence(
      reviewerPage,
      browserEvidenceDir,
      '08-evaluator-finalized-review.png',
      {
        protectedValues: screenshotProtectedValues,
        maskableValues: candidateMaskableValues,
      },
    );
    assert.match(
      await reloadedReviewPacket
        .getByTestId('review-packet-summary')
        .innerText(),
      /no automatic score or verdict/i,
    );

    await assertBrowserEvidenceDirectory(browserEvidenceDir);
    return { passed: true, sessionId, appUrl };
  } finally {
    heldSaveResponseRelease?.();
    heldRevokeResponseRelease?.();
    try {
      for (const context of [
        recruiterContext,
        candidateContext,
        reviewerContext,
      ]) {
        for (const page of context?.pages() ?? []) {
          await page.unrouteAll({ behavior: 'wait' });
        }
      }
    } finally {
      await Promise.allSettled([
        recruiterContext?.close(),
        candidateContext?.close(),
        reviewerContext?.close(),
      ]);
      await browser.close();
    }
  }
}
