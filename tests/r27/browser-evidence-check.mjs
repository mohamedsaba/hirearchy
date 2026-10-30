import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIXTURE_IDS } from '../../database/postgres/r23/adapter.mjs';
import { loadPlaywright } from '../r25/browser-issuance-check.mjs';

const csrfCookieName = '__Host-r23-csrf';

export async function runR27BrowserEvidenceChecks({
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

  const http = [];
  const pageErrors = [];
  const consoleErrors = [];
  const recruiter = await signInAndSelectOrg(origin, users.a, FIXTURE_IDS.orgA);
  const reviewer = await signInAndSelectOrg(origin, users.ab, FIXTURE_IDS.orgA);

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
        idempotencyKey: `r27-browser-${randomUUID()}`,
        scenarioId: 'scenario-002-booking-notification-retry',
        durationMinutes: 30,
      },
    },
  );
  http.push({ operation: 'issue', status: issuedResponse.status });
  assert.equal(issuedResponse.status, 201, issuedResponse.text);
  const issued = JSON.parse(issuedResponse.text);

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

  const bearerOnlyEvidence = await request(
    origin,
    `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/evidence`,
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${recovered.candidateToken}`,
      },
    },
  );
  http.push({
    operation: 'candidate_bearer_evidence_read',
    status: bearerOnlyEvidence.status,
  });
  assert.equal(bearerOnlyEvidence.status, 401);
  assert.match(bearerOnlyEvidence.headers['cache-control'] ?? '', /private/);
  assert.match(bearerOnlyEvidence.headers['cache-control'] ?? '', /no-store/);

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
  const screenshot = (page, name) =>
    page.screenshot({
      path: join(evidence, `r27-${name}.png`),
      fullPage: true,
    });

  const candidateRead = async () => {
    const response = await candidateCall();
    assert.equal(response.status, 200, response.text);
    return JSON.parse(response.text);
  };
  const waitCandidateWorkspace = async () => {
    await candidatePage.getByLabel('Workspace file').waitFor();
    await candidatePage
      .getByLabel('Workspace file')
      .selectOption('bookings/service.py');
    await candidatePage.locator('.cm-content').waitFor();
  };
  const authoritativeEditorText = async () =>
    candidatePage.evaluate(() => {
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
      if (!view?.state?.doc)
        throw new Error('CodeMirror EditorView unavailable');
      return view.state.doc.toString();
    });
  const appendInEditor = async (text) => {
    const editor = candidatePage.locator('.cm-content');
    await editor.click();
    await editor.press('ControlOrMeta+End');
    await editor.press('End');
    await editor.press('Enter');
    await editor.pressSequentially(text);
  };

  let submitted;
  let assignmentId;
  try {
    await candidatePage.goto(origin + recovered.candidatePath);
    await candidatePage
      .getByRole('button', { name: 'Activate assessment', exact: true })
      .waitFor();
    assert.equal(new URL(candidatePage.url()).hash, '');
    const activatedResponse = candidatePage.waitForResponse(
      (response) =>
        response.url().endsWith(candidatePath) &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.action === 'activate',
    );
    await candidatePage
      .getByRole('button', { name: 'Activate assessment', exact: true })
      .click();
    assert.equal((await activatedResponse).status(), 200);
    await waitCandidateWorkspace();
    await appendInEditor('# r27-browser-submitted-evidence');
    const saveResponse = candidatePage.waitForResponse(
      (response) =>
        response.url().endsWith(candidatePath) &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.action === 'save',
    );
    await candidatePage
      .getByRole('button', { name: 'Save work', exact: true })
      .click();
    assert.equal((await saveResponse).status(), 200);

    let candidateState = await candidateRead();
    let currentFile = candidateState.files.find(
      (file) => file.path === 'bookings/service.py',
    );
    assert.ok(currentFile);
    for (let index = 0; index < 50; index += 1) {
      const save = await candidateCall('save', {
        requestId: randomUUID(),
        path: currentFile.path,
        content: `${currentFile.content}\n# r27-pagination-${index}`,
        expectedVersion: currentFile.version,
      });
      assert.equal(save.status, 200, save.text);
      candidateState = JSON.parse(save.text);
      currentFile = candidateState.files.find(
        (file) => file.path === 'bookings/service.py',
      );
      assert.ok(currentFile);
    }

    assert.match(currentFile.content, /r27-pagination-49/);
    await candidatePage.reload();
    await waitCandidateWorkspace();
    await candidatePage.waitForFunction(
      (marker) => {
        const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
        return Boolean(view?.state?.doc?.toString().includes(marker));
      },
      'r27-pagination-49',
      { timeout: 15000 },
    );
    assert.match(await authoritativeEditorText(), /r27-pagination-49/);
    const submitResponse = candidatePage.waitForResponse(
      (response) =>
        response.url().endsWith(candidatePath) &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.action === 'submit',
    );
    await candidatePage
      .getByRole('button', { name: 'Submit assessment', exact: true })
      .click();
    assert.equal((await submitResponse).status(), 200);
    await candidatePage
      .getByText('Submitted', { exact: true })
      .first()
      .waitFor();
    submitted = await candidateRead();
    assert.equal(submitted.status, 'SUBMITTED');
    assert.equal(submitted.closureReason, 'candidate_submission');
    assert.match(
      submitted.submission.files.find((file) => file.path === currentFile.path)
        .content,
      /r27-browser-submitted-evidence/,
    );
    assert.ok(submitted.events.length > 50);
    await screenshot(candidatePage, '01-candidate-submitted');
    await stop();
    await start();
    await candidatePage.goto(origin + recovered.candidatePath);
    await candidatePage
      .getByText('Submitted', { exact: true })
      .first()
      .waitFor();
    assert.deepEqual((await candidateRead()).submission, submitted.submission);

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
    http.push({
      operation: 'assign_reviewer',
      status: assignmentResponse.status,
    });
    assert.equal(assignmentResponse.status, 201, assignmentResponse.text);
    assignmentId = JSON.parse(assignmentResponse.text).assignmentId;
    assert.ok(assignmentId);

    const evidencePath = `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/evidence`;
    const recruiterDenied = await request(origin, evidencePath, {
      cookies: recruiter,
      headers: { Accept: 'application/json' },
    });
    http.push({
      operation: 'unassigned_recruiter_evidence_read',
      status: recruiterDenied.status,
    });
    assert.equal(recruiterDenied.status, 404, recruiterDenied.text);
    assert.match(recruiterDenied.headers['cache-control'] ?? '', /no-store/);

    const reviewerWithoutSelection = await signInAndSelectOrg(
      origin,
      users.ab,
      null,
    );
    const missingSelectionDenied = await request(origin, evidencePath, {
      cookies: reviewerWithoutSelection,
      headers: { Accept: 'application/json' },
    });
    http.push({
      operation: 'reviewer_without_selected_org',
      status: missingSelectionDenied.status,
    });
    assert.equal(
      missingSelectionDenied.status,
      403,
      missingSelectionDenied.text,
    );

    const reviewerWrongOrg = await signInAndSelectOrg(
      origin,
      users.ab,
      FIXTURE_IDS.orgB,
    );
    const wrongSelectionDenied = await request(origin, evidencePath, {
      cookies: reviewerWrongOrg,
      headers: { Accept: 'application/json' },
    });
    http.push({
      operation: 'reviewer_selected_wrong_org',
      status: wrongSelectionDenied.status,
    });
    assert.equal(wrongSelectionDenied.status, 403, wrongSelectionDenied.text);

    const reviewerB = await signInAndSelectOrg(
      origin,
      users.b,
      FIXTURE_IDS.orgB,
    );
    const foreignOrgDenied = await request(origin, evidencePath, {
      cookies: reviewerB,
      headers: { Accept: 'application/json' },
    });
    http.push({
      operation: 'reviewer_b_foreign_org_session',
      status: foreignOrgDenied.status,
    });
    assert.equal(foreignOrgDenied.status, 403, foreignOrgDenied.text);
    for (const denied of [
      missingSelectionDenied,
      wrongSelectionDenied,
      foreignOrgDenied,
    ]) {
      assert.match(denied.headers['cache-control'] ?? '', /private/);
      assert.match(denied.headers['cache-control'] ?? '', /no-store/);
    }

    const firstPageResponse = await request(
      origin,
      `${evidencePath}?limit=50`,
      {
        cookies: reviewer,
        headers: { Accept: 'application/json' },
      },
    );
    http.push({
      operation: 'reviewer_evidence_page_one',
      status: firstPageResponse.status,
    });
    assert.equal(firstPageResponse.status, 200, firstPageResponse.text);
    assert.match(firstPageResponse.headers['cache-control'] ?? '', /private/);
    assert.match(firstPageResponse.headers['cache-control'] ?? '', /no-store/);
    const firstPage = JSON.parse(firstPageResponse.text);
    assert.equal(
      firstPageResponse.text.includes(recovered.candidateToken),
      false,
    );
    assert.doesNotMatch(
      firstPageResponse.text,
      /candidate_token|ciphertext|credentialEnvelope/,
    );
    assert.equal(firstPage.permission, 'assigned_reviewer');
    assert.equal(firstPage.events.length, 50);
    assert.notEqual(firstPage.pagination.nextAfterSequence, null);
    assert.equal(typeof firstPage.events.at(-1).sequence, 'string');

    const nextAfterSequence = firstPage.pagination.nextAfterSequence;
    const otherIssue = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions`,
      {
        method: 'POST',
        cookies: recruiter,
        headers: { Origin: origin, 'x-csrf-token': recruiter[csrfCookieName] },
        body: {
          idempotencyKey: `r27-unassigned-${randomUUID()}`,
          scenarioId: 'scenario-002-booking-notification-retry',
          durationMinutes: 30,
        },
      },
    );
    assert.equal(otherIssue.status, 201);
    const otherId = JSON.parse(otherIssue.text).sessionId;
    const otherRecovery = await request(
      origin,
      `/r23/api/organizations/${FIXTURE_IDS.orgA}/sessions/${otherId}/candidate-token`,
      { cookies: recruiter },
    );
    assert.equal(otherRecovery.status, 200);
    const otherToken = JSON.parse(otherRecovery.text).candidateToken;
    const otherCandidatePath = `/r26/api/candidate/${otherId}`;
    const otherActivation = await request(origin, otherCandidatePath, {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${otherToken}` },
      body: { action: 'activate', input: {} },
    });
    assert.equal(otherActivation.status, 200);
    const otherSubmit = await request(origin, otherCandidatePath, {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${otherToken}` },
      body: {
        action: 'submit',
        input: {
          requestId: randomUUID(),
          expectedWorkspaceDigest: JSON.parse(otherActivation.text)
            .workspaceDigest,
        },
      },
    });
    assert.equal(otherSubmit.status, 200);
    const craftedSessionRead = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${otherId}/evidence?limit=1&afterSequence=0`,
      { cookies: reviewer, headers: { Accept: 'application/json' } },
    );
    http.push({
      operation: 'same_org_unassigned_crafted_session_url',
      status: craftedSessionRead.status,
    });
    assert.equal(craftedSessionRead.status, 404);
    assert.deepEqual(Object.keys(JSON.parse(craftedSessionRead.text)), [
      'error',
    ]);
    assert.match(craftedSessionRead.headers['cache-control'] ?? '', /private/);
    assert.match(craftedSessionRead.headers['cache-control'] ?? '', /no-store/);

    const secondPageResponse = await request(
      origin,
      `${evidencePath}?afterSequence=${encodeURIComponent(nextAfterSequence)}&limit=50`,
      {
        cookies: reviewer,
        headers: { Accept: 'application/json' },
      },
    );
    http.push({
      operation: 'reviewer_evidence_page_two',
      status: secondPageResponse.status,
    });
    assert.equal(secondPageResponse.status, 200, secondPageResponse.text);
    const secondPage = JSON.parse(secondPageResponse.text);
    assert.ok(secondPage.events.length > 0);
    assert.notEqual(
      secondPage.events[0].sequence,
      firstPage.events.at(-1).sequence,
    );
    assert.deepEqual(secondPage.submission, firstPage.submission);

    await reviewerPage.goto(`${origin}/r23/login`);
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
    await screenshot(reviewerPage, '02-reviewer-session-summary');
    await workbenchLink.click();
    await reviewerPage
      .getByRole('tab', { name: 'Summary', exact: true })
      .waitFor();
    assert.match(
      await reviewerPage.locator('body').innerText(),
      /Submitted evidence/,
    );
    assert.equal(
      await reviewerPage
        .locator('.software-product-header')
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      'rgb(41, 30, 54)',
      'Workbench retains the existing product design tokens',
    );
    const expectedBrief = JSON.parse(firstPage.scenario.snapshotText).scenario
      .brief;
    assert.equal(
      (await reviewerPage.locator('body').innerText())
        .replace(/\s+/g, ' ')
        .includes(expectedBrief.replace(/\s+/g, ' ')),
      true,
      'Workbench displays the actual issued scenario brief',
    );
    assert.match(
      await reviewerPage.locator('body').innerText(),
      /Manifest digest/,
    );
    assert.equal(await reviewerPage.locator('#open-quick-note').count(), 0);
    assert.equal(
      await reviewerPage.locator('#review-workflow form').count(),
      0,
    );
    await screenshot(reviewerPage, '03-workbench-summary');

    const loadMore = reviewerPage
      .getByRole('button', {
        name: 'Load more recorded events',
      })
      .first();
    await loadMore.waitFor();
    await loadMore.click();
    await reviewerPage
      .getByText(
        `${secondPage.events.length + firstPage.events.length} events available`,
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await reviewerPage
        .getByRole('button', { name: 'Load more recorded events' })
        .count(),
      0,
    );

    const openFile = reviewerPage
      .locator('.evaluator-submitted-file-list li')
      .filter({
        has: reviewerPage.getByText('bookings/service.py', { exact: true }),
      })
      .getByRole('button', { name: 'Open contents and derived diff →' });
    await openFile.click();
    await reviewerPage
      .getByRole('heading', { name: 'Derived starter-to-submission diff' })
      .waitFor();
    assert.match(
      await reviewerPage.locator('body').innerText(),
      /r27-browser-submitted-evidence/,
    );
    assert.match(
      await reviewerPage.locator('body').innerText(),
      /Stable source reference/,
    );
    await reviewerPage
      .getByText('Stable source reference', { exact: true })
      .click();
    assert.equal(
      await reviewerPage
        .getByRole('button', { name: 'Copy source reference' })
        .count(),
      1,
    );
    await screenshot(reviewerPage, '04-workbench-file-diff');

    await reviewerPage.setViewportSize({ width: 390, height: 844 });
    const filePanelOverflow = await reviewerPage
      .locator('pre[aria-label^="Derived diff for "]')
      .evaluate((element) => getComputedStyle(element).overflowX);
    assert.equal(filePanelOverflow, 'auto');
    const horizontalOverflow = await reviewerPage.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert.equal(
      horizontalOverflow,
      false,
      'R2.7 Workbench does not overflow a 390 px viewport',
    );
    await screenshot(reviewerPage, '05-workbench-responsive');

    await reviewerPage.setViewportSize({ width: 375, height: 667 });
    assert.equal(
      await reviewerPage.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
      'R2.7 Workbench does not overflow a 375 px viewport',
    );
    await screenshot(reviewerPage, '05d-workbench-mobile-375');

    await reviewerPage.setViewportSize({ width: 768, height: 1024 });
    assert.equal(
      await reviewerPage.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
      'R2.7 Workbench does not overflow a 768 px viewport',
    );
    await screenshot(reviewerPage, '05c-workbench-tablet');

    await reviewerPage.setViewportSize({ width: 1440, height: 900 });
    assert.equal(
      await reviewerPage.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
      'R2.7 Workbench does not overflow a 1440 px viewport',
    );

    await reviewerPage.setViewportSize({ width: 390, height: 844 });
    await reviewerPage
      .getByRole('tab', { name: 'Summary', exact: true })
      .click();
    await reviewerPage
      .getByText('Open immutable scenario snapshot', { exact: true })
      .click();
    const snapshotPanelOverflow = await reviewerPage
      .locator('pre[aria-label="Immutable versioned scenario snapshot"]')
      .evaluate((element) => getComputedStyle(element).overflowX);
    assert.equal(snapshotPanelOverflow, 'auto');
    await screenshot(reviewerPage, '05b-expanded-snapshot-responsive');
    assert.equal(
      await reviewerPage.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
      'Expanded scenario snapshot stays within its scroll panel',
    );
    await reviewerPage
      .getByText('Open immutable scenario snapshot', { exact: true })
      .click();
    await reviewerPage.setViewportSize({ width: 1440, height: 900 });

    await reviewerPage
      .getByRole('tab', { name: 'Evidence', exact: true })
      .click();
    await reviewerPage
      .getByRole('tab', { name: 'Chronology', exact: true })
      .click();
    const eventRow = reviewerPage
      .getByRole('button', { name: /Workspace save recorded/ })
      .first();
    await eventRow.click();
    await reviewerPage
      .getByText('hirearchy.candidate_session_events', { exact: true })
      .waitFor();
    assert.match(await reviewerPage.locator('body').innerText(), /Sequence/);
    assert.match(
      await reviewerPage.locator('body').innerText(),
      /intermediate file content is unavailable/i,
    );
    await screenshot(reviewerPage, '06-workbench-timeline');

    // 20. Cross-organization or unauthorized session access is denied
    const crossOrgEvidence = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgB}/sessions/${issued.sessionId}/evidence`,
      {
        cookies: reviewer,
        headers: { Accept: 'application/json' },
      },
    );
    http.push({
      operation: 'cross_organization_evidence_denied',
      status: crossOrgEvidence.status,
    });
    assert.equal(crossOrgEvidence.status, 403, crossOrgEvidence.text);

    // 23 & 24. Next.js restart preserves the frozen evidence and enforces authorization
    const evidenceWorkbenchUrl = `${origin}/r27/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}`;
    await reviewerPage.goto('about:blank');
    await stop();
    await start();
    const restartPageResponse = await reviewerPage.goto(evidenceWorkbenchUrl);
    assert.equal(restartPageResponse.status(), 200);
    await reviewerPage
      .getByRole('tab', { name: 'Summary', exact: true })
      .waitFor();
    assert.match(
      await reviewerPage.locator('body').innerText(),
      /Submitted evidence/,
    );
    assert.match(
      await reviewerPage.locator('body').innerText(),
      /Manifest digest/,
    );
    await screenshot(reviewerPage, '07-server-restart-preserved');
    await reviewerPage.goto('about:blank');

    // 21. Assignment revocation denies subsequent evidence requests
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
    http.push({
      operation: 'revoke_reviewer_assignment',
      status: revokeResponse.status,
    });
    assert.equal(revokeResponse.status, 200, revokeResponse.text);

    const revokedRead = await request(origin, evidencePath, {
      cookies: reviewer,
      headers: { Accept: 'application/json' },
    });
    http.push({
      operation: 'reviewer_evidence_after_revocation',
      status: revokedRead.status,
    });
    assert.equal(revokedRead.status, 404, revokedRead.text);
    assert.deepEqual((await candidateRead()).submission, submitted.submission);

    const revokedPageResponse = await reviewerPage.goto(evidenceWorkbenchUrl);
    assert.equal(revokedPageResponse.status(), 404);
    await screenshot(reviewerPage, '08-assignment-revocation-denied');
    await reviewerPage.goto('about:blank');

    // Reviewer reassignment restores evidence access
    const reassignmentResponse = await request(
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
    http.push({
      operation: 'reassign_reviewer',
      status: reassignmentResponse.status,
    });
    assert.equal(reassignmentResponse.status, 201, reassignmentResponse.text);
    const currentAssignmentId = JSON.parse(
      reassignmentResponse.text,
    ).assignmentId;
    assert.ok(currentAssignmentId);
    const reassignedRead = await request(origin, evidencePath, {
      cookies: reviewer,
      headers: { Accept: 'application/json' },
    });
    http.push({
      operation: 'reviewer_evidence_after_reassignment',
      status: reassignedRead.status,
    });
    assert.equal(reassignedRead.status, 200, reassignedRead.text);
    assert.equal(
      JSON.parse(reassignedRead.text).permission,
      'assigned_reviewer',
    );

    const reassignedPageResponse =
      await reviewerPage.goto(evidenceWorkbenchUrl);
    assert.equal(reassignedPageResponse.status(), 200);
    await reviewerPage.goto('about:blank');

    // 22. Membership revocation denies subsequent evidence requests
    await admin.query(
      "UPDATE hirearchy.organization_memberships SET status='revoked', revoked_at=pg_catalog.clock_timestamp(), version=version+1 WHERE organization_id=$1 AND principal_id=$2",
      [FIXTURE_IDS.orgA, FIXTURE_IDS.userAB.principalId],
    );
    await stop();
    await start();
    const revokedMembershipRead = await request(origin, evidencePath, {
      cookies: reviewer,
      headers: { Accept: 'application/json' },
    });
    http.push({
      operation: 'reviewer_evidence_after_membership_revocation',
      status: revokedMembershipRead.status,
    });
    assert.equal(revokedMembershipRead.status, 403, revokedMembershipRead.text);
    assert.deepEqual((await candidateRead()).submission, submitted.submission);

    const revokedMembershipPageResponse =
      await reviewerPage.goto(evidenceWorkbenchUrl);
    assert.equal(revokedMembershipPageResponse.status(), 404);
    await screenshot(reviewerPage, '09-membership-revocation-denied');
    await reviewerPage.goto('about:blank');

    assert.deepEqual(pageErrors, [], 'No browser page errors');
    const allowedHmrReconnect =
      /^WebSocket connection to 'wss:\/\/127\.0\.0\.1:\d+\/_next\/hmr\?id=[^']+' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED$/;
    const allowedRevocationStatusMessage =
      /^Failed to load resource: the server responded with a status of (?:403|404) \(.*\)$/;
    const unexpectedConsoleErrors = consoleErrors.filter(
      (message) =>
        !allowedHmrReconnect.test(message) &&
        !allowedRevocationStatusMessage.test(message),
    );
    assert.deepEqual(
      unexpectedConsoleErrors,
      [],
      `Unexpected browser console errors: ${JSON.stringify(unexpectedConsoleErrors)}`,
    );

    writeFileSync(
      join(evidence, 'r27-browser-evidence.json'),
      JSON.stringify(
        {
          http,
          pageErrors,
          consoleErrors,
          sessionId: issued.sessionId,
          reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
          assignmentId,
          submission: {
            workspaceDigest: submitted.submission.workspaceDigest,
            manifestDigest: submitted.submission.manifestDigest,
            eventCount: submitted.events.length,
          },
          pagination: {
            firstPageCount: firstPage.events.length,
            secondPageCount: secondPage.events.length,
            firstCursor: firstPage.pagination.nextAfterSequence,
          },
          screenshots: [
            'r27-01-candidate-submitted.png',
            'r27-02-reviewer-session-summary.png',
            'r27-03-workbench-summary.png',
            'r27-04-workbench-file-diff.png',
            'r27-05-workbench-responsive.png',
            'r27-05b-expanded-snapshot-responsive.png',
            'r27-05c-workbench-tablet.png',
            'r27-05d-workbench-mobile-375.png',
            'r27-06-workbench-timeline.png',
            'r27-07-server-restart-preserved.png',
            'r27-08-assignment-revocation-denied.png',
            'r27-09-membership-revocation-denied.png',
          ],
        },
        null,
        2,
      ),
    );
    console.log(
      'PASS R2.7 assigned reviewer evidence Workbench, source provenance, bounded pagination, read-only boundaries, revocation, restart and responsive viewport',
    );
  } finally {
    await candidateContext.close();
    await reviewerContext.close();
    await browser.close();
  }
}
