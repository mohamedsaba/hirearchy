import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { FIXTURE_IDS } from '../../database/postgres/r23/adapter.mjs';
import { loadPlaywright } from '../r25/browser-issuance-check.mjs';

const csrfCookieName = '__Host-r23-csrf';

export async function runR212BrowserAiJourneyChecks({
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
  void admin;
  void connection;
  void runtimePassword;
  void candidateTokenKey;
  void start;
  void stop;

  const http = [];
  const pageErrors = [];
  const consoleErrors = [];

  // Step 1: Sign in recruiter and reviewer
  const recruiter = await signInAndSelectOrg(origin, users.a, FIXTURE_IDS.orgA);
  const reviewer = await signInAndSelectOrg(origin, users.ab, FIXTURE_IDS.orgA);

  // Step 2: Recruiter creates an AI-permitted assessment draft, validates, and issues it
  console.log('[R2.12 Browser] Step 2: Create AI-permitted draft and validate');
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
        title: 'Booking Notification Retry with AI',
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
        integratedAi: true,
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
  assert.equal(validatedVersion.integratedAi, true);

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
        idempotencyKey: `r212-browser-${randomUUID()}`,
        validatedVersionId: validatedVersion.id,
        durationMinutes: 30,
      },
    },
  );
  http.push({ operation: 'issue', status: issuedResponse.status });
  assert.equal(issuedResponse.status, 201, issuedResponse.text);
  const issued = JSON.parse(issuedResponse.text);

  // Step 3: Recover candidate token
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
  const candidateAiPath = `/r26/api/candidate/${issued.sessionId}/ai`;

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

  const candidateAiCall = async (method = 'GET', body = null) => {
    const response = await request(origin, candidateAiPath, {
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
        path: join(evidence, `r212-${name}.png`),
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
    console.log('[R2.12 Browser] Step 4: Candidate navigates to assessment');
    await candidatePage.goto(origin + recovered.candidatePath);
    await candidatePage.waitForLoadState('networkidle');

    // Verify AI capability is displayed in workspace capabilities
    const capabilitiesSection = candidatePage.locator('.r26-availability');
    await capabilitiesSection.waitFor();
    const capText = await capabilitiesSection.innerText();
    assert.match(capText, /AI assistance/i);
    assert.match(capText, /Available \(Synthetic Test Lane\)/i);
    assert.match(capText, /5 of 5 (?:questions|interactions) remaining/i);

    // Verify AI panel is rendered
    const aiPanel = candidatePage.locator('[data-testid="candidate-ai-panel"]');
    await aiPanel.waitFor();
    const panelText = await aiPanel.innerText();
    assert.match(panelText, /Synthetic Assistant \(Test Lane\)/i);
    assert.match(panelText, /5 of 5 remaining/i);

    await screenshot(candidatePage, '01-candidate-initial-ai-available');

    // -----------------------------------------------------------------------
    // Step 5: Activate assessment
    // -----------------------------------------------------------------------
    console.log('[R2.12 Browser] Step 5: Candidate activates assessment');
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

    // -----------------------------------------------------------------------
    // Step 6: Candidate submits Question 1 via UI
    // -----------------------------------------------------------------------
    console.log('[R2.12 Browser] Step 6: Candidate submits Question 1');
    const aiPromptInput = candidatePage.locator('#r26-ai-prompt-input');
    await aiPromptInput.waitFor();
    await aiPromptInput.fill(
      'How should I implement the booking retry logic with exponential backoff?',
    );

    // Verify character counter
    const charCounter = candidatePage.locator('.r26-ai-char-counter');
    const countText = await charCounter.innerText();
    assert.match(countText, /72 \/ 4,000/);

    const askButton = candidatePage.locator('[data-testid="ai-submit-button"]');
    const aiResponsePromise = candidatePage.waitForResponse(
      (res) =>
        res.url().endsWith(candidateAiPath) &&
        res.request().method() === 'POST',
    );
    await askButton.click();

    const aiRes = await aiResponsePromise;
    assert.equal(aiRes.status(), 200);

    // Verify candidate message and assistant response rendered
    const candidateMsg = candidatePage.locator(
      '[data-testid="ai-candidate-message"]',
    );
    await candidateMsg.waitFor();
    assert.match(
      await candidateMsg.innerText(),
      /How should I implement the booking retry logic/,
    );

    const assistantMsg = candidatePage.locator(
      '[data-testid="ai-assistant-message"]',
    );
    await assistantMsg.waitFor();
    const assistantText = await assistantMsg.innerText();
    assert.match(assistantText, /Synthetic Assistant \(Test Lane\)/i);
    assert.match(assistantText, /exponential backoff/i);

    // Verify budget decremented to 4
    const budgetBadge = candidatePage.locator(
      '[data-testid="ai-budget-badge"]',
    );
    await budgetBadge.waitFor();
    assert.match(
      await budgetBadge.innerText(),
      /4 of 5 (?:questions|interactions) remaining/,
    );

    await screenshot(candidatePage, '02-candidate-ai-question-1-response');

    // -----------------------------------------------------------------------
    // Step 7: Reload candidate page and verify persistence
    // -----------------------------------------------------------------------
    console.log(
      '[R2.12 Browser] Step 7: Reload and verify AI state persistence',
    );
    await candidatePage.reload();
    await candidatePage.waitForLoadState('networkidle');

    const persistedAssistantMsg = candidatePage.locator(
      '[data-testid="ai-assistant-message"]',
    );
    await persistedAssistantMsg.waitFor();
    assert.match(
      await persistedAssistantMsg.innerText(),
      /exponential backoff/i,
    );

    const persistedBudgetBadge = candidatePage.locator(
      '[data-testid="ai-budget-badge"]',
    );
    assert.match(
      await persistedBudgetBadge.innerText(),
      /4 of 5 (?:questions|interactions) remaining/,
    );

    // -----------------------------------------------------------------------
    // Step 8: Direct API Validation (Idempotency replay & Conflict rejection)
    // -----------------------------------------------------------------------
    console.log(
      '[R2.12 Browser] Step 8: Idempotency replay and conflict checks',
    );
    const testReqId = `req-idemp-${randomUUID()}`;
    const firstCall = await candidateAiCall('POST', {
      requestId: testReqId,
      candidatePrompt: 'How do I run tests in this environment?',
    });
    assert.equal(firstCall.status, 200);
    const firstBody = JSON.parse(firstCall.text);
    assert.equal(firstBody.admissionStatus, 'ADMITTED');

    // Replay with exact same requestId and prompt -> returns completed response (isReplay: true)
    const replayCall = await candidateAiCall('POST', {
      requestId: testReqId,
      candidatePrompt: 'How do I run tests in this environment?',
    });
    assert.equal(replayCall.status, 200);
    const replayBody = JSON.parse(replayCall.text);
    assert.equal(replayBody.admissionStatus, 'REPLAY_COMPLETED');
    assert.equal(replayBody.isReplay, true);

    // Conflict: same requestId with DIFFERENT prompt -> returns 409
    const conflictCall = await candidateAiCall('POST', {
      requestId: testReqId,
      candidatePrompt: 'A completely different question for conflict testing.',
    });
    assert.equal(conflictCall.status, 409);

    // Oversized prompt (> 4000 chars) -> returns 413
    const oversizedCall = await candidateAiCall('POST', {
      requestId: `req-large-${randomUUID()}`,
      candidatePrompt: 'a'.repeat(4001),
    });
    assert.equal(oversizedCall.status, 413);

    // -----------------------------------------------------------------------
    // Step 9: Exhaust Remaining Budget (Total 5 interactions)
    // -----------------------------------------------------------------------
    console.log('[R2.12 Browser] Step 9: Exhaust budget (questions 3, 4, 5)');
    // We have used 2 interactions so far: UI question 1 and direct question 2.
    // Send questions 3, 4, 5:
    for (let i = 3; i <= 5; i++) {
      const qRes = await candidateAiCall('POST', {
        requestId: `req-budget-${i}-${randomUUID()}`,
        candidatePrompt: `Question ${i}: Can you explain the timeout handling requirements?`,
      });
      assert.equal(qRes.status, 200);
    }

    // 6th question -> must be rejected with 429 BUDGET_EXHAUSTED
    const sixthCall = await candidateAiCall('POST', {
      requestId: `req-budget-6-${randomUUID()}`,
      candidatePrompt:
        'Question 6: This should be rejected by budget exhaustion.',
    });
    assert.equal(sixthCall.status, 429);
    assert.match(sixthCall.text, /BUDGET_EXHAUSTED/i);

    // Reload candidate page to observe budget exhausted UI state
    await candidatePage.reload();
    await candidatePage.waitForLoadState('networkidle');

    const exhaustedNotice = candidatePage.locator(
      '[data-testid="ai-budget-exhausted-notice"]',
    );
    await exhaustedNotice.waitFor();
    assert.match(
      await exhaustedNotice.innerText(),
      /Interaction budget exhausted/i,
    );
    assert.match(
      await exhaustedNotice.innerText(),
      /maximum allowance of 5 questions/i,
    );

    // Composer textarea should not be present (replaced by exhausted notice)
    assert.equal(
      await candidatePage.locator('#r26-ai-prompt-input').count(),
      0,
    );

    await screenshot(candidatePage, '03-candidate-ai-budget-exhausted');

    // -----------------------------------------------------------------------
    // Step 10: Candidate saves file and submits assessment
    // -----------------------------------------------------------------------
    console.log('[R2.12 Browser] Step 10: Candidate submits assessment');
    const candidateState = JSON.parse((await candidateCall('read')).text);
    const primaryFile = candidateState.files[0];
    assert.ok(primaryFile);

    const saveRes = await candidateCall('save', {
      requestId: randomUUID(),
      path: primaryFile.path,
      content: `${primaryFile.content}\n# R2.12 Candidate completed work\n`,
      expectedVersion: primaryFile.version,
    });
    assert.equal(saveRes.status, 200);

    // Reload candidate page so in-memory digest reflects the saved workspace update
    await candidatePage.reload();
    await candidatePage.waitForLoadState('networkidle');

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

    // Confirm submission modal if present
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

    // Verify submission finality in AI panel
    const finalityNotice = candidatePage.locator(
      '[data-testid="ai-finality-notice"]',
    );
    await finalityNotice.waitFor();
    assert.match(await finalityNotice.innerText(), /Assessment concluded/i);

    // Direct AI call after submission must return 409 SESSION_CLOSED
    const postSubmitAiCall = await candidateAiCall('POST', {
      requestId: `req-post-submit-${randomUUID()}`,
      candidatePrompt: 'Question after submission.',
    });
    assert.equal(postSubmitAiCall.status, 409);
    assert.match(postSubmitAiCall.text, /SESSION_CLOSED/i);

    await screenshot(candidatePage, '04-candidate-submitted-finality');

    // -----------------------------------------------------------------------
    // Step 11: Assign reviewer and review evidence workbench
    // -----------------------------------------------------------------------
    console.log(
      '[R2.12 Browser] Step 11: Reviewer inspects Evidence Workbench',
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
    await workbenchLink.click();
    await reviewerPage
      .getByRole('tab', { name: 'Summary', exact: true })
      .waitFor();

    // Verify AI interaction availability is reported as available
    const limitsSection = reviewerPage.locator(
      'aside[aria-label="Evidence availability"]',
    );
    await limitsSection.waitFor();
    const limitsText = await limitsSection.innerText();
    assert.match(limitsText, /AI interactions\s+available/i);

    // Verify Summary View has Recorded AI conversations card
    const aiSummaryCard = reviewerPage.locator(
      'section[aria-labelledby="r27-ai-conversations-title"]',
    );
    await aiSummaryCard.waitFor();
    assert.match(await aiSummaryCard.innerText(), /5 recorded/i);

    await screenshot(reviewerPage, '05-reviewer-workbench-ai-summary');

    // -----------------------------------------------------------------------
    // Step 12: Reviewer inspects AI conversations tab
    // -----------------------------------------------------------------------
    console.log('[R2.12 Browser] Step 12: Inspect AI conversations filter tab');
    await reviewerPage
      .getByRole('tab', { name: 'Evidence', exact: true })
      .click();
    await reviewerPage
      .getByRole('tab', { name: 'AI conversations', exact: true })
      .click();

    // Verify conversation rows are listed
    const conversationButtons = reviewerPage
      .locator('button.evaluator-source-row')
      .filter({
        hasText: /AI conversation/i,
      });
    await conversationButtons.first().waitFor();
    assert.equal(await conversationButtons.count(), 5);

    // Click on Conversation 1
    await conversationButtons.first().click();

    // Verify Conversation Inspector details
    const inspector = reviewerPage.locator('[data-source-inspector="true"]');
    await inspector.waitFor();
    const inspectorText = await inspector.innerText();
    assert.match(
      inspectorText,
      /Session AI conversation · Selected interaction/i,
    );
    assert.match(inspectorText, /synthetic-test-provider/i);
    assert.match(inspectorText, /synthetic-model-r212/i);
    assert.match(inspectorText, /Completed/i);
    assert.match(
      inspectorText,
      /How should I implement the booking retry logic with exponential backoff\?/,
    );
    assert.match(
      inspectorText,
      /Synthetic Assistant \(synthetic-test-provider\)/i,
    );

    await screenshot(reviewerPage, '06-reviewer-ai-conversation-inspector');

    // -----------------------------------------------------------------------
    // Step 13: Reviewer inspects Chronology filter tab
    // -----------------------------------------------------------------------
    console.log(
      '[R2.12 Browser] Step 13: Inspect Chronology AI timeline events',
    );
    await reviewerPage
      .getByRole('tab', { name: 'Chronology', exact: true })
      .click();

    const chronologyEvents = reviewerPage
      .locator('button.evaluator-source-row')
      .filter({
        hasText: /AI request recorded|AI response recorded/,
      });
    await chronologyEvents.first().waitFor();
    assert.ok((await chronologyEvents.count()) >= 2);

    await screenshot(reviewerPage, '07-reviewer-chronology-ai-events');

    // -----------------------------------------------------------------------
    // Step 14: Responsive Viewport Verification (1440, 768, 390, 375 px)
    // -----------------------------------------------------------------------
    console.log('[R2.12 Browser] Step 14: Test responsive viewports');
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
      await screenshot(candidatePage, `08-candidate-${vp.name}`);

      await reviewerPage.setViewportSize({
        width: vp.width,
        height: vp.height,
      });
      await reviewerPage.waitForTimeout(100);
      await screenshot(reviewerPage, `09-reviewer-${vp.name}`);
    }

    // -----------------------------------------------------------------------
    // Step 15: Revoke reviewer assignment and verify subsequent denial
    // -----------------------------------------------------------------------
    console.log(
      '[R2.12 Browser] Step 15: Revoke reviewer assignment and confirm denial',
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

    // After revocation, reviewer accessing evidence workbench must be denied (404/403)
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
      '[R2.12 Browser] All browser AI journey checks passed successfully!',
    );
  } finally {
    await candidateContext.close();
    await reviewerContext.close();
    await browser.close();
  }

  assert.equal(pageErrors.length, 0, `Page errors: ${pageErrors.join(', ')}`);
  assert.equal(
    consoleErrors.length,
    0,
    `Console errors: ${consoleErrors.join(', ')}`,
  );
}
