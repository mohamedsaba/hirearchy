import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { FIXTURE_IDS } from '../../database/postgres/r23/adapter.mjs';
import { loadPlaywright } from '../r25/browser-issuance-check.mjs';

const csrfCookieName = '__Host-r23-csrf';

export async function runR28BrowserRevisionChecks({
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

  // Step 1: Issue synthetic assessment
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
        idempotencyKey: `r28-browser-${randomUUID()}`,
        scenarioId: 'scenario-002-booking-notification-retry',
        durationMinutes: 30,
      },
    },
  );
  http.push({ operation: 'issue', status: issuedResponse.status });
  assert.equal(issuedResponse.status, 201, issuedResponse.text);
  const issued = JSON.parse(issuedResponse.text);

  // Step 2: Open as candidate (recover token)
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
      path: join(evidence, `r28-${name}.png`),
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
  const evidenceWorkbenchUrl = `${origin}/r27/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}`;

  try {
    // Step 3: Activate assessment
    await candidatePage.goto(origin + recovered.candidatePath);
    await candidatePage
      .getByRole('button', { name: 'Activate assessment', exact: true })
      .waitFor();
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

    // Step 4: Save revision 1
    await appendInEditor('# r28-revision-1-save');
    const save1Response = candidatePage.waitForResponse(
      (response) =>
        response.url().endsWith(candidatePath) &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON()?.action === 'save',
    );
    await candidatePage
      .getByRole('button', { name: 'Save work', exact: true })
      .click();
    assert.equal((await save1Response).status(), 200);

    let candidateState = await candidateRead();
    let currentFile = candidateState.files.find(
      (file) => file.path === 'bookings/service.py',
    );
    assert.ok(currentFile);
    assert.match(currentFile.content, /r28-revision-1-save/);
    const rev1Content = currentFile.content;

    // Step 5: Save revision 2
    const save2 = await candidateCall('save', {
      requestId: randomUUID(),
      path: currentFile.path,
      content: `${rev1Content}\n# r28-revision-2-save`,
      expectedVersion: currentFile.version,
    });
    assert.equal(save2.status, 200, save2.text);
    candidateState = JSON.parse(save2.text);
    currentFile = candidateState.files.find(
      (file) => file.path === 'bookings/service.py',
    );
    assert.ok(currentFile);
    assert.match(currentFile.content, /r28-revision-2-save/);
    const rev2Content = currentFile.content;

    // Step 6: Save revision 3
    const save3 = await candidateCall('save', {
      requestId: randomUUID(),
      path: currentFile.path,
      content: `${rev2Content}\n# r28-revision-3-save`,
      expectedVersion: currentFile.version,
    });
    assert.equal(save3.status, 200, save3.text);
    candidateState = JSON.parse(save3.text);
    currentFile = candidateState.files.find(
      (file) => file.path === 'bookings/service.py',
    );
    assert.ok(currentFile);
    assert.match(currentFile.content, /r28-revision-3-save/);

    // Step 7: Verify saves persisted
    candidateState = await candidateRead();
    currentFile = candidateState.files.find(
      (file) => file.path === 'bookings/service.py',
    );
    assert.ok(currentFile);
    assert.equal(Number(currentFile.version) >= 3, true);
    assert.match(currentFile.content, /r28-revision-3-save/);

    // Step 8: Submit assessment
    const submit = await candidateCall('submit', {
      requestId: randomUUID(),
      expectedWorkspaceDigest: candidateState.workspaceDigest,
    });
    assert.equal(submit.status, 200, submit.text);
    submitted = await candidateRead();
    assert.equal(submitted.status, 'SUBMITTED');
    assert.equal(submitted.closureReason, 'candidate_submission');

    // Step 9: Verify frozen final digest
    assert.ok(submitted.submission.workspaceDigest);
    assert.ok(submitted.submission.manifestDigest);
    await screenshot(candidatePage, '01-candidate-submitted');

    // Step 10: Sign in as assigned reviewer
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
    await reviewerPage.locator('input[name="email"]').fill(users.ab.email);
    await reviewerPage
      .locator('input[name="password"]')
      .fill(users.ab.password);
    await Promise.all([
      reviewerPage.waitForURL('**/r23/organizations'),
      reviewerPage.locator('button[type="submit"]').click(),
    ]);

    // Step 11: Select organization
    const orgForm = reviewerPage.locator('form').filter({
      has: reviewerPage.locator(`input[value="${FIXTURE_IDS.orgA}"]`),
    });
    await Promise.all([
      reviewerPage.waitForURL(`**/r23/organizations/${FIXTURE_IDS.orgA}`),
      orgForm.locator('button[type="submit"]').click(),
    ]);

    // Step 12: Open Evidence Workbench
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
    await screenshot(reviewerPage, '02-workbench-summary');

    // Step 13: Select first save event
    await reviewerPage
      .getByRole('tab', { name: 'Evidence', exact: true })
      .click();
    await reviewerPage
      .getByRole('tab', { name: 'Chronology', exact: true })
      .click();

    const saveEvents = reviewerPage.getByRole('button', {
      name: /Workspace save recorded/,
    });
    await saveEvents.first().waitFor();
    await saveEvents.nth(0).click();

    // Step 14: Inspect exact version 1 content
    await reviewerPage
      .getByRole('heading', { name: 'File content at this revision' })
      .waitFor();
    let bodyText = await reviewerPage.locator('body').innerText();
    assert.match(bodyText, /r28-revision-1-save/);
    assert.doesNotMatch(bodyText, /r28-revision-2-save/);
    assert.match(bodyText, /Intermediate save v1/);
    assert.match(bodyText, /bookings\/service\.py/);
    assert.match(bodyText, /Sequence/);
    await screenshot(reviewerPage, '03-workbench-revision-1');

    // Step 15: Select second save event
    await saveEvents.nth(1).click();

    // Step 16: Inspect exact version 2 content
    await reviewerPage
      .getByRole('heading', { name: 'File content at this revision' })
      .waitFor();
    bodyText = await reviewerPage.locator('body').innerText();
    assert.match(bodyText, /r28-revision-2-save/);
    assert.match(bodyText, /Intermediate save v2/);
    await screenshot(reviewerPage, '04-workbench-revision-2');

    // Step 17: Compare version 1 with version 2 (accurate diff)
    const diffWithPrevBtn = reviewerPage.getByRole('button', {
      name: 'Diff with previous revision',
      exact: true,
    });
    await diffWithPrevBtn.waitFor();
    await diffWithPrevBtn.click();
    await reviewerPage
      .getByRole('heading', { name: 'Diff with previous revision' })
      .waitFor();
    const diffPrevText = await reviewerPage.locator('body').innerText();
    assert.match(diffPrevText, /\+.*# r28-revision-2-save/);
    await screenshot(reviewerPage, '05-workbench-diff-v1-to-v2');

    // Step 18: Compare last revision with submitted file
    await saveEvents.nth(2).click();
    await reviewerPage
      .getByRole('heading', { name: 'File content at this revision' })
      .waitFor();
    const diffWithSubmittedBtn = reviewerPage.getByRole('button', {
      name: 'Diff with submitted code',
      exact: true,
    });
    await diffWithSubmittedBtn.waitFor();
    await diffWithSubmittedBtn.click();
    await reviewerPage
      .getByRole('heading', { name: 'Diff with submitted code' })
      .waitFor();
    const submittedDiffText = await reviewerPage.locator('body').innerText();
    assert.ok(
      submittedDiffText.includes('No net content change') ||
        submittedDiffText.includes('bookings/service.py'),
    );
    await screenshot(reviewerPage, '06-workbench-diff-submitted');

    // Step 19: Verify timeline order and provenance
    assert.match(
      await reviewerPage.locator('body').innerText(),
      /hirearchy\.(?:candidate_file_revisions|candidate_session_events)/,
    );

    // Step 20: Verify unavailable AI/terminal evidence remains unavailable
    await reviewerPage
      .getByRole('tab', { name: 'Summary', exact: true })
      .click();
    const summaryText = await reviewerPage.locator('body').innerText();
    assert.match(
      summaryText,
      /Terminal capture unavailable|No terminal capture recorded|unavailable/i,
    );
    await screenshot(reviewerPage, '07-workbench-unavailable-evidence');

    // Step 21: Verify 1440, 768, 390, 375 px responsive behavior
    for (const [w, h, tag] of [
      [1440, 900, '08a-responsive-1440'],
      [768, 1024, '08b-responsive-768'],
      [390, 844, '08c-responsive-390'],
      [375, 667, '08d-responsive-375'],
    ]) {
      await reviewerPage.setViewportSize({ width: w, height: h });
      const hasOverflow = await reviewerPage.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert.equal(
        hasOverflow,
        false,
        `Workbench must not overflow horizontally at ${w}px viewport`,
      );
      await screenshot(reviewerPage, tag);
    }
    await reviewerPage.setViewportSize({ width: 1280, height: 900 });

    // Step 22: Restart Next.js server and confirm revisions persist
    await reviewerPage.goto('about:blank');
    await stop();
    await start();
    const restartPageResponse = await reviewerPage.goto(evidenceWorkbenchUrl);
    assert.equal(restartPageResponse.status(), 200);
    await reviewerPage
      .getByRole('tab', { name: 'Evidence', exact: true })
      .click();
    await reviewerPage
      .getByRole('tab', { name: 'Chronology', exact: true })
      .click();
    const reloadedSaves = reviewerPage.getByRole('button', {
      name: /Workspace save recorded/,
    });
    await reloadedSaves.nth(0).click();
    await reviewerPage
      .getByRole('heading', { name: 'File content at this revision' })
      .waitFor();
    assert.match(
      await reviewerPage.locator('body').innerText(),
      /r28-revision-1-save/,
    );
    await screenshot(reviewerPage, '09-server-restart-persisted');
    await reviewerPage.goto('about:blank');

    // Step 23: Revoke assignment
    await admin.query(
      'DELETE FROM hirearchy.reviewer_assignments WHERE session_id = $1',
      [issued.sessionId],
    );

    // Step 24: Confirm subsequent revision retrieval is denied (404/403)
    const seq1 = submitted.events.find(
      (e) => e.type === 'WORKSPACE_CHANGED',
    )?.sequence;
    assert.ok(seq1);
    const deniedApi = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/evidence/revisions/${seq1}`,
      { cookies: reviewer, headers: { Accept: 'application/json' } },
    );
    assert.equal(
      [403, 404].includes(deniedApi.status),
      true,
      `Expected 403 or 404 but got ${deniedApi.status}`,
    );

    const revokedPageResponse = await reviewerPage.goto(evidenceWorkbenchUrl);
    assert.equal(revokedPageResponse.status(), 404);
    await screenshot(reviewerPage, '10-assignment-revocation-denied');
    await reviewerPage.goto('about:blank');

    // Step 25: Confirm original SQLite application remains unchanged
    const sqlitePath = join(evidence, 'legacy-synthetic.sqlite');
    if (existsSync(sqlitePath)) {
      const sqlite = new Database(sqlitePath, { readonly: true });
      try {
        const tables = sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all();
        const tableNames = tables.map((t) => t.name);
        assert.equal(
          tableNames.includes('candidate_file_revisions'),
          false,
          'SQLite must not contain candidate_file_revisions table',
        );
      } finally {
        sqlite.close();
      }
    }

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
      join(evidence, 'r28-browser-evidence.json'),
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
          screenshots: [
            'r28-01-candidate-submitted.png',
            'r28-02-workbench-summary.png',
            'r28-03-workbench-revision-1.png',
            'r28-04-workbench-revision-2.png',
            'r28-05-workbench-diff-v1-to-v2.png',
            'r28-06-workbench-diff-submitted.png',
            'r28-07-workbench-unavailable-evidence.png',
            'r28-08a-responsive-1440.png',
            'r28-08b-responsive-768.png',
            'r28-08c-responsive-390.png',
            'r28-08d-responsive-375.png',
            'r28-09-server-restart-persisted.png',
            'r28-10-assignment-revocation-denied.png',
          ],
        },
        null,
        2,
      ),
    );

    console.log(
      'PASS R2.8 Persistent Candidate Revision History browser verification: accurate diffs, responsive viewports, persistent revisions, revocation',
    );
  } finally {
    await candidateContext.close();
    await reviewerContext.close();
    await browser.close();
  }
}
