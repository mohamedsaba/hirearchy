import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { FIXTURE_IDS } from '../../database/postgres/r23/adapter.mjs';
import { loadPlaywright } from '../r25/browser-issuance-check.mjs';

const csrfCookieName = '__Host-r23-csrf';

export async function runR29BrowserObservationChecks({
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
        idempotencyKey: `r29-browser-${randomUUID()}`,
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
      path: join(evidence, `r29-${name}.png`),
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
  let observationId;
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
    await appendInEditor('# r29-observation-test-save');
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
    assert.match(currentFile.content, /r29-observation-test-save/);

    // Step 5: Submit assessment
    const submit = await candidateCall('submit', {
      requestId: randomUUID(),
      expectedWorkspaceDigest: candidateState.workspaceDigest,
    });
    assert.equal(submit.status, 200, submit.text);
    submitted = await candidateRead();
    assert.equal(submitted.status, 'SUBMITTED');
    assert.equal(submitted.closureReason, 'candidate_submission');

    await screenshot(candidatePage, '01-candidate-submitted');

    // Step 6: Assign reviewer
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

    // Step 7: Sign in as assigned reviewer
    await reviewerPage.goto(`${origin}/r23/login`);
    await reviewerPage.locator('input[name="email"]').fill(users.ab.email);
    await reviewerPage
      .locator('input[name="password"]')
      .fill(users.ab.password);
    await Promise.all([
      reviewerPage.waitForURL('**/r23/organizations'),
      reviewerPage.locator('button[type="submit"]').click(),
    ]);

    // Step 8: Select organization
    const orgForm = reviewerPage.locator('form').filter({
      has: reviewerPage.locator(`input[value="${FIXTURE_IDS.orgA}"]`),
    });
    await Promise.all([
      reviewerPage.waitForURL(`**/r23/organizations/${FIXTURE_IDS.orgA}`),
      orgForm.locator('button[type="submit"]').click(),
    ]);

    // Step 9: Open Evidence Workbench
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

    // Step 10: Select candidate save revision in Chronology
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

    await reviewerPage
      .getByRole('heading', { name: 'File content at this revision' })
      .waitFor();
    await screenshot(reviewerPage, '03-workbench-revision-selected');

    // Step 11: Inspect Anchored Observations section and evidence/interpretation distinction
    const observationSection = reviewerPage.locator(
      '.evaluator-observation-panel',
    );
    await observationSection.waitFor();
    const sectionText = await observationSection.innerText();
    assert.match(sectionText, /Anchored Observations/i);
    assert.match(sectionText, /Objective Candidate Evidence/i);
    assert.match(sectionText, /Human Evaluator Interpretation/i);
    assert.match(sectionText, /bookings\/service\.py/);

    // Step 12: Create new observation anchored to this revision
    const noteTextarea = observationSection.getByRole('textbox', {
      name: 'Observation note',
    });
    await noteTextarea.waitFor();
    const testObservationText =
      'Candidate properly edited bookings/service.py to add defensive handling.';
    await noteTextarea.fill(testObservationText);

    const saveBtn = observationSection.getByRole('button', {
      name: 'Save observation',
      exact: true,
    });
    await saveBtn.click();

    // Wait for observation to appear
    const observationCard = observationSection.locator(
      'article[data-testid="evaluator-observation"]',
    );
    await observationCard.first().waitFor();
    const cardText = await observationCard.first().innerText();
    assert.match(cardText, /v1/);
    assert.match(cardText, /Candidate properly edited bookings\/service\.py/);
    await screenshot(reviewerPage, '04-observation-created');

    // Step 13: Confirm observation persistence after page reload
    await reviewerPage.goto(evidenceWorkbenchUrl);
    await reviewerPage
      .getByRole('tab', { name: 'Evidence', exact: true })
      .click();
    await reviewerPage
      .getByRole('tab', { name: 'Chronology', exact: true })
      .click();
    const reloadedSaves = reviewerPage.getByRole('button', {
      name: /Workspace save recorded/,
    });
    await reloadedSaves.first().waitFor();
    await reloadedSaves.nth(0).click();

    const reloadedCard = reviewerPage
      .locator('.evaluator-observation-panel')
      .locator('article[data-testid="evaluator-observation"]');
    await reloadedCard.first().waitFor();
    const reloadedText = await reloadedCard.first().innerText();
    assert.match(reloadedText, /v1/);
    assert.match(
      reloadedText,
      /Candidate properly edited bookings\/service\.py/,
    );
    await screenshot(reviewerPage, '05-observation-persisted-after-reload');

    // Step 14: Edit observation with optimistic concurrency (v1 -> v2)
    const editBtn = reloadedCard.first().getByRole('button', {
      name: 'Edit observation',
      exact: true,
    });
    await editBtn.click();

    const editArea = reloadedCard.first().getByRole('textbox', {
      name: 'Edit observation body',
    });
    await editArea.waitFor();
    const updatedText =
      'Candidate properly edited bookings/service.py to add defensive handling with verified tests.';
    await editArea.fill(updatedText);

    const saveChangesBtn = reloadedCard.first().getByRole('button', {
      name: 'Save changes',
      exact: true,
    });
    await saveChangesBtn.click();

    await reviewerPage.waitForFunction(
      () => {
        const card = document.querySelector(
          'article[data-testid="evaluator-observation"]',
        );
        return card && card.textContent.includes('v2');
      },
      { timeout: 10000 },
    );

    const updatedCardText = await reloadedCard.first().innerText();
    assert.match(updatedCardText, /v2/);
    assert.match(updatedCardText, /with verified tests/);
    await screenshot(reviewerPage, '06-observation-updated-v2');

    // Step 15: Concurrency Conflict Verification via API
    // Retrieve observation ID from reviewer API
    const obsListRes = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/observations`,
      { cookies: reviewer, headers: { Accept: 'application/json' } },
    );
    assert.equal(obsListRes.status, 200, obsListRes.text);
    const obsList = JSON.parse(obsListRes.text).observations;
    assert.equal(obsList.length, 1);
    observationId = obsList[0].id;
    assert.equal(obsList[0].version, 2);

    // Stale update with expectedVersion: 1 should return 409 Conflict
    const conflictRes = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/observations/${observationId}`,
      {
        method: 'PATCH',
        cookies: reviewer,
        headers: {
          Origin: origin,
          'x-csrf-token': reviewer[csrfCookieName],
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: {
          expectedVersion: 1,
          body: 'Concurrent conflicting update',
        },
      },
    );
    http.push({ operation: 'conflict_patch', status: conflictRes.status });
    assert.equal(conflictRes.status, 409, conflictRes.text);
    const conflictJson = JSON.parse(conflictRes.text);
    assert.equal(conflictJson.error.code, 'CONCURRENCY_CONFLICT');
    assert.match(
      conflictJson.error.message,
      /Edit conflict: this observation was updated concurrently/,
    );

    // Step 16: Inspect provenance and anchor details
    const singleObsRes = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/observations/${observationId}`,
      { cookies: reviewer, headers: { Accept: 'application/json' } },
    );
    assert.equal(singleObsRes.status, 200, singleObsRes.text);
    const singleObs = JSON.parse(singleObsRes.text).observation;
    assert.equal(singleObs.id, observationId);
    assert.equal(singleObs.version, 2);
    assert.equal(singleObs.evidenceSourceType, 'file_revision');
    assert.equal(singleObs.filePath, 'bookings/service.py');
    assert.equal(singleObs.visibility, 'private');
    assert.ok(singleObs.createdAt);
    assert.ok(singleObs.updatedAt);
    assert.ok(singleObs.history && singleObs.history.length >= 1);
    await screenshot(reviewerPage, '07-provenance-and-anchors');

    // Step 17: Verify private reviewer boundary (another user cannot access)
    // Recruiter in same org cannot access private observations
    const recruiterAccessRes = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/observations`,
      { cookies: recruiter, headers: { Accept: 'application/json' } },
    );
    assert.equal(
      [403, 404].includes(recruiterAccessRes.status),
      true,
      `Recruiter must not access reviewer observations: got ${recruiterAccessRes.status}`,
    );

    // Reviewer in Org B cannot access Org A's session observations
    const reviewerB = await signInAndSelectOrg(
      origin,
      users.b,
      FIXTURE_IDS.orgB,
    );
    const orgBAccessRes = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/observations`,
      { cookies: reviewerB, headers: { Accept: 'application/json' } },
    );
    assert.equal(
      [403, 404].includes(orgBAccessRes.status),
      true,
      `Org B reviewer must be denied: got ${orgBAccessRes.status}`,
    );

    // Step 18: Responsive layout verification (1440, 768, 390, 375 px)
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

    // Step 19: Revoke assignment
    await admin.query(
      'DELETE FROM hirearchy.reviewer_assignments WHERE session_id = $1',
      [issued.sessionId],
    );

    // Step 20: Confirm subsequent observation access is denied (403/404)
    const revokedObservationApi = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/observations`,
      { cookies: reviewer, headers: { Accept: 'application/json' } },
    );
    assert.equal(
      [403, 404].includes(revokedObservationApi.status),
      true,
      `Expected 403 or 404 after assignment revocation but got ${revokedObservationApi.status}`,
    );

    const revokedSingleApi = await request(
      origin,
      `/r27/api/organizations/${FIXTURE_IDS.orgA}/sessions/${issued.sessionId}/observations/${observationId}`,
      { cookies: reviewer, headers: { Accept: 'application/json' } },
    );
    assert.equal(
      [403, 404].includes(revokedSingleApi.status),
      true,
      `Expected 403 or 404 for single observation but got ${revokedSingleApi.status}`,
    );

    const revokedPageResponse = await reviewerPage.goto(evidenceWorkbenchUrl);
    assert.equal(revokedPageResponse.status(), 404);
    await screenshot(reviewerPage, '09-assignment-revocation-denied');
    await reviewerPage.goto('about:blank');

    // Step 21: Confirm candidate evidence remains intact in database
    const { rows: eventRows } = await admin.query(
      'SELECT count(*) AS count FROM hirearchy.candidate_session_events WHERE session_id = $1',
      [issued.sessionId],
    );
    assert.equal(Number(eventRows[0].count) >= 3, true);

    const { rows: revisionRows } = await admin.query(
      'SELECT count(*) AS count FROM hirearchy.candidate_file_revisions WHERE session_id = $1',
      [issued.sessionId],
    );
    assert.equal(Number(revisionRows[0].count) >= 1, true);

    // Confirm original SQLite application remains unchanged
    const sqlitePath = join(evidence, 'legacy-synthetic.sqlite');
    if (existsSync(sqlitePath)) {
      const sqlite = new Database(sqlitePath, { readonly: true });
      try {
        const tables = sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all();
        const tableNames = tables.map((t) => t.name);
        assert.equal(
          tableNames.includes('evaluator_observations'),
          false,
          'SQLite must not contain evaluator_observations table',
        );
      } finally {
        sqlite.close();
      }
    }

    // Step 22: Browser console and error checks
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

    // Write evidence JSON
    writeFileSync(
      join(evidence, 'r29-browser-evidence.json'),
      JSON.stringify(
        {
          http,
          pageErrors,
          consoleErrors,
          sessionId: issued.sessionId,
          reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
          assignmentId,
          observationId,
          submission: {
            workspaceDigest: submitted.submission.workspaceDigest,
            manifestDigest: submitted.submission.manifestDigest,
            eventCount: submitted.events.length,
          },
          screenshots: [
            'r29-01-candidate-submitted.png',
            'r29-02-workbench-summary.png',
            'r29-03-workbench-revision-selected.png',
            'r29-04-observation-created.png',
            'r29-05-observation-persisted-after-reload.png',
            'r29-06-observation-updated-v2.png',
            'r29-07-provenance-and-anchors.png',
            'r29-08a-responsive-1440.png',
            'r29-08b-responsive-768.png',
            'r29-08c-responsive-390.png',
            'r29-08d-responsive-375.png',
            'r29-09-assignment-revocation-denied.png',
          ],
        },
        null,
        2,
      ),
    );

    console.log(
      'PASS R2.9 Structured Human Evaluator Observations browser verification: creation, persistence, optimistic concurrency, privacy boundary, responsive layouts, revocation',
    );
  } finally {
    await candidateContext.close();
    await reviewerContext.close();
    await browser.close();
  }
}
