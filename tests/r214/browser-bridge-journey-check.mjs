import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FIXTURE_IDS } from '../../database/postgres/r23/adapter.mjs';
import { loadPlaywright } from '../r25/browser-issuance-check.mjs';

const csrfCookieName = '__Host-r23-csrf';

export async function runR214BrowserBridgeJourneyChecks({
  origin,
  request,
  signInAndSelectOrg,
  users,
}) {
  const pageErrors = [];
  const consoleErrors = [];

  // Step 1: Sign in recruiter and reviewer
  console.log('[R2.14 Browser] Step 1: Sign in recruiter and reviewer');
  const recruiter = await signInAndSelectOrg(origin, users.a, FIXTURE_IDS.orgA);
  const reviewer = await signInAndSelectOrg(origin, users.ab, FIXTURE_IDS.orgA);

  // Step 2: Recruiter creates reservation-moves v3 assessment draft
  console.log(
    '[R2.14 Browser] Step 2: Create execution-enabled draft for reservation-moves v3',
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
        templateId: 'reservation-moves-v3',
        title: 'Reservation Moves Execution Test',
        brief:
          'Implement reservation move resolution algorithm in Python with pytest checks.',
        expectedBehavior: [
          'Resolves concurrent reservation moves without double booking',
          'Passes all pytest test suites',
        ],
        acceptanceCriteria: [
          'All reservation moves are validated',
          'Pytest tests pass successfully',
        ],
        primaryFilePath: 'solution.py',
        starterFiles: [
          {
            path: 'solution.py',
            content:
              '# Reservation Moves Solution\n\ndef move_reservation(req):\n    return True\n',
          },
        ],
        durationMinutes: 30,
        terminalEnabled: true,
        integratedAi: false,
        rubric: [
          {
            id: 'correctness',
            label: 'Move Correctness',
            description: 'Evaluates move handling logic',
            weight: 100,
            applicability: { kind: 'always', rule: 'Evaluates move logic' },
          },
        ],
      },
    },
  );
  assert.equal(draftResponse.status, 200, draftResponse.text);
  let { draft } = JSON.parse(draftResponse.text);

  // Select and save the template through the same Builder used by recruiters.
  const { chromium } = await loadPlaywright();
  const builderBrowser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  try {
    const builderContext = await builderBrowser.newContext({
      ignoreHTTPSErrors: true,
    });
    await builderContext.addCookies(
      Object.entries(recruiter).map(([name, value]) => ({
        name,
        value,
        url: origin,
      })),
    );
    const builderPage = await builderContext.newPage();
    await builderPage.goto(
      `${origin}/r23/organizations/${FIXTURE_IDS.orgA}/builder`,
    );
    const selector = builderPage.getByLabel('Assessment template');
    await selector.selectOption('custom');
    await selector.selectOption('reservation-moves-v3');
    const [saved] = await Promise.all([
      builderPage.waitForResponse(
        (response) =>
          response.url().endsWith('/assessments/draft') &&
          response.request().method() === 'PUT',
      ),
      builderPage.getByTestId('save-draft-button').click(),
    ]);
    assert.equal(saved.status(), 200, await saved.text());
    ({ draft } = await saved.json());
    await builderPage.reload();
    assert.equal(await selector.inputValue(), 'reservation-moves-v3');
    await builderContext.close();
  } finally {
    await builderBrowser.close();
  }

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
  assert.equal(validatedVersion.scenarioId, 'reservation-moves');
  assert.equal(validatedVersion.scenarioVersion, 'v3');
  assert.equal(
    validatedVersion.scenarioSnapshot.scenario.templateId,
    'reservation-moves-v3',
  );
  assert.deepEqual(
    Object.keys(validatedVersion.scenarioSnapshot.workspaceFiles).sort(),
    ['src/sender.py', 'src/service.py', 'src/state.py', 'tests/test_moves.py'],
  );

  // Step 3: Recruiter issues assessment
  console.log('[R2.14 Browser] Step 3: Recruiter issues assessment');
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
        idempotencyKey: `r214-browser-${randomUUID()}`,
        validatedVersionId: validatedVersion.id,
        durationMinutes: 30,
      },
    },
  );
  assert.equal(issuedResponse.status, 201, issuedResponse.text);
  const issued = JSON.parse(issuedResponse.text);

  // Recover candidate token link
  const recoveredResponse = await request(
    origin,
    `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/candidate-token`,
    { cookies: recruiter },
  );
  assert.equal(recoveredResponse.status, 200, recoveredResponse.text);
  const recovered = JSON.parse(recoveredResponse.text);
  assert.equal(
    recovered.candidatePath,
    `/r26/candidate/${issued.sessionId}#${recovered.candidateToken}`,
  );

  const candidatePath = `/r26/api/candidate/${issued.sessionId}`;
  const candidateExecutionPath = `/r26/api/candidate/${issued.sessionId}/execution`;

  const candidateCall = async (action = 'read', input = {}, overrides = {}) => {
    const res = await request(origin, candidatePath, {
      method: action === 'read' ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${recovered.candidateToken}`,
        ...(action === 'read' ? {} : { Origin: origin }),
      },
      body:
        action === 'read'
          ? undefined
          : {
              action,
              clientTime: new Date().toISOString(),
              ...input,
            },
      ...overrides,
    });
    return res;
  };

  const candidateExecutionCall = async (method, body = null) => {
    const res = await request(origin, candidateExecutionPath, {
      method,
      headers: {
        Authorization: `Bearer ${recovered.candidateToken}`,
        Origin: origin,
      },
      body,
    });
    return res;
  };

  // Launch browser
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });

  const candidatePage = await context.newPage();
  const reviewerPage = await context.newPage();

  const recordConsole = (pageName, msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter expected Next.js HMR reconnects and intentional 403 access denial
      if (
        text.includes('ERR_CONNECTION_REFUSED') ||
        text.includes('[HMR]') ||
        text.includes(
          'Failed to load resource: the server responded with a status of 403',
        ) ||
        text.includes('status of 403')
      ) {
        return;
      }
      consoleErrors.push(`[${pageName}] ${text}`);
    }
  };

  candidatePage.on('console', (msg) => recordConsole('Candidate', msg));
  reviewerPage.on('console', (msg) => recordConsole('Reviewer', msg));

  candidatePage.on('pageerror', (err) =>
    pageErrors.push(`[Candidate] ${err.message}`),
  );
  reviewerPage.on('pageerror', (err) =>
    pageErrors.push(`[Reviewer] ${err.message}`),
  );

  let assignmentId;

  try {
    // Step 4: Candidate activates workspace
    console.log('[R2.14 Browser] Step 4: Candidate activates workspace');
    await candidatePage.goto(origin + recovered.candidatePath);
    await candidatePage.waitForLoadState('networkidle');

    const activateButton = candidatePage.getByRole('button', {
      name: 'Activate assessment',
      exact: true,
    });
    await activateButton.waitFor();
    await Promise.all([
      candidatePage.waitForResponse(
        (res) =>
          res.url().endsWith(candidatePath) &&
          res.request().method() === 'POST' &&
          res.request().postDataJSON()?.action === 'activate',
      ),
      activateButton.click(),
    ]);
    await candidatePage.waitForLoadState('networkidle');

    // Step 5: Verify terminal panel is visible with full budget
    console.log('[R2.14 Browser] Step 5: Verify candidate terminal panel');
    const terminalPanel = candidatePage.locator(
      '[data-testid="candidate-execution-panel"]',
    );
    await terminalPanel.waitFor();

    const budgetPill = candidatePage.locator(
      '[data-testid="execution-panel-budget"]',
    );
    await budgetPill.waitFor();
    assert.match(await budgetPill.innerText(), /10 of 10 runs remaining/i);

    // Step 6: Candidate modifies file and saves
    console.log('[R2.14 Browser] Step 6: Candidate edits and saves code');
    const editor = candidatePage.locator('.cm-content[contenteditable="true"]');
    await editor.waitFor();
    await editor.click();
    await candidatePage.keyboard.type(
      '\n# Implemented retry logic\nimport time\ndef move_reservation(req):\n    return True\n',
    );

    const saveButton = candidatePage.getByRole('button', {
      name: 'Save work',
      exact: true,
    });
    await Promise.all([
      candidatePage.waitForResponse(
        (res) =>
          res.url().endsWith(candidatePath) &&
          res.request().method() === 'POST' &&
          res.request().postDataJSON()?.action === 'save',
      ),
      saveButton.click(),
    ]);
    await candidatePage.waitForLoadState('networkidle');

    // Step 7: Candidate executes checks
    console.log('[R2.14 Browser] Step 7: Candidate clicks Run checks');
    const runChecksButton = candidatePage.locator(
      '[data-testid="run-checks-button"]',
    );
    await runChecksButton.waitFor();

    const executionPromise = candidatePage.waitForResponse(
      (res) =>
        res.url().includes('/execution') && res.request().method() === 'POST',
    );
    await runChecksButton.click();

    const execRes = await executionPromise;
    assert.equal(execRes.status(), 200, await execRes.text());
    const execJson = await execRes.json();
    assert.ok(execJson.operationId);
    assert.equal(execJson.provenance, 'restricted-executor-service');
    assert.equal(execJson.isSynthetic, false);
    assert.notEqual(execJson.status, 'UNKNOWN');

    await candidatePage.waitForLoadState('networkidle');

    // Step 8: Verify execution panel updates
    console.log(
      '[R2.14 Browser] Step 8: Verify execution output and budget decrement',
    );
    const decrementedBudget = candidatePage
      .locator('[data-testid="execution-panel-budget"]')
      .filter({ hasText: /9 of 10 runs remaining/i });
    await decrementedBudget.waitFor();

    const stdoutPre = candidatePage.locator('[data-testid="execution-stdout"]');
    await stdoutPre.waitFor();
    const stdoutContent = await stdoutPre.innerText();
    assert.ok(stdoutContent.length > 0);

    // Verify the receipt came from the real restricted executor.
    const receiptModeBadge = candidatePage.locator(
      '[data-testid="receipt-execution-mode"]',
    );
    // Expand receipt details
    const receipt = candidatePage.locator('[data-testid="execution-receipt"]');
    await receipt.waitFor();
    await receipt.locator('summary').click();

    await receiptModeBadge.waitFor();
    const modeText = await receiptModeBadge.innerText();
    assert.ok(modeText.includes('Real Restricted Executor'));

    // Step 9: Verify persistence after reload
    console.log('[R2.14 Browser] Step 9: Verify persistence after reload');
    await candidatePage.reload();
    await candidatePage.waitForLoadState('networkidle');

    const persistedBudget = candidatePage
      .locator('[data-testid="execution-panel-budget"]')
      .filter({ hasText: /9 of 10 runs remaining/i });
    await persistedBudget.waitFor();

    // Step 10: Idempotency replay and conflict checks
    console.log('[R2.14 Browser] Step 10: Idempotency replay check');
    const candidateRead = JSON.parse((await candidateCall('read')).text);
    const currentWorkspaceDigest = candidateRead.workspaceDigest;

    const testReqId = `req-exec-r214-${randomUUID()}`;
    const firstCall = await candidateExecutionCall('POST', {
      requestId: testReqId,
      expectedWorkspaceDigest: currentWorkspaceDigest,
    });
    assert.equal(firstCall.status, 200, firstCall.text);
    const firstBody = JSON.parse(firstCall.text);
    assert.equal(firstBody.admissionStatus, 'ADMITTED');
    assert.equal(firstBody.isReplay, false);
    assert.equal(firstBody.remainingExecutions, 8);

    // Replay with identical intent returns isReplay: true without decrementing budget
    const replayCall = await candidateExecutionCall('POST', {
      requestId: testReqId,
      expectedWorkspaceDigest: currentWorkspaceDigest,
    });
    assert.equal(replayCall.status, 200, replayCall.text);
    const replayBody = JSON.parse(replayCall.text);
    assert.equal(
      replayBody.admissionStatus,
      firstBody.status === 'COMPLETED' ? 'REPLAY_COMPLETED' : 'REPLAY',
    );
    assert.equal(replayBody.isReplay, true);
    assert.equal(replayBody.remainingExecutions, 8);

    // Changed intent conflict check: same requestId with different expectedWorkspaceDigest
    const conflictCall = await candidateExecutionCall('POST', {
      requestId: testReqId,
      expectedWorkspaceDigest: '0'.repeat(64),
    });
    assert.equal(conflictCall.status, 409);

    // Step 11: Candidate submits assessment
    console.log('[R2.14 Browser] Step 11: Candidate submits assessment');
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

    // Button is now disabled
    assert.equal(await runChecksButton.isDisabled(), true);

    // Post-submit execution attempt returns 409 SESSION_CLOSED
    const postSubmitCall = await candidateExecutionCall('POST', {
      requestId: `req-post-sub-${randomUUID()}`,
      expectedWorkspaceDigest: currentWorkspaceDigest,
    });
    assert.equal(postSubmitCall.status, 409);
    assert.match(postSubmitCall.text, /SESSION_CLOSED/i);

    // Step 12: Recruiter assigns reviewer and reviewer opens Evidence Workbench
    console.log(
      '[R2.14 Browser] Step 12: Reviewer inspects Evidence Workbench',
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

    const orgForm = reviewerPage.locator('form').filter({
      has: reviewerPage.locator(`input[value="${FIXTURE_IDS.orgA}"]`),
    });
    await Promise.all([
      reviewerPage.waitForURL(`**/r23/organizations/${FIXTURE_IDS.orgA}`),
      orgForm.locator('button[type="submit"]').click(),
    ]);

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

    // Step 13: Reviewer inspects Evidence Sources and finds Execution runs
    console.log(
      '[R2.14 Browser] Step 13: Inspect Execution Sources in Workbench',
    );
    await reviewerPage
      .getByRole('tab', { name: 'Evidence', exact: true })
      .click();
    await reviewerPage
      .getByRole('tab', { name: 'Execution runs', exact: true })
      .click();

    // Step 14: Inspect execution source details
    console.log(
      '[R2.14 Browser] Step 14: Verify factual provenance and evaluator disclaimer',
    );
    const executionButtons = reviewerPage
      .locator('button.evaluator-source-row')
      .filter({
        hasText: /Execution run/i,
      });
    await executionButtons.first().waitFor();
    await executionButtons.first().click();

    // Verify evaluator disclaimer banner
    const disclaimer = reviewerPage.locator(
      '[data-testid="execution-evaluator-disclaimer"]',
    );
    await disclaimer.waitFor();
    const disclaimerText = await disclaimer.innerText();
    assert.match(disclaimerText, /no automatic hiring decision/i);

    // Verify provenance display
    const provenanceItem = reviewerPage.locator(
      '[data-testid="execution-factual-provenance"]',
    );
    await provenanceItem.waitFor();
    const provText = await provenanceItem.innerText();
    assert.ok(provText.includes('Restricted Docker Executor'));

    // Step 15: Revoke reviewer and verify 403 access denial
    console.log('[R2.14 Browser] Step 15: Revoked reviewer access denial');
    const revokeResponse = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/assignments/${assignmentId}`,
      {
        method: 'DELETE',
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

    console.log(
      '[R2.14 Browser] Step 16: Verify no unexpected console or page errors',
    );
    assert.equal(pageErrors.length, 0, `Page errors: ${pageErrors.join(', ')}`);
    assert.equal(
      consoleErrors.length,
      0,
      `Console errors: ${consoleErrors.join(', ')}`,
    );

    console.log('--- R2.14 Browser Journey Checks PASSED (16/16 steps) ---');
  } finally {
    await candidatePage.close().catch(() => {});
    await reviewerPage.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
