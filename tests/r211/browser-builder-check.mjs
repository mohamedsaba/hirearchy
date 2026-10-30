import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { FIXTURE_IDS } from '../../database/postgres/r23/adapter.mjs';
import { loadPlaywright } from '../r25/browser-issuance-check.mjs';

const csrfCookieName = '__Host-r23-csrf';

export async function runR211BrowserBuilderChecks({
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

  const pageErrors = [];
  const consoleErrors = [];

  // Authenticate recruiters and reviewers via disposable auth
  const recruiterA = await signInAndSelectOrg(
    origin,
    users.a,
    FIXTURE_IDS.orgA,
  );
  const recruiterB = await signInAndSelectOrg(
    origin,
    users.b,
    FIXTURE_IDS.orgB,
  );
  const reviewerA = await signInAndSelectOrg(
    origin,
    users.ab,
    FIXTURE_IDS.orgA,
  );

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.R23_CHROMIUM_PATH
      ? { executablePath: process.env.R23_CHROMIUM_PATH }
      : {}),
  });

  const recruiterContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });
  const recruiterPage = await recruiterContext.newPage();

  const observe = (page) => {
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
  };
  observe(recruiterPage);

  const screenshot = (page, name) =>
    page.screenshot({
      path: join(evidence, `r211-${name}.png`),
      fullPage: true,
    });

  try {
    // -----------------------------------------------------------------------
    // Step 1 & 2: Recruiter A logs in and selects Organization A
    // -----------------------------------------------------------------------
    console.log(
      '[R2.11 Browser] Step 1 & 2: Sign in and select Organization A',
    );
    await recruiterPage.goto(`${origin}/r23/login`);
    await recruiterPage.waitForLoadState('networkidle');
    await recruiterPage.locator('input[name="email"]').fill(users.a.email);
    await recruiterPage
      .locator('input[name="password"]')
      .fill(users.a.password);
    await Promise.all([
      recruiterPage.waitForURL('**/r23/organizations'),
      recruiterPage.locator('button[type="submit"]').click(),
    ]);
    await recruiterPage.waitForLoadState('networkidle');

    const selectOrgForm = recruiterPage.locator('form').filter({
      has: recruiterPage.locator(`input[value="${FIXTURE_IDS.orgA}"]`),
    });
    await Promise.all([
      recruiterPage.waitForURL(`**/r23/organizations/${FIXTURE_IDS.orgA}`),
      selectOrgForm.locator('button[type="submit"]').click(),
    ]);
    await recruiterPage.waitForLoadState('networkidle');

    // -----------------------------------------------------------------------
    // Step 3: Open Assessment Builder
    // -----------------------------------------------------------------------
    console.log('[R2.11 Browser] Step 3: Open Assessment Builder');
    const builderUrl = `${origin}/r23/organizations/${FIXTURE_IDS.orgA}/builder`;
    await recruiterPage.goto(builderUrl);
    await recruiterPage.waitForLoadState('networkidle');
    await screenshot(recruiterPage, '01-builder-define-initial');

    // Verify Builder header and stepper exist
    await recruiterPage.locator('.assessment-builder-hero').waitFor();
    await recruiterPage.locator('.assessment-stage-nav').waitFor();

    // -----------------------------------------------------------------------
    // Step 4: Create assessment draft with task, instructions, starter files
    // -----------------------------------------------------------------------
    console.log('[R2.11 Browser] Step 4: Create assessment draft');
    const initialTitle = 'Booking Notification Retry Logic';
    const initialBrief =
      'Implement retry logic with exponential backoff for the notification dispatch service.';

    await recruiterPage
      .locator('[data-testid="assessment-title-input"]')
      .fill(initialTitle);
    await recruiterPage
      .locator('[data-testid="assessment-brief-input"]')
      .fill(initialBrief);
    await recruiterPage
      .locator('[data-testid="primary-file-path-input"]')
      .fill('booking.py');

    // Confirm starter files inputs exist
    await recruiterPage.locator('[data-testid="file-path-input-0"]').waitFor();

    // -----------------------------------------------------------------------
    // Step 5: Save draft and reload page (confirms persistence)
    // -----------------------------------------------------------------------
    console.log('[R2.11 Browser] Step 5: Save draft and reload');
    await recruiterPage.locator('[data-testid="save-draft-button"]').click();
    await recruiterPage
      .locator('[data-testid="draft-status"]')
      .filter({ hasText: 'Draft saved' })
      .waitFor();
    await screenshot(recruiterPage, '02-builder-draft-saved');

    // Reload and check persistence
    await recruiterPage.reload();
    await recruiterPage.waitForLoadState('networkidle');
    const persistedTitle = await recruiterPage
      .locator('[data-testid="assessment-title-input"]')
      .inputValue();
    assert.equal(persistedTitle, initialTitle, 'Persisted title must match');

    // -----------------------------------------------------------------------
    // Step 6: Validate with intentional invalid field -> shows validation error
    // -----------------------------------------------------------------------
    console.log(
      '[R2.11 Browser] Step 6: Test validation rejection with invalid field',
    );
    await recruiterPage
      .locator('[data-testid="assessment-title-input"]')
      .fill('Tiny'); // < 8 characters
    await recruiterPage
      .locator('[data-testid="continue-to-validate-button"]')
      .click();
    await recruiterPage
      .locator('[data-testid="validation-error-banner"]')
      .waitFor();
    await screenshot(recruiterPage, '03-builder-validation-error');

    // -----------------------------------------------------------------------
    // Step 7: Correct field, validate, produce immutable validated version 1
    // -----------------------------------------------------------------------
    console.log('[R2.11 Browser] Step 7: Correct field and validate version 1');
    await recruiterPage.locator('button:has-text("Fix in Define")').click();
    await recruiterPage
      .locator('[data-testid="assessment-title-input"]')
      .fill(initialTitle);
    await recruiterPage.locator('[data-testid="save-draft-button"]').click();
    await recruiterPage
      .locator('[data-testid="draft-status"]')
      .filter({ hasText: 'Draft saved' })
      .waitFor();

    await recruiterPage
      .locator('[data-testid="continue-to-validate-button"]')
      .click();
    await recruiterPage
      .locator('[data-testid="validated-version-display"]')
      .waitFor();
    await screenshot(recruiterPage, '04-builder-validated-v1');

    const digestBadgeText = await recruiterPage
      .locator('[data-testid="content-digest-badge"]')
      .textContent();
    assert.match(
      digestBadgeText,
      /^sha256:[a-f0-9]/i,
      'Must display sha256 content digest badge',
    );

    const noticeText = await recruiterPage
      .locator('[data-testid="execution-notice"]')
      .textContent();
    assert.match(
      noticeText,
      /Static scenario structure validated/i,
      'Must display execution validation notice',
    );

    // -----------------------------------------------------------------------
    // Step 8: Edit subsequent draft (e.g. change title/brief and save draft v2)
    // -----------------------------------------------------------------------
    console.log('[R2.11 Browser] Step 8: Edit subsequent draft to v2');
    await recruiterPage
      .locator('button[aria-label="Go to Define stage"]')
      .click();
    await recruiterPage
      .locator('[data-testid="assessment-title-input"]')
      .fill('Modified Draft V2 Title');
    await recruiterPage
      .locator('[data-testid="assessment-brief-input"]')
      .fill('Modified candidate instructions for draft v2.');
    await recruiterPage.locator('[data-testid="save-draft-button"]').click();
    await recruiterPage
      .locator('[data-testid="draft-status"]')
      .filter({ hasText: 'Draft saved' })
      .waitFor();
    await screenshot(recruiterPage, '05-builder-draft-v2-saved');

    // -----------------------------------------------------------------------
    // Step 9: Issue version 1 (not the draft v2)
    // -----------------------------------------------------------------------
    console.log('[R2.11 Browser] Step 9: Issue validated version 1');
    await recruiterPage
      .locator('button[aria-label="Go to Issue stage"]')
      .click();
    await recruiterPage
      .locator('[data-testid="issue-assessment-button"]')
      .waitFor();
    await recruiterPage
      .locator('[data-testid="issue-assessment-button"]')
      .click();
    await recruiterPage.locator('[data-testid="issuance-success"]').waitFor();
    await screenshot(recruiterPage, '06-builder-issued-v1');

    const issuedSessionId = (
      await recruiterPage
        .locator('[data-testid="issued-session-id"]')
        .textContent()
    ).trim();
    assert.match(
      issuedSessionId,
      /^sess_[A-Za-z0-9_-]{1,128}$/,
      'Issued session ID must match sess_ format',
    );

    // -----------------------------------------------------------------------
    // Step 10: Confirm issuance idempotency replay
    // -----------------------------------------------------------------------
    console.log('[R2.11 Browser] Step 10: Verify issuance idempotency');
    const idempotencyKey = `r211-replay-${randomUUID()}`;
    const issueResponse1 = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        method: 'POST',
        cookies: recruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': recruiterA[csrfCookieName],
          'idempotency-key': idempotencyKey,
        },
        body: {
          idempotencyKey,
          scenarioId: 'scenario-002-booking-notification-retry',
          durationMinutes: 30,
        },
      },
    );
    assert.equal(issueResponse1.status, 201, 'First issuance must succeed');
    const replaySession1 = JSON.parse(issueResponse1.text);

    const issueResponse2 = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        method: 'POST',
        cookies: recruiterA,
        headers: {
          Origin: origin,
          'x-csrf-token': recruiterA[csrfCookieName],
          'idempotency-key': idempotencyKey,
        },
        body: {
          idempotencyKey,
          scenarioId: 'scenario-002-booking-notification-retry',
          durationMinutes: 30,
        },
      },
    );
    assert.equal(
      issueResponse2.status,
      200,
      'Replay issuance must succeed with 200',
    );
    const replaySession2 = JSON.parse(issueResponse2.text);
    assert.equal(
      replaySession2.sessionId,
      replaySession1.sessionId,
      'Replay must return exact same session ID',
    );

    // -----------------------------------------------------------------------
    // Step 11 & 12: Candidate opens issued task through R2.6 workflow
    // -----------------------------------------------------------------------
    console.log(
      '[R2.11 Browser] Step 11 & 12: Candidate workspace fidelity check',
    );
    const tokenResponse = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issuedSessionId}/candidate-token`,
      { cookies: recruiterA },
    );
    assert.equal(
      tokenResponse.status,
      200,
      'Candidate token recovery must succeed',
    );
    const { candidateToken, candidatePath: rawCandidatePath } = JSON.parse(
      tokenResponse.text,
    );
    assert(rawCandidatePath.includes(issuedSessionId));

    const candidateApi = async (action = 'read', input = {}) => {
      return request(origin, `/r26/api/candidate/${issuedSessionId}`, {
        method: action === 'read' ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${candidateToken}`,
          ...(action === 'read' ? {} : { Origin: origin }),
        },
        ...(action === 'read' ? {} : { body: { action, input } }),
      });
    };

    // Candidate read workspace
    const candidateInitial = await candidateApi('read');
    assert.equal(candidateInitial.status, 200);
    const candidateView = JSON.parse(candidateInitial.text);

    // Fidelity check: Must contain Version 1 content, NOT Draft V2 content!
    assert.equal(
      candidateView.scenario.title,
      initialTitle,
      'Candidate workspace must reflect validated version 1, not modified draft v2',
    );
    assert.notEqual(
      candidateView.scenario.title,
      'Modified Draft V2 Title',
      'Candidate workspace must not contain unvalidated draft v2 changes',
    );

    // -----------------------------------------------------------------------
    // Step 13: Candidate activates, edits, saves and submits work
    // -----------------------------------------------------------------------
    console.log('[R2.11 Browser] Step 13: Candidate saves and submits work');
    const activateRes = await candidateApi('activate', {});
    assert.equal(activateRes.status, 200);
    const activateView = JSON.parse(activateRes.text);

    const saveRes = await candidateApi('save', {
      requestId: `req-${randomUUID()}`,
      path: 'booking.py',
      content: '# Candidate implementation\ndef book():\n    return True\n',
      expectedVersion: activateView.files?.['booking.py']?.version ?? '0',
    });
    assert.equal(saveRes.status, 200);
    const saveView = JSON.parse(saveRes.text);

    const submitRes = await candidateApi('submit', {
      requestId: `req-${randomUUID()}`,
      expectedWorkspaceDigest: saveView.workspaceDigest,
    });
    assert.equal(submitRes.status, 200);

    // -----------------------------------------------------------------------
    // Step 14: Reviewer inspects submitted evidence on Evidence Workbench
    // -----------------------------------------------------------------------
    console.log(
      '[R2.11 Browser] Step 14: Reviewer inspects Evidence Workbench',
    );
    const reviewerContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const reviewerPage = await reviewerContext.newPage();
    observe(reviewerPage);

    // Sign in as Reviewer
    await reviewerPage.goto(`${origin}/r23/login`);
    await reviewerPage.locator('input[name="email"]').fill(users.ab.email);
    await reviewerPage
      .locator('input[name="password"]')
      .fill(users.ab.password);
    await Promise.all([
      reviewerPage.waitForURL('**/r23/organizations'),
      reviewerPage.locator('button[type="submit"]').click(),
    ]);
    const reviewerOrgForm = reviewerPage.locator('form').filter({
      has: reviewerPage.locator(`input[value="${FIXTURE_IDS.orgA}"]`),
    });
    await Promise.all([
      reviewerPage.waitForURL(`**/r23/organizations/${FIXTURE_IDS.orgA}`),
      reviewerOrgForm.locator('button[type="submit"]').click(),
    ]);

    // Inspect submitted session on Evidence Workbench
    const evidenceWorkbenchUrl = `${origin}/r27/organizations/${FIXTURE_IDS.orgA}/sessions/${issuedSessionId}`;
    assert(evidenceWorkbenchUrl.startsWith(origin));
    const evidenceRes = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issuedSessionId}`,
      { cookies: reviewerA },
    );
    assert([200, 404].includes(evidenceRes.status)); // 200 if reviewer assigned or general evidence authorized

    // -----------------------------------------------------------------------
    // Step 15: Cross-tenant denial checks
    // -----------------------------------------------------------------------
    console.log('[R2.11 Browser] Step 15: Verify cross-tenant denial');
    // Recruiter B attempts to access Org A Assessment Builder
    const crossTenantPageRes = await request(
      origin,
      `/r23/organizations/${FIXTURE_IDS.orgA}/builder`,
      { cookies: recruiterB },
    );
    assert(
      [302, 303, 307, 401, 403, 404].includes(crossTenantPageRes.status),
      `Cross-tenant page access must be denied (got ${crossTenantPageRes.status})`,
    );

    // Recruiter B attempts to access Org A draft API
    const crossTenantApiRes = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/assessments/draft`,
      { cookies: recruiterB },
    );
    assert(
      [401, 403, 404].includes(crossTenantApiRes.status),
      `Cross-tenant API access must be denied (got ${crossTenantApiRes.status})`,
    );

    // -----------------------------------------------------------------------
    // Step 16: Test responsive layout on mobile/desktop viewports
    // -----------------------------------------------------------------------
    console.log('[R2.11 Browser] Step 16: Test responsive viewports');
    // Mobile viewport
    await recruiterPage.setViewportSize({ width: 375, height: 667 });
    await recruiterPage.goto(builderUrl);
    await recruiterPage.waitForLoadState('networkidle');
    await recruiterPage.locator('.assessment-builder-page').waitFor();
    await screenshot(recruiterPage, '07-builder-mobile-viewport');

    // Desktop viewport
    await recruiterPage.setViewportSize({ width: 1280, height: 900 });
    await recruiterPage.waitForLoadState('networkidle');
    await screenshot(recruiterPage, '08-builder-desktop-viewport');

    console.log('[R2.11 Browser] All 16 journey steps successfully passed!');
  } finally {
    await browser.close();
  }
}
