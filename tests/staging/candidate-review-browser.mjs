import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

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

/**
 * Durable candidate and assigned-reviewer browser acceptance. The existing
 * staging harness owns provisioning and invokes this suite for its issued
 * session; this module does not provision users or touch the database.
 */
export async function checkCandidateReviewBrowserAcceptance({
  appUrl: initialAppUrl,
  users,
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

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.R23_CHROMIUM_PATH
      ? { executablePath: process.env.R23_CHROMIUM_PATH }
      : {}),
  });

  let appUrl = initialAppUrl;
  let heldSaveResponseRelease = null;
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
    assert.equal(
      new URL(candidateUrl).origin,
      new URL(appUrl).origin,
      'Only an active same-origin candidate link may be shown',
    );
    assert.match(candidateUrl, new RegExp(`/r26/candidate/${sessionId}#`));
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
    await candidatePage.goto(candidateUrl);
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

    await candidatePage.reload();
    await candidatePage.getByTestId('candidate-data-use-notice').waitFor();
    assert.equal(
      await candidatePage
        .getByRole('button', { name: 'Activate assessment' })
        .isDisabled(),
      true,
      'Consent must remain unchecked after reload until the candidate confirms it',
    );
    await candidatePage
      .getByTestId('candidate-data-use-notice')
      .locator('input[type="checkbox"]')
      .check();
    await Promise.all([
      candidatePage.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/r26/api/candidate/${sessionId}` &&
          response.request().method() === 'POST' &&
          response.ok(),
      ),
      candidatePage
        .getByRole('button', { name: 'Activate assessment' })
        .click(),
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
    } finally {
      releaseFirstResponse();
      heldSaveResponseRelease = null;
      await candidatePage.unroute(`**/r26/api/candidate/${sessionId}`);
    }

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
    await candidatePage.goto(candidatePathAtAppOrigin(candidateUrl, appUrl));
    const resumedEditor = candidatePage.locator(
      '.cm-content[aria-label="Edit file"]',
    );
    await resumedEditor.waitFor({ timeout: 20_000 });
    await waitUntil(
      async () =>
        (await resumedEditor.evaluate((element) => element.innerText)).includes(
          'edit typed while the save was in flight',
        ),
      'candidate work to survive an application restart',
    );
    assert.equal(
      (await resumedEditor.evaluate((element) => element.innerText)).includes(
        'edit typed while the save was in flight',
      ),
      true,
      'The confirmed latest edit must resume after restart',
    );

    await Promise.all([
      candidatePage.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/r26/api/candidate/${sessionId}` &&
          response.request().method() === 'POST' &&
          response.ok(),
      ),
      candidatePage.getByRole('button', { name: 'Submit assessment' }).click(),
    ]);
    await candidatePage
      .getByText('Assessment submitted. Your saved work is now read-only.')
      .waitFor();

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
    await recoveredRecruiterPage
      .getByTestId('candidate-invitation-revoke')
      .click();
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
    assert.match(
      await reloadedReviewPacket
        .getByTestId('review-packet-summary')
        .innerText(),
      /no automatic score or verdict/i,
    );

    return { passed: true, sessionId };
  } finally {
    heldSaveResponseRelease?.();
    await Promise.allSettled([
      recruiterContext?.close(),
      candidateContext?.close(),
      reviewerContext?.close(),
    ]);
    await browser.close();
  }
}
