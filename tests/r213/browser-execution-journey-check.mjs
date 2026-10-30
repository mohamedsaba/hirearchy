import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { FIXTURE_IDS } from '../../database/postgres/r23/adapter.mjs';
import { loadPlaywright } from '../r25/browser-issuance-check.mjs';

const csrfCookieName = '__Host-r23-csrf';

export async function runR213BrowserExecutionJourneyChecks({
  origin,
  request,
  signInAndSelectOrg,
  users,
  admin,
  connection,
  runtimePassword,
  candidateTokenKey,
  start,
  stop,
  evidence,
}) {
  void connection;
  void runtimePassword;
  void candidateTokenKey;

  const http = [];
  const pageErrors = [];
  const consoleErrors = [];

  // Step 1: Sign in recruiter and reviewer
  console.log('[R2.13 Browser] Step 1: Sign in recruiter and reviewer');
  const recruiter = await signInAndSelectOrg(origin, users.a, FIXTURE_IDS.orgA);
  const reviewer = await signInAndSelectOrg(origin, users.ab, FIXTURE_IDS.orgA);

  // Step 2: Recruiter creates execution-enabled draft, validates, and issues it
  console.log(
    '[R2.13 Browser] Step 2: Create execution-enabled draft and validate',
  );
  const draftResponse = await request(
    origin,
    `/r23/api/organizations/${FIXTURE_IDS.orgA}/assessments/draft`,
    {
      method: 'PUT',
      cookies: recruiter,
      headers: {
        Origin: origin,
        'x-csrf-token': recruiter[csrfCookieName],
      },
      body: {
        csrf: recruiter[csrfCookieName],
        title: 'Booking Notification Retry Execution',
        brief:
          'Implement robust retry logic for customer booking notifications with exponential backoff and jitter.',
        expectedBehavior: [
          'Retries transient network failures up to configured limit',
          'Applies exponential backoff with jitter',
          'Fails permanently when maximum retry attempts are exhausted',
        ],
        acceptanceCriteria: [
          'All network transient errors trigger backoff retry',
          'Notification delivery failure is logged with error metadata',
        ],
        primaryFilePath: 'booking.py',
        starterFiles: [
          {
            path: 'booking.py',
            content:
              '# Booking Notification Service\n\ndef send_notification(booking_id):\n    pass\n',
          },
        ],
        durationMinutes: 30,
        terminalEnabled: true,
        integratedAi: false,
        rubric: [
          {
            id: 'correctness',
            label: 'Retry Implementation Correctness',
            description: 'Evaluates retry logic handling of network exceptions',
            weight: 100,
            applicability: { kind: 'always', rule: 'Evaluates retry logic' },
          },
        ],
      },
    },
  );
  assert.equal(draftResponse.status, 200, draftResponse.text);
  const { draft } = JSON.parse(draftResponse.text);

  const validateResponse = await request(
    origin,
    `/r23/api/organizations/${FIXTURE_IDS.orgA}/assessments/validate`,
    {
      method: 'POST',
      cookies: recruiter,
      headers: {
        Origin: origin,
        'x-csrf-token': recruiter[csrfCookieName],
      },
      body: {
        csrf: recruiter[csrfCookieName],
        definitionId: draft.definitionId,
        expectedDraftVersion: draft.version,
      },
    },
  );
  assert.equal(validateResponse.status, 200, validateResponse.text);
  const { version: validatedVersion } = JSON.parse(validateResponse.text);
  assert.equal(validatedVersion.terminalEnabled, true);

  // Issue the immutable validated version
  const issuedResponse = await request(
    origin,
    `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
    {
      method: 'POST',
      cookies: recruiter,
      headers: {
        Origin: origin,
        'x-csrf-token': recruiter[csrfCookieName],
      },
      body: {
        csrf: recruiter[csrfCookieName],
        idempotencyKey: `r213-browser-${randomUUID()}`,
        validatedVersionId: validatedVersion.id,
        durationMinutes: 30,
      },
    },
  );
  http.push({ operation: 'issue', status: issuedResponse.status });
  assert.equal(issuedResponse.status, 201, issuedResponse.text);
  const issued = JSON.parse(issuedResponse.text);

  // Step 3: Recover candidate token
  console.log('[R2.13 Browser] Step 3: Recover candidate token link');
  const recoveredResponse = await request(
    origin,
    `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/candidate-token`,
    { cookies: recruiter },
  );
  http.push({
    operation: 'recover_candidate_link',
    status: recoveredResponse.status,
  });
  assert.equal(recoveredResponse.status, 200, recoveredResponse.text);
  const recovered = JSON.parse(recoveredResponse.text);
  assert.equal(
    recovered.candidatePath,
    `/r26/candidate/${issued.sessionId}#${recovered.candidateToken}`,
  );

  const candidatePath = `/r26/api/candidate/${issued.sessionId}`;
  const candidateExecutionPath = `/r26/api/candidate/${issued.sessionId}/execution`;

  const candidateCall = async (action = 'read', input, overrides = {}) => {
    const response = await request(origin, candidatePath, {
      method: action === 'read' ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${recovered.candidateToken}`,
        ...(action === 'read' ? {} : { Origin: origin }),
      },
      ...(action === 'read' ? {} : { body: { action, input } }),
      ...overrides,
    });
    return response;
  };

  const candidateExecutionCall = async (method = 'GET', body = null) => {
    const response = await request(origin, candidateExecutionPath, {
      method,
      headers: {
        Authorization: `Bearer ${recovered.candidateToken}`,
        ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
    });
    return response;
  };

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.R23_CHROMIUM_PATH
      ? { executablePath: process.env.R23_CHROMIUM_PATH }
      : {}),
  });

  const candidateContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });
  const reviewerContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });

  const candidatePage = await candidateContext.newPage();
  const reviewerPage = await reviewerContext.newPage();

  const observe = (page) => {
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
  };
  observe(candidatePage);
  observe(reviewerPage);

  const screenshot = (page, name) => {
    if (evidence) {
      return page.screenshot({
        path: join(evidence, `r213-${name}.png`),
        fullPage: true,
      });
    }
    return Promise.resolve();
  };

  let assignmentId;

  try {
    // -----------------------------------------------------------------------
    // Step 4: Candidate opens workspace before activation
    // -----------------------------------------------------------------------
    console.log('[R2.13 Browser] Step 4: Candidate navigates to assessment');
    await candidatePage.goto(origin + recovered.candidatePath);
    await candidatePage.waitForLoadState('networkidle');

    // Verify Terminal / Checks capability status
    const terminalCapStatus = candidatePage.locator(
      '[data-testid="terminal-capability-status"]',
    );
    await candidatePage
      .locator('[data-testid="terminal-capability-status"]')
      .filter({ hasText: /Available \(Synthetic Test Lane\)/i })
      .waitFor();
    const capText = await terminalCapStatus.innerText();
    assert.match(capText, /Available \(Synthetic Test Lane\)/i);

    await screenshot(candidatePage, '01-candidate-initial-terminal-available');

    // -----------------------------------------------------------------------
    // Step 5: Activate assessment
    // -----------------------------------------------------------------------
    console.log('[R2.13 Browser] Step 5: Candidate activates assessment');
    const activateButton = candidatePage.getByRole('button', {
      name: 'Activate assessment',
      exact: true,
    });
    await activateButton.waitFor();
    const activatedResponse = candidatePage.waitForResponse(
      (res) =>
        res.url().endsWith(candidatePath) &&
        res.request().method() === 'POST' &&
        res.request().postDataJSON()?.action === 'activate',
    );
    await activateButton.click();
    assert.equal((await activatedResponse).status(), 200);
    await candidatePage.waitForLoadState('networkidle');

    // Verify execution panel is rendered
    const executionPanel = candidatePage.locator(
      '[data-testid="candidate-execution-panel"]',
    );
    await executionPanel.waitFor();

    const synthBadge = candidatePage.locator(
      '[data-testid="synthetic-execution-badge"]',
    );
    await synthBadge.waitFor();
    assert.match(
      await synthBadge.innerText(),
      /\[Synthetic Test Result · Test Lane\]/i,
    );

    const budgetPill = candidatePage.locator(
      '[data-testid="execution-panel-budget"]',
    );
    await budgetPill.waitFor();
    assert.match(await budgetPill.innerText(), /10 of 10 runs remaining/i);

    const stateBadge = candidatePage.locator(
      '[data-testid="execution-state-badge"]',
    );
    await stateBadge.waitFor();
    assert.match(await stateBadge.innerText(), /Never executed/i);

    await screenshot(candidatePage, '02-candidate-workspace-activated');

    // -----------------------------------------------------------------------
    // Step 6: Candidate edits file, verifies dirty-state guard, and saves
    // -----------------------------------------------------------------------
    console.log('[R2.13 Browser] Step 6: Candidate edits and saves file');
    const editor = candidatePage.locator('.cm-content[contenteditable="true"]');
    await editor.waitFor();
    await editor.click();
    await candidatePage.keyboard.type(
      '\n# Candidate retry implementation with backoff sleep and jitter\n',
    );

    // Run checks button must be disabled when changes are unsaved (isDirty)
    const runChecksButton = candidatePage.locator(
      '[data-testid="run-checks-button"]',
    );
    await runChecksButton.waitFor();
    assert.equal(await runChecksButton.isDisabled(), true);

    const dirtyHint = candidatePage.locator('.r26-execution-hint');
    await dirtyHint.waitFor();
    assert.match(
      await dirtyHint.innerText(),
      /Save your changes first to run checks/i,
    );

    // Save work
    const saveButton = candidatePage.getByRole('button', {
      name: 'Save work',
      exact: true,
    });
    await saveButton.waitFor();
    const saveResponsePromise = candidatePage.waitForResponse(
      (res) =>
        res.url().endsWith(candidatePath) &&
        res.request().method() === 'POST' &&
        res.request().postDataJSON()?.action === 'save',
    );
    await saveButton.click();
    const saveRes = await saveResponsePromise;
    assert.equal(saveRes.status(), 200);
    await candidatePage.waitForLoadState('networkidle');

    // After save, run checks button must be re-enabled
    assert.equal(await runChecksButton.isEnabled(), true);

    // -----------------------------------------------------------------------
    // Step 7: Candidate executes checks runner via UI
    // -----------------------------------------------------------------------
    console.log('[R2.13 Browser] Step 7: Candidate runs checks');
    const executionPromise = candidatePage.waitForResponse(
      (res) =>
        res.url().endsWith(candidateExecutionPath) &&
        res.request().method() === 'POST',
    );
    await runChecksButton.click();
    const executionRes = await executionPromise;
    assert.equal(executionRes.status(), 200);
    await candidatePage.waitForLoadState('networkidle');

    // Verify UI reflects Passed (Exit 0) and decremented budget (9 remaining)
    const passedBadge = candidatePage
      .locator('[data-testid="execution-state-badge"]')
      .filter({ hasText: /Passed \(Exit 0\)/i });
    await passedBadge.waitFor();
    assert.match(await passedBadge.innerText(), /Passed \(Exit 0\)/i);

    const decrementedBudget = candidatePage
      .locator('[data-testid="execution-panel-budget"]')
      .filter({ hasText: /9 of 10 runs remaining/i });
    await decrementedBudget.waitFor();
    assert.match(
      await decrementedBudget.innerText(),
      /9 of 10 runs remaining/i,
    );

    // Verify stdout console
    const stdoutPre = candidatePage
      .locator('[data-testid="execution-stdout"]')
      .filter({ hasText: /3 passed/i });
    await stdoutPre.waitFor();
    const stdoutText = await stdoutPre.innerText();
    assert.match(stdoutText, /3 passed/i);
    assert.match(stdoutText, /test session starts/i);

    // Verify stderr tab
    const stderrTab = candidatePage.locator('[data-testid="stderr-tab"]');
    await stderrTab.click();
    const stderrPre = candidatePage.locator('[data-testid="execution-stderr"]');
    await stderrPre.waitFor();
    assert.match(await stderrPre.innerText(), /\(No standard error\)/i);

    // Switch back to stdout tab
    await candidatePage.locator('[data-testid="stdout-tab"]').click();

    await screenshot(candidatePage, '03-candidate-checks-passed');

    // -----------------------------------------------------------------------
    // Step 8: Expand stored synthetic execution receipt
    // -----------------------------------------------------------------------
    console.log(
      '[R2.13 Browser] Step 8: Expand and verify stored execution receipt',
    );
    const receipt = candidatePage.locator('[data-testid="execution-receipt"]');
    await receipt.waitFor();
    await receipt.locator('summary').click();

    const receiptText = await receipt.innerText();
    assert.match(receiptText, /recipe-python-check-v1/i);
    assert.match(receiptText, /1\.0\.0/i);
    assert.match(receiptText, /Exit Code[\s\S]*0/);
    assert.match(receiptText, /CLEAN/i);
    assert.match(receiptText, /synthetic-execution-adapter/i);

    await screenshot(candidatePage, '04-candidate-receipt-expanded');

    // -----------------------------------------------------------------------
    // Step 9: Reload candidate page and verify persistence
    // -----------------------------------------------------------------------
    console.log(
      '[R2.13 Browser] Step 9: Reload and verify execution state persistence',
    );
    await candidatePage.reload();
    await candidatePage.waitForLoadState('networkidle');

    const persistedStateBadge = candidatePage
      .locator('[data-testid="execution-state-badge"]')
      .filter({ hasText: /Passed \(Exit 0\)/i });
    await persistedStateBadge.waitFor();
    assert.match(await persistedStateBadge.innerText(), /Passed \(Exit 0\)/i);

    const persistedBudget = candidatePage
      .locator('[data-testid="execution-panel-budget"]')
      .filter({ hasText: /9 of 10 runs remaining/i });
    await persistedBudget.waitFor();
    assert.match(await persistedBudget.innerText(), /9 of 10 runs remaining/i);

    const persistedStdout = candidatePage
      .locator('[data-testid="execution-stdout"]')
      .filter({ hasText: /3 passed/i });
    await persistedStdout.waitFor();
    assert.match(await persistedStdout.innerText(), /3 passed/i);

    await screenshot(candidatePage, '05-candidate-persisted-after-reload');

    // -----------------------------------------------------------------------
    // Step 10: Direct API Validation (Idempotency replay & Conflict rejection)
    // -----------------------------------------------------------------------
    console.log(
      '[R2.13 Browser] Step 10: Idempotency replay and conflict checks',
    );
    const candidateRead = JSON.parse((await candidateCall('read')).text);
    const currentWorkspaceDigest = candidateRead.workspaceDigest;

    const testReqId = `req-exec-idemp-${randomUUID()}`;
    const firstCall = await candidateExecutionCall('POST', {
      requestId: testReqId,
      expectedWorkspaceDigest: currentWorkspaceDigest,
      recipeId: 'recipe-python-check-v1',
    });
    assert.equal(firstCall.status, 200, firstCall.text);
    const firstBody = JSON.parse(firstCall.text);
    assert.equal(firstBody.admissionStatus, 'ADMITTED');
    assert.equal(firstBody.remainingExecutions, 8);

    // Replay with exact same requestId and expectedWorkspaceDigest -> returns completed response (isReplay: true)
    const replayCall = await candidateExecutionCall('POST', {
      requestId: testReqId,
      expectedWorkspaceDigest: currentWorkspaceDigest,
      recipeId: 'recipe-python-check-v1',
    });
    assert.equal(replayCall.status, 200, replayCall.text);
    const replayBody = JSON.parse(replayCall.text);
    assert.equal(replayBody.admissionStatus, 'REPLAY_COMPLETED');
    assert.equal(replayBody.isReplay, true);
    assert.equal(replayBody.remainingExecutions, 8); // Budget preserved
    assert.equal(replayBody.operationId, firstBody.operationId);

    // Conflict: same requestId with DIFFERENT recipeId -> returns 409
    const conflictRecipeCall = await candidateExecutionCall('POST', {
      requestId: testReqId,
      expectedWorkspaceDigest: currentWorkspaceDigest,
      recipeId: 'different-recipe-id',
    });
    assert.equal(conflictRecipeCall.status, 409);

    // Mismatched expectedWorkspaceDigest -> returns 409 WORKSPACE_DIGEST_MISMATCH
    const mismatchedDigestCall = await candidateExecutionCall('POST', {
      requestId: `req-mismatch-${randomUUID()}`,
      expectedWorkspaceDigest: '0'.repeat(64),
      recipeId: 'recipe-python-check-v1',
    });
    assert.equal(mismatchedDigestCall.status, 409);
    assert.match(mismatchedDigestCall.text, /STALE_WORKSPACE/i);

    // -----------------------------------------------------------------------
    // Step 11: Candidate submits assessment
    // -----------------------------------------------------------------------
    console.log('[R2.13 Browser] Step 11: Candidate submits assessment');
    const submitButton = candidatePage.getByRole('button', {
      name: 'Submit assessment',
      exact: true,
    });
    await submitButton.waitFor();
    const submitResponsePromise = candidatePage.waitForResponse(
      (res) =>
        res.url().endsWith(candidatePath) &&
        res.request().method() === 'POST' &&
        res.request().postDataJSON()?.action === 'submit',
    );
    await submitButton.click();

    const confirmButton = candidatePage.getByRole('button', {
      name: 'Confirm and submit',
      exact: true,
    });
    if ((await confirmButton.count()) > 0) {
      await confirmButton.click();
    }
    const submitRes = await submitResponsePromise;
    assert.equal(submitRes.status(), 200);
    await candidatePage.waitForLoadState('networkidle');

    // Run checks button is disabled after submission
    assert.equal(await runChecksButton.isDisabled(), true);

    // Direct execution call after submission must return 409 SESSION_CLOSED
    const postSubmitCall = await candidateExecutionCall('POST', {
      requestId: `req-post-submit-${randomUUID()}`,
      expectedWorkspaceDigest: currentWorkspaceDigest,
      recipeId: 'recipe-python-check-v1',
    });
    assert.equal(postSubmitCall.status, 409);
    assert.match(postSubmitCall.text, /SESSION_CLOSED/i);

    await screenshot(candidatePage, '06-candidate-submitted-closed');

    // -----------------------------------------------------------------------
    // Step 12: Assign reviewer and review Evidence Workbench
    // -----------------------------------------------------------------------
    console.log(
      '[R2.13 Browser] Step 12: Reviewer inspects Evidence Workbench Summary',
    );
    const assignmentResponse = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/assignments`,
      {
        method: 'POST',
        cookies: recruiter,
        headers: {
          Origin: origin,
          'x-csrf-token': recruiter[csrfCookieName],
        },
        body: { reviewerPrincipalId: FIXTURE_IDS.userAB.principalId },
      },
    );
    assert.equal(assignmentResponse.status, 201, assignmentResponse.text);
    assignmentId = JSON.parse(assignmentResponse.text).assignmentId;

    // Reviewer signs in
    await reviewerPage.goto(`${origin}/r23/login`);
    await reviewerPage.waitForLoadState('networkidle');
    await reviewerPage.locator('input[name="email"]').fill(users.ab.email);
    await reviewerPage
      .locator('input[name="password"]')
      .fill(users.ab.password);
    await Promise.all([
      reviewerPage.waitForURL('**/r23/organizations'),
      reviewerPage.locator('button[type="submit"]').click(),
    ]);

    // Select Organization A
    const orgForm = reviewerPage.locator('form').filter({
      has: reviewerPage.locator(`input[value="${FIXTURE_IDS.orgA}"]`),
    });
    await Promise.all([
      reviewerPage.waitForURL(`**/r23/organizations/${FIXTURE_IDS.orgA}`),
      orgForm.locator('button[type="submit"]').click(),
    ]);

    // Navigate to session review
    const sessionRow = reviewerPage.locator(
      `li[data-session-id="${issued.sessionId}"]`,
    );
    await sessionRow.waitFor();
    await Promise.all([
      reviewerPage.waitForURL(
        `**/r23/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}`,
      ),
      sessionRow
        .getByRole('link', { name: 'Inspect session', exact: true })
        .click(),
    ]);

    const workbenchLink = reviewerPage.getByRole('link', {
      name: 'Open submitted evidence workbench (read only)',
    });
    await workbenchLink.waitFor();
    await Promise.all([
      reviewerPage.waitForURL(
        `**/r27/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}**`,
      ),
      workbenchLink.click(),
    ]);
    await reviewerPage.waitForLoadState('networkidle');
    await reviewerPage
      .getByRole('tab', { name: 'Summary', exact: true })
      .waitFor();

    // Verify Terminal capability availability is reported
    const limitsSection = reviewerPage.locator(
      'aside[aria-label="Evidence availability"]',
    );
    await limitsSection.waitFor();
    const limitsText = await limitsSection.innerText();
    assert.match(limitsText, /Terminal\s+available/i);

    // Verify Summary View has Recorded execution runs card
    const execSummaryCard = reviewerPage.locator(
      'section[aria-labelledby="r213-execution-runs-title"]',
    );
    await execSummaryCard.waitFor();
    assert.match(await execSummaryCard.innerText(), /2 recorded/i);

    await screenshot(reviewerPage, '07-reviewer-workbench-summary');

    // -----------------------------------------------------------------------
    // Step 13: Reviewer inspects Execution runs filter tab
    // -----------------------------------------------------------------------
    console.log(
      '[R2.13 Browser] Step 13: Inspect Execution runs filter tab and receipt',
    );
    await reviewerPage
      .getByRole('tab', { name: 'Evidence', exact: true })
      .click();
    await reviewerPage
      .getByRole('tab', { name: 'Execution runs', exact: true })
      .click();

    // Verify execution rows are listed
    const executionButtons = reviewerPage
      .locator('button.evaluator-source-row')
      .filter({
        hasText: /Execution run/i,
      });
    await executionButtons.first().waitFor();
    assert.ok((await executionButtons.count()) >= 2);

    // Click on Execution Run 1
    await executionButtons.first().click();

    // Verify Execution Run Inspector details
    const inspector = reviewerPage.locator('[data-source-inspector="true"]');
    await inspector.waitFor();
    const inspectorText = await inspector.innerText();
    assert.match(
      inspectorText,
      /Session execution run · Candidate test execution/i,
    );
    assert.match(inspectorText, /recipe-python-check-v1/i);
    assert.match(inspectorText, /1\.0\.0/i);
    assert.match(inspectorText, /Exit Code[\s\S]*0/);
    assert.match(inspectorText, /CLEAN/i);
    assert.match(inspectorText, /synthetic-execution-adapter/i);

    const syntheticReceiptBadge = inspector.locator(
      '[data-testid="synthetic-execution-receipt-badge"]',
    );
    await syntheticReceiptBadge.waitFor();
    assert.match(
      await syntheticReceiptBadge.innerText(),
      /Synthetic Execution Receipt · Test Lane/i,
    );

    const evaluatorStdout = inspector.locator(
      '[data-testid="evaluator-execution-stdout"]',
    );
    await evaluatorStdout.waitFor();
    assert.match(await evaluatorStdout.innerText(), /3 passed/i);

    await screenshot(reviewerPage, '08-reviewer-execution-run-inspector');

    // -----------------------------------------------------------------------
    // Step 14: Responsive Viewport Verification (1440, 768, 390, 375 px)
    // -----------------------------------------------------------------------
    console.log('[R2.13 Browser] Step 14: Test responsive viewports');
    const viewports = [
      { width: 1440, height: 900, name: 'desktop-1440' },
      { width: 768, height: 1024, name: 'tablet-768' },
      { width: 390, height: 844, name: 'mobile-390' },
      { width: 375, height: 667, name: 'mobile-375' },
    ];
    for (const vp of viewports) {
      await candidatePage.setViewportSize({
        width: vp.width,
        height: vp.height,
      });
      await candidatePage.waitForTimeout(100);
      await screenshot(candidatePage, `09-candidate-${vp.name}`);

      await reviewerPage.setViewportSize({
        width: vp.width,
        height: vp.height,
      });
      await reviewerPage.waitForTimeout(100);
      await screenshot(reviewerPage, `10-reviewer-${vp.name}`);
    }

    // -----------------------------------------------------------------------
    // Step 15: Revoke reviewer assignment and verify subsequent denial
    // -----------------------------------------------------------------------
    console.log(
      '[R2.13 Browser] Step 15: Revoke reviewer assignment and confirm denial',
    );
    const revokeResponse = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/assignments/${assignmentId}/revoke`,
      {
        method: 'POST',
        cookies: recruiter,
        headers: {
          Origin: origin,
          'x-csrf-token': recruiter[csrfCookieName],
        },
      },
    );
    assert.equal(revokeResponse.status, 200, revokeResponse.text);

    // After revocation, reviewer accessing evidence workbench must be denied (401/403/404)
    const revokedWorkbenchResponse = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/evidence`,
      { cookies: reviewer },
    );
    assert.ok(
      [401, 403, 404].includes(revokedWorkbenchResponse.status),
      `Revoked reviewer must be denied, got status ${revokedWorkbenchResponse.status}`,
    );

    // -----------------------------------------------------------------------
    // Step 16: Restarts Next.js and verifies stored execution records remain intact
    // -----------------------------------------------------------------------
    if (typeof stop === 'function' && typeof start === 'function') {
      console.log(
        '[R2.13 Browser] Step 16: Restart Next.js server and verify persisted state',
      );
      await stop();
      await start();
    }

    if (admin) {
      const { rows: execRows } = await admin.query(
        'SELECT status, exit_code, recipe_id FROM hirearchy.candidate_execution_operations WHERE session_id = $1 ORDER BY sequence_start ASC',
        [issued.sessionId],
      );
      assert.ok(execRows.length >= 2);
      assert.equal(execRows[0].status, 'COMPLETED');
      assert.equal(execRows[0].exit_code, 0);
      assert.equal(execRows[0].recipe_id, 'recipe-python-check-v1');
    }

    console.log(
      '[R2.13 Browser] All browser execution journey checks passed successfully!',
    );
  } finally {
    await candidateContext.close();
    await reviewerContext.close();
    await browser.close();
  }

  const allowedHmrReconnect =
    /^WebSocket connection to 'wss:\/\/127\.0\.0\.1:\d+\/_next\/hmr\?id=[^']+' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED$/;
  const allowedRevocationStatusMessage =
    /^Failed to load resource: the server responded with a status of (?:403|404) \(.*\)$/;
  const unexpectedConsoleErrors = consoleErrors.filter(
    (message) =>
      !allowedHmrReconnect.test(message) &&
      !allowedRevocationStatusMessage.test(message),
  );

  assert.equal(pageErrors.length, 0, `Page errors: ${pageErrors.join(', ')}`);
  assert.equal(
    unexpectedConsoleErrors.length,
    0,
    `Console errors: ${unexpectedConsoleErrors.join(', ')}`,
  );
}
